import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { gitComparisonCommand } from '../cli/git-comparison.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { GitComparison, GitComparisonChange, GitComparisonFile } from '../shared/repositories.ts';
import { validGitComparison, validGitComparisonFile } from '../shared/git-comparison.ts';
import { createGitFixture } from './git-fixture.ts';
import { createApp } from '../server/app.ts';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';

const base = 'a'.repeat(40), target = 'b'.repeat(40), tree = 'c'.repeat(40), blob = 'd'.repeat(40);
const person = { name: 'Author', email: 'author@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const commit = (id: string) => ({ id, treeId: tree, parentIds: [], author: person, committer: person, message: 'Source', messageTruncated: false });
const entry = { path: 'paper.tex', objectId: blob, mode: '100644', type: 'file' as const, size: 7 };
const change: GitComparisonChange = { id: 'e'.repeat(64), status: 'modified', similarity: null, before: entry, after: { ...entry, objectId: 'f'.repeat(40) } };
const inventory: GitComparison = { repositoryId: 'R1', objectFormat: 'sha1', accessEpoch: 1, baseCommit: commit(base), targetCommit: commit(target), baseTreeId: tree, targetTreeId: tree, algorithm: 'git-M50-C50', changes: [change] };
const file: GitComparisonFile = { ...inventory, change, before: { repositoryId: 'R1', objectFormat: 'sha1', commitId: base, path: entry.path, objectId: blob, mode: '100644', state: 'text', size: 7, content: 'Before\n' }, after: { repositoryId: 'R1', objectFormat: 'sha1', commitId: target, path: entry.path, objectId: 'f'.repeat(40), mode: '100644', state: 'text', size: 7, content: 'After.\n' } };
async function exercise(options: PaperCLI['options'], response: unknown = inventory) {
  const calls: { path: string; method?: string; body?: unknown }[] = [], output: string[] = [], original = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(' '));
  try {
    await gitComparisonCommand({ command: 'compare-commits', args: ['R1'], options, optionNames: Object.keys(options), request: async <T>(path: string, method?: string, body?: unknown) => { calls.push({ path, method, body }); return response as T; }, download: async () => { throw new Error('Unexpected download'); } });
    return { calls, output, error: undefined };
  } catch (error) { return { calls, output, error }; }
  finally { console.log = original; }
}
test('commit comparison CLI performs only one exact read and retains literal source line differences', async () => {
  const list = await exercise({ base, commit: target }); assert.equal(list.error, undefined); assert.equal(list.calls.length, 1);
  assert.equal(list.calls[0]!.path, `/api/repositories/R1/compare?base=${base}&target=${target}`); assert.equal(list.calls[0]!.method, undefined); assert.equal(list.calls[0]!.body, undefined);
  const selected = await exercise({ base, commit: target, 'before-path': 'paper.tex', 'after-path': 'paper.tex' }, file);
  assert.equal(selected.error, undefined); assert.equal(selected.calls.length, 1); assert.match(selected.output.join('\n'), /-Before\n\+After\./);
});
test('comparison CLI rejects mutable selectors and ambiguous paths before a request', async () => {
  for (const options of [{ commit: target }, { base: 'main', commit: target }, { base, commit: 'HEAD^' }, { base: 'a'.repeat(64), commit: target }, { base, commit: target, path: 'paper.tex' }, { base, commit: target, 'before-path': '' }, { base, commit: target, 'after-path': '../secret' }, { base: 'empty', commit: target, 'before-path': 'paper.tex' }]) {
    const result = await exercise(options); assert.ok(result.error); assert.equal(result.calls.length, 0); assert.deepEqual(result.output, []);
  }
});
test('comparison validation rejects mismatched pairs, duplicate entries and substituted file identities before printing source', async () => {
  for (const response of [{ ...inventory, targetCommit: commit(base) }, { ...inventory, baseTreeId: blob }, { ...inventory, accessEpoch: undefined }, { ...inventory, changes: [change, change] }, { ...inventory, changes: [{ ...change, before: { ...entry, mode: '120000' } }] }]) {
    assert.equal(validGitComparison(response, 'R1', { base, target }), false);
    const result = await exercise({ base, commit: target }, response); assert.ok(result.error); assert.deepEqual(result.output, []);
  }
  const query = { base, target, beforePath: 'paper.tex', afterPath: 'paper.tex' };
  for (const response of [{ ...file, before: { ...file.before, commitId: target } }, { ...file, after: { ...file.after, objectId: blob } }, { ...file, after: { ...file.after, size: 0 } }, { ...file, change: { ...change, after: { ...change.after, path: 'different.tex' } } }]) assert.equal(validGitComparisonFile(response, 'R1', query, change), false);
  const mismatch = await exercise({ base, commit: target, 'before-path': 'other.tex', 'after-path': 'paper.tex' }, file); assert.ok(mismatch.error); assert.deepEqual(mismatch.output, []);
});
test('comparison CLI preserves absent and empty sides and never treats binary content as empty', async () => {
  const added = { ...change, status: 'added' as const, before: null, after: { ...entry, size: 0 } };
  const empty: GitComparisonFile = { ...file, baseCommit: null, change: added, before: null, after: { ...file.after!, objectId: blob, state: 'text', size: 0, content: '' } };
  const saved = await exercise({ base: 'empty', commit: target, 'after-path': 'paper.tex', json: true }, empty); assert.equal(saved.error, undefined); assert.equal(JSON.parse(saved.output[0]!).before, null); assert.equal(JSON.parse(saved.output[0]!).after.content, '');
  const binary = await exercise({ base, commit: target, 'before-path': 'paper.tex', 'after-path': 'paper.tex' }, { ...file, after: { ...file.after, state: 'binary', content: undefined } });
  assert.ok(binary.error, 'nontext side carrying a content field is invalid');
  const nontext = { ...file.after! }; delete (nontext as { content?: string }).content;
  const shown = await exercise({ base, commit: target, 'before-path': 'paper.tex', 'after-path': 'paper.tex' }, { ...file, after: { ...nontext, state: 'binary' } }); assert.equal(shown.error, undefined); assert.match(shown.output.join(' '), /text comparison is unavailable/); assert.doesNotMatch(shown.output.join(' '), /No text changes/);
});
test('comparison CLI follows verified rename paths and escapes terminal controls without altering JSON source', async () => {
  const renamed = { ...change, status: 'renamed' as const, similarity: 75, after: { ...change.after!, path: 'new\tname\u001b[2J.tex' } };
  const result = { ...file, change: renamed, after: { ...file.after!, path: renamed.after.path } };
  const options = { base, commit: target, 'before-path': 'paper.tex', 'after-path': renamed.after.path };
  const human = await exercise(options, result); assert.equal(human.error, undefined); assert.doesNotMatch(human.output.join(''), /\u001b/); assert.match(human.output.join(''), /75% similarity/); assert.match(human.calls[0]!.path, /%1B%5B2J/);
  const machine = await exercise({ ...options, json: true }, result); assert.equal(machine.error, undefined); assert.equal(JSON.parse(machine.output[0]!).after.path, renamed.after.path);
});

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function runCLI(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const mount of ['/', '/review/']) test(`commit comparison CLI reads real pinned Git source with a read-only token at ${mount}`, async () => {
  const fixture = await createGitFixture(); const store = createStore({ path: ':memory:' });
  const operator = createAuth({ database: store.database, mode: 'local', provisioning: true, basePath: mount });
  const account = await operator.createAccount({ username: 'reader', displayName: 'Reader', password: 'Repository comparison testing password' });
  const repository = store.createRepository({ name: 'Observed source', remoteUrl: 'https://example.invalid/no-fetch.git' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: mount, gitRepositories: { [repository.id]: fixture.barePath } });
  try {
    const token = app.auth.createToken(account.id, { name: 'Read-only CLI', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${mount}`;
    const args = ['compare-commits', repository.id, '--base', fixture.base, '--commit', fixture.head, '--server', url, '--json'];
    const inventory = await runCLI(args, token.token); assert.equal(inventory.code, 0, inventory.stderr);
    const comparison = JSON.parse(inventory.stdout) as GitComparison; assert.equal(comparison.baseCommit!.id, fixture.base); assert.equal(comparison.targetCommit.id, fixture.head); assert.ok(comparison.changes.find(item => item.after?.path === 'README.md'));
    await fixture.advanceMain();
    const selected = await runCLI([...args, '--before-path', 'README.md', '--after-path', 'README.md'], token.token); assert.equal(selected.code, 0, selected.stderr);
    const detail = JSON.parse(selected.stdout) as GitComparisonFile; assert.equal(detail.targetCommit.id, fixture.head); assert.ok(detail.after?.state === 'text'); assert.match(detail.after.content, /After the change/);
    app.auth.revokeToken(account.id, token.record.id);
    const denied = await runCLI(args, token.token); assert.equal(denied.code, 1); assert.equal(denied.stdout, ''); assert.ok(!denied.stderr.includes(token.token));
  } finally { await app.close(); store.close(); await fixture.close(); }
});
