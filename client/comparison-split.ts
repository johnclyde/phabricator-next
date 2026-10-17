import type { ComparisonRange, ComparisonSegment, ReadyComparison } from '../shared/comparison';
import type { ComparisonSide } from '../shared/comparison-discussion';

export interface SplitSourceFragment {
  text: string;
  kind: ComparisonSegment['kind'];
  range: ComparisonRange;
  segmentIndex: number;
  passageIndex: number | null;
}

export interface SplitSourceLine {
  number: number;
  /** Original text, including LF/CRLF when present. Bare CR remains source text. */
  text: string;
  range: ComparisonRange;
  ending: 'lf' | 'crlf' | 'none';
  fragments: SplitSourceFragment[];
}

export interface SplitSourceBlock {
  before: SplitSourceLine[];
  after: SplitSourceLine[];
}

/**
 * Present the existing comparison without a second diff or guessed line pairing.
 * Blocks align at unchanged source text on physical line boundaries. An edit spanning
 * unequal numbers of lines leaves space on the shorter side; all physical lines,
 * original offsets, word highlights and passage indexes remain exact.
 */
export function comparisonSplitBlocks(comparison: ReadyComparison): SplitSourceBlock[] {
  const blocks: SplitSourceBlock[] = [];
  let block: SplitSourceBlock = { before: [], after: [] };
  const pending: Record<ComparisonSide, SplitSourceFragment[]> = { before: [], after: [] };
  const numbers = { before: 0, after: 0 };
  let passageIndex = 0;
  const finishLine = (side: ComparisonSide) => {
    const fragments = pending[side];
    if (!fragments.length) return;
    const text = fragments.map(fragment => fragment.text).join('');
    block[side].push({
      number: ++numbers[side], text, fragments,
      range: { start: fragments[0]!.range.start, end: fragments.at(-1)!.range.end },
      ending: text.endsWith('\r\n') ? 'crlf' : text.endsWith('\n') ? 'lf' : 'none',
    });
    pending[side] = [];
  };
  const finishBlock = () => {
    if (block.before.length || block.after.length) blocks.push(block);
    block = { before: [], after: [] };
  };
  comparison.segments.forEach((segment, segmentIndex) => {
    while (passageIndex < comparison.passages.length && segmentIndex >= comparison.passages[passageIndex]!.segmentEnd) passageIndex++;
    const passage = comparison.passages[passageIndex];
    const changedPassage = passage && segmentIndex >= passage.segmentStart && segmentIndex < passage.segmentEnd ? passageIndex : null;
    let offset = 0;
    while (offset < segment.text.length) {
      const newline = segment.text.indexOf('\n', offset);
      const end = newline < 0 ? segment.text.length : newline + 1;
      const text = segment.text.slice(offset, end);
      // When both edits ended at a line boundary, the next unchanged source
      // line gets its own row instead of drifting upward on the shorter side.
      if (segment.kind === 'unchanged' && !pending.before.length && !pending.after.length) finishBlock();
      for (const side of ['before', 'after'] as const) {
        if ((side === 'before' && segment.kind === 'added') || (side === 'after' && segment.kind === 'removed')) continue;
        pending[side].push({ text, kind: segment.kind, segmentIndex, passageIndex: changedPassage, range: { start: segment[side].start + offset, end: segment[side].start + end } });
        if (text.endsWith('\n')) finishLine(side);
      }
      // Only an unchanged newline establishes an exact boundary on both sides.
      if (segment.kind === 'unchanged' && text.endsWith('\n')) finishBlock();
      offset = end;
    }
  });
  finishLine('before'); finishLine('after'); finishBlock();
  return blocks;
}
