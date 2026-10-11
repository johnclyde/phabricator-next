import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { gitPatchCommand } from '../cli/git-patch';
import type { PaperCLI } from '../cli/paper-builds';
import { GIT_LIMITS, type GitPatch } from '../shared/repositories';
import { gitPatchBytes, gitPatchFilename, validGitPatch } from '../shared/git-patch';
import { createGitFixture, createGitComparisonFixture } from './git-fixture';
import { createApp } from '../server/app';
import { createStore } from '../server/store';
import { createAuth } from '../server/auth';

const base = 'a'.repeat(40), target = 'b'.repeat(40), query = { base, target };
const person = { name: 'Writer', email: 'writer@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const commit = (id: string) => ({ id, treeId: id === base ? 'c'.repeat(40) : 'd'.repeat(40), parentIds: [], author: person, committer: person, message: 'Source', messageTruncated: false });
const source = Buffer.from([0xef, 0xbb, 0xbf, 0x41, 13, 10, 0, 0xc0, 0xaf, 27, 91, 50, 74]);
function patch(data = source): GitPatch { return { repositoryId: 'R1', objectFormat: 'sha1', accessEpoch: 1, baseCommit: commit(base), targetCommit: commit(target), baseTreeId: commit(base).treeId, targetTreeId: commit(target).treeId, format: 'git-binary-patch-v1', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') }; }
async function exercise(options: PaperCLI['options'], response: unknown = patch(), optionNames = Object.keys(options)) {
  const calls: string[] = [], output: string[] = [], original = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(' '));
  try { await gitPatchCommand({ command: 'download-patch', args: ['R1'], options, optionNames, request: async <T>(path: string) => { calls.push(path); return response as T; }, download: async () => { throw new Error('Unexpected byte request'); } }); return { calls, output, error: undefined }; }
  catch (error) { return { calls, output, error }; } finally { console.log = original; }
}

test('patch bytes preserve all encodings and reject mismatched identities, sizes, base64, hashes and epochs', async () => {
  assert.deepEqual(Buffer.from(await gitPatchBytes(patch(), 'R1', query)), source);
  const empty = { ...patch(Buffer.alloc(0)), targetCommit: { ...commit(target), treeId: commit(base).treeId }, targetTreeId: commit(base).treeId };
  assert.deepEqual(await gitPatchBytes(empty, 'R1', query), new Uint8Array());
  await assert.rejects(gitPatchBytes(patch(Buffer.alloc(0)), 'R1', query));
  await assert.rejects(gitPatchBytes({ ...patch(), targetCommit: empty.targetCommit, targetTreeId: empty.targetTreeId }, 'R1', query));
  const oversized = patch(Buffer.alloc(GIT_LIMITS.patchBytes, 255));
  assert.equal(validGitPatch(oversized, 'R1', query), true, 'large canonical base64 must not overflow a regular-expression stack');
  assert.equal((await gitPatchBytes(oversized, 'R1', query)).length, GIT_LIMITS.patchBytes);
  for (const bad of [
    { ...patch(), repositoryId: 'R2' }, { ...patch(), targetCommit: commit(base) }, { ...patch(), objectFormat: 'sha256' }, { ...patch(), format: 'text' },
    { ...patch(), accessEpoch: undefined }, { ...patch(), bytes: -1 }, { ...patch(), bytes: GIT_LIMITS.patchBytes + 1 }, { ...patch(), dataBase64: patch().dataBase64 + '\n' },
    { ...patch(), sha256: '0'.repeat(64) }, { ...patch(Buffer.from('f')), dataBase64: 'Zh==' }, { ...patch(), targetTreeId: 'e'.repeat(40) },
  ]) await assert.rejects(gitPatchBytes(bad, 'R1', query));
  await assert.rejects(gitPatchBytes(patch(), 'R1', query, { ...patch(), accessEpoch: 2 }));
  await assert.rejects(gitPatchBytes({ ...patch(), baseCommit: null }, 'R1', { base: null, target }));
  assert.match(gitPatchFilename('R1', query), /^R1-a+-to-b+\.patch$/);
  assert.throws(() => gitPatchFilename('../../secret', query));
});

test('download-patch validates before creating files and never overwrites files or follows output symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-patch-cli-'));
  try {
    const output = join(root, 'new.patch'), options = { base, commit: target, output, json: true };
    const invalid = await exercise(options, { ...patch(), sha256: '0'.repeat(64) }); assert.ok(invalid.error); assert.deepEqual(invalid.output, []); await assert.rejects(stat(output));
    const valid = await exercise(options); assert.equal(valid.error, undefined); assert.deepEqual(valid.calls, [`/api/repositories/R1/compare/patch?base=${base}&target=${target}`]);
    assert.deepEqual(await readFile(output), source); assert.equal((await stat(output)).mode & 0o777, 0o600);
    const receipt = JSON.parse(valid.output[0]!); assert.equal(receipt.sha256, patch().sha256); assert.equal(receipt.bytes, source.length); assert.equal(receipt.dataBase64, undefined);
    const again = await exercise(options); assert.ok(again.error); assert.deepEqual(again.output, []); assert.deepEqual(await readFile(output), source);
    const linked = join(root, 'linked.patch'); await symlink(output, linked);
    assert.ok((await exercise({ ...options, output: linked })).error); assert.deepEqual(await readFile(output), source);
    for (const bad of [{ commit: target, output }, { base: 'HEAD', commit: target, output }, { base, commit: 'main', output }, { base: 'a'.repeat(64), commit: target, output }, { base, commit: target, output: '-' }, { base, commit: target, output, path: 'a' }]) { const result = await exercise(bad); assert.ok(result.error); assert.deepEqual(result.calls, []); }
    const duplicate = await exercise(options, patch(), [...Object.keys(options), 'base']); assert.ok(duplicate.error); assert.deepEqual(duplicate.calls, []);
    assert.deepEqual((await readdir(root)).sort(), ['linked.patch', 'new.patch']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed patch write leaves no partial destination or temporary file', async context => {
  const root = await mkdtemp(join(tmpdir(), 'phab-patch-write-'));
  const probe = await open(join(root, 'probe'), 'wx');
  try {
    const failure = context.mock.method(Object.getPrototypeOf(probe), 'writeFile', async () => { throw new Error('Simulated full disk'); });
    const output = join(root, 'failed.patch');
    const result = await exercise({ base, commit: target, output });
    failure.mock.restore();
    assert.ok(result.error); assert.deepEqual(result.output, []); await assert.rejects(stat(output));
    assert.deepEqual(await readdir(root), ['probe']);
  } finally { await probe.close(); await rm(root, { recursive: true, force: true }); }
});

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function runCLI(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const [format, mount] of [['sha1', '/'], ['sha256', '/review/']] as const) test(`download-patch CLI exports verified ${format} bytes with a read-only token at ${mount}`, async () => {
  const fixture = await createGitFixture(format), pair = await createGitComparisonFixture(fixture), store = createStore({ path: ':memory:' });
  const provision = createAuth({ database: store.database, mode: 'local', provisioning: true, basePath: mount });
  const account = await provision.createAccount({ username: 'reader', displayName: 'Reader', password: 'A repository patch testing password' });
  store.createRepository({ name: 'Observed source', remoteUrl: 'https://example.invalid/no-network.git' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: mount, gitRepositories: { R1: fixture.barePath } });
  try {
    const token = app.auth.createToken(account.id, { name: 'Download exact patches', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${mount}`, output = join(fixture.root, 'export.patch');
    const args = ['download-patch', 'R1', '--base', pair.base, '--commit', pair.target, '--server', url, '--output', output, '--json'];
    const result = await runCLI(args, token.token); assert.equal(result.code, 0, result.stderr);
    const receipt = JSON.parse(result.stdout), bytes = await readFile(output);
    assert.equal(receipt.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(receipt.bytes, bytes.length); assert.equal(receipt.base, pair.base); assert.equal(receipt.target, pair.target);
    assert.ok(bytes.includes(Buffer.from('GIT binary patch'))); assert.ok(bytes.includes(Buffer.from([0xc0, 0xaf]))); assert.doesNotMatch(result.stdout, /diff --git|GIT binary patch/);
    await fixture.advanceMain();
    const next = join(fixture.root, 'again.patch'), repeatedArgs = [...args]; repeatedArgs[repeatedArgs.indexOf('--output') + 1] = next;
    const repeated = await runCLI(repeatedArgs, token.token);
    // Keep the argument selection explicit when a branch has moved.
    if (repeated.code !== 0) throw new Error(repeated.stderr);
    assert.deepEqual(await readFile(next), bytes);
    app.auth.revokeToken(account.id, token.record.id);
    const deniedPath = join(fixture.root, 'denied.patch'); const denied = await runCLI(['download-patch', 'R1', '--base', pair.base, '--commit', pair.target, '--server', url, '--output', deniedPath], token.token);
    assert.equal(denied.code, 1); assert.equal(denied.stdout, ''); await assert.rejects(stat(deniedPath)); assert.ok(!denied.stderr.includes(token.token));
  } finally { await app.close(); store.close(); await fixture.close(); }
});
