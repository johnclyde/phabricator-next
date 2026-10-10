import type { ComparisonRange, ComparisonSegment, ReadyComparison } from '../shared/comparison';

export interface ComparisonLine {
  kind: ComparisonSegment['kind'];
  /** Exact source text for this row, including its LF/CRLF terminator if present. */
  text: string;
  ending: 'lf' | 'crlf' | 'none';
  beforeLine: number | null;
  afterLine: number | null;
  before: ComparisonRange;
  after: ComparisonRange;
  passageIndex: number | null;
}

/**
 * Expand a bounded literal line comparison once, preserving both source ranges.
 * Passage lookup advances monotonically instead of scanning all passages per row.
 * Empty files have no lines; a removed line never receives a target line number.
 */
export function comparisonLineRows(comparison: ReadyComparison): ComparisonLine[] {
  if (comparison.mode !== 'lines') throw new RangeError('Line rows require a literal line comparison.');
  const rows: ComparisonLine[] = [];
  let oldLine = 0, newLine = 0, passage = 0;
  comparison.segments.forEach((segment, segmentIndex) => {
    while (passage < comparison.passages.length && segmentIndex >= comparison.passages[passage]!.segmentEnd) passage++;
    const selected = comparison.passages[passage];
    const passageIndex = selected && segmentIndex >= selected.segmentStart && segmentIndex < selected.segmentEnd ? passage : null;
    let offset = 0;
    while (offset < segment.text.length) {
      const newline = segment.text.indexOf('\n', offset);
      const end = newline === -1 ? segment.text.length : newline + 1;
      const text = segment.text.slice(offset, end);
      const removed = segment.kind === 'removed', added = segment.kind === 'added';
      rows.push({
        kind: segment.kind, text,
        ending: text.endsWith('\r\n') ? 'crlf' : text.endsWith('\n') ? 'lf' : 'none',
        beforeLine: added ? null : ++oldLine,
        afterLine: removed ? null : ++newLine,
        before: { start: segment.before.start + (added ? 0 : offset), end: segment.before.start + (added ? 0 : end) },
        after: { start: segment.after.start + (removed ? 0 : offset), end: segment.after.start + (removed ? 0 : end) },
        passageIndex,
      });
      offset = end;
    }
  });
  return rows;
}
