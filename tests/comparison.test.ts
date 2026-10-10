import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPARISON_LIMITS, compareFile, type ComparisonFile, type ComparisonLimits, type ComparisonMode, type FileComparison, type ReadyComparison } from '../shared/comparison.ts';

const file = (content: string, path = 'paper.tex'): ComparisonFile => ({ path, content });
function ready(value: FileComparison): ReadyComparison { if (value.status !== 'ready') assert.fail(`Expected a ready comparison, got ${value.reason}`); return value; }
function check(before: string, after: string, mode: ComparisonMode = 'words'): ReadyComparison {
  const result = ready(compareFile(file(before), file(after), mode));
  assert.equal(result.segments.filter(part => part.kind !== 'added').map(part => part.text).join(''), before);
  assert.equal(result.segments.filter(part => part.kind !== 'removed').map(part => part.text).join(''), after);
  let oldOffset = 0, newOffset = 0, previousSegmentEnd = 0;
  for (const part of result.segments) {
    assert.equal(part.before.start, oldOffset); assert.equal(part.after.start, newOffset);
    assert.equal(before.slice(part.before.start, part.before.end), part.kind === 'added' ? '' : part.text);
    assert.equal(after.slice(part.after.start, part.after.end), part.kind === 'removed' ? '' : part.text);
    for (const [text, span] of [[before, part.before], [after, part.after]] as const) {
      for (const offset of [span.start, span.end]) {
        const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
        assert.equal(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff, false, 'a valid surrogate pair may not be bisected');
      }
    }
    oldOffset = part.before.end; newOffset = part.after.end;
  }
  assert.equal(oldOffset, before.length); assert.equal(newOffset, after.length);
  for (const passage of result.passages) {
    assert.ok(passage.segmentStart >= previousSegmentEnd);
    assert.ok(passage.segmentEnd > passage.segmentStart);
    const parts = result.segments.slice(passage.segmentStart, passage.segmentEnd);
    assert.ok(parts.every(part => part.kind !== 'unchanged'));
    assert.equal(parts[0]!.before.start, passage.before.start); assert.equal(parts.at(-1)!.before.end, passage.before.end);
    assert.equal(parts[0]!.after.start, passage.after.start); assert.equal(parts.at(-1)!.after.end, passage.after.end);
    assert.equal(before.slice(passage.before.start, passage.before.end), parts.filter(part => part.kind === 'removed').map(part => part.text).join(''));
    assert.equal(after.slice(passage.after.start, passage.after.end), parts.filter(part => part.kind === 'added').map(part => part.text).join(''));
    assert.equal(passage.kind, passage.before.start === passage.before.end ? 'added' : passage.after.start === passage.after.end ? 'removed' : 'replaced');
    previousSegmentEnd = passage.segmentEnd;
  }
  return result;
}
function tooLarge(before: string, after: string, reason: string, limits: Partial<ComparisonLimits> = {}, mode: ComparisonMode = 'words') {
  const value = compareFile(file(before), file(after), mode, limits);
  assert.equal(value.status, 'too_large');
  assert.equal(value.status === 'too_large' && value.reason, reason);
  assert.equal('segments' in value, false); assert.equal('passages' in value, false);
  return value;
}

test('literal word passages carry exact immutable UTF-16 slices and group replacements', () => {
  const before = 'The court denies relief. Costs remain.';
  const after = 'The court grants relief. Costs stay.';
  const result = check(before, after);
  assert.equal(result.fileChange, 'modified'); assert.equal(result.passages.length, 2);
  assert.deepEqual(result.passages.map(item => [before.slice(item.before.start, item.before.end), after.slice(item.after.start, item.after.end)]), [['denies', 'grants'], ['remain', 'stay']]);
  assert.equal(result.metrics.inputCodeUnits, before.length + after.length);
  assert.equal(result.metrics.sourceLines, 2);
  assert.ok(result.metrics.tokens! > 0 && result.metrics.tokens! <= COMPARISON_LIMITS.maxTokens);
});

test('reverse, nonadjacent and identical sources are literal comparisons, never latest-version inference', () => {
  const older = 'A.\nB.\n', newer = 'A.\nChanged B.\nC.\n';
  for (const mode of ['words', 'lines'] as const) {
    const forward = check(older, newer, mode), reverse = check(newer, older, mode), same = check(older, older, mode);
    assert.equal(forward.segments.filter(part => part.kind === 'added').map(part => part.text).join(''), reverse.segments.filter(part => part.kind === 'removed').map(part => part.text).join(''));
    assert.equal(same.fileChange, 'unchanged'); assert.deepEqual(same.passages, []);
    assert.equal(same.segments.length, 1);
  }
});

test('added and removed files retain presence independently of content and support empty files', () => {
  for (const text of ['', 'Entire source 😀\r\n']) {
    const added = ready(compareFile(null, file(text))), removed = ready(compareFile(file(text), null));
    assert.equal(added.fileChange, 'added'); assert.equal(removed.fileChange, 'removed');
    assert.equal(added.beforePresent, false); assert.equal(removed.afterPresent, false);
    assert.equal(added.passages.length, text ? 1 : 0); assert.equal(removed.passages.length, text ? 1 : 0);
    assert.equal(added.segments.map(part => part.text).join(''), text); assert.equal(removed.segments.map(part => part.text).join(''), text);
    check('', text); check(text, '');
  }
  const empty = ready(compareFile(file(''), file(''), 'words', Object.fromEntries(Object.keys(COMPARISON_LIMITS).map(key => [key, 0]))));
  assert.equal(empty.fileChange, 'unchanged'); assert.deepEqual(empty.segments, []); assert.deepEqual(empty.passages, []);
});

test('Unicode is preserved exactly without normalization or broken surrogate pairs', () => {
  const fixtures = [
    ['café 😀 e\u0301 第一章', 'cafe 😃 é 第二章'],
    ['👩‍⚖️ shall review.', '👩‍🔬 must review.'],
    ['\ud800 lone high and \udc00 lone low', '\ud800 lone high and 😀 valid pair'],
    ['a\u00a0b\u2003c', 'a b\tc'],
  ];
  for (const [before, after] of fixtures) for (const mode of ['words', 'lines'] as const) check(before!, after!, mode);
});

test('whitespace-only edits, CRLF, blank lines and final newlines are observable changes', () => {
  const fixtures = [['a b', 'a  b'], ['a\tb', 'a b'], ['one\r\ntwo\r\n', 'one\ntwo\n'], ['a\n', 'a'], ['a', 'a\n'], ['\n\n', '\n'], [' ', '\t'], ['\r', '\n']];
  for (const [before, after] of fixtures) for (const mode of ['words', 'lines'] as const) {
    const result = check(before!, after!, mode); assert.ok(result.passages.length > 0); assert.equal(result.fileChange, 'modified');
  }
  const lines = check('a\r\nb\r\n', 'a\r\nchanged\r\n', 'lines');
  assert.deepEqual(lines.passages[0]!.before, { start: 3, end: 6 });
  assert.deepEqual(lines.passages[0]!.after, { start: 3, end: 12 });
});

test('line and word modes provide distinct literal granularity without changing source', () => {
  const before = 'The court denies relief.\nAn unchanged line.\n', after = 'The court grants relief.\nAn unchanged line.\n';
  const words = check(before, after, 'words'), lines = check(before, after, 'lines');
  assert.equal(before.slice(words.passages[0]!.before.start, words.passages[0]!.before.end), 'denies');
  assert.equal(before.slice(lines.passages[0]!.before.start, lines.passages[0]!.before.end), 'The court denies relief.\n');
});

test('unchanged context separates passages; removals, additions and full replacements remain ordered', () => {
  for (const [before, after] of [['a\nx\nb\ny\nc\n', 'a\nxx\nb\nyy\nc\n'], ['middle', 'prefix middle suffix'], ['first\nsecond\n', 'third\nfourth\n']]) {
    const result = check(before!, after!, 'lines');
    assert.ok(result.passages.every((value, index) => index === 0 || result.passages[index - 1]!.segmentEnd < value.segmentStart));
  }
  assert.equal(check('a\nx\nb\ny\nc\n', 'a\nxx\nb\nyy\nc\n', 'lines').passages.length, 2);
});

test('inputs and caller budgets are immutable, including frozen source records', () => {
  const before = Object.freeze(file('One word.')), after = Object.freeze(file('Two words.'));
  const limits = Object.freeze({ maxComparisons: 100 });
  const original = structuredClone({ before, after, limits });
  const result = ready(compareFile(before, after, 'words', limits)); result.segments[0]!.text = 'Edited result only';
  assert.deepEqual({ before, after, limits }, original);
  assert.equal(Object.isFrozen(COMPARISON_LIMITS), true);
});

test('selected path is explicit and cannot silently compare a different or absent file', () => {
  assert.throws(() => compareFile(null, null), /at least one version/);
  assert.throws(() => compareFile(file('same', 'a.tex'), file('same', 'b.tex')), /same exact file path/);
  assert.throws(() => compareFile(undefined as unknown as ComparisonFile, file('')), RangeError);
  assert.throws(() => compareFile({ path: '', content: '' }, file('')), RangeError);
  assert.throws(() => compareFile({ path: 'a', content: 42 } as unknown as ComparisonFile, null), RangeError);
  assert.throws(() => compareFile(file('a'), file('b'), 'semantic' as ComparisonMode), RangeError);
  // Other files are not inputs, so the helper never reads their content.
  const untouched = { get content(): string { throw new Error('Unselected file read'); }, path: 'unselected.tex' };
  const sources = [file('selected'), untouched]; assert.equal(ready(compareFile(sources[0]!, file('selected'))).fileChange, 'unchanged');
});

test('input and source-line budgets reject before tokenization or diff work', () => {
  const input = tooLarge('x'.repeat(COMPARISON_LIMITS.maxInputCodeUnits + 1), '', 'input_code_units');
  assert.equal(input.metrics.tokens, null); assert.equal(input.metrics.sourceLines, null); assert.equal(input.metrics.comparisons, 0);
  const lines = tooLarge('\n'.repeat(COMPARISON_LIMITS.maxSourceLines + 1), '', 'source_lines');
  assert.equal(lines.metrics.tokens, null); assert.equal(lines.metrics.comparisons, 0);
  assert.equal(ready(compareFile(file('aa'), file('aa'), 'words', { maxInputCodeUnits: 4 })).fileChange, 'unchanged');
  tooLarge('aa', 'aa', 'input_code_units', { maxInputCodeUnits: 3 });
});

test('token, edit-distance and deterministic comparator budgets independently stop work', () => {
  const tokens = tooLarge('a '.repeat(20_001), '', 'tokens'); assert.equal(tokens.metrics.comparisons, 0);
  tooLarge('one', 'two', 'edit_length', { maxEditLength: 1 });
  assert.equal(ready(compareFile(file('one'), file('two'), 'words', { maxEditLength: 2 })).passages.length, 1);
  const comparisons = tooLarge('a b c d e f', 'a b c d e g', 'comparisons', { maxComparisons: 3 });
  assert.equal(comparisons.metrics.comparisons, 3);
  assert.equal(ready(compareFile(file('a'), file('a'), 'words', { maxComparisons: 1 })).metrics.comparisons, 1);
});

test('render, segment and passage limits return an explicit failure without partial text', () => {
  tooLarge('a b', 'a c', 'segments', { maxSegments: 2 });
  tooLarge('a\nx\nb\ny\nc\n', 'a\nxx\nb\nyy\nc\n', 'passages', { maxPassages: 1 }, 'lines');
  tooLarge('word', 'other', 'rendered_code_units', { maxRenderedCodeUnits: 8 });
  assert.equal(ready(compareFile(file('word'), file('other'), 'words', { maxRenderedCodeUnits: 9 })).passages.length, 1);
  tooLarge('x'.repeat(120_001), '', 'rendered_code_units');
});

test('pathological differing and repetitive inputs terminate deterministically within budgets', () => {
  const fixtures = [
    ['a '.repeat(8_000), 'b '.repeat(8_000)],
    [Array.from({ length: 4_000 }, (_, index) => `old${index}`).join(' '), Array.from({ length: 4_000 }, (_, index) => `new${index}`).join(' ')],
    ['a b '.repeat(4_000), 'b a '.repeat(4_000)],
  ];
  for (const [before, after] of fixtures) {
    const first = compareFile(file(before!), file(after!));
    assert.deepEqual(compareFile(file(before!), file(after!)), first);
    assert.ok(first.metrics.comparisons <= COMPARISON_LIMITS.maxComparisons);
    if (first.status === 'ready') check(before!, after!);
    else assert.ok(['comparisons', 'edit_length', 'segments', 'passages'].includes(first.reason));
  }
  assert.equal(compareFile(file(fixtures[0]![0]!), file(fixtures[0]![1]!)).status, 'too_large');
});

test('invalid or expanded budgets cannot remove the fixed safety ceilings', () => {
  for (const value of [-1, 0.5, Infinity, NaN, COMPARISON_LIMITS.maxTokens + 1]) assert.throws(() => compareFile(file('a'), file('b'), 'words', { maxTokens: value }), RangeError);
  assert.throws(() => compareFile(file('a'), file('b'), 'words', { inventedLimit: 1 } as Partial<ComparisonLimits>), RangeError);
});

test('deterministic generated literal fixtures reconstruct both sources and retain monotonic passage ranges', () => {
  const alphabet = ['a', 'b', ' ', '\t', '\r\n', '\n', '😀', 'é', 'e\u0301', '{', '}', '\\', '中'];
  let seed = 112358;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < 160; index++) {
    const text = () => Array.from({ length: next() % 24 }, () => alphabet[next() % alphabet.length]!).join('');
    const before = text(), after = text();
    check(before, after, 'words'); check(after, before, 'words'); check(before, after, 'lines'); check(after, before, 'lines');
  }
});
