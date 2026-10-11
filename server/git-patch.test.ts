import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { GIT_LIMITS } from '../shared/repositories.ts';
import type { GitPatch, GitComparisonQuery } from '../shared/repositories.ts';
import { createGitFixture, createGitComparisonFixture } from '../tests/git-fixture.ts';
import type { GitFixture } from '../tests/git-fixture.ts';
import { createGitObserver } from './git.ts';
import { HttpError } from './validation.ts';

const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
async function fixtureTest(work: (fixture: GitFixture) => Promise<void>, format: 'sha1' | 'sha256' = 'sha1') {
  const fixture = await createGitFixture(format); try { await work(fixture); } finally { await fixture.close(); }
}
const blob = async (fixture: GitFixture, content: string | Buffer) => (await fixture.git(['hash-object', '-w', '--stdin'], content)).trim();
async function commitRecords(fixture: GitFixture, records: string[]): Promise<string> {
  const tree = (await fixture.git(['mktree', '-z'], records.join(''))).trim();
  return (await fixture.git(['commit-tree', tree], 'Exact patch fixture\n')).trim();
}
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(directory, { recursive: true, withFileTypes: true }))) {
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); result[path.slice(directory.length + 1)] = createHash('sha256').update(await readFile(path)).digest('hex'); }
  }
  return result;
}
function patchBytes(patch: GitPatch): Buffer {
  const bytes = Buffer.from(patch.dataBase64, 'base64');
  assert.equal(bytes.toString('base64'), patch.dataBase64); assert.equal(bytes.length, patch.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), patch.sha256); assert.equal(patch.format, 'git-binary-patch-v1');
  return bytes;
}
async function applyExactly(fixture: GitFixture, patch: GitPatch): Promise<void> {
  // Deliberate writes are confined to this disposable TEST repository. The
  // observer itself is checked separately against a byte-for-byte snapshot.
  const bytes = patchBytes(patch);
  if (patch.baseCommit) await fixture.git(['read-tree', patch.baseTreeId]);
  else await fixture.git(['read-tree', '--empty']);
  if (bytes.length) await fixture.git(['apply', '--cached', '--binary', '--whitespace=nowarn'], bytes);
  assert.equal((await fixture.git(['write-tree'])).trim(), patch.targetTreeId);
}

for (const format of ['sha1', 'sha256'] as const) test(`${format} patches round-trip both directions with binary bytes, invalid UTF-8, rename/copy, mode/type changes and gitlinks`, async () => fixtureTest(async fixture => {
  const pair = await createGitComparisonFixture(fixture), observer = createGitObserver({ R1: fixture.barePath });
  const initial = await snapshot(fixture.barePath);
  const forward = await observer.patch('R1', pair), reverse = await observer.patch('R1', { base: pair.target, target: pair.base });
  assert.equal(forward.baseCommit?.id, pair.base); assert.equal(forward.targetCommit.id, pair.target);
  assert.equal(forward.objectFormat, format); assert.equal(forward.baseTreeId, forward.baseCommit!.treeId); assert.equal(forward.targetTreeId, forward.targetCommit.treeId);
  assert.deepEqual(await snapshot(fixture.barePath), initial, 'export never writes objects, refs or index in the operator binding');
  const raw = patchBytes(forward); assert.ok(raw.includes(Buffer.from('GIT binary patch\n')));
  assert.ok(raw.includes(Buffer.from('rename from rename-before.txt'))); assert.ok(raw.includes(Buffer.from('copy from copy-source.txt')));
  assert.ok(raw.includes(Buffer.from('old mode 100644\nnew mode 100755')));
  assert.ok(raw.includes(Buffer.from([0xc0, 0xaf])), 'raw text patch retains invalid UTF-8 bytes without string conversion');
  await applyExactly(fixture, forward); await applyExactly(fixture, reverse);
  assert.deepEqual(await observer.patch('R1', pair), forward, 'operator index and moving refs do not change an exact patch');
}, format));

for (const format of ['sha1', 'sha256'] as const) test(`${format} arbitrary, root, merge-parent and equal-tree patches preserve exact identities without an operator empty-tree object`, async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }), empty = createHash(format).update('tree 0\0').digest('hex');
  await rm(join(fixture.barePath, 'objects', empty.slice(0, 2), empty.slice(2)), { force: true });
  const initial = await snapshot(fixture.barePath);
  const root = await observer.patch('R1', { base: null, target: fixture.head });
  assert.equal(root.baseCommit, null); assert.equal(root.baseTreeId, empty);
  assert.deepEqual(await snapshot(fixture.barePath), initial);
  await applyExactly(fixture, root);
  const merge = (await observer.commit('R1', fixture.head)).commit;
  for (const base of [fixture.head, ...merge.parentIds, fixture.importCommit]) {
    const patch = await observer.patch('R1', { base, target: fixture.head }); await applyExactly(fixture, patch);
    if (patch.baseTreeId === patch.targetTreeId) { assert.equal(patch.bytes, 0); assert.equal(patch.dataBase64, ''); }
  }
  const equal = await observer.patch('R1', { base: fixture.importCommit, target: fixture.importEqualCommit });
  assert.equal(equal.bytes, 0); assert.notEqual(equal.baseCommit!.id, equal.targetCommit.id);
  const emptyCommit = await commitRecords(fixture, []);
  await applyExactly(fixture, await observer.patch('R1', { base: fixture.head, target: emptyCommit }));
  await applyExactly(fixture, await observer.patch('R1', { base: null, target: emptyCommit }));
}, format));

test('operator and committed attributes cannot suppress bytes, invoke filters or change patch output', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const attrs = await blob(fixture, '* -diff\n*.dat diff=forbidden\n*.txt diff\n'), binary = await blob(fixture, Buffer.from([0, 1, 2, 255]));
  const base = await commitRecords(fixture, [`100644 blob ${attrs}\t.gitattributes\0`, `100644 blob ${fixture.readmeBlob}\tbefore.txt\0`]);
  const target = await commitRecords(fixture, [`100644 blob ${attrs}\t.gitattributes\0`, `100644 blob ${binary}\tnew.dat\0`, `100644 blob ${await blob(fixture, 'changed\r\nno final newline')}\tbefore.txt\0`]);
  const query = { base, target }, original = await observer.patch('R1', query);
  await mkdir(join(fixture.barePath, 'info'), { recursive: true });
  await writeFile(join(fixture.barePath, 'info', 'attributes'), '* diff=forbidden\n*.dat diff\n*.txt -diff\n');
  assert.deepEqual(await observer.patch('R1', query), original);
  assert.ok(patchBytes(original).includes(Buffer.from('GIT binary patch\n')));
  await applyExactly(fixture, original);
  // An inherited index now contains committed attributes as well.
  assert.deepEqual(await observer.patch('R1', query), original);
  const marker = join(fixture.root, 'must-not-run'), config = join(fixture.barePath, 'config'), initial = await readFile(config);
  await writeFile(config, Buffer.concat([initial, Buffer.from(`\n[diff "forbidden"]\n command = touch ${marker}\n textconv = touch ${marker}\n`)]));
  await assert.rejects(observer.patch('R1', query), hasCode('GIT_UNAVAILABLE'));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
}));

test('binary modifications, symlink renames, gitlink edits and quoted filenames apply without decoding source bytes', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const binary = Buffer.alloc(1024); for (let index = 0; index < binary.length; index++) binary[index] = index % 256;
  const modified = Buffer.from(binary); modified[127] = 19;
  const oldBlob = await blob(fixture, binary), newBlob = await blob(fixture, modified), link = await blob(fixture, '../../outside-never-followed');
  const strange = 'quoted " unicode 研究\tline\nback\\slash.txt';
  const base = await commitRecords(fixture, [`100644 blob ${oldBlob}\tbinary\0`, `120000 blob ${link}\told-link\0`, `160000 commit ${fixture.base}\tmodule\0`, `100644 blob ${await blob(fixture, '\ufefforiginal\r\nlast')}\t${strange}\0`]);
  const target = await commitRecords(fixture, [`100644 blob ${newBlob}\tbinary\0`, `120000 blob ${link}\tnew-link\0`, `160000 commit ${fixture.head}\tmodule\0`, `100644 blob ${await blob(fixture, '\ufeffchanged\r\nlast\n')}\t${strange}\0`]);
  for (const query of [{ base, target }, { base: target, target: base }]) {
    const patch = await observer.patch('R1', query), bytes = patchBytes(patch);
    assert.ok(bytes.includes(Buffer.from('GIT binary patch\n'))); assert.ok(bytes.includes(Buffer.from('rename from old-link')) || bytes.includes(Buffer.from('rename from new-link')));
    assert.ok(bytes.includes(Buffer.from('Subproject commit '))); assert.ok(bytes.includes(Buffer.from('\\nback\\\\slash.txt')));
    await applyExactly(fixture, patch);
  }
}));

test('explicit empty subdirectories fail even when unchanged, and unsafe index paths are never emitted as successful patches', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath }), empty = (await fixture.git(['mktree', '-z'], '')).trim();
  const base = await commitRecords(fixture, [`040000 tree ${empty}\tunchanged-empty\0`]);
  const target = await commitRecords(fixture, [`040000 tree ${empty}\tunchanged-empty\0`, `100644 blob ${fixture.readmeBlob}\tadded\0`]);
  for (const query of [{ base, target }, { base, target: base }, { base: null, target }]) await assert.rejects(observer.patch('R1', query), hasCode('GIT_PATCH_UNREPRESENTABLE'));
  const unsafe = await commitRecords(fixture, [`100644 blob ${fixture.readmeBlob}\t.git\0`]);
  await assert.rejects(observer.patch('R1', { base: null, target: unsafe }), hasCode('GIT_PATCH_UNREPRESENTABLE'));
}));

test('unchanged blob bodies are not copied or admitted to changed-source limits, while all tree metadata is verified', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const huge = await blob(fixture, Buffer.alloc(GIT_LIMITS.comparisonBlobBytes + 1, 65));
  const subtree = (await fixture.git(['mktree', '-z'], `100644 blob ${huge}\tlarge\0`)).trim();
  const base = await commitRecords(fixture, [`040000 tree ${subtree}\tunchanged\0`]);
  const target = await commitRecords(fixture, [`040000 tree ${subtree}\tunchanged\0`, `100644 blob ${fixture.readmeBlob}\tadded\0`]);
  await applyExactly(fixture, await observer.patch('R1', { base, target }));
  const path = join(fixture.barePath, 'objects', subtree.slice(0, 2), subtree.slice(2));
  await chmod(path, 0o600); await writeFile(path, deflateSync(Buffer.from('tree 0\0')));
  await assert.rejects(observer.patch('R1', { base, target }), hasCode('GIT_INVALID_OBJECT'));
}));

test('corrupted changed source bodies and selected commit metadata reject the complete export', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const content = await blob(fixture, Buffer.from([0, 255, 7])), target = await commitRecords(fixture, [`100644 blob ${content}\tdata\0`]);
  const path = join(fixture.barePath, 'objects', content.slice(0, 2), content.slice(2)), original = await readFile(path);
  await chmod(path, 0o600); await writeFile(path, deflateSync(Buffer.from('blob 3\0BAD')));
  await assert.rejects(observer.patch('R1', { base: null, target }), hasCode('GIT_INVALID_OBJECT')); await writeFile(path, original);
  const commitPath = join(fixture.barePath, 'objects', target.slice(0, 2), target.slice(2));
  await chmod(commitPath, 0o600); await writeFile(commitPath, deflateSync(Buffer.from('commit 0\0')));
  await assert.rejects(observer.patch('R1', { base: null, target }), hasCode('GIT_INVALID_OBJECT'));
}));

test('patch output and changed-source limits reject rather than truncate a valid prefix', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const length = GIT_LIMITS.patchBytes / 2 + 1000;
  const base = await commitRecords(fixture, [`100644 blob ${await blob(fixture, Buffer.alloc(length, 65))}\tlarge\0`]);
  const target = await commitRecords(fixture, [`100644 blob ${await blob(fixture, Buffer.alloc(length, 66))}\tlarge\0`]);
  await assert.rejects(observer.patch('R1', { base, target }), hasCode('GIT_LIMIT_EXCEEDED'));
  const huge = await commitRecords(fixture, [`100644 blob ${await blob(fixture, Buffer.alloc(GIT_LIMITS.comparisonBlobBytes + 1, 65))}\tlarge\0`]);
  await assert.rejects(observer.patch('R1', { base: null, target: huge }), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('complete unchanged tree traversal is bounded independently of the changed-path inventory', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  const leaf = (await fixture.git(['mktree', '-z'], Array.from({ length: 1000 }, (_, index) => `100644 blob ${fixture.readmeBlob}\tf${index}\0`).join(''))).trim();
  const records = Array.from({ length: 21 }, (_, index) => `040000 tree ${leaf}\td${index}\0`);
  const base = await commitRecords(fixture, records), target = await commitRecords(fixture, [...records, `100644 blob ${fixture.readmeBlob}\tadded\0`]);
  await assert.rejects(observer.patch('R1', { base, target }), hasCode('GIT_LIMIT_EXCEEDED'));
}));

test('invalid selectors and cancellation never produce a successful empty patch', async () => fixtureTest(async fixture => {
  const observer = createGitObserver({ R1: fixture.barePath });
  for (const query of [null, {}, { base: 'HEAD', target: fixture.head }, { base: null, target: 42 }]) await assert.rejects(observer.patch('R1', query as GitComparisonQuery), hasCode('GIT_INVALID_QUERY'));
  await assert.rejects(observer.patch('R1', { base: null, target: fixture.readmeBlob }), hasCode('GIT_OBJECT_UNAVAILABLE'));
  const controller = new AbortController(), pending = observer.patch('R1', { base: null, target: fixture.head }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(pending, hasCode('GIT_ABORTED')); } finally { clearTimeout(timer); }
  assert.ok((await observer.patch('R1', { base: null, target: fixture.base })).bytes > 0);
}));
