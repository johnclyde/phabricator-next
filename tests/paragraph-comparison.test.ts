import test from 'node:test';
import assert from 'node:assert/strict';
import { compareParagraphFile, PARAGRAPH_COMPARISON_LIMITS, type ParagraphComparison, type ReadyParagraphComparison } from '../shared/paragraph-comparison.ts';
import { COMPARISON_LIMITS, compareFile, type ComparisonFile, type ComparisonLimits, type ComparisonRange } from '../shared/comparison.ts';
import { comparisonPassages } from '../shared/comparison-navigation.ts';
import { createPassageAnchor } from '../shared/anchors.ts';
import type { RevisionVersion } from '../shared/types.ts';

const file = (content: string, path = 'paper.tex'): ComparisonFile => ({ path, content });
const ready = (value: ParagraphComparison): ReadyParagraphComparison => { if (value.status !== 'ready') assert.fail(`Expected a complete comparison, got ${value.reason}.`); return value; };
function check(before: string, after: string, overrides: Partial<ComparisonLimits> = {}) {
  const result = ready(compareParagraphFile(file(before), file(after), overrides));
  assert.equal(result.mode, 'words'); assert.equal(result.alignment, 'source-paragraphs');
  assert.equal(result.segments.filter(segment => segment.kind !== 'added').map(segment => segment.text).join(''), before);
  assert.equal(result.segments.filter(segment => segment.kind !== 'removed').map(segment => segment.text).join(''), after);
  let oldOffset = 0, newOffset = 0, previousPassageEnd = 0;
  const boundary = (text: string, range: ComparisonRange) => {
    assert.ok(Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end) && range.start >= 0 && range.end >= range.start && range.end <= text.length);
    for (const offset of [range.start, range.end]) assert.equal(/[\uD800-\uDBFF]/.test(text[offset - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[offset] ?? ''), false, 'Never bisect a valid Unicode pair.');
  };
  for (const segment of result.segments) {
    assert.equal(segment.before.start, oldOffset); assert.equal(segment.after.start, newOffset);
    assert.equal(before.slice(segment.before.start, segment.before.end), segment.kind === 'added' ? '' : segment.text);
    assert.equal(after.slice(segment.after.start, segment.after.end), segment.kind === 'removed' ? '' : segment.text);
    boundary(before, segment.before); boundary(after, segment.after); oldOffset = segment.before.end; newOffset = segment.after.end;
  }
  assert.equal(oldOffset, before.length); assert.equal(newOffset, after.length);
  for (const passage of result.passages) {
    assert.ok(passage.segmentStart >= previousPassageEnd && passage.segmentEnd > passage.segmentStart);
    const segments = result.segments.slice(passage.segmentStart, passage.segmentEnd);
    assert.ok(segments.every(segment => segment.kind !== 'unchanged'));
    assert.equal(before.slice(passage.before.start, passage.before.end), segments.filter(segment => segment.kind === 'removed').map(segment => segment.text).join(''));
    assert.equal(after.slice(passage.after.start, passage.after.end), segments.filter(segment => segment.kind === 'added').map(segment => segment.text).join(''));
    previousPassageEnd = passage.segmentEnd;
  }
  const ids = new Set<string>();
  for (const match of result.reordered) {
    assert.equal(ids.has(match.id), false); ids.add(match.id);
    assert.equal(before.slice(match.before.start, match.before.end), after.slice(match.after.start, match.after.end));
    assert.ok(match.before.end > match.before.start); boundary(before, match.before); boundary(after, match.after);
    for (const [side, segmentIndex, passageIndex, kind] of [['before', match.beforeSegment, match.beforePassage, 'removed'], ['after', match.afterSegment, match.afterPassage, 'added']] as const) {
      const segment = result.segments[segmentIndex]!, passage = result.passages[passageIndex]!;
      assert.equal(segment.kind, kind); assert.ok(segment[side].start <= match[side].start && segment[side].end >= match[side].end);
      assert.ok(passage.segmentStart <= segmentIndex && passage.segmentEnd > segmentIndex);
    }
  }
  assert.ok(result.metrics.comparisons <= (overrides.maxComparisons ?? COMPARISON_LIMITS.maxComparisons));
  return result;
}
function limited(before: string, after: string, reason: string, overrides: Partial<ComparisonLimits> = {}) {
  const result = compareParagraphFile(file(before), file(after), overrides);
  assert.equal(result.status, 'too_large'); assert.equal(result.status === 'too_large' && result.reason, reason);
  for (const property of ['segments', 'passages', 'reordered', 'alignment']) assert.equal(property in result, false, 'No partially completed reading aid is returned.');
  return result;
}
const alpha = 'Alpha exact paragraph.', beta = 'Beta distinct paragraph.', conclusion = 'Conclusion stays.';

test('alignment precedes word refinement and links complete exact bodies across a swap', () => {
  const before = 'The first finding is exact.\n\nThe second finding is exact.\n\nConclusion remains.\n', after = 'The second finding is exact.\n\nThe first finding is exact.\n\nConclusion remains.\n';
  const literal = compareFile(file(before), file(after)); assert.equal(literal.status, 'ready');
  if (literal.status === 'ready') assert.deepEqual(literal.passages.map(passage => before.slice(passage.before.start, passage.before.end)), ['first', 'second']);
  const result = check(before, after); assert.equal(result.reordered.length, 1);
  const match = result.reordered[0]!;
  assert.equal(before.slice(match.before.start, match.before.end), 'The first finding is exact.');
  assert.equal(match.before.start, 0); assert.equal(match.after.start, after.indexOf('The first'));
  assert.deepEqual(comparisonPassages(result, false).indexes, [0, 1]);
  assert.deepEqual(compareParagraphFile(file(before), file(after)), result, 'Backbone ties are deterministic.');
});

test('in-place paragraph edits retain fine word differences and offset shifts are not reorderings', () => {
  const before = `${alpha}\n\nThe court denies relief.\n\n${conclusion}\n`, after = `New opening.\n\n${alpha}\n\nThe court grants relief.\n\n${conclusion}\n`;
  const result = check(before, after); assert.deepEqual(result.reordered, []);
  assert.ok(result.segments.some(segment => segment.kind === 'removed' && segment.text === 'denies'));
  assert.ok(result.segments.some(segment => segment.kind === 'added' && segment.text === 'grants'));
  assert.deepEqual(check(`${alpha}\n\n${beta}`, `Prefix.\n\n${alpha}\n\n${beta}`).reordered, []);
});

test('repeated paragraphs, copies and edited relocations never receive inferred correspondence', () => {
  const repeated = 'Repeated exact paragraph.';
  for (const [before, after] of [
    [`${repeated}\n\n${repeated}\n\n${conclusion}`, `${repeated}\n\n${conclusion}\n\n${repeated}`],
    [`${alpha}\n\n${beta}`, `${alpha}\n\n${beta}\n\n${alpha}`],
    [`${alpha}\n\n${beta}\n\n${alpha}`, `${beta}\n\n${alpha}`],
    [`${alpha}\n\n${beta}\n\n${conclusion}`, `${beta}\n\nAlpha edited paragraph.\n\n${conclusion}`],
  ]) {
    const result = check(before!, after!);
    assert.deepEqual(result.reordered, [], JSON.stringify([before, after]));
  }
});

test('source blocks preserve LaTeX commands, internal CRLF, indentation and literal separators', () => {
  const tex = '  \\section{A}\\label{sec:a}\r\nA \\emph{literal} claim 😀.  ', other = '\\begin{equation} x = y \\end{equation}';
  const before = ` \t\r\n${tex}\r\n \t\r\n${other}\r\n\r\nTail.\r\n`, after = `${other}\r\n\r\n${tex}\n\t\nTail.`;
  const result = check(before, after); assert.equal(result.reordered.length, 1);
  const match = result.reordered[0]!; assert.equal(before.slice(match.before.start, match.before.end), tex);
  assert.equal(after.slice(match.after.start, match.after.end), tex);
  assert.ok(result.passages.length > 0); assert.ok(result.segments.some(segment => segment.text.includes('\r\n')));
  assert.deepEqual(check('A\rB\rC', 'C\rA\rB').reordered, [], 'Bare CR does not create source paragraphs.');
  // TeX comments and environments are unexecuted source; physical blank lines,
  // not a speculative TeX parser, define this optional alignment.
  check('\\begin{verbatim}\n\n% literal text\n\n\\end{verbatim}', '% literal text\n\n\\begin{verbatim}\n\n\\end{verbatim}');
});

test('line endings, final newline, Unicode normalization and non-ASCII spaces remain significant', () => {
  for (const [before, after] of [['A\r\n\r\nB\r\n', 'A\n\nB\n'], ['A\n', 'A'], ['A\n \t\nB', 'A\n\nB'], ['café 😀 e\u0301\n\nLast', 'cafe 😃 é\n\nLast'], ['\ud800 lone\n\n\udc00 low', '\udc00 low\n\n\ud800 lone'], ['a\u00a0b\n\nLast', 'a b\n\nLast']]) {
    const result = check(before!, after!); assert.equal(result.fileChange, 'modified'); assert.ok(result.passages.length > 0);
  }
  const noNormalization = check('e\u0301\n\nStable', 'Stable\n\né'); assert.deepEqual(noNormalization.reordered, []);
});

test('all body and separator edges align with literal tokens without stripping whitespace', () => {
  for (const trailing of ['', ' ', '\t', ' \t ', '\u00a0', '\u2003', '\r']) for (const separator of ['\n\n', '\r\n\r\n', '\n \t\n', '\r\n\t \r\n']) for (const final of ['', '\n', '\r\n']) {
    const body = ` \t😀 exact${trailing}`, before = `${body}${separator}${beta}${separator}${conclusion}${final}`, after = `${beta}${separator}${body}${separator}${conclusion}${final}`;
    const result = check(before, after); assert.equal(result.reordered.length, 1);
    // A trailing bare CR followed by LF is, by definition, the CRLF separator.
    const expected = trailing === '\r' && separator.startsWith('\n') ? body.slice(0, -1) : body;
    assert.equal(before.slice(result.reordered[0]!.before.start, result.reordered[0]!.before.end), expected);
    check(before, `${after} \t`);
  }
  assert.deepEqual(check('A\n\u00a0\nB', 'B\n\u00a0\nA').reordered, [], 'A non-ASCII-space line is significant body text, not a blank delimiter.');
  assert.deepEqual(check('A\n\u2003\nB', 'B\n\u2003\nA').reordered, []);
});

test('a gap containing an exact reordered body keeps nearby ordinary edits coarse and completely literal', () => {
  const before = `${alpha}\n\n${beta}\n\nOld side text.\n\n${conclusion}`, after = `${beta}\n\n${alpha}\n\nNew side text.\n\n${conclusion}`;
  const result = check(before, after); assert.equal(result.reordered.length, 1);
  assert.equal(before.slice(result.reordered[0]!.before.start, result.reordered[0]!.before.end), alpha);
  assert.ok(result.segments.some(segment => segment.kind === 'removed' && segment.text.includes('Old side text.')));
  assert.ok(result.segments.some(segment => segment.kind === 'added' && segment.text.includes(alpha) && segment.text.includes('New side text.')));
  assert.equal(result.segments.some(segment => segment.text === 'Old' || segment.text === 'New'), false, 'No cross-body word matching fragments the reordered source.');
});

test('equal, reversed, absent and empty sources retain exact presence without synthesizing matches', () => {
  const before = `${alpha}\n\n${beta}\n\n${conclusion}\n`, after = `${beta}\n\n${alpha}\n\n${conclusion}\n`;
  assert.equal(check(before, after).reordered.length, 1); assert.equal(check(after, before).reordered.length, 1);
  const same = check(before, before); assert.equal(same.fileChange, 'unchanged'); assert.deepEqual(same.reordered, []); assert.deepEqual(same.passages, []);
  for (const content of ['', ' \t\r\n', before]) {
    const added = ready(compareParagraphFile(null, file(content))), removed = ready(compareParagraphFile(file(content), null));
    assert.equal(added.fileChange, 'added'); assert.equal(removed.fileChange, 'removed'); assert.equal(added.beforePresent, false); assert.equal(removed.afterPresent, false);
    assert.equal(added.segments.map(segment => segment.text).join(''), content); assert.equal(removed.segments.map(segment => segment.text).join(''), content);
    assert.deepEqual(added.reordered, []); assert.deepEqual(removed.reordered, []); check('', content); check(content, '');
  }
  const zero = Object.fromEntries(Object.keys(COMPARISON_LIMITS).map(key => [key, 0])); assert.deepEqual(ready(compareParagraphFile(file(''), file(''), zero)).segments, []);
});

test('reordered ranges remain valid exact target source anchors and never rewrite input versions', () => {
  const before = `${alpha}\n\n${beta}\n\n${conclusion}`, after = `${beta}\n\n${alpha}\n\n${conclusion}`;
  const version = { id: 'target-v2', revisionId: 'P1', number: 2, contentHash: 'b'.repeat(64), files: [file(after)], message: 'Moved source', createdAt: '2026-10-12T00:00:00Z' } as RevisionVersion;
  const snapshot = structuredClone(version); const result = check(before, after), moved = result.reordered[0]!;
  const anchor = createPassageAnchor(version, 'paper.tex', { ...moved.after, quote: after.slice(moved.after.start, moved.after.end) });
  assert.equal(anchor.versionId, version.id); assert.equal(anchor.contentHash, version.contentHash); assert.equal(anchor.quote, alpha); assert.deepEqual(version, snapshot);
  const frozenBefore = Object.freeze(file(before)), frozenAfter = Object.freeze(file(after)), budget = Object.freeze({ maxComparisons: 100 });
  const inputSnapshot = structuredClone({ frozenBefore, frozenAfter, budget }); const another = ready(compareParagraphFile(frozenBefore, frozenAfter, budget)); another.reordered[0]!.before.start = 999;
  assert.deepEqual({ frozenBefore, frozenAfter, budget }, inputSnapshot); assert.equal(check(before, after).reordered[0]!.before.start, 0);
});

test('whole-source input, line and paragraph caps reject before tokenization with no partial output', () => {
  assert.equal(limited('x'.repeat(COMPARISON_LIMITS.maxInputCodeUnits + 1), '', 'input_code_units').metrics.tokens, null);
  assert.equal(limited('\n'.repeat(COMPARISON_LIMITS.maxSourceLines + 1), '', 'source_lines').metrics.tokens, null);
  const paragraphs = Array.from({ length: PARAGRAPH_COMPARISON_LIMITS.maxParagraphs + 1 }, (_, index) => `P${index}`).join('\n\n');
  assert.equal(limited(paragraphs, '', 'paragraphs').metrics.tokens, null);
  const half = Array.from({ length: PARAGRAPH_COMPARISON_LIMITS.maxParagraphs / 2 + 1 }, (_, index) => `P${index}`).join('\n\n');
  limited(half, half, 'paragraphs');
  assert.equal(check('aa', 'aa', { maxInputCodeUnits: 4 }).fileChange, 'unchanged'); limited('aa', 'aa', 'input_code_units', { maxInputCodeUnits: 3 });
});

test('aggregate token and edit budgets include unchanged bodies and every refined gap', () => {
  limited('a '.repeat(20_001), '', 'tokens'); limited('a b', 'a b', 'tokens', { maxTokens: 5 });
  // Each separate changed gap needs only two edits. Their combined four edits
  // must not fit a three-edit allowance through independent helper calls.
  const before = 'Start.\n\nold\n\nMiddle.\n\nold2\n\nEnd.', after = 'Start.\n\nnew\n\nMiddle.\n\nnew2\n\nEnd.';
  limited(before, after, 'edit_length', { maxEditLength: 3 }); check(before, after, { maxEditLength: 4 });
  const swapped = `${alpha}\n\n${beta}`, reversed = `${beta}\n\n${alpha}`;
  limited(swapped, reversed, 'edit_length', { maxEditLength: 1 });
});

test('comparison, segment, passage and render budgets apply to the whole aligned result', () => {
  const before = 'Start.\n\nold\n\nMiddle.\n\nold2\n\nEnd.', after = 'Start.\n\nnew\n\nMiddle.\n\nnew2\n\nEnd.';
  const result = check(before, after); assert.ok(result.metrics.comparisons > 2);
  const bounded = limited(before, after, 'comparisons', { maxComparisons: result.metrics.comparisons - 1 }); assert.equal(bounded.metrics.comparisons, result.metrics.comparisons - 1);
  limited(before, after, 'segments', { maxSegments: result.segments.length - 1 }); limited(before, after, 'passages', { maxPassages: 1 });
  const rendered = result.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  limited(before, after, 'rendered_code_units', { maxRenderedCodeUnits: rendered - 1 }); check(before, after, { maxRenderedCodeUnits: rendered });
  limited('x'.repeat(120_001), '', 'rendered_code_units');
});

test('invalid sources and expanded or malformed budgets are rejected without reading another file', () => {
  assert.throws(() => compareParagraphFile(null, null), /at least one/); assert.throws(() => compareParagraphFile(file('a', 'one.tex'), file('a', 'two.tex')), /same exact file/);
  assert.throws(() => compareParagraphFile(undefined as unknown as ComparisonFile, file('')), RangeError); assert.throws(() => compareParagraphFile({ path: '', content: '' }, null), RangeError);
  for (const value of [-1, 0.5, Infinity, NaN, COMPARISON_LIMITS.maxTokens + 1]) assert.throws(() => compareParagraphFile(file('a'), file('b'), { maxTokens: value }), RangeError);
  assert.throws(() => compareParagraphFile(file('a'), file('b'), { invented: 1 } as Partial<ComparisonLimits>), RangeError); assert.equal(Object.isFrozen(PARAGRAPH_COMPARISON_LIMITS), true);
});

test('deterministic generated reorders and repeated source reconstruct exact strings within aggregate ceilings', () => {
  let seed = 271828; const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const pool = [alpha, beta, conclusion, '重复 😀 e\u0301', ' repeated ', '\\cite{key}', '\ud800 lone', 'internal\r\nline', 'a\u00a0b'];
  const endings = ['\n\n', '\r\n\r\n', '\n \t\n'];
  for (let run = 0; run < 150; run++) {
    const source = () => Array.from({ length: next() % 12 }, () => pool[next() % pool.length]!).join(endings[next() % endings.length]!);
    const before = source(), after = source(), result = check(before, after);
    assert.deepEqual(compareParagraphFile(file(before), file(after)), result); check(after, before);
  }
  const before = Array.from({ length: 700 }, (_, index) => `Paragraph ${index}`).join('\n\n'), after = before.split('\n\n').reverse().join('\n\n');
  const result = compareParagraphFile(file(before), file(after)); assert.equal(result.status, 'too_large'); if (result.status === 'too_large') assert.equal(result.reason, 'edit_length');
});
