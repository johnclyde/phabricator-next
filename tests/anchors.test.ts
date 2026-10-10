import test from 'node:test';
import assert from 'node:assert/strict';
import { createPassageAnchor, lineRange, projectAnchor } from '../shared/anchors.ts';
import type { PassageInput, RevisionVersion } from '../shared/types.ts';

function version(content: string, id = 'V1', path = 'motion.md'): RevisionVersion {
  return { id, revisionId: 'L1', number: id === 'V1' ? 1 : 2, files: [{ path, content }], message: '', contentHash: `hash-${id}`, createdAt: '2026-10-10T00:00:00Z' };
}
function anchor(content: string, quote: string) {
  const source = version(content); const start = content.indexOf(quote);
  return createPassageAnchor(source, 'motion.md', { start, end: start + quote.length, quote });
}

test('anchors retain the exact selected source, immutable identity and bounded Unicode-safe context', () => {
  const before = `x😀${'a'.repeat(79)}`;
  const quote = 'The café seeks 😀 relief.\r\n第二段';
  const after = `${'b'.repeat(79)}😀z`;
  const source = version(before + quote + after);
  const selected = createPassageAnchor(source, 'motion.md', { start: before.length, end: before.length + quote.length, quote });
  assert.deepEqual(selected, { versionId: 'V1', contentHash: 'hash-V1', filePath: 'motion.md', start: before.length, end: before.length + quote.length, quote, prefix: 'a'.repeat(79), suffix: 'b'.repeat(79) });
  assert.deepEqual(projectAnchor(selected, source), { status: 'original', start: selected.start, end: selected.end, occurrences: 1 });
});

test('invalid, oversized and mismatched selections fail with actionable RangeErrors', () => {
  const source = version('abc😀def');
  const invalid: PassageInput[] = [
    { start: -1, end: 1, quote: 'a' }, { start: 0, end: 0, quote: '' },
    { start: 2, end: 1, quote: '' }, { start: 0.5, end: 1, quote: 'a' },
    { start: 0, end: Infinity, quote: 'abc' }, { start: NaN, end: 1, quote: 'a' },
    { start: 0, end: 50, quote: 'abc' }, { start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 2, quote: 'a' },
    { start: 0, end: 3, quote: 'ABC' }, { start: 0, end: 3, quote: ' abc' },
  ];
  for (const input of invalid) assert.throws(() => createPassageAnchor(source, 'motion.md', input), RangeError);
  assert.throws(() => createPassageAnchor(source, 'absent.tex', { start: 0, end: 1, quote: 'a' }), /file.*exists/);
  assert.throws(() => createPassageAnchor(source, 'motion.md', null as unknown as PassageInput), RangeError);
  assert.throws(() => createPassageAnchor(source, 'motion.md', { start: 0, end: 1, quote: 1 } as unknown as PassageInput), RangeError);
  const long = version('x'.repeat(20_001));
  assert.equal(createPassageAnchor(long, 'motion.md', { start: 0, end: 20_000, quote: 'x'.repeat(20_000) }).quote.length, 20_000);
  assert.throws(() => createPassageAnchor(long, 'motion.md', { start: 0, end: 20_001, quote: long.files[0]!.content }), /20,000/);
});

test('UTF-16 boundaries never bisect surrogate pairs or normalize composed text', () => {
  const source = version('a😀e\u0301');
  assert.throws(() => createPassageAnchor(source, 'motion.md', { start: 1, end: 2, quote: '\ud83d' }), /surrogate/);
  assert.throws(() => createPassageAnchor(source, 'motion.md', { start: 2, end: 3, quote: '\ude00' }), /surrogate/);
  assert.equal(createPassageAnchor(source, 'motion.md', { start: 1, end: 3, quote: '😀' }).quote, '😀');
  assert.throws(() => createPassageAnchor(source, 'motion.md', { start: 3, end: 5, quote: 'é' }), /exactly match/);
  // A standalone low surrogate in old source may not match half of a new pair.
  assert.equal(projectAnchor(anchor('\ude00', '\ude00'), version('😀', 'V2')).status, 'changed');
});

test('insertions and moves project a unique passage without changing its original anchor', () => {
  const quote = 'The record supports relief.';
  const selected = anchor(`Introduction.\n\n${quote}\n\nConclusion.`, quote);
  const original = structuredClone(selected);
  for (const content of [`A new opening.\nIntroduction.\n\n${quote}\n\nConclusion.`, `Conclusion.\n\n${quote}\n\nIntroduction.`, quote]) {
    const target = version(content, 'V2'); const targetBefore = structuredClone(target);
    assert.deepEqual(projectAnchor(selected, target), { status: 'relocated', start: content.indexOf(quote), end: content.indexOf(quote) + quote.length, occurrences: 1 });
    assert.deepEqual(target, targetBefore);
    assert.deepEqual(selected, original);
  }
});

test('repeated or overlapping matches are ambiguous even when old context favors one', () => {
  const selected = anchor('Before.\nPassage.\nAfter.', 'Passage.');
  assert.deepEqual(projectAnchor(selected, version('Before.\nPassage.\nAfter.\nPassage.', 'V2')), { status: 'ambiguous', start: null, end: null, occurrences: 2 });
  assert.deepEqual(projectAnchor(anchor('aa', 'aa'), version('aaaa', 'V2')), { status: 'ambiguous', start: null, end: null, occurrences: 3 });
  const originalRepeated = version('aa aa');
  const second = createPassageAnchor(originalRepeated, 'motion.md', { start: 3, end: 5, quote: 'aa' });
  assert.equal(projectAnchor(second, originalRepeated).status, 'original', 'the original offset remains authoritative even with repeated text');
});

test('changed, removed and absent-file passages remain explicitly unavailable without matching other files', () => {
  const selected = anchor('The court grants relief.', 'grants relief');
  for (const content of ['The court denies relief.', 'The court.', '']) {
    assert.deepEqual(projectAnchor(selected, version(content, 'V2')), { status: 'changed', start: null, end: null, occurrences: 0 });
  }
  assert.deepEqual(projectAnchor(selected, version('grants relief', 'V2', 'other.md')), { status: 'file_missing', start: null, end: null, occurrences: 0 });
  const target = version('No matching passage here.', 'V2'); target.files.push({ path: 'other.md', content: 'grants relief' });
  assert.equal(projectAnchor(selected, target).status, 'changed');
});

test('original status verifies the original identity, source slice and context instead of relocating corrupt originals', () => {
  const source = version('Before quote after');
  const selected = anchor(source.files[0]!.content, 'quote');
  assert.equal(projectAnchor(selected, { ...source, contentHash: 'another-hash' }).status, 'changed');
  assert.equal(projectAnchor(selected, version('Before other quote after')).status, 'changed');
  assert.equal(projectAnchor({ ...selected, prefix: 'Incorrect context' }, source).status, 'changed');
  assert.equal(projectAnchor({ ...selected, suffix: 'Incorrect context' }, source).status, 'changed');
  assert.equal(projectAnchor({ ...selected, start: -1 }, source).status, 'changed');
  assert.equal(projectAnchor({ ...selected, quote: '' }, version('Anything', 'V2')).status, 'changed');
  assert.equal(projectAnchor(selected, { ...source, id: 'V2' }).status, 'relocated', 'identical content in another version is still a projection');
});

test('line ranges preserve intervening LF/CRLF and Unicode while excluding the final line terminator', () => {
  const content = 'First 😀\r\nSecond e\u0301\r\nThird\n';
  assert.deepEqual(lineRange(content, 1, 1), { start: 0, end: 8, quote: 'First 😀' });
  assert.deepEqual(lineRange(content, 2, 2), { start: 10, end: 19, quote: 'Second e\u0301' });
  assert.deepEqual(lineRange(content, 1, 2), { start: 0, end: 19, quote: 'First 😀\r\nSecond e\u0301' });
  const third = lineRange(content, 3, 3);
  assert.equal(third.quote, 'Third');
  assert.equal(content.slice(third.start, third.end), third.quote);
  assert.equal(lineRange('One\nTwo', 1, 2).quote, 'One\nTwo');
  assert.equal(lineRange('Lone carriage return\r', 1, 1).quote, 'Lone carriage return\r');
});

test('line selection rejects missing, empty, reversed and noninteger ranges', () => {
  for (const [start, end] of [[0, 1], [2, 1], [1, 3], [1, 1.5], [NaN, 1], [1, Infinity]]) {
    assert.throws(() => lineRange('One\nTwo', start!, end!), RangeError);
  }
  assert.throws(() => lineRange('', 1, 1), /nonempty/);
  assert.throws(() => lineRange('One\n\nThree', 2, 2), /nonempty/);
  assert.throws(() => lineRange('One\n', 2, 2), /nonempty/);
});

test('projections count all overlapping matches on a large repetitive source with bounded match storage', () => {
  const quote = 'a'.repeat(20_000);
  const selected = anchor(quote, quote);
  assert.deepEqual(projectAnchor(selected, version('a'.repeat(500_000), 'V2')), { status: 'ambiguous', start: null, end: null, occurrences: 480_001 });
});

test('generated exact spans project consistently and do not mutate frozen inputs', () => {
  const pieces = ['A', 'é', 'e\u0301', '😀', '\r\n', '∑', '中'];
  for (let index = 0; index < pieces.length; index++) {
    const quote = `[${pieces[index]}${pieces[(index + 1) % pieces.length]}]`;
    const source = version(`Left ${quote} right`);
    const selected = Object.freeze(anchor(source.files[0]!.content, quote));
    const target = version(`Inserted\n${quote}\nMoved`, 'V2');
    Object.freeze(target.files[0]); Object.freeze(target.files); Object.freeze(target);
    const snapshot = JSON.stringify({ selected, target });
    const projected = projectAnchor(selected, target);
    assert.equal(projected.status, 'relocated');
    assert.equal(target.files[0]!.content.slice(projected.start!, projected.end!), quote);
    assert.equal(JSON.stringify({ selected, target }), snapshot);
  }
});
