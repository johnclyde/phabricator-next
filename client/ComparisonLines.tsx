import { Fragment, useMemo } from 'react';
import type { ComparisonRange, ReadyComparison } from '../shared/comparison';
import { comparisonPassage, type ComparisonDiscussionContext, type ComparisonDiscussionPlacement, type ComparisonSide } from '../shared/comparison-discussion';
import ComparisonDiscussion from './ComparisonDiscussion';
import { comparisonLineRows } from './comparison-lines';

export interface ComparisonLinesProps {
  comparison: ReadyComparison;
  projectedWord?: boolean;
  passageIndex: number;
  canComment: boolean;
  onLine: (line: number) => void;
  selectedLine: number | null;
  discussion?: {
    context: ComparisonDiscussionContext;
    placements: ComparisonDiscussionPlacement[];
    onComment: (side: ComparisonSide, range: ComparisonRange) => void;
    openThread: (threadId: string) => void;
  };
}

export default function ComparisonLines({ comparison, passageIndex, canComment, onLine, selectedLine, projectedWord = false, discussion }: ComparisonLinesProps) {
  const rows = useMemo(() => comparisonLineRows(comparison), [comparison]);
  const inline = !projectedWord ? discussion : undefined;
  const gutterPassages = useMemo(() => rows.map(row => {
    const forSide = (side: ComparisonSide) => {
      if (!inline || (side === 'before' ? row.beforeLine : row.afterLine) === null) return null;
      const range = { start: row[side].start, end: row[side].end - (row.ending === 'crlf' ? 2 : row.ending === 'lf' ? 1 : 0) };
      return { range, passage: comparisonPassage(inline.context, side, range) };
    };
    return { before: forSide('before'), after: forSide('after') };
  }), [rows, inline?.context]);
  const threadRows = useMemo(() => {
    const result = new Map<number, ComparisonDiscussionPlacement[]>();
    for (const placement of inline?.placements || []) {
      let last = -1;
      rows.forEach((row, index) => { const range = row[placement.side]; if (range.start < range.end && range.start < placement.anchor.end && range.end > placement.anchor.start) last = index; });
      if (last >= 0) result.set(last, [...(result.get(last) || []), placement]);
    }
    return result;
  }, [inline?.placements, rows]);
  const gutter = (row: typeof rows[number], index: number, side: ComparisonSide) => {
    const line = side === 'before' ? row.beforeLine : row.afterLine;
    if (line === null) return null;
    if (projectedWord || (side === 'before' && !inline)) return line;
    if (!inline) return <button type="button" disabled={!canComment} aria-label={canComment ? `Comment on line ${line}` : `Line ${line}`} onClick={() => { if (canComment) onLine(line); }}>{line}</button>;
    const { range, passage } = gutterPassages[index]![side]!;
    const empty = range.start === range.end;
    const version = side === 'before' ? inline.context.base : inline.context.target;
    const label = empty ? `Empty ${side === 'before' ? 'base' : 'target'} line ${line}` : side === 'before' ? `Comment on base line ${line} · Version ${version?.number ?? '?'}` : `Comment on line ${line}`;
    return <button type="button" disabled={!canComment || passage.status !== 'ready'} aria-label={label}
      title={passage.status === 'unavailable' ? passage.message : `Comment on original version ${passage.versionNumber}`}
      onClick={() => { if (canComment && passage.status === 'ready') inline.onComment(side, range); }}>{line}</button>;
  };
  if (!rows.length) return <p className="info-strip">{projectedWord ? comparison.fileChange === 'added' ? 'Empty scope added.' : comparison.fileChange === 'removed' ? 'Empty scope removed.' : 'This projected scope is empty on both sides.' : comparison.fileChange === 'added' ? 'Empty file added.' : comparison.fileChange === 'removed' ? 'Empty file removed.' : 'This file is empty on both sides.'}</p>;
  return <>{inline && rows.some(row => row.text === '\n' || row.text === '\r\n') && <p className="comparison-comment-unavailable">Empty lines have no nonempty source passage. Comment on a neighboring passage or choose a line range in Source.</p>}<div className={`diff-scroll literal-line-diff${inline ? ' has-inline-discussion' : ''}`} tabIndex={0} aria-label={projectedWord ? "Selected Word scope comparison" : "Selected file comparison"}>
    <table className="diff-table"><thead><tr><th scope="col" className="line-number old-number">Base</th><th scope="col" className="line-number">Target</th><th scope="col" className="diff-sign" aria-label="Change"/><th scope="col">{projectedWord ? 'Projected text' : 'Source text'}</th></tr></thead><tbody>{rows.map((row, index) => <Fragment key={index}><tr
      className={`${row.kind === 'unchanged' ? 'context' : row.kind}${row.passageIndex === passageIndex ? ' active-change' : ''}${row.afterLine !== null && row.afterLine === selectedLine ? ' selected-line' : ''}`}
      data-change-passage={row.passageIndex ?? undefined}
      data-line-ending={row.ending}
    >
      <td className="line-number old-number">{gutter(row, index, 'before')}</td>
      <td className="line-number">{gutter(row, index, 'after')}</td>
      <td className="diff-sign" aria-label={row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Unchanged'}>{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</td>
      <td className="diff-code"><pre>{row.text}</pre>{row.ending === 'none' && <span className="diff-no-newline">No newline at end of {row.kind === 'removed' ? 'base' : row.kind === 'added' ? 'target' : 'either'} {projectedWord ? 'scope' : 'file'}.</span>}</td>
    </tr>
      {(threadRows.get(index) || []).map(placement => <tr className="comparison-discussion-row" key={placement.thread.id}><td colSpan={4}><ComparisonDiscussion placement={placement} versionNumber={(placement.side === 'before' ? inline!.context.base : inline!.context.target)!.number} openThread={inline!.openThread}/></td></tr>)}
    </Fragment>)}</tbody></table>
  </div></>;
}
