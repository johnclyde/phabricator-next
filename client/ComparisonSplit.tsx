import { Fragment, useMemo } from 'react';
import { comparisonPassage, type ComparisonDiscussionPlacement, type ComparisonSide } from '../shared/comparison-discussion';
import ComparisonDiscussion from './ComparisonDiscussion';
import type { ComparisonLinesProps } from './ComparisonLines';
import { comparisonSplitBlocks, type SplitSourceLine } from './comparison-split';

/** Two source columns share exact unchanged boundaries, not inferred line matches. */
export default function ComparisonSplit({ comparison, passageIndex, canComment, onLine, selectedLine, projectedWord = false, discussion }: ComparisonLinesProps) {
  const blocks = useMemo(() => comparisonSplitBlocks(comparison), [comparison]);
  const inline = !projectedWord ? discussion : undefined;
  const threadLines = useMemo(() => {
    const result = new Map<string, ComparisonDiscussionPlacement[]>();
    for (const placement of inline?.placements || []) {
      let last: SplitSourceLine | undefined;
      for (const block of blocks) for (const line of block[placement.side]) {
        if (line.range.start < placement.anchor.end && line.range.end > placement.anchor.start) last = line;
      }
      if (last) {
        const key = `${placement.side}:${last.number}`;
        result.set(key, [...(result.get(key) || []), placement]);
      }
    }
    return result;
  }, [blocks, inline?.placements]);
  const gutter = (line: SplitSourceLine, side: ComparisonSide) => {
    if (projectedWord || (side === 'before' && !inline)) return line.number;
    if (!inline) return <button type="button" disabled={!canComment} aria-label={canComment ? `Comment on line ${line.number}` : `Line ${line.number}`} onClick={() => { if (canComment) onLine(line.number); }}>{line.number}</button>;
    const range = { start: line.range.start, end: line.range.end - (line.ending === 'crlf' ? 2 : line.ending === 'lf' ? 1 : 0) };
    const passage = comparisonPassage(inline.context, side, range);
    const version = side === 'before' ? inline.context.base : inline.context.target;
    const label = range.start === range.end ? `Empty ${side === 'before' ? 'base' : 'target'} line ${line.number}` : side === 'before' ? `Comment on base line ${line.number} · Version ${version?.number ?? '?'}` : `Comment on line ${line.number}`;
    return <button type="button" disabled={!canComment || passage.status !== 'ready'} aria-label={label}
      title={passage.status === 'unavailable' ? passage.message : `Comment on original version ${passage.versionNumber}`}
      onClick={() => { if (canComment && passage.status === 'ready') inline.onComment(side, range); }}>{line.number}</button>;
  };
  const renderLine = (line: SplitSourceLine, side: ComparisonSide) => <Fragment key={line.number}>
    <div className={`comparison-split-line${side === 'after' && line.number === selectedLine ? ' selected-line' : ''}`} data-source-line={line.number} data-line-ending={line.ending}>
      <span className="comparison-split-gutter">{gutter(line, side)}</span>
      <pre className="comparison-split-code" data-comparison-side={side} data-source-start={line.range.start} data-source-end={line.range.end}>{line.fragments.map((fragment, index) => {
        const Tag = fragment.kind === 'removed' ? 'del' : fragment.kind === 'added' ? 'ins' : 'span';
        return <Tag key={index} className={fragment.passageIndex !== null && fragment.passageIndex === passageIndex ? 'active-change' : undefined}
          data-comparison-segment={fragment.segmentIndex} data-change-passage={fragment.passageIndex ?? undefined}
          data-source-start={fragment.range.start} data-source-end={fragment.range.end}>{fragment.text}</Tag>;
      })}</pre>
    </div>
    {line.ending === 'none' && <p className="diff-no-newline comparison-split-no-newline">No newline at end of {side === 'before' ? 'base' : 'target'} {projectedWord ? 'scope' : 'file'}.</p>}
    {(threadLines.get(`${side}:${line.number}`) || []).map(placement => <ComparisonDiscussion key={placement.thread.id} placement={placement} versionNumber={(side === 'before' ? inline!.context.base : inline!.context.target)!.number} openThread={inline!.openThread}/>)}
  </Fragment>;
  const emptySide = (side: ComparisonSide) => {
    const present = side === 'before' ? comparison.beforePresent : comparison.afterPresent;
    const length = side === 'before' ? comparison.beforeLength : comparison.afterLength;
    if (length) return <span className="comparison-split-empty" aria-label={`No ${side === 'before' ? 'base' : 'target'} source in this block`}/>;
    return <p className="comparison-split-empty">{present ? projectedWord ? 'Empty scope' : 'Empty file' : projectedWord ? 'Scope absent in this version' : 'File absent in this version'}</p>;
  };
  const hasBlankLine = blocks.some(block => [...block.before, ...block.after].some(line => line.text === '\n' || line.text === '\r\n'));
  return <>
    <div className="diff-legend comparison-split-legend"><span><i className="removed-key"/>Removed text in base</span><span><i className="added-key"/>Added text in target</span></div>
    <p className="comparison-horizontal-hint">Swipe horizontally to see both versions.</p>
    {inline && hasBlankLine && <p className="comparison-comment-unavailable">Empty lines have no nonempty source passage. Comment on a neighboring passage or choose a line range in Source.</p>}
    <div className="comparison-split diff-scroll" tabIndex={0} aria-label={projectedWord ? 'Side-by-side Word scope comparison' : 'Side-by-side source comparison'}>
      <table className="comparison-split-table"><thead><tr><th scope="col">Base{inline?.context.base ? ` · Version ${inline.context.base.number}` : ''}</th><th scope="col">Target{inline?.context.target ? ` · Version ${inline.context.target.number}` : ''}</th></tr></thead><tbody>
        {(blocks.length ? blocks : [{ before: [], after: [] }]).map((block, index) => <tr className="comparison-split-block" key={index}>
          {(['before', 'after'] as const).map(side => <td className="comparison-split-cell" data-comparison-side={side} key={side}>{block[side].length ? block[side].map(line => renderLine(line, side)) : emptySide(side)}</td>)}
        </tr>)}
      </tbody></table>
    </div>
  </>;
}
