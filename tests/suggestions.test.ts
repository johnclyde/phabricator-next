import test from 'node:test';
import assert from 'node:assert/strict';
import { createPassageAnchor } from '../shared/anchors.ts';
import { applySuggestedReplacement, validateSuggestion } from '../shared/suggestions.ts';
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
