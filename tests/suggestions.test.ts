import test from 'node:test';
import assert from 'node:assert/strict';
import { createPassageAnchor } from '../shared/anchors.ts';
import { applySuggestedReplacement, validateSuggestion, validateSuggestionDraft } from '../shared/suggestions.ts';
import { reviewDraftPayload } from '../shared/review-drafts.ts';
import type { PassageAnchor, RevisionVersion, SuggestedReplacement } from '../shared/types.ts';

function fixture(content = 'Before. Original passage. After.', quote = 'Original passage.') {
  const version: RevisionVersion = {
    id: 'V1', revisionId: 'L1', number: 1, contentHash: 'hash-V1', message: 'Initial version', createdAt: '2026-10-10T00:00:00Z',
    files: [{ path: 'motion.md', content }, { path: 'other.txt', content: `Do not replace ${quote} in this file.` }],
  };
  const start = content.indexOf(quote);
  return { version, anchor: createPassageAnchor(version, 'motion.md', { start, end: start + quote.length, quote }) };
}

test('validation preserves exact replacement whitespace, CRLF and Unicode in a fresh value', () => {
  const { anchor } = fixture();
  for (const replacement of ['  ', '\t\r\n', ' \r\n第二段 😀 e\u0301\r\n ', '\u0001']) {
    const suggestion = Object.freeze({ replacement });
    const validated = validateSuggestion(anchor, suggestion);
    assert.deepEqual(validated, suggestion);
    assert.notEqual(validated, suggestion);
  }
  assert.equal(validateSuggestion(anchor, { replacement: 'é' }).replacement, 'é');
  assert.equal(validateSuggestion(anchor, { replacement: 'e\u0301' }).replacement, 'e\u0301');
});

test('empty replacement deletes only the selected passage and does not remove its file', () => {
  const { version, anchor } = fixture('Head\r\nRemove 😀 this\r\nTail', 'Remove 😀 this');
  const files = applySuggestedReplacement(version, anchor, { replacement: '' });
  assert.equal(files[0]!.content, 'Head\r\n\r\nTail');
  assert.deepEqual(files[1], version.files[1]);
  const whole = fixture('Delete all source', 'Delete all source');
  assert.deepEqual(applySuggestedReplacement(whole.version, whole.anchor, { replacement: '' })[0], { path: 'motion.md', content: '' });
});

test('malformed, unchanged, oversized and invalid-Unicode suggestions fail with RangeError', () => {
  const { anchor } = fixture();
  const invalid: unknown[] = [null, undefined, 1, '', [], {}, { replacement: 1 }, { replacement: null }, { replacement: false }, { replacement: 'new', extra: true }];
  for (const suggestion of invalid) assert.throws(() => validateSuggestion(anchor, suggestion as SuggestedReplacement), RangeError);
  assert.throws(() => validateSuggestion(anchor, { replacement: anchor.quote }), /matches the original/);
  assert.throws(() => validateSuggestion(anchor, { replacement: 'x'.repeat(20_001) }), /20,000/);
  assert.throws(() => validateSuggestion(anchor, { replacement: 'null\0byte' }), /null/);
  for (const replacement of ['\ud800', '\udfff', 'a\ud800b', '\ud800\ud800\udc00', '\udc00\ud800', '😀\udc00']) {
    assert.throws(() => validateSuggestion(anchor, { replacement }), /surrogate/);
  }
  assert.equal(validateSuggestion(anchor, { replacement: '😀'.repeat(10_000) }).replacement.length, 20_000);
  assert.throws(() => validateSuggestion(anchor, { replacement: '😀'.repeat(10_001) }), /20,000/);
  assert.throws(() => validateSuggestion(null as unknown as PassageAnchor, { replacement: '' }), /original passage/);
});

test('replacement preserves surrounding source, file order and every other file exactly', () => {
  const { version, anchor } = fixture('Intro e\u0301\r\nOriginal passage.\r\nTail 😀');
  version.files.unshift({ path: 'z-first.tex', content: '\\input{motion}\r\n' });
  const result = applySuggestedReplacement(version, anchor, { replacement: 'Replacement 😀\r\nNext line.' });
  assert.deepEqual(result, [
    version.files[0],
    { path: 'motion.md', content: 'Intro e\u0301\r\nReplacement 😀\r\nNext line.\r\nTail 😀' },
    version.files[2],
  ]);
  assert.notEqual(result, version.files);
  result.forEach((file, index) => assert.notEqual(file, version.files[index]));
});

test('same quotation in another source version or hash is never silently relocated', () => {
  const { version, anchor } = fixture();
  for (const target of [
    { ...version, id: 'V2' },
    { ...version, contentHash: 'different-hash' },
    { ...version, id: 'V2', files: [{ path: 'motion.md', content: `Moved: ${anchor.quote}` }] },
  ]) assert.throws(() => applySuggestedReplacement(target, anchor, { replacement: 'Changed.' }), /different source version/);
});

test('a missing file or quote at the wrong original offset cannot match another occurrence or file', () => {
  const { version, anchor } = fixture();
  assert.throws(() => applySuggestedReplacement({ ...version, files: [version.files[1]!] }, anchor, { replacement: 'Changed.' }), /file.*exists/);
  const moved = { ...version, files: [{ path: 'motion.md', content: `Moved text. ${anchor.quote}` }, version.files[1]!] };
  assert.throws(() => applySuggestedReplacement(moved, anchor, { replacement: 'Changed.' }), /exactly match/);
  const repeated = fixture('same same', 'same');
  const second = createPassageAnchor(repeated.version, 'motion.md', { start: 5, end: 9, quote: 'same' });
  assert.equal(applySuggestedReplacement(repeated.version, second, { replacement: 'new' })[0]!.content, 'same new');
});

test('corrupted context, quote and offsets fail instead of applying a partial or guessed edit', () => {
  const { version, anchor } = fixture('Before 😀 passage after', '😀 passage');
  const corrupt: PassageAnchor[] = [
    { ...anchor, prefix: 'Wrong prefix' }, { ...anchor, suffix: 'Wrong suffix' },
    { ...anchor, quote: 'Different quote' }, { ...anchor, start: -1 },
    { ...anchor, end: Infinity }, { ...anchor, start: anchor.start + 1, quote: anchor.quote.slice(1) },
  ];
  for (const value of corrupt) assert.throws(() => applySuggestedReplacement(version, value, { replacement: 'Changed.' }), RangeError);
});

test('frozen source, anchor and suggestion remain unchanged through generated Unicode replacements', () => {
  const pieces = ['😀', 'e\u0301', 'é', '中', '\r\n', '\t', ' '];
  for (let index = 0; index < pieces.length; index++) {
    const quote = `[${pieces[index]}]`, replacement = `(${pieces[(index + 1) % pieces.length]})`;
    const { version, anchor } = fixture(`Left ${quote} right`, quote);
    const suggestion = Object.freeze({ replacement });
    version.files.forEach(Object.freeze); Object.freeze(version.files); Object.freeze(version); Object.freeze(anchor);
    const snapshot = JSON.stringify({ version, anchor, suggestion });
    assert.equal(applySuggestedReplacement(version, anchor, suggestion)[0]!.content, `Left ${replacement} right`);
    assert.equal(JSON.stringify({ version, anchor, suggestion }), snapshot);
  }
});

test('multi-passage edits apply across files using original offsets, preserving proposal order and input bytes', () => {
  const { version, anchor } = fixture('Left. Original passage. Right 😀.');
  const at = (filePath: string, quote: string) => { const start = version.files.find(file => file.path === filePath)!.content.indexOf(quote); return createPassageAnchor(version, filePath, { start, end: start + quote.length, quote }); };
  const suggestion = { replacement: 'A much longer replacement.', additionalEdits: [
    { anchor: at('motion.md', 'Right 😀'), replacement: '', explanation: 'Remove the closing fragment.' },
    { anchor: at('other.txt', 'Do not replace'), replacement: 'Keep', explanation: 'Clarify the companion source.' },
    { anchor: at('motion.md', 'Left'), replacement: 'First', explanation: 'Use a numbered introduction.' },
  ] };
  const snapshot = JSON.stringify({ version, anchor, suggestion });
  assert.deepEqual(applySuggestedReplacement(version, anchor, suggestion, 'Clarify the central claim.'), [
    { path: 'motion.md', content: 'First. A much longer replacement. .' },
    { path: 'other.txt', content: 'Keep Original passage. in this file.' },
  ]);
  const copy = validateSuggestion(anchor, suggestion);
  assert.deepEqual(copy, suggestion);
  assert.notEqual(copy.additionalEdits![0]!.anchor, suggestion.additionalEdits[0]!.anchor);
  assert.equal(JSON.stringify({ version, anchor, suggestion }), snapshot);
});

test('adjacent passages are legal while overlapping, duplicate and nested edits reject the whole set', () => {
  const { version, anchor } = fixture('abcd', 'ab');
  const adjacent = createPassageAnchor(version, 'motion.md', { start: 2, end: 4, quote: 'cd' });
  assert.equal(applySuggestedReplacement(version, anchor, { replacement: 'A', additionalEdits: [{ anchor: adjacent, replacement: 'B', explanation: 'Second clause.' }] })[0]!.content, 'AB');
  for (const range of [{ start: 0, end: 2, quote: 'ab' }, { start: 1, end: 3, quote: 'bc' }, { start: 0, end: 1, quote: 'a' }, { start: 0, end: 4, quote: 'abcd' }]) {
    const additional = createPassageAnchor(version, 'motion.md', range);
    assert.throws(() => applySuggestedReplacement(version, anchor, { replacement: 'A', additionalEdits: [{ anchor: additional, replacement: 'B', explanation: 'Conflicting range.' }] }), /overlap/);
    assert.equal(version.files[0]!.content, 'abcd');
  }
});

test('every additional passage must match original source identity, file, offsets, quotation and context', () => {
  const { version, anchor } = fixture();
  const extra = createPassageAnchor(version, 'other.txt', { start: 0, end: 2, quote: 'Do' });
  for (const changed of [
    { versionId: 'V2' }, { contentHash: 'other' }, { filePath: 'missing.txt' }, { quote: 'No' },
    { start: 1, end: 3 }, { prefix: 'Forged' }, { suffix: 'Forged' },
  ]) assert.throws(() => applySuggestedReplacement(version, anchor, { replacement: 'Changed', additionalEdits: [{ anchor: { ...extra, ...changed }, replacement: 'Will', explanation: 'Keep all edits together.' }] }), RangeError);
  assert.throws(() => applySuggestedReplacement({ ...version, files: [...version.files, version.files[0]!] }, anchor, { replacement: 'Changed' }), /ambiguous/);
  assert.throws(() => applySuggestedReplacement({ ...version, docx: {} as RevisionVersion['docx'] }, anchor, { replacement: 'Changed' }), /Word/);
});

test('multi-passage shape, individual explanations and Unicode remain strictly validated', () => {
  const { version, anchor } = fixture();
  const edit = { anchor: createPassageAnchor(version, 'other.txt', { start: 0, end: 2, quote: 'Do' }), replacement: 'Will', explanation: 'State the intention.' };
  for (const additionalEdits of [null, {}, 'text', [null], [{ ...edit, extra: true }], [{ ...edit, explanation: '' }], [{ ...edit, explanation: ' \n ' }], [{ ...edit, explanation: '\0' }], [{ ...edit, explanation: '\ud800' }], [{ ...edit, explanation: 'x'.repeat(20_001) }], [{ ...edit, replacement: 'Do' }], [{ ...edit, anchor: { ...edit.anchor, extra: true } }], [{ ...edit, anchor: { ...edit.anchor, quote: 'D\ud800' } }]]) {
    assert.throws(() => validateSuggestion(anchor, { replacement: 'Changed', additionalEdits } as SuggestedReplacement), RangeError);
  }
});

test('suggestions and unfinished drafts have no separate aggregate text ceiling', () => {
  const { version, anchor } = fixture();
  const edit = { anchor: createPassageAnchor(version, 'other.txt', { start: 0, end: 2, quote: 'Do' }), replacement: 'R'.repeat(20_000), explanation: 'E'.repeat(20_000) };
  const next = { ...edit, anchor: createPassageAnchor(version, 'other.txt', { start: 3, end: 6, quote: 'not' }) };
  const suggestion = { replacement: 'P'.repeat(20_000), additionalEdits: [edit, next] };
  const snapshot = JSON.stringify(suggestion);
  assert.deepEqual(validateSuggestionDraft(anchor, suggestion, 'Primary explanation'), suggestion);
  assert.equal(JSON.stringify(suggestion), snapshot);
  assert.deepEqual(validateSuggestion(anchor, suggestion, 'Primary explanation'), suggestion);
  assert.equal(applySuggestedReplacement(version, anchor, suggestion, 'Primary explanation')[1]!.content, 'R'.repeat(20_000) + ' ' + 'R'.repeat(20_000) + ' replace Original passage. in this file.');
  assert.throws(() => validateSuggestionDraft(anchor, { ...suggestion, replacement: 'x'.repeat(20_001) }), /20,000/);
  assert.deepEqual(validateSuggestionDraft(anchor, { replacement: anchor.quote, additionalEdits: [{ ...edit, replacement: edit.anchor.quote, explanation: '' }] }), { replacement: anchor.quote, additionalEdits: [{ ...edit, replacement: edit.anchor.quote, explanation: '' }] });
});

test('thousands of unordered suggestions across files preserve every exact edit without count or aggregate truncation', () => {
  const count = 2_048, perFile = 32;
  const originals = Array.from({ length: count }, (_, index) => `Original ${index} 😀 e\u0301`);
  const replacements = originals.map((_, index) => index % 3 === 0 ? '' : index % 3 === 1 ? `A substantially longer replacement ${index} 🧪` : `R${index}`);
  const version: RevisionVersion = { id: 'V-many', revisionId: 'L1', number: 1, contentHash: 'a'.repeat(64), message: 'Many passages', createdAt: '2026-10-10T00:00:00Z', files: Array.from({ length: count / perFile }, (_, index) => ({ path: `part-${index}.tex`, content: originals.slice(index * perFile, (index + 1) * perFile).join('\r\n') + '\r\n' })) };
  const edits = originals.map((quote, index) => {
    const file = version.files[Math.floor(index / perFile)]!, start = file.content.indexOf(quote);
    return { anchor: createPassageAnchor(version, file.path, { start, end: start + quote.length, quote }), replacement: replacements[index]!, explanation: `Keep the complete proposal together, including exact edit ${index}.` };
  });
  const first = edits[0]!, suggestion = { replacement: first.replacement, additionalEdits: edits.slice(1).reverse() };
  const snapshot = JSON.stringify({ version, suggestion });
  assert.ok(edits.reduce((total, edit) => total + edit.anchor.quote.length + edit.replacement.length + edit.explanation.length, 0) > 100_000);
  const privatePayload = { kind: 'comment' as const, body: first.explanation, versionId: version.id, contentHash: version.contentHash, filePath: first.anchor.filePath, line: 1, passage: { start: first.anchor.start, end: first.anchor.end, quote: first.anchor.quote }, suggestion };
  assert.deepEqual(reviewDraftPayload(privatePayload), privatePayload, 'the private parser preserves submission order');
  assert.deepEqual(validateSuggestionDraft(first.anchor, suggestion, first.explanation), suggestion);
  assert.deepEqual(applySuggestedReplacement(version, first.anchor, suggestion, first.explanation), version.files.map((file, index) => ({ path: file.path, content: replacements.slice(index * perFile, (index + 1) * perFile).join('\r\n') + '\r\n' })));
  for (const extra of [
    { ...edits[1]!, anchor: { ...edits[1]!.anchor, suffix: 'Forged last context' } },
    { ...edits[1]!, anchor: { ...first.anchor } },
  ]) {
    const invalid = { ...suggestion, additionalEdits: [...suggestion.additionalEdits.slice(0, -1), extra] };
    assert.throws(() => applySuggestedReplacement(version, first.anchor, invalid, first.explanation), RangeError);
  }
  const overlapping = { ...suggestion, additionalEdits: [...suggestion.additionalEdits, { ...first }] };
  assert.throws(() => reviewDraftPayload({ ...privatePayload, suggestion: overlapping }), /complete private review draft/);
  assert.equal(JSON.stringify({ version, suggestion }), snapshot, 'neither accepted nor rejected sets mutate original source or proposal order');
});
