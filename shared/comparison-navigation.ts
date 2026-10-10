import type { ReadyComparison } from './comparison.ts';

/**
 * Filter navigation only: comparison text, passage indexes and UTF-16 offsets
 * remain literal evidence. Each changed segment is visited once; work is bounded
 * by the existing ready comparison's passage and rendered-text limits.
 */
export function comparisonPassages(result: ReadyComparison, skipSpaceTabOnly: boolean): { indexes: number[]; skipped: number } {
  const indexes: number[] = [];
  let skipped = 0;
  const filter = skipSpaceTabOnly && result.beforePresent && result.afterPresent;
  result.passages.forEach((passage, index) => {
    if (filter) {
      const before: string[] = [], after: string[] = [];
      for (let segmentIndex = passage.segmentStart; segmentIndex < passage.segmentEnd; segmentIndex++) {
        const segment = result.segments[segmentIndex]!;
        if (segment.kind === 'removed') before.push(segment.text);
        if (segment.kind === 'added') after.push(segment.text);
      }
      const oldText = before.join(''), newText = after.join('');
      if (oldText !== newText && oldText.replace(/[ \t]/g, '') === newText.replace(/[ \t]/g, '')) {
        skipped++;
        return;
      }
    }
    indexes.push(index);
  });
  return { indexes, skipped };
}
