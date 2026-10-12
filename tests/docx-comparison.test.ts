import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareDocxScope, DOCX_COMPARISON_LIMITS, DOCX_COMPARISON_NOTICE, DOCX_COMPARISON_SEPARATORS, docxComparisonScopes, projectDocxComparison, type DocxComparisonProjection, type ReadyDocxComparisonProjection } from '../shared/docx-comparison.ts';
import { COMPARISON_LIMITS, type ReadyComparison } from '../shared/comparison.ts';
import { defaultDocxComparison, docxComparisonIdentity, docxComparisonMetadata, docxVersionIdentity, isDocxComparisonSelection, resolveDocxComparison, type DocxComparisonSelection } from '../client/docx-comparison-model.ts';
import type { DocxBlock, DocxProjection, DocxRun } from '../shared/docx.ts';
import type { RevisionDetail, RevisionVersion } from '../shared/types.ts';
import { inspectDocx, replaceDocx } from '../server/docx-package.ts';

const block = (id: string, runs: DocxRun[], part = 'word/document.xml'): DocxBlock => ({ id, part, kind: 'paragraph', runs, text: 'This field must not be used.' });
const projection = (blocks: DocxBlock[] = [], patch: Partial<DocxProjection> = {}): DocxProjection => ({ format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks, notes: [], comments: [], changes: [], editableRanges: [], warnings: [], ...patch });
const projected = (value: DocxProjection): ReadyDocxComparisonProjection => ready(projectDocxComparison(value));
function ready(value: DocxComparisonProjection): ReadyDocxComparisonProjection { if (value.status !== 'ready') assert.fail(value.message); return value; }
function compared(before: ReadyDocxComparisonProjection | null, after: ReadyDocxComparisonProjection, scope: 'document' | 'footnotes' | 'endnotes' = 'document', mode: 'words' | 'lines' = 'words'): ReadyComparison {
  const result = compareDocxScope(before, after, scope, mode); if (result.status !== 'ready') assert.fail(result.reason);
  assert.equal(result.segments.filter(segment => segment.kind !== 'added').map(segment => segment.text).join(''), before?.scopes[scope]?.file.content ?? '');
  assert.equal(result.segments.filter(segment => segment.kind !== 'removed').map(segment => segment.text).join(''), after.scopes[scope]?.file.content ?? '');
  return result;
}
function version(number: number, value = projection([block('block', [{ text: `Version ${number}.` }])]), packageHash = number.toString(16).repeat(64)): RevisionVersion {
  return { id: `version-${number}`, revisionId: 'L1', number, files: [], message: '', createdAt: '', contentHash: number.toString(16).repeat(64), docx: { format: 'docx', fileName: 'motion.docx', sha256: packageHash, bytes: 100, sourceFile: { fileId: 'F1', sha256: 'a'.repeat(64), bytes: 100 }, projection: value } };
}
function detail(versions = [version(1), version(2)], currentVersion = 2): RevisionDetail {
  return { revision: { id: 'L1', title: 'Motion', summary: '', kind: 'document', status: 'needs_review', repositoryId: null, projectId: null, currentVersion, createdAt: '', updatedAt: '' }, versions, comments: [], threads: [], threadEvents: [], suggestionApplications: [], reviews: [], activity: [] };
}
function selection(value = detail()): DocxComparisonSelection { const selected = defaultDocxComparison(value); assert.ok(selected); return selected; }

test('stored runs determine projected text; deleted and move-from are omitted without reading block.text', () => {
  const source = block('p1', [{ text: 'A ' }, { text: 'removed ', change: 'deleted' }, { text: 'new ', change: 'inserted' }, { text: 'old location ', change: 'moveFrom' }, { text: 'new location', change: 'moveTo' }]);
  Object.defineProperty(source, 'text', { get() { throw new Error('block.text includes deleted content'); } });
  const result = projected(projection([source]));
  assert.equal(result.scopes.document!.file.content, 'A new new location');
  assert.deepEqual(result.scopes.document!.boundaries, [{ kind: 'block', id: 'p1', start: 0, end: 18 }]);
  assert.deepEqual(result.warnings, [DOCX_COMPARISON_NOTICE, DOCX_COMPARISON_SEPARATORS]);
  assert.match(result.warnings[0]!, /outer, row or paragraph-mark revisions/);
  assert.match(result.warnings[0]!, /not Word’s complete accepted or final text/);
});

test('literal whitespace and Unicode remain exact, including run boundaries and synthetic LF between blocks', () => {
  const text = '\t café 😀 e\u0301\r\n\u00a0\u2003';
  const result = projected(projection([block('p1', [{ text: text.slice(0, 8) }, { text: text.slice(8) }]), block('p2', []), block('p3', [{ text: '\n final\t' }])]));
  assert.equal(result.scopes.document!.file.content, text + '\n\n\n final\t');
  assert.deepEqual(result.scopes.document!.boundaries.map(item => result.scopes.document!.file.content.slice(item.start, item.end)), [text, '', '\n final\t']);
  const newer = projected(projection([block('p1', [{ text: ' cafe 😃 é\n\u00a0\u2003' }])]));
  assert.ok(compared(result, newer).passages.length);
  assert.ok(compared(result, newer, 'document', 'lines').passages.length);
});

test('all stored blocks and note blocks participate beyond reader display slices', () => {
  const blocks = Array.from({ length: 2_001 }, (_, index) => block(`p${index}`, [{ text: index === 2_000 ? 'last document' : '' }]));
  const notes = Array.from({ length: 201 }, (_, index) => ({ id: `footnote:${index}`, kind: 'footnote' as const, blocks: [block(`n${index}`, [{ text: index === 200 ? 'last note' : '' }], 'word/footnotes.xml')] }));
  const result = projected(projection(blocks, { notes }));
  assert.ok(result.scopes.document!.file.content.endsWith('last document'));
  assert.ok(result.scopes.footnotes!.file.content.endsWith('last note'));
  assert.equal(result.scopes.document!.boundaries.length, 2_001);
  assert.equal(result.scopes.footnotes!.boundaries.filter(item => item.kind === 'note').length, 201);
});

test('note scopes preserve exact IDs/order and boundaries, including empty and separator notes', () => {
  const result = projected(projection([], { notes: [
    { id: 'footnote:9', kind: 'footnote', blocks: [block('n9', [{ text: 'Nine.\t' }], 'word/footnotes.xml')] },
    { id: 'endnote:3', kind: 'endnote', blocks: [block('e3', [{ text: 'End.' }], 'word/endnotes.xml')] },
    { id: 'footnote:-1', kind: 'footnote', blocks: [] },
    { id: 'footnote:2', kind: 'footnote', blocks: [block('n2', [], 'word/footnotes.xml')] },
  ] }));
  assert.equal(result.scopes.footnotes!.file.content, '[Footnote ID: footnote:9]\nNine.\t\n\n[Footnote ID: footnote:-1]\n\n[Footnote ID: footnote:2]\n');
  assert.equal(result.scopes.endnotes!.file.content, '[Endnote ID: endnote:3]\nEnd.');
  assert.deepEqual(result.scopes.footnotes!.boundaries.filter(item => item.kind === 'note').map(item => item.id), ['footnote:9', 'footnote:-1', 'footnote:2']);
  for (const scope of Object.values(result.scopes)) for (const boundary of scope?.boundaries ?? []) assert.ok(boundary.start >= 0 && boundary.end >= boundary.start && boundary.end <= scope!.file.content.length);
});

test('empty-text note reference changes remain visible; deleted references disappear and IDs are not renumbered', () => {
  const before = projected(projection([block('p1', [{ text: 'Claim' }, { text: '', noteId: 'footnote:2' }, { text: '', noteId: 'endnote:8', change: 'deleted' }])]));
  const after = projected(projection([block('p1', [{ text: 'Claim' }, { text: '', noteId: 'footnote:3', change: 'inserted' }])]));
  assert.equal(before.scopes.document!.file.content, 'Claim[Note reference: footnote:2]');
  assert.deepEqual(before.scopes.document!.boundaries[0], { kind: 'reference', id: 'footnote:2', start: 5, end: 33 });
  assert.ok(compared(before, after).passages.length);
  const note = (id: string) => projected(projection([], { notes: [{ id, kind: 'footnote', blocks: [block('n', [{ text: 'Same note body.' }], 'word/footnotes.xml')] }] }));
  assert.ok(compared(note('footnote:2'), note('footnote:3'), 'footnotes').passages.length);
});

test('absent scopes are distinct from an existing empty document or empty note body', () => {
  const empty = projected(projection()), withNote = projected(projection([], { notes: [{ id: 'footnote:2', kind: 'footnote', blocks: [] }] }));
  assert.equal(empty.scopes.document!.file.content, ''); assert.equal(empty.scopes.footnotes, null);
  assert.deepEqual(docxComparisonScopes(empty, withNote), ['document', 'footnotes']);
  assert.equal(compared(null, empty).fileChange, 'added');
  assert.equal(compared(empty, empty).fileChange, 'unchanged');
  assert.equal(compared(empty, withNote, 'footnotes').fileChange, 'added');
  assert.equal(compared(withNote, empty, 'footnotes').fileChange, 'removed');
  assert.throws(() => compareDocxScope(empty, empty, 'footnotes'), /at least one/);
});

test('projection warnings survive exactly; returned scopes never alias source structures', () => {
  const source = projection([block('p1', [{ text: 'Exact source' }])], { warnings: ['Opaque Word field: keep exact.', ''] });
  const original = structuredClone(source), result = projected(source);
  assert.deepEqual(result.warnings.slice(2), source.warnings);
  result.scopes.document!.file.content = 'Mutated result'; result.scopes.document!.boundaries[0]!.id = 'changed'; result.warnings[2] = 'changed';
  assert.deepEqual(source, original);
});

test('unsupported, incomplete, contradictory and cyclic projection shapes fail atomically', () => {
  const cases: unknown[] = [null, { format: 'phabricator.docx.projection.v2' }, projection([block('p1', [{ text: 'ok', change: 'rejected' } as unknown as DocxRun])]), projection([block('same', []), block('same', [])]), projection([], { notes: [{ id: 'duplicate', kind: 'footnote', blocks: [] }, { id: 'duplicate', kind: 'endnote', blocks: [] }] })];
  const noRuns = block('p', []); Reflect.deleteProperty(noRuns, 'runs'); cases.push(projection([noRuns]));
  const circular = block('p', []); circular.runs.push({ text: circular as unknown as string }); cases.push(projection([circular]));
  for (const item of cases) { const result = projectDocxComparison(item); assert.equal(result.status, 'unavailable'); assert.equal('scopes' in result, false); }
});

test('whole-projection bounds reject large or invisible input without partial scopes', () => {
  const { maxRuns, maxBlocks, maxNotes, maxWarnings, maxOutputCodeUnits, maxSourceCodeUnits } = DOCX_COMPARISON_LIMITS;
  const cases = [
    projection(Array.from({ length: maxBlocks + 1 }, (_, index) => block(String(index), []))),
    projection([block('p', Array.from({ length: maxRuns + 1 }, () => ({ text: '', change: 'deleted' as const })))]),
    projection([], { notes: Array.from({ length: maxNotes + 1 }, (_, index) => ({ id: String(index), kind: 'footnote', blocks: [] })) }),
    projection([], { warnings: Array(maxWarnings + 1).fill('') as string[] }),
    projection([block('p', [{ text: 'x'.repeat(maxOutputCodeUnits + 1) }])]),
    projection([block('p', [{ text: 'x'.repeat(maxSourceCodeUnits + 1), change: 'deleted' }])]),
    projection([block('p', [{ text: '', noteId: 'x'.repeat(4_001) }])]),
  ];
  for (const item of cases) { const result = projectDocxComparison(item); assert.equal(result.status, 'unavailable'); assert.equal(result.status === 'unavailable' && result.reason, 'projection_limit'); assert.equal('scopes' in result, false); }
});

test('literal comparison ceilings remain in effect after admissible projection and are never expanded', () => {
  const text = projected(projection([block('p', [{ text: 'x'.repeat(100_001) }])]));
  const result = compareDocxScope(text, text, 'document'); assert.equal(result.status, 'too_large');
  assert.equal(result.status === 'too_large' && result.reason, 'input_code_units'); assert.equal('segments' in result, false);
  assert.throws(() => compareDocxScope(text, text, 'document', 'words', { maxInputCodeUnits: COMPARISON_LIMITS.maxInputCodeUnits + 1 }), RangeError);
});

test('default honors an explicitly selected reader version and requires the exact numeric predecessor', () => {
  const first = version(1), second = version(2), third = version(3), data = detail([third, first, second], 3);
  assert.deepEqual(defaultDocxComparison(data, docxVersionIdentity(second)), { revisionId: 'L1', base: docxVersionIdentity(first), target: docxVersionIdentity(second), filePath: 'document', mode: 'words', view: 'changes' });
  assert.equal(defaultDocxComparison(data, null), null);
  assert.equal(defaultDocxComparison(data, { ...docxVersionIdentity(second)!, packageSha256: 'f'.repeat(64) }), null);
  assert.equal(defaultDocxComparison(detail([first, third], 3)), null, 'missing predecessor is not an imaginary empty version');
  assert.equal(defaultDocxComparison(detail([first], 2)), null, 'missing head is not the last array entry');
  assert.equal(defaultDocxComparison(data, docxVersionIdentity(first))!.base, null);
});

test('exact arbitrary, reverse, equal and explicitly empty-base pairs do not follow newer heads', () => {
  const data = detail([version(1), version(2), version(3)], 3), saved = selection(detail());
  for (const selected of [saved, { ...saved, base: saved.target, target: saved.base! }, { ...saved, base: saved.target }, { ...saved, base: null }, { ...saved, target: docxVersionIdentity(data.versions[2]!)! }]) {
    const result = resolveDocxComparison(data, selected); assert.ok(!('error' in result));
    assert.equal(result.base?.id ?? null, selected.base?.id ?? null); assert.equal(result.target.id, selected.target.id);
    compared(result.before, result.after);
  }
  assert.deepEqual(saved, selection(detail()), 'new heads do not mutate saved selection');
});

test('same projected text is independent of package equality and never certifies complete Word equality', () => {
  const text = projection([block('p', [{ text: 'Same projected words.' }])]);
  const data = detail([version(1, text), version(2, text)]), selected = selection(data);
  const result = resolveDocxComparison(data, selected); assert.ok(!('error' in result));
  assert.equal(result.samePackage, false); assert.equal(compared(result.before, result.after).fileChange, 'unchanged');
  data.versions[1]!.docx!.sha256 = data.versions[0]!.docx!.sha256;
  const same = resolveDocxComparison(data, selection(data)); assert.ok(!('error' in same)); assert.equal(same.samePackage, true);
  assert.ok(same.after.warnings.length >= 2);
});

test('missing, changed, foreign, duplicate or non-Word identities return errors without fallback', () => {
  const data = detail(), selected = selection(data);
  for (const side of ['base', 'target'] as const) for (const patch of [{ id: 'missing' }, { contentHash: 'f'.repeat(64) }, { packageSha256: 'e'.repeat(64) }]) assert.ok('error' in resolveDocxComparison(data, { ...selected, [side]: { ...selected[side]!, ...patch } }));
  assert.ok('error' in resolveDocxComparison(data, { ...selected, revisionId: 'L2' }));
  assert.ok('error' in resolveDocxComparison(detail([{ ...data.versions[0]!, revisionId: 'L2' }, data.versions[1]!]), selected));
  assert.ok('error' in resolveDocxComparison(detail([...data.versions, data.versions[1]!]), selected));
  const withoutWord = { ...data.versions[1]! }; Reflect.deleteProperty(withoutWord, 'docx');
  assert.equal(docxVersionIdentity(withoutWord), null); assert.ok('error' in resolveDocxComparison(detail([data.versions[0]!, withoutWord]), selected));
  assert.ok('error' in resolveDocxComparison(data, { ...selected, filePath: 'footnotes' }));
  const invalid = structuredClone(data); invalid.versions[1]!.docx!.projection = { format: 'future' } as unknown as DocxProjection;
  const result = resolveDocxComparison(invalid, selected); assert.ok('error' in result); assert.match(result.error, /not supported/);
});

test('metadata strictly clones immutable pins and preferences without persisting source or speech', () => {
  const selected = selection(), input = { ...selected, privateSource: 'secret', before: { text: 'secret' }, target: { ...selected.target, projection: { text: 'secret' } }, base: { ...selected.base!, source: 'secret' }, skipSpaceTabOnly: true };
  const metadata = docxComparisonMetadata(input); assert.deepEqual(metadata, { ...selected, skipSpaceTabOnly: true });
  assert.equal(JSON.stringify(metadata).includes('secret'), false);
  input.target.id = 'changed'; input.base.contentHash = 'changed'; assert.deepEqual(metadata.target, selected.target); assert.deepEqual(metadata.base, selected.base);
  assert.equal(docxComparisonIdentity(selected), docxComparisonIdentity({ ...selected, target: { packageSha256: selected.target.packageSha256, contentHash: selected.target.contentHash, id: selected.target.id } }));
  assert.notEqual(docxComparisonIdentity(selected), docxComparisonIdentity({ ...selected, target: { ...selected.target, packageSha256: 'e'.repeat(64) } }));
  for (const invalid of [null, { ...selected, target: { ...selected.target, packageSha256: '' } }, { ...selected, base: { ...selected.base, contentHash: 'X'.repeat(64) } }, { ...selected, filePath: 'Word file' }, { ...selected, view: 'source' }, { ...selected, mode: 'semantic' }, { ...selected, skipSpaceTabOnly: 'true' }]) assert.equal(isDocxComparisonSelection(invalid, 'L1'), false);
  assert.equal(isDocxComparisonSelection(metadata, 'L1'), true); assert.equal(isDocxComparisonSelection(metadata, 'L2'), false);
});

test('real DOCX fixture projection compares tracked replacement without resurrecting imported deleted text', async () => {
  const bytes = await readFile(new URL('./fixtures/docx/roundtrip.docx', import.meta.url));
  const original = await inspectDocx(bytes), range = original.editableRanges.find(item => item.text === 'The original result is clear.'); assert.ok(range);
  const edited = await replaceDocx(bytes, { rangeId: range.id, start: 4, end: 12, quote: 'original', replacement: 'revised' }, { author: 'Comparison fixture', date: '2026-10-11T00:00:00.000Z' });
  const before = projected(original), after = projected(edited.projection), result = compared(before, after);
  assert.deepEqual(result.segments.filter(item => item.kind === 'removed').map(item => item.text), ['original']);
  assert.deepEqual(result.segments.filter(item => item.kind === 'added').map(item => item.text), ['revised']);
  assert.ok(before.scopes.document!.file.content.includes('new wording')); assert.equal(before.scopes.document!.file.content.includes('old wording'), false);
  assert.ok(before.scopes.document!.file.content.includes('[Note reference: footnote:2]'));
  assert.ok(before.scopes.footnotes!.file.content.includes('Source note with exact wording.'));
  assert.equal(compared(before, after, 'footnotes').fileChange, 'unchanged');
  assert.deepEqual(after.warnings.slice(2), edited.projection.warnings);
});
