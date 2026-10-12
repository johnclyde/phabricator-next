import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ComparisonLines from './ComparisonLines';
import { useWorkspace } from './SessionGate';
import { comparisonPassages } from '../shared/comparison-navigation';
import { compareFile, type ComparisonSegment, type FileComparison } from '../shared/comparison';
import { compareParagraphFile, type ReadyParagraphComparison, type ReorderedParagraph } from '../shared/paragraph-comparison';
import type { RevisionDetail, RevisionVersion, SourceFile } from '../shared/types';
import type { ComparisonVoiceAction } from './voice';
import { comparisonNarration, type ComparisonVoiceSnapshot } from './comparison-voice';
import { comparisonIdentity, comparisonPaths, versionIdentity, type ComparisonSelection } from './comparison-model';

export type ComparisonAction = ComparisonVoiceAction;
export interface ComparisonController { identity: string; snapshot: ComparisonVoiceSnapshot; execute: (action: ComparisonAction) => { text: string; identity: string } }
export type RegisterComparison = (controller: ComparisonController | null) => void;
interface ParagraphMarker { match: ReorderedParagraph; number: number; side: 'before' | 'after' }
/** Word projections are presentation inputs; immutable versions/files are never rewritten. */
export interface WordComparisonPresentation {
  before: SourceFile | null;
  after: SourceFile | null;
  scopes: string[];
  scopeLabel: (scope: string) => string;
  compare: (scope: string) => FileComparison;
  identity: (selection: ComparisonSelection) => string;
  available: () => boolean;
  basePackageSha256: string | null;
  targetPackageSha256: string;
}

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
  return <div className="comparison-picker">
    <div className="comparison-toolbar">
      <label>Compare<select aria-label="Base version" value={base?.number ?? (selection.base ? 'unavailable' : 0)} onChange={event => pick('base', Number(event.target.value))}><option value={0}>Empty base</option>{selection.base && !base && <option value="unavailable">Unavailable selected version</option>}{detail.versions.map(item => <option key={item.id} value={item.number}>Version {item.number}</option>)}</select></label>
      <label>With<select aria-label="Version to inspect" value={target?.number ?? 'unavailable'} onChange={event => pick('target', Number(event.target.value))}>{!target && <option value="unavailable">Unavailable selected version</option>}{detail.versions.map(item => <option key={item.id} value={item.number}>Version {item.number}{item.number === detail.revision.currentVersion ? ' · current' : ''}</option>)}</select></label>
      <div className="segmented"><button className={selection.view === 'changes' ? 'selected' : ''} onClick={() => choose({ ...selection, view: 'changes' })}>Changes</button><button className={selection.view === 'source' ? 'selected' : ''} onClick={() => choose({ ...selection, view: 'source' })}>Source</button>{detail.revision.kind === 'paper' && <button className={selection.view === 'structure' ? 'selected' : ''} onClick={() => choose({ ...selection, view: 'structure' })}>Structure</button>}</div>
    </div>
    <div className="comparison-file-controls">
      <div className="file-toolbar"><label>File<select aria-label="Source file" value={selection.filePath} onChange={event => choose({ ...selection, filePath: event.target.value })}>{!paths.includes(selection.filePath) && <option value={selection.filePath}>Unavailable selected file</option>}{paths.map(path => <option key={path}>{path}</option>)}</select></label></div>

    </div>
    <details className="comparison-options">
      <summary>Comparison options</summary>
      <div className="comparison-file-navigation"><button className="button" disabled={fileIndex <= 0} onClick={() => choose({ ...selection, filePath: paths[fileIndex - 1]! })}>Previous file</button><span role="status">{fileIndex < 0 ? 'Selected file unavailable' : `File ${fileIndex + 1} of ${paths.length}`}</span><button className="button" disabled={fileIndex < 0 || fileIndex >= paths.length - 1} onClick={() => choose({ ...selection, filePath: paths[fileIndex + 1]! })}>Next file</button></div>
      <div className="comparison-options-controls">
        <label>Compare text<select aria-label="Comparison mode" value={selection.mode} onChange={event => choose({ ...selection, mode: event.target.value as ComparisonSelection['mode'] })}><option value="words">Words</option><option value="lines">Lines</option></select></label>
        <button type="button" className="button" disabled={!base || !target} onClick={() => choose({ ...selection, base: selection.target, target: selection.base! })}>Swap versions</button>
        <button type="button" className="text-button" onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); current(); }}>Show current version</button>
        <span className="content-hash" title={selection.target.contentHash}>Target snapshot {selection.target.contentHash.slice(0, 10)}</span>
      </div>
      <div className="comparison-navigation-options"><label className="checkbox"><input type="checkbox" checked={Boolean(selection.skipSpaceTabOnly)} onChange={event => choose({ ...selection, skipSpaceTabOnly: event.target.checked })}/>Skip space/tab-only changes</label><small>Only passage navigation and narration skip these changes. All literal text stays visible. Keyboard: j/k for changes; Shift+J/K for files.</small></div>
      {detail.revision.kind !== 'code' && !base?.docx && !target?.docx && selection.mode === 'words' && <div className="comparison-navigation-options paragraph-alignment-options"><label className="checkbox"><input type="checkbox" checked={Boolean(selection.paragraphAlignment)} onChange={event => choose({ ...selection, paragraphAlignment: event.target.checked })}/>Align source paragraphs</label><small>Exact paragraph match; source paragraphs, not rendered structure. Added and removed text stays literal; repeated or edited paragraphs are not guessed as moves.</small></div>}
    </details>
  </div>;
}
function downloadSource(file: SourceFile, side: string) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${side}-${file.path.split('/').pop() || 'source.txt'}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Comparison({ revisionId, base, target, selection, register, children, canComment, onLine, selectedLine, change, word, supportsParagraphAlignment = false }: { word?: WordComparisonPresentation; supportsParagraphAlignment?: boolean; change: (selection: ComparisonSelection) => void; canComment: boolean; onLine: (line: number) => void; selectedLine: number | null; revisionId: string; base: RevisionVersion | null; target: RevisionVersion; selection: ComparisonSelection; register: RegisterComparison; children?: React.ReactNode }) {
  const client = useWorkspace(), { isActive, unavailableObject } = client;
  const before = word ? word.before : base?.files.find(file => file.path === selection.filePath) || null;
  const after = word ? word.after : target.files.find(file => file.path === selection.filePath) || null;
  const paragraphAlignment = supportsParagraphAlignment && !word && !base?.docx && !target.docx && selection.mode === 'words' && selection.paragraphAlignment === true;
  const result = useMemo(() => word ? word.compare(selection.filePath) : paragraphAlignment ? compareParagraphFile(before, after) : compareFile(before, after, selection.mode), [before, after, selection.mode, word, selection.filePath, paragraphAlignment]);
  const aligned = paragraphAlignment && result.status === 'ready' ? result as ReadyParagraphComparison : null;
  const paragraphMarkers = useMemo(() => {
    const markers = new Map<number, ParagraphMarker[]>();
    aligned?.reordered.forEach((match, index) => {
      for (const side of ['before', 'after'] as const) {
        const segment = side === 'before' ? match.beforeSegment : match.afterSegment;
        const values = markers.get(segment) || []; values.push({ match, number: index + 1, side }); markers.set(segment, values);
      }
    });
    for (const values of markers.values()) values.sort((a, b) => a.match[a.side].start - b.match[b.side].start);
    return markers;
  }, [aligned]);
  const navigation = useMemo(() => result.status === 'ready' ? comparisonPassages(result, Boolean(selection.skipSpaceTabOnly)) : { indexes: [], skipped: 0 }, [result, selection.skipSpaceTabOnly]);
  const [passageIndex, setPassageIndex] = useState(navigation.indexes[0] ?? -1); const cursor = useRef(passageIndex);
  const count = navigation.indexes.length;
  const identity = word ? word.identity(selection) : comparisonIdentity(selection);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const mounted = useRef(true);
  const readerId = useId(), counterpartGeneration = useRef(0), paragraphTargets = useRef(new Map<string, HTMLSpanElement>());
  const wordAvailable = useRef(word?.available); wordAvailable.current = word?.available;
  const root = useRef<HTMLDivElement>(null); const scrollFrame = useRef<number | null>(null); const pendingFile = useRef<string | null>(null);
  const snapshot: ComparisonVoiceSnapshot = { revisionId, base: base && { id: base.id, number: base.number, contentHash: base.contentHash }, target: { id: target.id, number: target.number, contentHash: target.contentHash }, filePath: selection.filePath, result, passageIndex, skipSpaceTabOnly: Boolean(selection.skipSpaceTabOnly), ...(paragraphAlignment ? { paragraphAlignment: true } : {}), ...(word ? { word: { scopeLabel: word.scopeLabel(selection.filePath), basePackageSha256: word.basePackageSha256, targetPackageSha256: word.targetPackageSha256 } } : {}) };
  const move = (ordinal: number) => {
    if (word && (!mounted.current || !word.available())) return cursor.current;
    counterpartGeneration.current++;
    const next = navigation.indexes[Math.max(0, Math.min(count - 1, ordinal))] ?? -1;
    cursor.current = next; setPassageIndex(next);
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => { scrollFrame.current = null; if (mounted.current && currentIdentity.current === identity && isActive() && !unavailableObject(revisionId) && (!word || word.available())) root.current?.querySelector(`[data-change-passage="${next}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
    return next;
  };
  const execute = (action: ComparisonAction): { text: string; identity: string } => {
    if (!mounted.current || !isActive() || unavailableObject(revisionId) || (word && !word.available())) return { identity, text: 'This comparison is no longer available.' };
    if (pendingFile.current) return { identity: pendingFile.current, text: word ? 'The selected Word scope is changing. Wait for it to finish loading.' : 'The selected file is changing. Wait for it to finish loading.' };
    if (action === 'nextFile' || action === 'previousFile') {
      const paths = word ? word.scopes : comparisonPaths(base, target); const index = paths.indexOf(selection.filePath) + (action === 'nextFile' ? 1 : -1);
      if (index < 0 || index >= paths.length) return { identity, text: word ? index < 0 ? 'Already at the first Word scope.' : 'Already at the last Word scope.' : index < 0 ? 'Already at the first file.' : 'Already at the last file.' };
      const next = { ...selection, filePath: paths[index]! }; const nextIdentity = word ? word.identity(next) : comparisonIdentity(next);
      const nextBefore = base?.files.find(file => file.path === next.filePath) || null, nextAfter = target.files.find(file => file.path === next.filePath) || null;
      const nextResult = word ? word.compare(next.filePath) : paragraphAlignment ? compareParagraphFile(nextBefore, nextAfter) : compareFile(nextBefore, nextAfter, next.mode);
      const nextNavigation = nextResult.status === 'ready' ? comparisonPassages(nextResult, Boolean(next.skipSpaceTabOnly)) : { indexes: [] };
      counterpartGeneration.current++; pendingFile.current = nextIdentity; change(next);
      return { identity: nextIdentity, text: comparisonNarration({ ...snapshot, ...(snapshot.word && word ? { word: { ...snapshot.word, scopeLabel: word.scopeLabel(next.filePath) } } : {}), filePath: next.filePath, result: nextResult, passageIndex: nextNavigation.indexes[0] ?? -1 }, 'current') };
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
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; counterpartGeneration.current++; register(null); }; }, [register]);
  useEffect(() => {
    counterpartGeneration.current++; pendingFile.current = null; cursor.current = navigation.indexes[0] ?? -1; setPassageIndex(cursor.current);
    return () => { counterpartGeneration.current++; if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); };
  }, [identity]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!isActive() || unavailableObject(revisionId) || (wordAvailable.current && !wordAvailable.current())) return;
      if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
      const element = event.target instanceof Element ? event.target : null;
      if (element?.closest('input, textarea, select, button, summary, a, form, object, embed, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"]')) return;
      if (document.querySelector('dialog[open], [role="dialog"]:not([aria-hidden="true"]):not([hidden]), [aria-modal="true"]:not([aria-hidden="true"]):not([hidden])')) return;
      const key = event.key.toLowerCase(); if (key !== 'j' && key !== 'k') return;
      if (window.getSelection()?.toString()) return;
      event.preventDefault(); window.dispatchEvent(new Event('comparison-navigation'));
      executeRef.current(event.shiftKey ? key === 'j' ? 'nextFile' : 'previousFile' : key === 'j' ? 'nextChange' : 'previousChange');
    };
    document.addEventListener('keydown', keyboard); return () => document.removeEventListener('keydown', keyboard);
  }, []);
  useEffect(() => {
    const retire = () => { counterpartGeneration.current++; if (scrollFrame.current !== null) { cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null; } };
    const access = client.onAccessChange(retire);
    window.addEventListener('pagehide', retire);
    return () => { retire(); access(); window.removeEventListener('pagehide', retire); };
  }, [client]);
  const accessEpoch = client.session?.accessEpoch, sourceGeneration = client.taskSnapshotGeneration();
  const objectGeneration = client.session?.objectGenerations.get(revisionId) || 0;
  const paragraphCurrent = () => {
    try { client.assertActive(); } catch { return false; }
    return mounted.current && currentIdentity.current === identity && pendingFile.current === null && !unavailableObject(revisionId)
      && accessEpoch === client.session?.accessEpoch && sourceGeneration === client.taskSnapshotGeneration()
      && objectGeneration === (client.session?.objectGenerations.get(revisionId) || 0);
  };
  const paragraphTargetKey = (match: ReorderedParagraph, side: 'before' | 'after') => `${side}:${match.id}`;
  const paragraphTargetId = (number: number, side: 'before' | 'after') => `paragraph-${readerId}-${side}-${number}`;
  const counterpart = (marker: ParagraphMarker) => {
    if (!aligned || !paragraphCurrent()) return;
    const side = marker.side === 'before' ? 'after' : 'before', next = side === 'before' ? marker.match.beforePassage : marker.match.afterPassage;
    if (!navigation.indexes.includes(next)) return;
    window.dispatchEvent(new Event('comparison-navigation'));
    const ticket = ++counterpartGeneration.current;
    cursor.current = next; setPassageIndex(next);
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (ticket !== counterpartGeneration.current || !paragraphCurrent()) return;
      scrollFrame.current = null;
      const element = paragraphTargets.current.get(paragraphTargetKey(marker.match, side));
      if (!element?.isConnected || !root.current?.contains(element)) return;
      element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };
  const ordinal = navigation.indexes.indexOf(passageIndex);
  const passage = result.status === 'ready' ? result.passages[passageIndex] : undefined;
  const literalSegment = (segment: ComparisonSegment, index: number) => {
    const passageNumber = result.status === 'ready' ? result.passages.findIndex(item => item.segmentStart === index) : -1;
    const selected = passage && index >= passage.segmentStart && index < passage.segmentEnd;
    const markers = paragraphMarkers.get(index) || [], content: ReactNode[] = [];
    let offset = 0;
    for (const marker of markers) {
      const range = marker.match[marker.side], segmentStart = segment[marker.side].start;
      const start = range.start - segmentStart, end = range.end - segmentStart;
      content.push(segment.text.slice(offset, start));
      content.push(<span key={`${marker.side}:${marker.match.id}`} className="paragraph-match-text" tabIndex={-1}
        id={paragraphTargetId(marker.number, marker.side)} data-paragraph-id={marker.match.id} data-paragraph-side={marker.side}
        data-source-start={range.start} data-source-end={range.end}
        ref={element => { const key = paragraphTargetKey(marker.match, marker.side); if (element) paragraphTargets.current.set(key, element); else paragraphTargets.current.delete(key); }}>{segment.text.slice(start, end)}</span>);
      offset = end;
    }
    content.push(segment.text.slice(offset));
    const Tag = segment.kind === 'added' ? 'ins' : segment.kind === 'removed' ? 'del' : 'span';
    return <Fragment key={index}>
      <Tag data-comparison-segment={index} data-change-passage={passageNumber >= 0 ? passageNumber : undefined} className={selected ? 'active-change' : undefined}>{content}</Tag>
      {markers.map(marker => {
        const side = marker.side === 'before' ? 'after' : 'before', next = side === 'before' ? marker.match.beforePassage : marker.match.afterPassage;
        const skipped = !navigation.indexes.includes(next);
        return <span className="paragraph-reorder" role="note" data-paragraph-id={marker.match.id} data-paragraph-side={marker.side} key={`${marker.side}:${marker.match.id}`}>
          <span>Reordered source paragraph {marker.number} · Exact paragraph match</span>
          <button type="button" className="button" aria-controls={paragraphTargetId(marker.number, side)} disabled={skipped} title={skipped ? 'The counterpart is skipped by the current navigation filter.' : undefined} onClick={() => counterpart(marker)}>Show {side === 'before' ? 'removed' : 'added'} paragraph {marker.number}</button>
        </span>;
      })}
    </Fragment>;
  };
  return <div className="exact-comparison" ref={root}>
    <p className="comparison-identity">{base ? `Version ${base.number}` : 'Empty base'} → Version {target.number} · <strong>{word ? word.scopeLabel(selection.filePath) : selection.filePath}</strong> · {paragraphAlignment ? 'Source paragraph alignment' : selection.mode === 'words' ? 'Literal word comparison' : 'Literal line comparison'}{word ? ' · Word projected text' : ''}</p>
    {aligned && <p className="paragraph-alignment-note">Exact paragraph match; source paragraphs, not rendered structure. {aligned.reordered.length} exact reordered {aligned.reordered.length === 1 ? 'paragraph' : 'paragraphs'}. Added and removed text remains visible.</p>}
    {result.status === 'too_large' ? <><div className="comparison-limit"><h3>Comparison too large to render safely</h3><p>{word ? 'No partial comparison is shown. Read or download either projected scope below, or return to the document reader to download the exact Word package.' : 'No partial comparison is shown. Read or download either exact source instead.'}</p><div className="small-actions">{before && <button className="button" onClick={() => { if (!word || word.available()) downloadSource(before, `v${base!.number}`); }}>{word ? 'Download base projected text' : 'Download base source'}</button>}{after && <button className="button" onClick={() => { if (!word || word.available()) downloadSource(after, `v${target.number}`); }}>{word ? 'Download target projected text' : 'Download target source'}</button>}</div>{before && <details><summary>{word ? 'Read base projected text' : 'Read base source'}</summary><pre className="raw-comparison-source">{before.content || (word ? '(Empty projected scope)' : '(Empty file)')}</pre></details>}{after && <details><summary>{word ? 'Read target projected text' : 'Read target source'}</summary><pre className="raw-comparison-source">{after.content || (word ? '(Empty projected scope)' : '(Empty file)')}</pre></details>}</div>{selection.view !== 'changes' && children}</> : <>
      <div className="passage-navigation"><button className="button" disabled={!count || ordinal <= 0} onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); move(ordinal - 1); }}>Previous change</button><span role="status">{count ? `Change ${ordinal + 1} of ${count}` : navigation.skipped ? 'No navigable changes' : word ? 'No projected text changes' : 'No text changes'}{navigation.skipped > 0 ? ` · ${navigation.skipped} space/tab-only ${navigation.skipped === 1 ? 'change' : 'changes'} skipped` : ''}{result.fileChange === 'added' ? word ? ' · Scope added' : ' · File added' : result.fileChange === 'removed' ? word ? ' · Scope removed' : ' · File removed' : ''}</span><button className="button" disabled={!count || ordinal >= count - 1} onClick={() => { window.dispatchEvent(new Event('comparison-navigation')); move(ordinal + 1); }}>Next change</button></div>
      {selection.view === 'changes' ? selection.mode === 'lines' ? <ComparisonLines projectedWord={Boolean(word)} comparison={result} passageIndex={passageIndex} canComment={canComment && Boolean(after)} onLine={onLine} selectedLine={selectedLine}/> : <div className="prose-diff"><div className="diff-legend"><span><i className="added-key"/>Added text</span><span><i className="removed-key"/>Removed text</span><small>{word ? 'Projected lines cannot receive comments. Use an original Word passage in the document reader.' : 'Source comments attach only to the selected target.'}</small></div><div className="prose-content literal-diff" aria-label={word ? "Selected Word scope comparison" : "Selected file comparison"}>{result.segments.map(literalSegment)}{!result.beforeLength && !result.afterLength && <span className="muted">{word ? result.fileChange === 'added' ? 'Empty scope added.' : result.fileChange === 'removed' ? 'Empty scope removed.' : 'This projected scope is empty on both sides.' : result.fileChange === 'added' ? 'Empty file added.' : result.fileChange === 'removed' ? 'Empty file removed.' : 'This file is empty on both sides.'}</span>}</div></div> : children}
    </>}
  </div>;
}
