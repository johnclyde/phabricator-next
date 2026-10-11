import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { gitBlameCommand } from '../cli/git-blame.ts';
import type { PaperCLI } from '../cli/paper-builds.ts';
import type { GitBlame } from '../shared/repositories.ts';
import { gitSourceLines, validGitBlame } from '../shared/git-blame.ts';
import { createGitFixture } from './git-fixture.ts';
import { createGitBlameFixture } from './git-blame-fixture.ts';
import { createApp } from '../server/app.ts';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';

const target = 'a'.repeat(40), origin = 'b'.repeat(40), path = 'paper.tex';
const author = { name: 'Writer', email: 'writer@example.test', timestamp: '2026-01-01T00:00:00.000Z' };
const commit = (id: string) => ({ id, treeId: 'c'.repeat(40), parentIds: [], author, committer: author, message: 'Source history', messageTruncated: false });
const content = '\ufeffFirst\r\n\nLast';
const result: GitBlame = { repositoryId: 'R1', objectFormat: 'sha1', accessEpoch: 2, algorithm: 'git-blame-root', commit: commit(target),
  blob: { repositoryId: 'R1', objectFormat: 'sha1', commitId: target, path, objectId: 'd'.repeat(40), mode: '100644', state: 'text', content, size: new TextEncoder().encode(content).length },
  commits: [commit(origin)], lines: [1, 2, 3].map(lineNumber => ({ lineNumber, commitId: origin, originalLine: lineNumber + 1, path: 'original paper.tex' })) };

async function exercise(options: PaperCLI['options'], response: unknown = result) {
  const calls: { path: string; method?: string; body?: unknown }[] = [], output: string[] = [], original = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(' '));
  try {
    await gitBlameCommand({ command: 'blame', args: ['R1'], options, optionNames: Object.keys(options), request: async <T>(path: string, method?: string, body?: unknown) => { calls.push({ path, method, body }); return response as T; }, download: async () => { throw new Error('Unexpected download'); } });
    return { calls, output, error: undefined };
  } catch (error) { return { calls, output, error }; }
  finally { console.log = original; }
}

test('Git logical lines preserve BOM, CRLF, blank lines and missing final newline', () => {
  assert.deepEqual(gitSourceLines(''), []); assert.deepEqual(gitSourceLines('\n'), ['']);
  assert.deepEqual(gitSourceLines(content), ['\ufeffFirst\r', '', 'Last']);
  assert.deepEqual(gitSourceLines('first\n\n'), ['first', '']);
});
test('blame CLI makes one exact read and prints provenance without changing source', async () => {
  const response = await exercise({ commit: target, path }); assert.equal(response.error, undefined);
  assert.deepEqual(response.calls, [{ path: `/api/repositories/R1/blame?commit=${target}&path=paper.tex`, method: undefined, body: undefined }]);
  assert.match(response.output.join('\n'), /original paper.tex:2/); assert.match(response.output.join('\n'), /First\\u000d/); assert.match(response.output.join('\n'), /No final newline/);
  const machine = await exercise({ commit: target, path, json: true }); assert.equal(machine.error, undefined); assert.deepEqual(JSON.parse(machine.output[0]!), result);
});
test('blame CLI rejects mutable selectors and unsupported options before contacting the server', async () => {
  for (const options of [{ path }, { commit: 'main', path }, { commit: target.slice(0, 12), path }, { commit: target.toUpperCase(), path }, { commit: target, path: '' }, { commit: target, path: '../private' }, { commit: target, path, base: origin }]) {
    const response = await exercise(options); assert.ok(response.error); assert.deepEqual(response.calls, []); assert.deepEqual(response.output, []);
  }
});
test('blame rejects incomplete, mismatched or substituted source attribution before printing', async () => {
  for (const patch of [
    { repositoryId: 'R2' }, { objectFormat: 'sha256' }, { commit: commit(origin) }, { accessEpoch: undefined }, { algorithm: 'invented' },
    { blob: { ...result.blob, path: 'other.tex' } }, { blob: { ...result.blob, commitId: origin } }, { blob: { ...result.blob, size: 0 } }, { blob: { ...result.blob, mode: '120000' } }, { blob: { ...result.blob, accessEpoch: 1 } },
    { lines: null }, { lines: result.lines!.slice(1) }, { lines: [...result.lines!, result.lines![0]] }, { lines: result.lines!.map((line, index) => index ? line : { ...line, lineNumber: 2 }) },
    { lines: result.lines!.map(line => ({ ...line, originalLine: 0 })) }, { lines: result.lines!.map(line => ({ ...line, commitId: target })) }, { lines: result.lines!.map(line => ({ ...line, path: '../secret' })) },
    { commits: [] }, { commits: [commit(origin), commit(origin)] }, { commits: [commit(origin), commit(target)] },
  ]) {
    const forged = { ...result, ...patch }; assert.equal(validGitBlame(forged, 'R1', target, path), false, JSON.stringify(patch));
    const response = await exercise({ commit: target, path }, forged); assert.ok(response.error); assert.deepEqual(response.output, []);
  }
});
test('blame preserves empty and special states with no invented line provenance', async () => {
  const empty = { ...result, blob: { ...result.blob, content: '', size: 0 }, lines: [], commits: [] };
  const response = await exercise({ commit: target, path }, empty); assert.equal(response.error, undefined); assert.match(response.output.join('\n'), /Empty text file/);
  const { content: _content, ...identity } = result.blob as Extract<GitBlame['blob'], { state: 'text' }>;
  for (const [state, mode, size] of [['binary', '100644', 5], ['unsupported_encoding', '100644', 2], ['oversized', '100644', 256001], ['symlink', '120000', 9], ['submodule', '160000', null]] as const) {
    const special = { ...result, blob: { ...identity, state, mode, size }, lines: null, commits: [] };
    const response = await exercise({ commit: target, path }, special); assert.equal(response.error, undefined); assert.match(response.output.join('\n'), /provenance is unavailable/); assert.doesNotMatch(response.output.join('\n'), /Empty text file/);
    assert.equal(validGitBlame({ ...special, lines: [] }, 'R1', target, path), false);
    assert.equal(validGitBlame({ ...special, blob: { ...special.blob, content: 'substitute' } }, 'R1', target, path), false);
  }
});
test('human blame output escapes source, filename and author terminal controls while JSON roundtrips', async () => {
  const content = '\u001b[2J\u202eHidden\r\n', path = 'path\tname\u001b.tex', originPath = 'old\nname\u2066.tex';
  const value = { ...result, blob: { ...result.blob, path, content, size: new TextEncoder().encode(content).length }, lines: [{ lineNumber: 1, originalLine: 1, commitId: origin, path: originPath }], commits: [{ ...commit(origin), author: { ...author, name: '\u001b[2JWriter' } }] };
  const response = await exercise({ commit: target, path }, value); assert.equal(response.error, undefined); assert.doesNotMatch(response.output.join(''), /[\u001b\u202e\u2066]/); assert.match(response.output.join(''), /\\u001b/); assert.match(response.calls[0]!.path, /%1B/);
  const machine = await exercise({ commit: target, path, json: true }, value); assert.equal(machine.error, undefined); assert.deepEqual(JSON.parse(machine.output[0]!), value); assert.doesNotMatch(machine.output[0]!, /[\u001b\u202e\u2066]/);
});

const executable = fileURLToPath(new URL('../cli/index.ts', import.meta.url)), loader = import.meta.resolve('tsx');
function runCLI(args: string[], token: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, executable, ...args], { env: { ...process.env, PHABRICATOR_URL: undefined, PHABRICATOR_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
for (const [mount, format] of [['/', 'sha1'], ['/review/', 'sha256']] as const) test(`blame CLI reads exact ${format} source with read-only credentials at ${mount}`, async () => {
  const fixture = await createGitFixture(format), store = createStore({ path: ':memory:' });
  const operator = createAuth({ database: store.database, mode: 'local', provisioning: true, basePath: mount });
  const account = await operator.createAccount({ username: 'reader', displayName: 'Reader', password: 'Repository provenance testing password' });
  const repository = store.createRepository({ name: 'Observed source', remoteUrl: 'https://example.invalid/no-fetch.git' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: mount, gitRepositories: { [repository.id]: fixture.barePath } });
  try {
    const token = app.auth.createToken(account.id, { name: 'Read-only CLI', scopes: ['read'] });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}${mount}`;
    const args = ['blame', repository.id, '--commit', fixture.head, '--path', 'README.md', '--server', url, '--json'];
    const read = await runCLI(args, token.token); assert.equal(read.code, 0, read.stderr);
    const blame = JSON.parse(read.stdout) as GitBlame; assert.equal(validGitBlame(blame, repository.id, fixture.head, 'README.md'), true);
    assert.equal(blame.lines![0]!.commitId, fixture.base); assert.equal(blame.lines!.length, 2); assert.equal(blame.blob.state, 'text');
    const renamed = await createGitBlameFixture(fixture);
    const renameRead = await runCLI(['blame', repository.id, '--commit', renamed.merge, '--path', renamed.path, '--server', url, '--json'], token.token);
    assert.equal(renameRead.code, 0, renameRead.stderr); const renameBlame = JSON.parse(renameRead.stdout) as GitBlame;
    assert.equal(validGitBlame(renameBlame, repository.id, renamed.merge, renamed.path), true);
    assert.equal(renameBlame.lines![0]!.path, renamed.originalPath); assert.equal(renameBlame.lines![0]!.commitId, renamed.root);
    assert.equal(renameBlame.blob.state === 'text' && renameBlame.blob.content, renamed.content);
    await fixture.advanceMain(); const again = await runCLI(args, token.token); assert.equal(again.code, 0, again.stderr); assert.deepEqual(JSON.parse(again.stdout), blame);
    app.auth.revokeToken(account.id, token.record.id); const denied = await runCLI(args, token.token); assert.equal(denied.code, 1); assert.equal(denied.stdout, ''); assert.ok(!denied.stderr.includes(token.token));
  } finally { await app.close(); store.close(); await fixture.close(); }
});
