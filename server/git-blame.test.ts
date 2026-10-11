import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { GIT_LIMITS } from '../shared/repositories.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import type { GitFixture } from '../tests/git-fixture.ts';
import { createGitBlameFixture } from '../tests/git-blame-fixture.ts';
import { createGitObserver } from './git.ts';
import { HttpError } from './validation.ts';

const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
async function fixtureTest(work: (fixture: GitFixture) => Promise<void>, format: 'sha1' | 'sha256' = 'sha1') {
  const fixture = await createGitFixture(format); try { await work(fixture); } finally { await fixture.close(); }
}
/** Fast immutable-object construction makes long histories bounded test data, not subprocess storms. */
async function object(fixture: GitFixture, type: 'blob' | 'tree' | 'commit', data: Buffer): Promise<string> {
  const raw = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]), id = createHash(fixture.objectFormat).update(raw).digest('hex');
  const directory = join(fixture.barePath, 'objects', id.slice(0, 2)); await mkdir(directory, { recursive: true });
  const path = join(directory, id.slice(2));
  await chmod(path, 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  await writeFile(path, deflateSync(raw)); return id;
}
async function version(fixture: GitFixture, content: string | Buffer, parents: string[] = [], path = 'source.txt', mode = '100644'): Promise<{ commit: string; blob: string; tree: string }> {
  const blob = await object(fixture, 'blob', Buffer.from(content));
  const tree = await object(fixture, 'tree', Buffer.concat([Buffer.from(`${mode} ${path}\0`), Buffer.from(blob, 'hex')]));
  const commit = await object(fixture, 'commit', Buffer.from(`tree ${tree}\n${parents.map(id => `parent ${id}\n`).join('')}author Literal Author <literal@example.invalid> 1704164645 +0000\ncommitter Literal Author <literal@example.invalid> 1704164645 +0000\n\nLiteral history\n`));
  return { commit, blob, tree };
}

for (const format of ['sha1', 'sha256'] as const) test(`verified ${format} blame retains root, rename, both merge parents and literal filename provenance`, async () => fixtureTest(async fixture => {
  const source = await createGitBlameFixture(fixture), observer = createGitObserver({ R1: fixture.barePath });
  const before = (await readdir(join(fixture.barePath, 'objects'), { recursive: true })).sort();
  const result = await observer.blame('R1', source.merge, source.path);
  assert.equal(result.commit.id, source.merge); assert.deepEqual(result.commit.parentIds, [source.main, source.feature]);
  assert.equal(result.algorithm, 'git-blame-root'); assert.equal(result.objectFormat, format); assert.equal(result.blob.state, 'text');
  if (result.blob.state === 'text') assert.equal(result.blob.content, source.content);
  assert.deepEqual(result.lines?.map(line => line.commitId), [source.root, source.root, source.main, source.feature, source.edit, source.edit, source.merge]);
  assert.deepEqual(result.lines?.map(line => line.lineNumber), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.lines?.map(line => line.originalLine), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(result.lines?.map(line => line.path), [source.originalPath, source.originalPath, source.path, source.path, source.originalPath, source.originalPath, source.path]);
  assert.deepEqual(result.commits.map(commit => commit.id), [source.root, source.main, source.feature, source.edit, source.merge]);
  const root = await observer.blame('R1', source.root, source.originalPath);
  assert.equal(root.lines?.length, 5); assert.ok(root.lines?.every(line => line.commitId === source.root));
  assert.equal(root.blob.state, 'text'); if (root.blob.state === 'text') assert.equal(root.blob.content, source.rootContent);
  const renamed = await observer.blame('R1', source.renamed, source.path); assert.ok(renamed.lines?.every(line => line.path === source.originalPath));
  assert.deepEqual((await readdir(join(fixture.barePath, 'objects'), { recursive: true })).sort(), before);
  await fixture.advanceMain(); assert.deepEqual(await observer.blame('R1', source.merge, source.path), result);
}, format));

test('empty text and binary, invalid encoding, oversized, symlink and gitlink targets remain distinct without invented origins', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const empty = await observer.blame('R1', fixture.head, 'docs/empty.txt'); assert.equal(empty.blob.state, 'text'); assert.deepEqual(empty.lines, []); assert.deepEqual(empty.commits, []);
  for (const [path, state] of [['binary.dat', 'binary'], ['invalid.txt', 'unsupported_encoding'], ['oversized.txt', 'oversized'], ['link', 'symlink'], ['module', 'submodule']] as const) {
    const result = await observer.blame('R1', fixture.head, path); assert.equal(result.blob.state, state); assert.equal(result.lines, null); assert.deepEqual(result.commits, []); assert.equal(Object.hasOwn(result.blob, 'content'), false);
  }
  await assert.rejects(observer.blame('R1', fixture.head, 'docs'), hasCode('GIT_OBJECT_UNAVAILABLE'));
  await assert.rejects(observer.blame('R1', fixture.head, 'link/secret'), hasCode('GIT_OBJECT_UNAVAILABLE'));
}));

test('literal LF splitting preserves blank lines, CR, BOM, whitespace and changes to the final LF', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const content of ['\n', '\n\n', '\r', '\r\n', '\ufeff\r\n\r\nlast', '  \t\n', 'unterminated']) {
    const source = await version(fixture, content); const result = await observer.blame('R1', source.commit, 'source.txt');
    assert.equal(result.blob.state, 'text'); if (result.blob.state === 'text') assert.equal(result.blob.content, content);
    assert.equal(result.lines?.length, content.split('\n').length - Number(content.endsWith('\n')));
  }
  const first = await version(fixture, 'same\nlast'), second = await version(fixture, 'same\nlast\n', [first.commit]), third = await version(fixture, 'same\nlast', [second.commit]);
  assert.deepEqual((await observer.blame('R1', second.commit, 'source.txt')).lines?.map(line => line.commitId), [first.commit, second.commit]);
  assert.deepEqual((await observer.blame('R1', third.commit, 'source.txt')).lines?.map(line => line.commitId), [first.commit, third.commit]);
  const whitespace = await version(fixture, 'same \nlast', [third.commit]);
  assert.equal((await observer.blame('R1', whitespace.commit, 'source.txt')).lines?.[0]?.commitId, whitespace.commit);
}));

test('C-quoted paths decode all Git control escapes and octal Unicode bytes literally', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const path of ['plain space.txt', ':(literal)\tname', 'a\x07\b\t\n\v\f\r"\\研究.txt', '\ufeffliteral.txt']) {
    const source = await version(fixture, 'literal\n', [], path), result = await observer.blame('R1', source.commit, path);
    assert.equal(result.blob.path, path); assert.equal(result.lines?.[0]?.path, path);
  }
}));

test('only full commit IDs and literal non-directory paths can select blame', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const id of ['HEAD', 'main', fixture.head.slice(0, 10), `${fixture.head}^`, '--help']) await assert.rejects(observer.blame('R1', id, 'README.md'), hasCode('GIT_INVALID_QUERY'));
  for (const path of ['', '/README.md', '../README.md', 'docs//paper.tex', 'README.md\0', 'x'.repeat(4097)]) await assert.rejects(observer.blame('R1', fixture.head, path), hasCode('GIT_INVALID_QUERY'));
  await assert.rejects(observer.blame('R1', fixture.readmeBlob, 'README.md'), hasCode('GIT_OBJECT_UNAVAILABLE'));
  await assert.rejects(observer.blame('R1', fixture.head, 'not-found'), hasCode('GIT_OBJECT_UNAVAILABLE'));
}));

test('target and historical blob limits fail the whole operation before any partial attribution is returned', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const huge = await version(fixture, Buffer.alloc(GIT_LIMITS.blameBlobBytes + 1, 65));
  await assert.rejects(observer.blame('R1', huge.commit, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
  const old = await version(fixture, 'kept\n' + 'x'.repeat(GIT_LIMITS.blameBlobBytes));
  const current = await version(fixture, 'kept\n', [old.commit]);
  await assert.rejects(observer.blame('R1', current.commit, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
  const tooMany = await version(fixture, '\n'.repeat(GIT_LIMITS.blameLines + 1));
  await assert.rejects(observer.blame('R1', tooMany.commit, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
  // A source within the logical-line limit can still exceed the independent
  // porcelain output bound. This is failure, never truncated attribution.
  const output = await version(fixture, 'line\n'.repeat(GIT_LIMITS.blameLines));
  await assert.rejects(observer.blame('R1', output.commit, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('origin count and combined distinct historical source bytes have independent complete-result limits', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  let parent: string | undefined, content = '';
  for (let index = 0; index <= GIT_LIMITS.blameOrigins; index += 1) {
    content += `Origin ${index}\n`; parent = (await version(fixture, content, parent ? [parent] : [])).commit;
  }
  await assert.rejects(observer.blame('R1', parent!, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
  parent = undefined; content = '';
  for (let index = 0; index < 9; index += 1) {
    content += `Retained ${index}\n`;
    parent = (await version(fixture, 'x'.repeat(7_500_000) + ` ${index}\n` + content, parent ? [parent] : [])).commit;
  }
  const small = await version(fixture, content, [parent!]);
  await assert.rejects(observer.blame('R1', small.commit, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('every attributed historical commit, tree and blob is hash verified and missing origins never become unknown lines', async () => fixtureTest(async fixture => {
  const source = await createGitBlameFixture(fixture), observer = createGitObserver({ R1: fixture.barePath });
  const root = await observer.blame('R1', source.root, source.originalPath);
  const cases = [
    { id: root.blob.objectId, type: 'blob', body: Buffer.from('Every old line was corrupted.\n') },
    { id: root.commit.id, type: 'commit', body: Buffer.from((await fixture.git(['cat-file', 'commit', root.commit.id])) + 'tampered') },
    { id: root.commit.treeId, type: 'tree', body: Buffer.alloc(0) },
  ];
  for (const item of cases) {
    const path = join(fixture.barePath, 'objects', item.id.slice(0, 2), item.id.slice(2)), original = await readFile(path);
    await chmod(path, 0o600); await writeFile(path, deflateSync(Buffer.concat([Buffer.from(`${item.type} ${item.body.length}\0`), item.body])));
    await assert.rejects(observer.blame('R1', source.merge, source.path), error => error instanceof HttpError && ['GIT_INVALID_OBJECT', 'GIT_OBJECT_UNAVAILABLE'].includes(error.code ?? ''));
    await writeFile(path, original);
  }
  const path = join(fixture.barePath, 'objects', source.root.slice(0, 2), source.root.slice(2)), original = await readFile(path); await rm(path);
  await assert.rejects(observer.blame('R1', source.merge, source.path), hasCode('GIT_OBJECT_UNAVAILABLE')); await writeFile(path, original);
  assert.equal((await observer.blame('R1', source.merge, source.path)).lines?.length, 7);
}));

test('blame shares deadline, queue and cancellation bounds and cannot execute repository diff configuration', async context => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const controllers = Array.from({ length: GIT_LIMITS.concurrency + GIT_LIMITS.queued }, () => new AbortController());
  const requests = controllers.map(controller => observer.blame('R1', fixture.head, 'README.md', controller.signal).catch(error => error));
  await assert.rejects(observer.blame('R1', fixture.head, 'README.md'), hasCode('GIT_BUSY'));
  controllers.forEach(controller => controller.abort()); assert.ok((await Promise.all(requests)).every(hasCode('GIT_ABORTED')));
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = observer.blame('R1', fixture.head, 'README.md'); const checked = assert.rejects(timeout, hasCode('GIT_LIMIT_EXCEEDED'));
  context.mock.timers.tick(GIT_LIMITS.timeoutMs); await checked; context.mock.timers.reset();
  assert.equal((await observer.blame('R1', fixture.base, 'README.md')).lines?.length, 2);
  const config = join(fixture.barePath, 'config'), original = await readFile(config), marker = join(fixture.root, 'must-not-execute');
  await writeFile(config, Buffer.concat([original, Buffer.from(`\n[diff "source"]\n textconv = touch ${marker}\n command = touch ${marker}\n`)]));
  await assert.rejects(observer.blame('R1', fixture.head, 'README.md'), hasCode('GIT_UNAVAILABLE')); await assert.rejects(readFile(marker), { code: 'ENOENT' });
}));


test('reachable unrelated files count toward verification limits while unreachable corrupt or oversized objects do not', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const huge = await version(fixture, Buffer.alloc(GIT_LIMITS.blameBlobBytes + 1, 66));
  const root = await version(fixture, 'small current source\n');
  const orphanPath = join(fixture.barePath, 'objects', huge.blob.slice(0, 2), huge.blob.slice(2));
  await writeFile(orphanPath, deflateSync(Buffer.from('blob 3\0bad')));
  assert.equal((await observer.blame('R1', root.commit, 'source.txt')).lines?.length, 1);
  // Restoring the oversized unreachable body still has no bearing on root.
  const hugeAgain = await version(fixture, Buffer.alloc(GIT_LIMITS.blameBlobBytes + 1, 66));
  assert.equal((await observer.blame('R1', root.commit, 'source.txt')).lines?.length, 1);
  // Reachability now makes that unrelated old source part of the integrity
  // boundary, even though this selected target has only one short line.
  const child = await version(fixture, 'small current source\n', [hugeAgain.commit]);
  await assert.rejects(observer.blame('R1', child.commit, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('reachable commit-count preflight is distinct from reported line origins', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }); let parent: string | undefined;
  for (let index = 0; index <= GIT_LIMITS.blameHistoryCommits; index += 1) parent = (await version(fixture, 'same single origin\n', parent ? [parent] : [])).commit;
  await assert.rejects(observer.blame('R1', parent!, 'source.txt'), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('streamed verification treats large binary bodies as bytes, accepts empty objects and never follows gitlinks', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }), selected = await version(fixture, 'selected\n');
  const fakeFrame = Buffer.from(`${selected.blob} blob 0\n\n\0embedded\n`), body = Buffer.concat(Array.from({ length: 20_000 }, () => fakeFrame));
  const binary = await object(fixture, 'blob', body), empty = await object(fixture, 'blob', Buffer.alloc(0));
  const tree = await object(fixture, 'tree', Buffer.concat([
    Buffer.from('100644 binary.dat\0'), Buffer.from(binary, 'hex'),
    Buffer.from('100644 empty.dat\0'), Buffer.from(empty, 'hex'),
    Buffer.from('160000 module\0'), Buffer.from('f'.repeat(fixture.objectFormat === 'sha1' ? 40 : 64), 'hex'),
    Buffer.from('100644 source.txt\0'), Buffer.from(selected.blob, 'hex'),
  ]));
  const metadata = (await fixture.git(['cat-file', 'commit', selected.commit])).replace(selected.tree, tree);
  const commit = await object(fixture, 'commit', Buffer.from(metadata));
  const result = await observer.blame('R1', commit, 'source.txt'); assert.equal(result.lines?.[0]?.commitId, commit);
  const path = join(fixture.barePath, 'objects', binary.slice(0, 2), binary.slice(2));
  body[body.length - 1] = body[body.length - 1]! ^ 1;
  await writeFile(path, deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])));
  // This file emits no blamed lines. Corrupting it still invalidates the
  // complete graph used to decide whether another file was renamed/copied.
  await assert.rejects(observer.blame('R1', commit, 'source.txt'), hasCode('GIT_INVALID_OBJECT'));
}));
