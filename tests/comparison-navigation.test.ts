import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFile, type ComparisonMode, type ReadyComparison } from '../shared/comparison.ts';
import { comparisonPassages } from '../shared/comparison-navigation.ts';

const file = (content: string) => ({ path: 'paper.tex', content });
function compare(before: string | null, after: string | null, mode: ComparisonMode = 'words'): ReadyComparison {
  const value = compareFile(before === null ? null : file(before), after === null ? null : file(after), mode);
  if (value.status !== 'ready') assert.fail(`Expected ready comparison, got ${value.reason}.`);
  return value;
}

test('navigation keeps original indexes when disabled and skips only space/tab passages when enabled', () => {
  const result = compare('a b\nkeep\nold\nkeep\nc\td\n', 'a  b\nkeep\nnew\nkeep\nc d\n', 'lines');
  assert.equal(result.passages.length, 3);
  assert.deepEqual(comparisonPassages(result, false), { indexes: [0, 1, 2], skipped: 0 });
  assert.deepEqual(comparisonPassages(result, true), { indexes: [1], skipped: 2 });
  const retained = result.passages[1]!;
  assert.equal(result.segments[retained.segmentStart]!.text, 'old\n');
});

test('space/tab insertions, deletions and replacements are skipped in both directions and modes', () => {
  const fixtures = [[' ', '\t'], ['', ' \t '], ['a b', 'a  b'], ['a\tb', 'ab'], [' leading', '\tleading'], ['trailing \t', 'trailing'], ['a \t\r\n', 'a\r\n']];
  for (const [before, after] of fixtures) for (const mode of ['words', 'lines'] as const) for (const [left, right] of [[before!, after!], [after!, before!]]) {
    const result = compare(left!, right!, mode);
    assert.ok(result.passages.length > 0);
    assert.deepEqual(comparisonPassages(result, true), { indexes: [], skipped: result.passages.length }, `${mode}: ${JSON.stringify([left, right])}`);
  }
});

test('CR, LF, CRLF and final-newline changes remain significant', () => {
  const fixtures = [['a\r\n', 'a\n'], ['a\n', 'a'], ['a\r', 'a'], ['\r', '\n'], ['a\n\n', 'a\n'], [' \r\n', '\t\n']];
  for (const [before, after] of fixtures) for (const mode of ['words', 'lines'] as const) for (const [left, right] of [[before!, after!], [after!, before!]]) {
    const result = compare(left!, right!, mode);
    const filtered = comparisonPassages(result, true);
    assert.ok(filtered.indexes.length > 0, `${mode}: ${JSON.stringify([left, right])}`);
    assert.equal(filtered.indexes.length + filtered.skipped, result.passages.length);
  }
});

test('NBSP and every other JavaScript whitespace code point remain significant', () => {
  const significant = ['\v', '\f', '\u0085', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff', '\u200b'];
  for (const whitespace of significant) for (const mode of ['words', 'lines'] as const) {
    const result = compare(`a${whitespace}b`, 'a b', mode);
    assert.deepEqual(comparisonPassages(result, true), { indexes: result.passages.map((_, index) => index), skipped: 0 }, `${mode}: ${JSON.stringify(whitespace)}`);
  }
});

test('mixed edits retain their complete passage, including whitespace and Unicode differences', () => {
  for (const [before, after] of [['old \t', 'new '], ['café 😀 ', 'cafe 😃\t'], ['é ', 'e\u0301\t'], ['a\u00a0 ', 'a \t']]) for (const mode of ['words', 'lines'] as const) {
    const result = compare(before!, after!, mode);
    const selection = comparisonPassages(result, true);
    assert.ok(selection.indexes.length > 0);
    // In line mode the whole line is one passage: never split out or rewrite
    // its spaces while preserving the other edits.
    if (mode === 'lines') assert.deepEqual(selection, { indexes: [0], skipped: 0 });
  }
});

test('file additions and removals remain material even for whitespace-only content', () => {
  for (const text of [' ', '\t', ' \t ', '\r\n', '😀']) for (const mode of ['words', 'lines'] as const) {
    for (const result of [compare(null, text, mode), compare(text, null, mode)]) {
      assert.deepEqual(comparisonPassages(result, true), { indexes: result.passages.map((_, index) => index), skipped: 0 });
    }
  }
  // Existing files may become empty through a whitespace-only edit; an absent
  // file is a different fact and never gets this exception.
  assert.deepEqual(comparisonPassages(compare(' \t', ''), true), { indexes: [], skipped: 1 });
});

test('equal and empty comparisons have no navigable passages without hiding file existence', () => {
  for (const result of [compare('', ''), compare('same \t\r\n😀', 'same \t\r\n😀'), compare(null, ''), compare('', null)]) {
    assert.deepEqual(comparisonPassages(result, true), { indexes: [], skipped: 0 });
    assert.deepEqual(comparisonPassages(result, false), { indexes: [], skipped: 0 });
  }
});

test('equal changed text is not classified as a whitespace difference', () => {
  const result = compare(' ', '\t');
  // Protect the explicit differing-text condition even if a later producer
  // emits an equal remove/add pair rather than an unchanged segment.
  const same = structuredClone(result);
  same.segments.find(segment => segment.kind === 'added')!.text = ' ';
  assert.deepEqual(comparisonPassages(same, true), { indexes: [0], skipped: 0 });
});

test('filtering does not mutate literal segments, passage ranges or returned selection aliases', () => {
  const result = compare('a b\nkeep\nold😀\nkeep\nc\td', 'a  b\nkeep\nnew😀\nkeep\nc d', 'lines');
  const snapshot = structuredClone(result);
  for (const segment of result.segments) { Object.freeze(segment.before); Object.freeze(segment.after); Object.freeze(segment); }
  for (const passage of result.passages) { Object.freeze(passage.before); Object.freeze(passage.after); Object.freeze(passage); }
  Object.freeze(result.segments); Object.freeze(result.passages); Object.freeze(result.metrics); Object.freeze(result);
  const filtered = comparisonPassages(result, true);
  assert.deepEqual(filtered, { indexes: [1], skipped: 2 });
  filtered.indexes.push(99);
  assert.deepEqual(comparisonPassages(result, true), { indexes: [1], skipped: 2 });
  assert.deepEqual(result, snapshot);
});

test('many bounded passages preserve their original ordered indexes', () => {
  const before = Array.from({ length: 80 }, (_, index) => `old${index} \nanchor${index}\n`).join('');
  const after = Array.from({ length: 80 }, (_, index) => `${index % 2 ? `new${index}` : `old${index}`}\t\nanchor${index}\n`).join('');
  const result = compare(before, after, 'lines');
  assert.equal(result.passages.length, 80);
  assert.deepEqual(comparisonPassages(result, true), { indexes: Array.from({ length: 40 }, (_, index) => index * 2 + 1), skipped: 40 });
});
