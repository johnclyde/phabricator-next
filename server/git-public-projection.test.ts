import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitFixture, type GitFixture } from '../tests/git-fixture.ts';
import { createPublicGitProjection, type PublicGitProjection } from './git-public-projection.ts';

interface Result { code: number | null; output: Buffer; error: string }
function git(path: string, args: string[], input?: string | Buffer, protocol?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', path, ...args], { cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ALLOW_PROTOCOL: '', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', ...(protocol ? { GIT_PROTOCOL: protocol } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = []; let bytes = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4_000_000) child.kill('SIGKILL'); else output.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4_000_000) child.kill('SIGKILL'); else errors.push(chunk); });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, output: Buffer.concat(output), error: Buffer.concat(errors).toString('utf8') }); });
    child.stdin.on('error', () => undefined); child.stdin.end(input);
  });
}
const ok = (result: Result) => { assert.equal(result.code, 0, result.error); return result.output.toString('utf8'); };
const pkt = (text: string) => (Buffer.byteLength(text) + 4).toString(16).padStart(4, '0') + text;
async function withFixture(work: (fixture: GitFixture) => Promise<void>, format: 'sha1' | 'sha256' = 'sha1') { const fixture = await createGitFixture(format); try { await work(fixture); } finally { await fixture.close(); } }

for (const format of ['sha1', 'sha256'] as const) test(`public ${format} projection contains exactly public reachability, including tag objects and blobs`, async () => withFixture(async fixture => {
  await fixture.git(['update-ref', 'refs/phabricator/hidden', fixture.importCommit]);
  const secretBlob = (await fixture.git(['hash-object', '-w', '--stdin'], 'Unpublished private proof DO-NOT-DISCLOSE\n')).trim();
  await fixture.git(['update-ref', 'refs/phabricator/proof', secretBlob]);
  await fixture.git(['repack', '-ad']);
  const projection = await createPublicGitProjection('R1', fixture.barePath);
  try {
    assert.equal(projection.objectFormat, format); assert.equal(projection.head, 'refs/heads/main');
    assert.equal(ok(await git(projection.path, ['for-each-ref', '--format=%(objectname) %(refname)'])), await fixture.git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/tags/']));
    const expected = (await fixture.git(['rev-list', '--objects', '--stdin'], projection.refs.map(ref => ref.objectId).join('\n') + '\n')).trim().split('\n').map(line => line.split(' ')[0]!).sort();
    const actual = ok(await git(projection.path, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])).trim().split('\n').sort();
    assert.deepEqual(actual, [...new Set(expected)]);
    assert.equal((await git(projection.path, ['cat-file', '-e', fixture.importCommit])).code, 1);
    assert.equal((await git(projection.path, ['cat-file', '-e', secretBlob])).code, 1);
    assert.equal(ok(await git(projection.path, ['cat-file', '-t', fixture.annotatedTag])).trim(), 'tag');
    assert.equal(ok(await git(projection.path, ['cat-file', '-t', fixture.readmeBlob])).trim(), 'blob');
    await assert.rejects(access(join(projection.path, 'objects', 'info', 'alternates')));
    const packed = (await readdir(join(projection.path, 'objects', 'pack'))).filter(name => name.endsWith('.pack'));
    assert.equal(packed.length, 1); assert.equal((await stat(join(projection.path, 'objects', 'pack', packed[0]!))).nlink, 1);
    assert.equal((await stat(join(projection.path, '..'))).mode & 0o077, 0);
    const before = projection.refs.find(ref => ref.name === 'refs/heads/main')!.objectId;
    await fixture.advanceMain(); assert.equal(ok(await git(projection.path, ['rev-parse', 'main'])).trim(), before);
  } finally { await projection.dispose(); }
  await assert.rejects(access(projection.path)); await projection.dispose();
}, format));

test('protocol v2 cannot retrieve a hidden known object ID from the isolated public database', async () => withFixture(async fixture => {
  await fixture.git(['update-ref', 'refs/phabricator/private', fixture.importCommit]);
  const projection = await createPublicGitProjection('R1', fixture.barePath);
  try {
    const request = (id: string) => pkt('command=fetch\n') + '0001' + pkt(`want ${id}\n`) + pkt('done\n') + '0000';
    const hidden = await git(projection.path, ['upload-pack', '--stateless-rpc', projection.path], request(fixture.importCommit), 'version=2');
    assert.notEqual(hidden.code, 0); assert.match(hidden.error + hidden.output.toString('utf8'), /not our ref|not a valid object/);
    const published = await git(projection.path, ['upload-pack', '--stateless-rpc', projection.path], request(fixture.head), 'version=2');
    assert.equal(published.code, 0, published.error); assert.ok(published.output.includes(Buffer.from('PACK')));
  } finally { await projection.dispose(); }
}));

test('hidden or detached source HEAD never advertises internal objects', async () => withFixture(async fixture => {
  await fixture.git(['update-ref', 'refs/phabricator/private', fixture.importCommit]);
  await writeFile(join(fixture.barePath, 'HEAD'), 'ref: refs/phabricator/private\n');
  let projection = await createPublicGitProjection('R1', fixture.barePath);
  try { assert.equal(projection.head, 'refs/heads/main'); assert.equal(await readFile(join(projection.path, 'HEAD'), 'utf8'), 'ref: refs/heads/main\n'); }
  finally { await projection.dispose(); }
  for (const ref of ['refs/heads/main', 'refs/heads/feature']) await fixture.git(['update-ref', '-d', ref]);
  await writeFile(join(fixture.barePath, 'HEAD'), `${fixture.importCommit}\n`);
  projection = await createPublicGitProjection('R1', fixture.barePath);
  try { assert.equal(projection.head, null); assert.equal(await readFile(join(projection.path, 'HEAD'), 'utf8'), 'ref: refs/heads/main\n'); assert.notEqual((await git(projection.path, ['cat-file', '-e', fixture.importCommit])).code, 0); }
  finally { await projection.dispose(); }
}));

test('empty public repository remains an empty isolated object database even when internal refs exist', async () => withFixture(async fixture => {
  await fixture.git(['update-ref', 'refs/phabricator/hidden', fixture.head]);
  const refs = (await fixture.git(['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/tags/'])).trim().split('\n');
  for (const ref of refs) await fixture.git(['update-ref', '-d', ref]);
  const projection = await createPublicGitProjection('R1', fixture.barePath);
  try { assert.deepEqual(projection.refs, []); assert.equal(projection.head, null); assert.equal(ok(await git(projection.path, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])), ''); }
  finally { await projection.dispose(); }
}));

test('pack-size bounds and cancellation clean up temporary projections without returning partial repositories', async () => withFixture(async fixture => {
  const directory = join(fixture.root, 'projections'); await mkdir(directory, { mode: 0o700 });
  await assert.rejects(createPublicGitProjection('R1', fixture.barePath, { parentDirectory: directory, maxPackBytes: 12 }), /size or time limit/);
  assert.deepEqual(await readdir(directory), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createPublicGitProjection('R1', fixture.barePath, { parentDirectory: directory, signal: controller.signal }), /cancelled/);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(createPublicGitProjection('R1', fixture.barePath, { parentDirectory: directory, timeoutMs: 1 }), /time limit/);
  assert.deepEqual(await readdir(directory), []);
}));

test('public symbolic aliases and unsafe source configuration fail closed', async () => withFixture(async fixture => {
  await fixture.git(['update-ref', 'refs/phabricator/hidden', fixture.importCommit]);
  await fixture.git(['symbolic-ref', 'refs/heads/alias', 'refs/phabricator/hidden']);
  await assert.rejects(createPublicGitProjection('R1', fixture.barePath), /snapshot is unavailable/);
  await fixture.git(['symbolic-ref', '--delete', 'refs/heads/alias']);
  const config = await readFile(join(fixture.barePath, 'config'), 'utf8'); await writeFile(join(fixture.barePath, 'config'), `${config}\n[include]\npath = /DO-NOT-DISCLOSE\n`);
  await assert.rejects(createPublicGitProjection('R1', fixture.barePath), error => error instanceof Error && !error.message.includes('DO-NOT-DISCLOSE'));
}));
