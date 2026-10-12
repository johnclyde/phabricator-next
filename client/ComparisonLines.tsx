import { useMemo } from 'react';
import type { ReadyComparison } from '../shared/comparison';
import { comparisonLineRows } from './comparison-lines';

export interface ComparisonLinesProps {
  comparison: ReadyComparison;
  projectedWord?: boolean;
  passageIndex: number;
  canComment: boolean;
  onLine: (line: number) => void;
  selectedLine: number | null;
}

export default function ComparisonLines({ comparison, passageIndex, canComment, onLine, selectedLine, projectedWord = false }: ComparisonLinesProps) {
  const rows = useMemo(() => comparisonLineRows(comparison), [comparison]);
  if (!rows.length) return <p className="info-strip">{projectedWord ? comparison.fileChange === 'added' ? 'Empty scope added.' : comparison.fileChange === 'removed' ? 'Empty scope removed.' : 'This projected scope is empty on both sides.' : comparison.fileChange === 'added' ? 'Empty file added.' : comparison.fileChange === 'removed' ? 'Empty file removed.' : 'This file is empty on both sides.'}</p>;
  return <div className="diff-scroll literal-line-diff" tabIndex={0} aria-label={projectedWord ? "Selected Word scope comparison" : "Selected file comparison"}>
    <table className="diff-table"><thead><tr><th scope="col" className="line-number old-number">Base</th><th scope="col" className="line-number">Target</th><th scope="col" className="diff-sign" aria-label="Change"/><th scope="col">{projectedWord ? 'Projected text' : 'Source text'}</th></tr></thead><tbody>{rows.map((row, index) => <tr
      key={index}
      className={`${row.kind === 'unchanged' ? 'context' : row.kind}${row.passageIndex === passageIndex ? ' active-change' : ''}${row.afterLine !== null && row.afterLine === selectedLine ? ' selected-line' : ''}`}
      data-change-passage={row.passageIndex ?? undefined}
      data-line-ending={row.ending}
    >
      <td className="line-number old-number">{row.beforeLine}</td>
      <td className="line-number">{row.afterLine !== null ? projectedWord ? row.afterLine : <button type="button" disabled={!canComment} aria-label={canComment ? `Comment on line ${row.afterLine}` : `Line ${row.afterLine}`} onClick={() => { if (canComment) onLine(row.afterLine!); }}>{row.afterLine}</button> : null}</td>
      <td className="diff-sign" aria-label={row.kind === 'added' ? 'Added' : row.kind === 'removed' ? 'Removed' : 'Unchanged'}>{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</td>
      <td className="diff-code"><pre>{row.text}</pre>{row.ending === 'none' && <span className="diff-no-newline">No newline at end of {row.kind === 'removed' ? 'base' : row.kind === 'added' ? 'target' : 'either'} {projectedWord ? 'scope' : 'file'}.</span>}</td>
    </tr>)}</tbody></table>
  </div>;
}
