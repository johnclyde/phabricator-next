import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ComparisonLines from './ComparisonLines';
import { compareFile } from '../shared/comparison';
import type { RevisionDetail, RevisionVersion, SourceFile } from '../shared/types';
import type { ComparisonVoiceAction } from './voice';
import { comparisonNarration, type ComparisonVoiceSnapshot } from './comparison-voice';
import { comparisonPaths, versionIdentity, type ComparisonSelection } from './comparison-model';

export type ComparisonAction = ComparisonVoiceAction;
export interface ComparisonController { identity: string; snapshot: ComparisonVoiceSnapshot; execute: (action: ComparisonAction) => string }
export type RegisterComparison = (controller: ComparisonController | null) => void;
export function ComparisonPicker({ detail, selection, change, current }: { detail: RevisionDetail; selection: ComparisonSelection; change: (selection: ComparisonSelection) => void; current: () => void }) {
  const base = detail.versions.find(item => item.id === selection.base?.id) || null;
  const target = detail.versions.find(item => item.id === selection.target.id);
  const paths = target ? comparisonPaths(base, target) : [];
  const pick = (side: 'base' | 'target', number: number) => {
    const chosen = detail.versions.find(item => item.number === number);
    if (side === 'target' && !chosen) return;
    const next = { ...selection, [side]: chosen ? versionIdentity(chosen) : null } as ComparisonSelection;
    const nextTarget = side === 'target' ? chosen : target;
    const nextBase = side === 'base' ? chosen || null : base;
    if (nextTarget) { const union = comparisonPaths(nextBase, nextTarget); if (!union.includes(next.filePath)) next.filePath = union[0] || ''; }
    change(next);
  };
  return <>
    <div className="comparison-toolbar">
      <label>Compare<select aria-label="Base version" value={base?.number ?? (selection.base ? 'unavailable' : 0)} onChange={event => pick('base', Number(event.target.value))}><option value={0}>Empty base</option>{selection.base && !base && <option value="unavailable">Unavailable selected version</option>}{detail.versions.map(item => <option key={item.id} value={item.number}>Version {item.number}</option>)}</select></label>
      <button type="button" className="button" disabled={!base || !target} onClick={() => change({ ...selection, base: selection.target, target: selection.base! })}>Swap versions</button>
      <label>With<select aria-label="Version to inspect" value={target?.number ?? 'unavailable'} onChange={event => pick('target', Number(event.target.value))}>{!target && <option value="unavailable">Unavailable selected version</option>}{detail.versions.map(item => <option key={item.id} value={item.number}>Version {item.number}{item.number === detail.revision.currentVersion ? ' · current' : ''}</option>)}</select></label>
      <button type="button" className="text-button" onClick={current}>Show current version</button>
      <div className="segmented"><button className={selection.view === 'changes' ? 'selected' : ''} onClick={() => change({ ...selection, view: 'changes' })}>Changes</button><button className={selection.view === 'source' ? 'selected' : ''} onClick={() => change({ ...selection, view: 'source' })}>Source</button>{detail.revision.kind === 'paper' && <button className={selection.view === 'structure' ? 'selected' : ''} onClick={() => change({ ...selection, view: 'structure' })}>Structure</button>}</div>
    </div>
    <div className="file-toolbar"><label>File<select aria-label="Source file" value={selection.filePath} onChange={event => change({ ...selection, filePath: event.target.value })}>{!paths.includes(selection.filePath) && <option value={selection.filePath}>Unavailable selected file</option>}{paths.map(path => <option key={path}>{path}</option>)}</select></label><label>Compare text<select aria-label="Comparison mode" value={selection.mode} onChange={event => change({ ...selection, mode: event.target.value as ComparisonSelection['mode'] })}><option value="words">Words</option><option value="lines">Lines</option></select></label><span className="content-hash" title={selection.target.contentHash}>Target snapshot {selection.target.contentHash.slice(0, 10)}</span></div>
  </>;
}
function downloadSource(file: SourceFile, side: string) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${side}-${file.path.split('/').pop() || 'source.txt'}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Comparison({ revisionId, base, target, selection, register, children, canComment, onLine, selectedLine }: { canComment: boolean; onLine: (line: number) => void; selectedLine: number | null; revisionId: string; base: RevisionVersion | null; target: RevisionVersion; selection: ComparisonSelection; register: RegisterComparison; children?: React.ReactNode }) {
  const before = base?.files.find(file => file.path === selection.filePath) || null;
  const after = target.files.find(file => file.path === selection.filePath) || null;
  const result = useMemo(() => compareFile(before, after, selection.mode), [before, after, selection.mode]);
  const [passageIndex, setPassageIndex] = useState(0); const cursor = useRef(0);
  const count = result.status === 'ready' ? result.passages.length : 0;
  const identity = JSON.stringify([revisionId, selection.base, selection.target, selection.filePath, selection.mode, selection.view]);
  const snapshot: ComparisonVoiceSnapshot = { revisionId, base: base && { id: base.id, number: base.number, contentHash: base.contentHash }, target: { id: target.id, number: target.number, contentHash: target.contentHash }, filePath: selection.filePath, result, passageIndex };
  const move = (next: number) => { const bounded = Math.max(0, Math.min(count - 1, next)); cursor.current = bounded; setPassageIndex(bounded); requestAnimationFrame(() => document.querySelector(`[data-change-passage="${bounded}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); return bounded; };
  useLayoutEffect(() => { register({ identity, snapshot, execute: action => {
    if (action === 'changes') return comparisonNarration({ ...snapshot, passageIndex: cursor.current });
    if (action === 'currentChange') return comparisonNarration({ ...snapshot, passageIndex: cursor.current }, 'current');
    const proposed = cursor.current + (action === 'nextChange' ? 1 : -1);
    if (result.status === 'too_large' || !count) return comparisonNarration({ ...snapshot, passageIndex: cursor.current }, 'current');
    if (proposed < 0 || proposed >= count) return proposed < 0 ? 'Already at the first change.' : 'Already at the last change.';
    return comparisonNarration({ ...snapshot, passageIndex: move(proposed) }, 'current');
  } }); });
  useLayoutEffect(() => () => register(null), [register]);
  useEffect(() => { cursor.current = 0; setPassageIndex(0); }, [identity]);
  const passage = result.status === 'ready' ? result.passages[passageIndex] : undefined;
  return <div className="exact-comparison">
    <p className="comparison-identity">{base ? `Version ${base.number}` : 'Empty base'} → Version {target.number} · <strong>{selection.filePath}</strong> · {selection.mode === 'words' ? 'Literal word comparison' : 'Literal line comparison'}</p>
    {result.status === 'too_large' ? <><div className="comparison-limit"><h3>Comparison too large to render safely</h3><p>No partial comparison is shown. Read or download either exact source instead.</p><div className="small-actions">{before && <button className="button" onClick={() => downloadSource(before, `v${base!.number}`)}>Download base source</button>}{after && <button className="button" onClick={() => downloadSource(after, `v${target.number}`)}>Download target source</button>}</div>{before && <details><summary>Read base source</summary><pre className="raw-comparison-source">{before.content || '(Empty file)'}</pre></details>}{after && <details><summary>Read target source</summary><pre className="raw-comparison-source">{after.content || '(Empty file)'}</pre></details>}</div>{selection.view !== 'changes' && children}</> : <>
      <div className="passage-navigation"><button className="button" disabled={!count || passageIndex === 0} onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); move(passageIndex - 1); }}>Previous change</button><span role="status">{count ? `Change ${passageIndex + 1} of ${count}` : 'No text changes'}{result.fileChange === 'added' ? ' · File added' : result.fileChange === 'removed' ? ' · File removed' : ''}</span><button className="button" disabled={!count || passageIndex === count - 1} onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); move(passageIndex + 1); }}>Next change</button></div>
      {selection.view === 'changes' ? selection.mode === 'lines' ? <ComparisonLines comparison={result} passageIndex={passageIndex} canComment={canComment && Boolean(after)} onLine={onLine} selectedLine={selectedLine}/> : <div className="prose-diff"><div className="diff-legend"><span><i className="added-key"/>Added text</span><span><i className="removed-key"/>Removed text</span><small>Source comments attach only to the selected target.</small></div><div className="prose-content literal-diff" aria-label="Selected file comparison">{result.segments.map((segment, index) => { const passageNumber = result.passages.findIndex(item => item.segmentStart === index); const selected = passage && index >= passage.segmentStart && index < passage.segmentEnd; const props = { key: index, 'data-change-passage': passageNumber >= 0 ? passageNumber : undefined, className: selected ? 'active-change' : '' }; return segment.kind === 'added' ? <ins {...props}>{segment.text}</ins> : segment.kind === 'removed' ? <del {...props}>{segment.text}</del> : <span {...props}>{segment.text}</span>; })}{!result.beforeLength && !result.afterLength && <span className="muted">{result.fileChange === 'added' ? 'Empty file added.' : result.fileChange === 'removed' ? 'Empty file removed.' : 'This file is empty on both sides.'}</span>}</div></div> : children}
    </>}
  </div>;
}
