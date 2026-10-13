import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sourceSnapshotCanonical } from '../shared/source-snapshot.ts';
import { revisionPatchBaseline } from '../shared/revision-patch.ts';
import type { RevisionVersion, SourceFile } from '../shared/types.ts';
import { createGitFixture } from '../tests/git-fixture.ts';
import { createGitObserver } from './git.ts';
import { buildRevisionPatchTree, createRevisionPatchFromGitBase, resolveRevisionPatch, revisionPatchChanges, revisionPatchIdentity, revisionPatchObjectId, verifyRevisionPatch } from './revision-patch.ts';

function version(files: SourceFile[], number=1): RevisionVersion {
  return { id: `version-${number}`, revisionId: 'D1', number, files, contentHash: createHash('sha256').update(sourceSnapshotCanonical(files)).digest('hex'), message: 'Source snapshot', createdAt: '2026-10-13T00:00:00.000Z' };
}

for (const format of ['sha1', 'sha256'] as const) test(`revision patch verifies complete ${format} trees and preserves modes, bytes, deletions and additions`, async () => {
  const fixture = await createGitFixture(format);
  try {
    const snapshot = await createGitObserver({ R1: fixture.barePath }).importSnapshot('R1', fixture.importCommit);
    const baseline = { ...version(snapshot.files), gitSource: snapshot.provenance };
    assert.equal(buildRevisionPatchTree(snapshot.provenance.manifest, format).treeId, snapshot.provenance.treeId);
    const files = snapshot.files.filter(file => file.path !== 'name with spaces.md').map(file => ({ ...file, content: file.path === 'docs/paper.tex' ? '\\section{Revised}\r\nNo final newline' : file.content }));
    files.push({ path: 'new.tex', content: '\ufeffnew text\r\n' });
    const edited = version(files, 2), patch = resolveRevisionPatch('R1', [edited, baseline], edited.id, edited.contentHash);
    assert.deepEqual(verifyRevisionPatch(patch), patch);
    assert.equal(patch.baseVersionId, baseline.id); assert.equal(patch.baseCommitId, fixture.importCommit);
    assert.equal(patch.files.find(file => file.path === 'tools/check.sh')!.mode, '100755');
    assert.equal(patch.files.find(file => file.path === 'new.tex')!.mode, '100644');
    assert.equal(patch.files.find(file => file.path === 'docs/paper.tex')!.content, '\\section{Revised}\r\nNo final newline');
    assert.deepEqual(revisionPatchChanges(patch).map(change => [change.path, Boolean(change.before), Boolean(change.after)]), [['docs/paper.tex', true, true], ['name with spaces.md', true, false], ['new.tex', false, true]]);
    const expectedManifest = patch.files.map(file => ({ path: file.path, mode: file.mode, objectId: revisionPatchObjectId(format, 'blob', Buffer.from(file.content)) }));
    const target = buildRevisionPatchTree(expectedManifest, format);
    for (const file of patch.files) assert.equal((await fixture.git(['hash-object', '-w', '--stdin'], file.content)).trim(), expectedManifest.find(entry => entry.path === file.path)!.objectId);
    for (const object of target.objects) assert.equal((await fixture.git(['hash-object', '-t', 'tree', '-w', '--stdin'], object.bytes)).trim(), object.objectId);
    assert.equal(target.treeId, patch.targetTreeId);
    assert.equal((await fixture.git(['ls-tree', '-r', patch.targetTreeId])).includes('name with spaces.md'), false);
    assert.deepEqual(Object.keys(revisionPatchIdentity(patch)).sort(), ['revisionId','versionId','versionNumber','contentHash','baseVersionId','baseContentHash','baseCommitId','baseTreeId','targetTreeId','objectFormat','patchSha256'].sort());
  } finally { await fixture.close(); }
});

test('latest prior Git import is the immutable baseline; a selected import has zero changes', async () => {
  const fixture = await createGitFixture();
  try {
    const observer = createGitObserver({ R1: fixture.barePath });
    const before = await observer.importSnapshot('R1', fixture.importCommit), after = await observer.importSnapshot('R1', fixture.importNextCommit);
    const baseline = { ...version(before.files), gitSource: before.provenance }, imported = { ...version(after.files, 3), gitSource: after.provenance }, edited = version([...before.files, { path: 'v2.txt', content: 'second version' }], 2);
    assert.equal(resolveRevisionPatch('R1', [imported, edited, baseline], edited.id, edited.contentHash).baseVersionId, baseline.id);
    const patch = resolveRevisionPatch('R1', [baseline, imported], imported.id, imported.contentHash);
    assert.equal(patch.baseVersionId, imported.id); assert.equal(patch.targetTreeId, after.provenance.treeId); assert.deepEqual(revisionPatchChanges(patch), []);
    assert.equal(patch.files.find(file => file.path === 'tools/check.sh')!.mode, '100644');
    const changed = version([...after.files, { path: 'v4.txt', content: 'fourth version' }], 4);
    assert.equal(resolveRevisionPatch('R1', [baseline, changed, imported], changed.id, changed.contentHash).baseVersionId, imported.id);
    assert.equal(revisionPatchBaseline('R1', [baseline, changed, imported], changed.id).reason, null);
  } finally { await fixture.close(); }
});

test('paper and legal-text revision identifiers use the same verified patch contract', async () => {
  const fixture = await createGitFixture();
  try {
    const snapshot = await createGitObserver({ R1: fixture.barePath }).importSnapshot('R1', fixture.importCommit);
    for (const revisionId of ['P1', 'L1']) {
      const base = { ...version(snapshot.files), revisionId, gitSource: snapshot.provenance }, edited = { ...version([...snapshot.files, { path: 'new.tex', content: 'Reviewed text' }], 2), revisionId };
      const patch = resolveRevisionPatch('R1', [base, edited], edited.id, edited.contentHash);
      assert.equal(verifyRevisionPatch(patch).revisionId, revisionId);
    }
  } finally { await fixture.close(); }
});

test('explicit verified Git baseline produces an imported revision delta with exact target modes and tree', async () => {
  const fixture = await createGitFixture();
  try {
    const observer = createGitObserver({ R1: fixture.barePath }), before = await observer.importSnapshot('R1', fixture.base), after = await observer.importSnapshot('R1', fixture.importCommit);
    const target = { ...version(after.files), gitSource: after.provenance }, patch = createRevisionPatchFromGitBase('R1', target, before);
    assert.equal(patch.baseVersionId, null); assert.equal(patch.baseCommitId, fixture.base); assert.equal(patch.targetTreeId, after.provenance.treeId); assert.ok(revisionPatchChanges(patch).length > 1);
    assert.equal(patch.files.find(file => file.path === 'tools/check.sh')!.mode, '100755');
    const edited = version(after.files.map(file => ({ ...file, content: file.path === 'README.md' ? 'edited\n' : file.content })), 2);
    const explicit = createRevisionPatchFromGitBase('R1', edited, before, after.provenance.manifest);
    assert.equal(explicit.files.find(file => file.path === 'tools/check.sh')!.mode, '100755');
  } finally { await fixture.close(); }
});

test('patch resolution rejects missing origin, stale identities, tampered baseline and unsupported source', async () => {
  const fixture = await createGitFixture();
  try {
    const snapshot = await createGitObserver({ R1: fixture.barePath }).importSnapshot('R1', fixture.importCommit), baseline = { ...version(snapshot.files), gitSource: snapshot.provenance }, edited = version(snapshot.files, 2);
    assert.throws(() => resolveRevisionPatch('R1', [edited], edited.id, edited.contentHash), /could not be verified/);
    assert.throws(() => resolveRevisionPatch('R2', [baseline, edited], edited.id, edited.contentHash));
    assert.throws(() => resolveRevisionPatch('R1', [baseline, edited], edited.id, '0'.repeat(64)));
    for (const bad of [
      { ...baseline, contentHash: '0'.repeat(64) },
      { ...baseline, gitSource: { ...baseline.gitSource, treeId: 'f'.repeat(40) } },
      { ...baseline, gitSource: { ...baseline.gitSource, manifest: baseline.gitSource.manifest.map((entry, index) => index ? entry : { ...entry, objectId: 'f'.repeat(40) }) } },
      { ...baseline, gitSource: { ...baseline.gitSource, manifest: baseline.gitSource.manifest.map((entry, index) => index ? entry : { ...entry, mode: '100755' as const }) } },
    ]) assert.throws(() => resolveRevisionPatch('R1', [bad, edited], edited.id, edited.contentHash));
    const unsupported = { ...edited, assets: [{ path: 'figure.png', fileId: 'F1', sha256: 'a'.repeat(64), bytes: 5, mediaType: 'image/png' as const }] };
    assert.throws(() => resolveRevisionPatch('R1', [baseline, unsupported], edited.id, edited.contentHash));
    for (const files of [[{ path: '.git/config', content: 'unsafe' }], [{ path: 'dir/NUL.txt', content: 'unsafe' }], [{ path: 'foo', content: 'one' }, { path: 'foo/child', content: 'two' }], [{ path: 'file', content: '\0binary' }], [{ path: 'file', content: '\ud800' }]]) {
      const bad = version(files, 2); assert.throws(() => resolveRevisionPatch('R1', [baseline, bad], bad.id, bad.contentHash));
    }
  } finally { await fixture.close(); }
});

test('transport validation rejects changes to payload bytes, modes, paths and immutable pins', async () => {
  const fixture = await createGitFixture();
  try {
    const snapshot = await createGitObserver({ R1: fixture.barePath }).importSnapshot('R1', fixture.importCommit), baseline = { ...version(snapshot.files), gitSource: snapshot.provenance }, patch = resolveRevisionPatch('R1', [baseline], baseline.id, baseline.contentHash);
    for (const bad of [
      { ...patch, versionId: 'another-version' }, { ...patch, repositoryId: 'R2' }, { ...patch, baseContentHash: 'f'.repeat(64) }, { ...patch, targetTreeId: 'f'.repeat(40) }, { ...patch, patchSha256: 'f'.repeat(64) }, { ...patch, extra: true },
      { ...patch, files: patch.files.map((file, index) => index ? file : { ...file, content: 'changed' }) },
      { ...patch, files: patch.files.map((file, index) => index ? file : { ...file, mode: '100755' }) },
      { ...patch, files: patch.files.map((file, index) => index ? file : { ...file, path: '../escape' }) },
      { ...patch, baseManifest: patch.baseManifest.slice(1) },
    ]) assert.throws(() => verifyRevisionPatch(bad));
  } finally { await fixture.close(); }
});

test('tree construction follows bytewise Git ordering and rejects portable path collisions', async () => {
  const fixture = await createGitFixture();
  try {
    const blob = revisionPatchObjectId('sha1', 'blob', Buffer.from('contents')), input = ['a/z', 'a.txt', 'é.md', '中.txt', 'a-b', 'a0'].map(path => ({ path, mode: '100644' as const, objectId: blob })), tree = buildRevisionPatchTree(input, 'sha1');
    await fixture.git(['hash-object', '-w', '--stdin'], 'contents');
    for (const object of tree.objects) assert.equal((await fixture.git(['hash-object', '-t', 'tree', '-w', '--stdin'], object.bytes)).trim(), object.objectId);
    assert.deepEqual((await fixture.git(['ls-tree', '-r', '--name-only', '-z', tree.treeId])).split('\0').filter(Boolean), ['a-b','a.txt','a/z','a0','é.md','中.txt']);
    for (const paths of [['a', 'a/b'], ['A', 'a'], ['é/a', 'e\u0301/b'], ['straße', 'STRASSE'], ['dir/.git/config'], ['.gi\u200ct/config'], ['git~1/config'], ['space.']]) assert.throws(() => buildRevisionPatchTree(paths.map(path => ({ path, mode: '100644', objectId: blob })), 'sha1'));
  } finally { await fixture.close(); }
});
