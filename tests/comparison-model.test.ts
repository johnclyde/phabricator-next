import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonIdentity, comparisonMetadata, comparisonPaths, defaultComparison, isComparisonSelection, resolveComparison, versionIdentity, type ComparisonSelection } from '../client/comparison-model.ts';
import type { RevisionDetail, RevisionKind, RevisionVersion, SourceFile } from '../shared/types.ts';

function version(number: number, files: SourceFile[], revisionId = 'P1'): RevisionVersion {
  return { id: `immutable-${revisionId}-${number}`, revisionId, number, files, contentHash: String(number).repeat(64), message: `Version ${number}`, createdAt: '2026-10-10T00:00:00.000Z' };
}
const first = version(1, [{ path: 'paper.tex', content: 'First exact source.\r\n' }, { path: 'removed.txt', content: 'Deleted source.' }, { path: 'empty.txt', content: '' }]);
const second = version(2, [{ path: 'paper.tex', content: 'Second exact source.\n' }, { path: 'added.txt', content: 'Added source.' }, { path: 'empty.txt', content: '' }]);
function detail(versions: RevisionVersion[] = [first, second], currentVersion = 2, kind: RevisionKind = 'paper'): RevisionDetail {
  return { revision: { id: 'P1', title: 'Paper', summary: '', kind, status: 'needs_review', repositoryId: null, projectId: null, currentVersion, createdAt: '', updatedAt: '' }, versions, comments: [], threads: [], threadEvents: [], suggestionApplications: [], reviews: [], activity: [] };
}
function selection(): ComparisonSelection {
  return { revisionId: 'P1', base: versionIdentity(first), target: versionIdentity(second), filePath: 'paper.tex', mode: 'words', view: 'changes' };
}
function expectUnavailable(result: ReturnType<typeof resolveComparison>, reason: RegExp): void {
  assert.ok('error' in result, 'unavailable selections must not silently fall back to another version or file');
  assert.match(result.error, reason);
}

test('comparison identities contain only the immutable ID and hash, independent of display number', () => {
  assert.deepEqual(versionIdentity(second), { id: second.id, contentHash: second.contentHash });
  const identity = versionIdentity(second);
  identity.id = 'changed locally';
  assert.equal(second.id, 'immutable-P1-2', 'selection metadata must not mutate the source snapshot');
  const saved = selection();
  const before = structuredClone(saved);
  const latest = version(3, [{ path: 'latest-only.txt', content: 'New head.' }]);
  assert.deepEqual(resolveComparison(detail([latest, first, second], 3), saved), { base: first, target: second });
  assert.deepEqual(saved, before, 'a head refresh cannot rewrite the selected pair or file');
  assert.equal(comparisonIdentity(saved), comparisonIdentity({ ...saved, base: { contentHash: saved.base!.contentHash, id: saved.base!.id, ignored: 'extra' }, target: { contentHash: saved.target.contentHash, id: saved.target.id, ignored: 'extra' } } as ComparisonSelection), 'context identity ignores property order and untrusted extra fields');
});

test('initial selection uses the stated head and immediate predecessor, with kind-appropriate literal mode', () => {
  for (const kind of ['paper', 'document', 'code'] as const) {
    const initial = defaultComparison(detail([second, first], 2, kind));
    assert.deepEqual(initial, { ...selection(), mode: kind === 'code' ? 'lines' : 'words' });
  }
  assert.deepEqual(defaultComparison(detail([first], 1)), { ...selection(), base: null, target: versionIdentity(first), view: 'preview' });
  for (const kind of ['document', 'code'] as const) assert.equal(defaultComparison(detail([first], 1, kind))?.view, 'changes');
  assert.equal(defaultComparison(detail([second], 2))?.view, 'changes', 'a missing predecessor must not disguise a later version as an initial reading view');
  assert.equal(defaultComparison(detail([first], 2)), null, 'missing head must not silently use the last array entry');
});

test('reverse, equal, and explicitly empty base pairs resolve without ordering or latest-version substitution', () => {
  const source = detail();
  const forward = selection();
  assert.deepEqual(resolveComparison(source, { ...forward, base: forward.target, target: forward.base! }), { base: second, target: first });
  assert.deepEqual(resolveComparison(source, { ...forward, base: forward.target }), { base: second, target: second });
  assert.deepEqual(resolveComparison(source, { ...forward, base: null }), { base: null, target: second });
  assert.deepEqual(resolveComparison(source, { ...forward, base: null, target: forward.base! }), { base: null, target: first });
});

test('missing identities, foreign revisions, and changed snapshot hashes produce explicit errors on either side', () => {
  const source = detail();
  const saved = selection();
  for (const side of ['base', 'target'] as const) {
    const original = saved[side]!;
    expectUnavailable(resolveComparison(source, { ...saved, [side]: { ...original, id: 'missing' } }), /version|snapshot/i);
    expectUnavailable(resolveComparison(source, { ...saved, [side]: { ...original, contentHash: 'f'.repeat(64) } }), /version|snapshot/i);
    const altered = source.versions.map(item => item.id === original.id ? { ...item, contentHash: 'e'.repeat(64) } : item);
    expectUnavailable(resolveComparison(detail(altered), saved), /version|snapshot/i);
    const foreign = source.versions.map(item => item.id === original.id ? { ...item, revisionId: 'P2' } : item);
    expectUnavailable(resolveComparison(detail(foreign), saved), /version|snapshot/i);
  }
  expectUnavailable(resolveComparison(source, { ...saved, revisionId: 'P2' }), /version|snapshot/i);
  const foreign = version(1, first.files, 'P2');
  expectUnavailable(resolveComparison(source, { ...saved, target: versionIdentity(foreign) }), /version|snapshot/i);
});

test('added, deleted, and empty files remain selectable in the exact union without searching another path', () => {
  const source = detail();
  assert.deepEqual(comparisonPaths(first, second), ['paper.tex', 'added.txt', 'empty.txt', 'removed.txt']);
  assert.deepEqual(comparisonPaths(null, second), ['paper.tex', 'added.txt', 'empty.txt']);
  for (const filePath of ['added.txt', 'removed.txt', 'empty.txt']) {
    const resolved = resolveComparison(source, { ...selection(), filePath });
    assert.ok(!('error' in resolved));
    assert.equal(resolved.base, first);
    assert.equal(resolved.target, second);
  }
  expectUnavailable(resolveComparison(source, { ...selection(), filePath: 'missing.txt' }), /file/i);
  expectUnavailable(resolveComparison(source, { ...selection(), filePath: 'Paper.tex' }), /file/i);
  expectUnavailable(resolveComparison(source, { ...selection(), base: null, filePath: 'removed.txt' }), /file/i);
  expectUnavailable(resolveComparison(source, { ...selection(), base: versionIdentity(second), filePath: 'removed.txt' }), /file/i);
});

test('metadata serialization whitelists presentation and identities, never nested source or speech text', () => {
  const saved = selection();
  const supplied = { ...saved, content: 'private source', segments: [{ text: 'private excerpt' }], speech: 'private speech', base: { ...saved.base!, files: first.files, message: first.message }, target: { ...saved.target, content: second.files[0]!.content, number: 2 } };
  const record = comparisonMetadata(supplied);
  assert.deepEqual(record, saved);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), saved);
  assert.deepEqual(Object.keys(record), ['revisionId', 'base', 'target', 'filePath', 'mode', 'view']);
  assert.deepEqual(Object.keys(record.base!), ['id', 'contentHash']);
  assert.deepEqual(Object.keys(record.target), ['id', 'contentHash']);
  supplied.base.id = 'mutated'; supplied.target.contentHash = 'mutated';
  assert.deepEqual(record, saved, 'stored identities must be independent copies');
  assert.deepEqual(comparisonMetadata({ ...saved, base: null }), { ...saved, base: null });
});

test('shape validation rejects malformed stored records instead of coercing enums or empty identities', () => {
  const saved = selection();
  assert.equal(isComparisonSelection(JSON.parse(JSON.stringify(saved)), 'P1'), true);
  assert.equal(isComparisonSelection({ ...saved, base: null, mode: 'lines', view: 'source' }, 'P1'), true);
  assert.equal(isComparisonSelection({ ...saved, view: 'structure' }, 'P1'), true);
  assert.equal(isComparisonSelection({ ...saved, view: 'preview' }, 'P1'), true);
  const invalid: unknown[] = [null, undefined, false, 1, 'selection', [], {},
    { ...saved, revisionId: 'P2' }, { ...saved, base: undefined }, { ...saved, target: null },
    { ...saved, target: { id: second.id } }, { ...saved, target: { id: '', contentHash: second.contentHash } },
    { ...saved, target: { id: second.id, contentHash: '' } }, { ...saved, base: { id: first.id, contentHash: 1 } },
    { ...saved, filePath: null }, { ...saved, filePath: '' }, { ...saved, mode: 'semantic' },
    { ...saved, mode: ['words'] }, { ...saved, view: ['changes'] }, { ...saved, view: 'rendered-diff' },
  ];
  for (const value of invalid) assert.equal(isComparisonSelection(value, 'P1'), false, JSON.stringify(value));
});

test('navigation preference is optional for old metadata and accepts only a boolean without copying source', () => {
  const legacy = selection();
  assert.equal(isComparisonSelection(legacy, 'P1'), true);
  assert.equal(Boolean(legacy.skipSpaceTabOnly), false);
  for (const flag of [true, false]) {
    const selected = { ...legacy, skipSpaceTabOnly: flag };
    assert.equal(isComparisonSelection(selected, 'P1'), true);
    assert.deepEqual(comparisonMetadata({ ...selected, source: 'excluded' } as ComparisonSelection), selected);
  }
  for (const flag of [null, 0, 1, 'true', [], {}]) assert.equal(isComparisonSelection({ ...legacy, skipSpaceTabOnly: flag }, 'P1'), false);
});

test('paragraph alignment is an optional boolean whose saved record excludes computed matches and source', () => {
  const legacy = selection();
  assert.equal(Object.hasOwn(defaultComparison(detail())!, 'paragraphAlignment'), false, 'old and new default comparisons remain literal');
  assert.equal(isComparisonSelection(legacy, 'P1'), true);
  assert.equal(comparisonIdentity(legacy), comparisonIdentity({ ...legacy, paragraphAlignment: false }));
  assert.notEqual(comparisonIdentity(legacy), comparisonIdentity({ ...legacy, paragraphAlignment: true }), 'changing alignment retires the old reading context');
  for (const flag of [true, false]) {
    const selected = { ...legacy, paragraphAlignment: flag, skipSpaceTabOnly: true };
    const supplied = {
      ...selected, source: 'Private manuscript text', reordered: [{ before: { start: 0, end: 8 }, quote: 'Private paragraph' }],
      renderedStructure: 'Not source evidence', speech: 'Private narration',
      base: { ...selected.base!, files: first.files }, target: { ...selected.target, files: second.files },
    };
    const saved = comparisonMetadata(supplied), restored: unknown = JSON.parse(JSON.stringify(saved));
    assert.deepEqual(restored, selected);
    assert.equal(isComparisonSelection(restored, 'P1'), true);
    assert.deepEqual(Object.keys(saved).sort(), ['revisionId', 'base', 'target', 'filePath', 'mode', 'view', 'skipSpaceTabOnly', 'paragraphAlignment'].sort());
    assert.deepEqual(Object.keys(saved.base!).sort(), ['contentHash', 'id']);
    assert.deepEqual(Object.keys(saved.target).sort(), ['contentHash', 'id']);
    supplied.base.id = 'later change'; supplied.target.contentHash = 'later change';
    assert.deepEqual(saved, selected, 'the saved record owns copies of both exact pins');
  }
  for (const flag of [null, 0, 1, 'true', 'false', [], {}, new Boolean(true)]) {
    assert.equal(isComparisonSelection({ ...legacy, paragraphAlignment: flag }, 'P1'), false, `Do not coerce ${String(flag)} into a reading preference.`);
  }
});

test('restoring paragraph alignment retains the exact arbitrary pair and never repairs missing source pins', () => {
  const latest = version(3, [{ path: 'newest.tex', content: 'A different current manuscript.' }]);
  const refreshed = detail([latest, first, second], 3);
  const selected = { ...selection(), paragraphAlignment: true };
  for (const [base, target] of [[first, second], [second, first], [second, second], [null, first]] as const) {
    const restored = comparisonMetadata({ ...selected, base: base && versionIdentity(base), target: versionIdentity(target) });
    const original = structuredClone(restored);
    assert.deepEqual(resolveComparison(refreshed, restored), { base, target });
    assert.deepEqual(restored, original);
    assert.equal(restored.paragraphAlignment, true);
  }
  const persisted = comparisonMetadata({ ...selected, mode: 'lines', view: 'source', filePath: 'removed.txt' });
  assert.equal(persisted.paragraphAlignment, true, 'temporarily choosing another presentation does not erase the opt-in preference');
  assert.deepEqual(resolveComparison(refreshed, persisted), { base: first, target: second });
  expectUnavailable(resolveComparison(detail([latest, second], 3), selected), /version|snapshot/i);
  expectUnavailable(resolveComparison(refreshed, { ...selected, target: { ...selected.target, contentHash: 'changed' } }), /version|snapshot/i);
});
