import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFile, type ComparisonMode, type ComparisonSegment, type ReadyComparison } from '../shared/comparison.ts';
import { compareParagraphFile } from '../shared/paragraph-comparison.ts';
import { comparisonSplitBlocks } from '../client/comparison-split.ts';

function verify(before: string | null, after: string | null, mode: ComparisonMode = 'words', source?: ReadyComparison) {
  const file = (content: string | null) => content === null ? null : { path: 'paper.tex', content };
  const comparison = source || compareFile(file(before), file(after), mode);
  if (comparison.status !== 'ready') assert.fail(`Expected ready, got ${comparison.reason}`);
  const original = structuredClone(comparison), blocks = comparisonSplitBlocks(comparison);
  for (const side of ['before', 'after'] as const) {
    const text = (side === 'before' ? before : after) || '';
    const lines = blocks.flatMap(block => block[side]);
    assert.equal(lines.map(line => line.text).join(''), text);
    let offset = 0;
    lines.forEach((line, index) => {
      assert.equal(line.number, index + 1);
      assert.equal(line.range.start, offset);
      assert.equal(line.range.end, offset + line.text.length);
      assert.equal(text.slice(line.range.start, line.range.end), line.text);
      assert.equal(line.fragments.map(fragment => fragment.text).join(''), line.text);
      assert.equal(line.text.indexOf('\n'), line.ending === 'none' ? -1 : line.text.length - 1, 'a row is exactly one physical source line');
      assert.equal(line.ending, line.text.endsWith('\r\n') ? 'crlf' : line.text.endsWith('\n') ? 'lf' : 'none');
      for (const fragment of line.fragments) {
        const segment: ComparisonSegment = comparison.segments[fragment.segmentIndex]!;
        assert.equal(text.slice(fragment.range.start, fragment.range.end), fragment.text);
        assert.equal(fragment.kind, segment.kind);
        assert.notEqual(fragment.kind, side === 'before' ? 'added' : 'removed');
        assert.ok(fragment.range.start >= segment[side].start && fragment.range.end <= segment[side].end);
        assert.equal(fragment.passageIndex === null, fragment.kind === 'unchanged');
        if (fragment.passageIndex !== null) {
          const passage = comparison.passages[fragment.passageIndex]!;
          assert.ok(fragment.segmentIndex >= passage.segmentStart && fragment.segmentIndex < passage.segmentEnd);
          assert.ok(fragment.range.start >= passage[side].start && fragment.range.end <= passage[side].end);
        }
      }
      offset = line.range.end;
    });
  }
  blocks.slice(0, -1).forEach((block, index) => {
    const next = blocks[index + 1]!;
    const sharedEnd = (['before', 'after'] as const).every(side => {
      const fragment = block[side].at(-1)?.fragments.at(-1);
      return fragment?.kind === 'unchanged' && fragment.text.endsWith('\n');
    });
    const sharedStart = (['before', 'after'] as const).every(side => next[side][0]?.fragments[0]?.kind === 'unchanged');
    assert.ok(sharedEnd || sharedStart, 'an exact unchanged boundary establishes alignment');
    for (const side of ['before', 'after'] as const) {
      const previous = block[side].at(-1);
      assert.ok(!previous || previous.text.endsWith('\n'), 'blocks never divide a physical source line');
    }
  });
  assert.deepEqual(comparison, original, 'presentation cannot mutate immutable comparison evidence');
  return blocks;
}

test('word split preserves entire physical lines while highlighting exact changes', () => {
  const blocks = verify('The old claim.\nUnchanged\nOld proof', 'The new claim.\nUnchanged\nNew proof');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]!.before[0]!.text, 'The old claim.\n');
  assert.equal(blocks[0]!.after[0]!.text, 'The new claim.\n');
  assert.deepEqual(blocks[0]!.before[0]!.fragments.filter(piece => piece.kind === 'removed').map(piece => piece.text), ['old']);
});

test('unequal changed blocks align only at exact shared boundaries and preserve independent numbering', () => {
  const blocks = verify('First\nold\nEnd\nLast', 'First\nnew\nextra\nEnd\nLast', 'lines');
  assert.equal(blocks.length, 4);
  assert.deepEqual(blocks[1]!.before.map(line => line.number), [2]);
  assert.deepEqual(blocks[1]!.after.map(line => line.number), [2, 3]);
  assert.equal(blocks[2]!.before[0]!.text, 'End\n');
  assert.equal(blocks[2]!.after[0]!.text, 'End\n');
  assert.equal(blocks[3]!.before[0]!.number, 4);
  assert.equal(blocks[3]!.after[0]!.number, 5);
});

test('CRLF, blank lines, bare CR, Unicode, leading whitespace and absent final newline remain exact', () => {
  for (const mode of ['words', 'lines'] as const) {
    const blocks = verify('😀 e\u0301\r\n\r\n  old\r', '😀 é\r\n\r\n  new\n', mode);
    assert.ok(blocks.flatMap(block => block.before).some(line => line.text === '\r\n' && line.ending === 'crlf'));
    assert.equal(blocks.at(-1)!.before.at(-1)!.ending, 'none');
    verify('one\r\ntwo', 'one\ntwo', mode);
    verify('\n', '\r\n', mode);
    verify('same', 'same\n', mode);
  }
});

test('added, deleted and empty files have no invented source line', () => {
  for (const mode of ['words', 'lines'] as const) {
    assert.deepEqual(verify('', '', mode), []);
    assert.deepEqual(verify(null, '', mode), []);
    assert.deepEqual(verify('', null, mode), []);
    assert.ok(verify(null, 'one\n\ntwo', mode).every(block => block.before.length === 0));
    assert.ok(verify('one\n\ntwo', null, mode).every(block => block.after.length === 0));
  }
});

test('reverse and source-paragraph comparisons retain original order and navigation passages', () => {
  const before = 'Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.', after = 'Beta paragraph.\n\nAlpha paragraph.\n\nGamma paragraph revised.';
  verify(before, after); verify(after, before);
  const aligned = compareParagraphFile({ path: 'paper.tex', content: before }, { path: 'paper.tex', content: after });
  if (aligned.status !== 'ready') assert.fail('Expected ready paragraph fixture');
  assert.ok(aligned.reordered.length > 0);
  verify(before, after, 'words', aligned);
});

test('bounded presentation scales with source lines and tolerates edits around newline boundaries', () => {
  const large = `${'same\r\n'.repeat(3_999)}last`;
  assert.equal(verify(large, large).length, 4_000);
  const pieces = ['a', ' b', '\n', '\r\n', '😀', '\t', '\r', 'é'];
  let seed = 2026;
  const pick = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return pieces[seed % pieces.length]!; };
  for (let index = 0; index < 80; index++) {
    let before = '', after = '';
    for (let part = 0; part < 18; part++) { before += pick(); after += part % 5 === 0 ? pick() : before.slice(-1); }
    verify(before, after);
    verify(before, after, 'lines');
  }
});
