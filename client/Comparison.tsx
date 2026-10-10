import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ComparisonLines from './ComparisonLines';
import { useWorkspace } from './SessionGate';
import { comparisonPassages } from '../shared/comparison-navigation';
import { compareFile } from '../shared/comparison';
import type { RevisionDetail, RevisionVersion, SourceFile } from '../shared/types';
import type { ComparisonVoiceAction } from './voice';
import { comparisonNarration, type ComparisonVoiceSnapshot } from './comparison-voice';
import { comparisonIdentity, comparisonPaths, versionIdentity, type ComparisonSelection } from './comparison-model';

export type ComparisonAction = ComparisonVoiceAction;
export interface ComparisonController { identity: string; snapshot: ComparisonVoiceSnapshot; execute: (action: ComparisonAction) => { text: string; identity: string } }
export type RegisterComparison = (controller: ComparisonController | null) => void;
export function ComparisonPicker({ detail, selection, change, current }: { detail: RevisionDetail; selection: ComparisonSelection; change: (selection: ComparisonSelection) => void; current: () => void }) {
  const base = detail.versions.find(item => item.id === selection.base?.id) || null;
  const target = detail.versions.find(item => item.id === selection.target.id);
  const paths = target ? comparisonPaths(base, target) : [];
  const fileIndex = paths.indexOf(selection.filePath);
  const choose = (next: ComparisonSelection) => { window.dispatchEvent(new Event('comparison-navigation')); change(next); };
  const pick = (side: 'base' | 'target', number: number) => {
    const chosen = detail.versions.find(item => item.number === number);
    if (side === 'target' && !chosen) return;
    const next = { ...selection, [side]: chosen ? versionIdentity(chosen) : null } as ComparisonSelection;
    const nextTarget = side === 'target' ? chosen : target;
    const nextBase = side === 'base' ? chosen || null : base;
    if (nextTarget) { const union = comparisonPaths(nextBase, nextTarget); if (!union.includes(next.filePath)) next.filePath = union[0] || ''; }
    choose(next);
  };
  return <>
    <div className="comparison-toolbar">
      <label>Compare<select aria-label="Base version" value={base?.number ?? (selection.base ? 'unavailable' : 0)} onChange={event => pick('base', Number(event.target.value))}><option value={0}>Empty base</option>{selection.base && !base && <option value="unavailable">Unavailable selected version</option>}{detail.versions.map(item => <option key={item.id} value={item.number}>Version {item.number}</option>)}</select></label>
      <button type="button" className="button" disabled={!base || !target} onClick={() => choose({ ...selection, base: selection.target, target: selection.base! })}>Swap versions</button>
      <label>With<select aria-label="Version to inspect" value={target?.number ?? 'unavailable'} onChange={event => pick('target', Number(event.target.value))}>{!target && <option value="unavailable">Unavailable selected version</option>}{detail.versions.map(item => <option key={item.id} value={item.number}>Version {item.number}{item.number === detail.revision.currentVersion ? ' · current' : ''}</option>)}</select></label>
      <button type="button" className="text-button" onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); current(); }}>Show current version</button>
      <div className="segmented"><button className={selection.view === 'changes' ? 'selected' : ''} onClick={() => choose({ ...selection, view: 'changes' })}>Changes</button><button className={selection.view === 'source' ? 'selected' : ''} onClick={() => choose({ ...selection, view: 'source' })}>Source</button>{detail.revision.kind === 'paper' && <button className={selection.view === 'structure' ? 'selected' : ''} onClick={() => choose({ ...selection, view: 'structure' })}>Structure</button>}</div>
    </div>
    <div className="comparison-file-navigation"><button className="button" disabled={fileIndex <= 0} onClick={() => choose({ ...selection, filePath: paths[fileIndex - 1]! })}>Previous file</button><span role="status">{fileIndex < 0 ? 'Selected file unavailable' : `File ${fileIndex + 1} of ${paths.length}`}</span><button className="button" disabled={fileIndex < 0 || fileIndex >= paths.length - 1} onClick={() => choose({ ...selection, filePath: paths[fileIndex + 1]! })}>Next file</button></div>
    <div className="file-toolbar"><label>File<select aria-label="Source file" value={selection.filePath} onChange={event => choose({ ...selection, filePath: event.target.value })}>{!paths.includes(selection.filePath) && <option value={selection.filePath}>Unavailable selected file</option>}{paths.map(path => <option key={path}>{path}</option>)}</select></label><label>Compare text<select aria-label="Comparison mode" value={selection.mode} onChange={event => choose({ ...selection, mode: event.target.value as ComparisonSelection['mode'] })}><option value="words">Words</option><option value="lines">Lines</option></select></label><span className="content-hash" title={selection.target.contentHash}>Target snapshot {selection.target.contentHash.slice(0, 10)}</span></div>
    <div className="comparison-navigation-options"><label className="checkbox"><input type="checkbox" checked={Boolean(selection.skipSpaceTabOnly)} onChange={event => choose({ ...selection, skipSpaceTabOnly: event.target.checked })}/>Skip space/tab-only changes</label><small>Only passage navigation and narration skip these changes. All literal text stays visible. Keyboard: j/k for changes; Shift+J/K for files.</small></div>
  </>;
}
function downloadSource(file: SourceFile, side: string) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${side}-${file.path.split('/').pop() || 'source.txt'}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Comparison({ revisionId, base, target, selection, register, children, canComment, onLine, selectedLine, change }: { change: (selection: ComparisonSelection) => void; canComment: boolean; onLine: (line: number) => void; selectedLine: number | null; revisionId: string; base: RevisionVersion | null; target: RevisionVersion; selection: ComparisonSelection; register: RegisterComparison; children?: React.ReactNode }) {
  const { isActive, unavailableObject } = useWorkspace();
  const before = base?.files.find(file => file.path === selection.filePath) || null;
  const after = target.files.find(file => file.path === selection.filePath) || null;
  const result = useMemo(() => compareFile(before, after, selection.mode), [before, after, selection.mode]);
  const navigation = useMemo(() => result.status === 'ready' ? comparisonPassages(result, Boolean(selection.skipSpaceTabOnly)) : { indexes: [], skipped: 0 }, [result, selection.skipSpaceTabOnly]);
  const [passageIndex, setPassageIndex] = useState(navigation.indexes[0] ?? -1); const cursor = useRef(passageIndex);
  const count = navigation.indexes.length;
  const identity = comparisonIdentity(selection);
  const root = useRef<HTMLDivElement>(null); const scrollFrame = useRef<number | null>(null); const pendingFile = useRef<string | null>(null);
  const snapshot: ComparisonVoiceSnapshot = { revisionId, base: base && { id: base.id, number: base.number, contentHash: base.contentHash }, target: { id: target.id, number: target.number, contentHash: target.contentHash }, filePath: selection.filePath, result, passageIndex, skipSpaceTabOnly: Boolean(selection.skipSpaceTabOnly) };
  const move = (ordinal: number) => {
    const next = navigation.indexes[Math.max(0, Math.min(count - 1, ordinal))] ?? -1;
    cursor.current = next; setPassageIndex(next);
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = null; root.current?.querySelector(`[data-change-passage="${next}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
    return next;
  };
  const execute = (action: ComparisonAction): { text: string; identity: string } => {
    if (!isActive() || unavailableObject(revisionId)) return { identity, text: 'This comparison is no longer available.' };
    if (pendingFile.current) return { identity: pendingFile.current, text: 'The selected file is changing. Wait for it to finish loading.' };
    if (action === 'nextFile' || action === 'previousFile') {
      const paths = comparisonPaths(base, target); const index = paths.indexOf(selection.filePath) + (action === 'nextFile' ? 1 : -1);
      if (index < 0 || index >= paths.length) return { identity, text: index < 0 ? 'Already at the first file.' : 'Already at the last file.' };
      const next = { ...selection, filePath: paths[index]! }; const nextIdentity = comparisonIdentity(next);
      const nextResult = compareFile(base?.files.find(file => file.path === next.filePath) || null, target.files.find(file => file.path === next.filePath) || null, next.mode);
      const nextNavigation = nextResult.status === 'ready' ? comparisonPassages(nextResult, Boolean(next.skipSpaceTabOnly)) : { indexes: [] };
      pendingFile.current = nextIdentity; change(next);
      return { identity: nextIdentity, text: comparisonNarration({ ...snapshot, filePath: next.filePath, result: nextResult, passageIndex: nextNavigation.indexes[0] ?? -1 }, 'current') };
    }
    if (action === 'changes') return { identity, text: comparisonNarration({ ...snapshot, passageIndex: cursor.current }) };
    if (action === 'currentChange') return { identity, text: comparisonNarration({ ...snapshot, passageIndex: cursor.current }, 'current') };
    const proposed = navigation.indexes.indexOf(cursor.current) + (action === 'nextChange' ? 1 : -1);
    if (result.status === 'too_large' || !count) return { identity, text: comparisonNarration({ ...snapshot, passageIndex: cursor.current }, 'current') };
    if (proposed < 0 || proposed >= count) return { identity, text: proposed < 0 ? 'Already at the first navigable change.' : 'Already at the last navigable change.' };
    return { identity, text: comparisonNarration({ ...snapshot, passageIndex: move(proposed) }, 'current') };
  };
  const executeRef = useRef(execute); executeRef.current = execute;
  useLayoutEffect(() => { register({ identity, snapshot, execute }); });
  useLayoutEffect(() => () => register(null), [register]);
  useEffect(() => {
    cursor.current = navigation.indexes[0] ?? -1; setPassageIndex(cursor.current);
    return () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); };
  }, [identity]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!isActive() || unavailableObject(revisionId)) return;
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('input, textarea, select, button, a, form, object, embed, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"]')) return;
      if (document.querySelector('dialog[open], [role="dialog"]:not([aria-hidden="true"]):not([hidden]), [aria-modal="true"]:not([aria-hidden="true"]):not([hidden])')) return;
      const key = event.key.toLowerCase(); if (key !== 'j' && key !== 'k') return;
      if (window.getSelection()?.toString()) return;
      event.preventDefault(); window.dispatchEvent(new Event('comparison-navigation'));
      executeRef.current(event.shiftKey ? key === 'j' ? 'nextFile' : 'previousFile' : key === 'j' ? 'nextChange' : 'previousChange');
    };
    document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard);
  }, []);
  const ordinal = navigation.indexes.indexOf(passageIndex);
  const passage = result.status === 'ready' ? result.passages[passageIndex] : undefined;
  return <div className="exact-comparison" ref={root}>
    <p className="comparison-identity">{base ? `Version ${base.number}` : 'Empty base'} → Version {target.number} · <strong>{selection.filePath}</strong> · {selection.mode === 'words' ? 'Literal word comparison' : 'Literal line comparison'}</p>
    {result.status === 'too_large' ? <><div className="comparison-limit"><h3>Comparison too large to render safely</h3><p>No partial comparison is shown. Read or download either exact source instead.</p><div className="small-actions">{before && <button className="button" onClick={() => downloadSource(before, `v${base!.number}`)}>Download base source</button>}{after && <button className="button" onClick={() => downloadSource(after, `v${target.number}`)}>Download target source</button>}</div>{before && <details><summary>Read base source</summary><pre className="raw-comparison-source">{before.content || '(Empty file)'}</pre></details>}{after && <details><summary>Read target source</summary><pre className="raw-comparison-source">{after.content || '(Empty file)'}</pre></details>}</div>{selection.view !== 'changes' && children}</> : <>
      <div className="passage-navigation"><button className="button" disabled={!count || ordinal <= 0} onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); move(ordinal - 1); }}>Previous change</button><span role="status">{count ? `Change ${ordinal + 1} of ${count}` : navigation.skipped ? 'No navigable changes' : 'No text changes'}{navigation.skipped > 0 ? ` · ${navigation.skipped} space/tab-only ${navigation.skipped === 1 ? 'change' : 'changes'} skipped` : ''}{result.fileChange === 'added' ? ' · File added' : result.fileChange === 'removed' ? ' · File removed' : ''}</span><button className="button" disabled={!count || ordinal >= count - 1} onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); move(ordinal + 1); }}>Next change</button></div>
      {selection.view === 'changes' ? selection.mode === 'lines' ? <ComparisonLines comparison={result} passageIndex={passageIndex} canComment={canComment && Boolean(after)} onLine={onLine} selectedLine={selectedLine}/> : <div className="prose-diff"><div className="diff-legend"><span><i className="added-key"/>Added text</span><span><i className="removed-key"/>Removed text</span><small>Source comments attach only to the selected target.</small></div><div className="prose-content literal-diff" aria-label="Selected file comparison">{result.segments.map((segment, index) => { const passageNumber = result.passages.findIndex(item => item.segmentStart === index); const selected = passage && index >= passage.segmentStart && index < passage.segmentEnd; const props = { key: index, 'data-change-passage': passageNumber >= 0 ? passageNumber : undefined, className: selected ? 'active-change' : '' }; return segment.kind === 'added' ? <ins {...props}>{segment.text}</ins> : segment.kind === 'removed' ? <del {...props}>{segment.text}</del> : <span {...props}>{segment.text}</span>; })}{!result.beforeLength && !result.afterLength && <span className="muted">{result.fileChange === 'added' ? 'Empty file added.' : result.fileChange === 'removed' ? 'Empty file removed.' : 'This file is empty on both sides.'}</span>}</div></div> : children}
    </>}
  </div>;
}
