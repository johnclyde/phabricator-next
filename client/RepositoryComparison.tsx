import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GitComparison, GitComparisonChange, GitComparisonFile, GitComparisonSide } from '../shared/repositories';
import { isGitObjectId } from '../shared/repositories';
import { compareFile } from '../shared/comparison';
import ComparisonLines from './ComparisonLines';
import RepositoryPatch from './RepositoryPatch';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import type { RepositorySelection } from './repository-cache';
import { comparisonCacheKey, comparisonPair, comparisonQuery, selectedChange, validComparison, validComparisonFile } from './repository-comparison';

const short = (value: string) => value.slice(0, 12);
const labels = { added: 'Added', deleted: 'Deleted', modified: 'Modified', type_changed: 'Type changed', renamed: 'Renamed', copied: 'Copied' };
const types = { file: 'File', tree: 'Directory', symlink: 'Symbolic link', submodule: 'Submodule' };
const title = (change: GitComparisonChange) => change.before && change.after && change.before.path !== change.after.path ? `${change.before.path} → ${change.after.path}` : change.after?.path ?? change.before!.path;
type Props = { id: string; selection: RepositorySelection; online: boolean; generation: number; choose: (selection: RepositorySelection, automatic?: boolean) => void; cached: <T>(key: string) => T | null; saveCache: (key: string, value: unknown) => boolean; dropCache: (key: string) => void };
export default function RepositoryComparison({ id, selection, online, generation, choose, cached, saveCache, dropCache }: Props) {
  const { request, isActive, unavailableObject, onRepositorySnapshotChange, onAccessChange } = useWorkspace();
  const pair = comparisonPair(selection), inventoryKey = comparisonCacheKey(selection), fileKey = comparisonCacheKey(selection, true);
  const [inventory, setInventory] = useState<GitComparison | null>(null), [file, setFile] = useState<GitComparisonFile | null>(null);
  const [loading, setLoading] = useState(false), [fileLoading, setFileLoading] = useState(false), [error, setError] = useState(''), [fileError, setFileError] = useState('');
  const [saved, setSaved] = useState(false), [savedFile, setSavedFile] = useState(false), [reload, setReload] = useState(0);
  const [baseInput, setBaseInput] = useState(selection.baseCommitId ?? 'empty'), [targetInput, setTargetInput] = useState(selection.commitId);
  const mounted = useRef(true), inventoryReads = useRef(0), fileReads = useRef(0), current = useRef(selection);
  current.current = selection;
  const actions = useRef({ choose, cached, saveCache, dropCache }); actions.current = { choose, cached, saveCache, dropCache };
  const active = () => mounted.current && isActive() && !unavailableObject(id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; inventoryReads.current++; fileReads.current++; }; }, []);
  useEffect(() => onRepositorySnapshotChange(() => { inventoryReads.current++; fileReads.current++; setInventory(null); setFile(null); setLoading(false); setFileLoading(false); }), []);
  useEffect(() => onAccessChange(ids => { if (ids.includes(id)) { inventoryReads.current++; fileReads.current++; setInventory(null); setFile(null); setLoading(false); setFileLoading(false); setError('This repository is no longer available.'); setFileError(''); } }), [id]);
  // Synchronize a newly selected pair before its inputs can receive edits.
  // A deferred reset can otherwise overwrite typing immediately after Swap.
  useLayoutEffect(() => { setBaseInput(selection.baseCommitId ?? 'empty'); setTargetInput(selection.commitId); }, [pair]);
  useEffect(() => { const focus = () => { if (active()) setReload(value => value + 1); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, []);
  useEffect(() => {
    const sequence = ++inventoryReads.current; fileReads.current++; setFile(null); setFileLoading(false); setFileError(''); setError(''); setLoading(true);
    const retained = actions.current.cached<unknown>(inventoryKey); const usable = validComparison(retained, id, selection) ? retained : null;
    setInventory(usable); setSaved(Boolean(usable));
    void (async () => {
      try {
        const next = await request<unknown>(`/api/repositories/${id}/compare?${comparisonQuery(selection)}`);
        if (!active() || sequence !== inventoryReads.current) return;
        if (!validComparison(next, id, selection)) throw new Error('The returned comparison does not match this exact commit pair.');
        setInventory(next); setSaved(false); actions.current.saveCache(inventoryKey, next);
      } catch (failure) {
        if (!active() || sequence !== inventoryReads.current) return;
        if (isNetworkError(failure)) setError(usable ? 'Offline: reading the previously loaded exact commit comparison.' : 'This exact commit pair has not been saved here. Reconnect to load it.');
        else { setInventory(null); setFile(null); actions.current.dropCache(inventoryKey); setError(failure instanceof Error ? failure.message : 'This comparison is unavailable.'); }
      } finally { if (active() && sequence === inventoryReads.current) setLoading(false); }
    })();
    return () => { inventoryReads.current++; fileReads.current++; };
  }, [id, pair, online, generation, reload]);
  const visible = inventory && validComparison(inventory, id, selection) ? inventory : null;
  const chosen = visible ? selectedChange(visible, selection) : undefined;
  useEffect(() => {
    if (!visible || chosen || selection.beforePath != null || selection.afterPath != null || !visible.changes.length || !active()) return;
    const first = visible.changes[0]!;
    actions.current.choose({ ...current.current, beforePath: first.before?.path ?? null, afterPath: first.after?.path ?? null }, true);
  }, [visible, chosen, fileKey]);
  useEffect(() => {
    const sequence = ++fileReads.current; setFile(null); setFileError(''); setFileLoading(false);
    if (!visible || !chosen) return;
    const retained = actions.current.cached<unknown>(fileKey), usable = validComparisonFile(retained, id, selection, visible) ? retained : null;
    setFile(usable); setSavedFile(Boolean(usable)); setFileLoading(true);
    void (async () => {
      try {
        const next = await request<unknown>(`/api/repositories/${id}/compare/file?${comparisonQuery(selection, true)}`);
        if (!active() || sequence !== fileReads.current) return;
        if (!validComparisonFile(next, id, selection, visible)) throw new Error('The returned file does not match the selected change and comparison access snapshot. Reload this exact comparison.');
        setFile(next); setSavedFile(false); actions.current.saveCache(fileKey, next);
      } catch (failure) {
        if (!active() || sequence !== fileReads.current) return;
        if (isNetworkError(failure)) setFileError(usable ? 'Offline: reading the previously loaded exact file comparison.' : 'This changed file has not been saved here. Reconnect to load its exact sides.');
        else { setFile(null); actions.current.dropCache(fileKey); setFileError(failure instanceof Error ? failure.message : 'The selected change is unavailable.'); }
      } finally { if (active() && sequence === fileReads.current) setFileLoading(false); }
    })();
    return () => { fileReads.current++; };
  }, [id, visible, fileKey, online, generation, reload]);
  const currentFile = visible && file && validComparisonFile(file, id, selection, visible) ? file : null;
  const compare = (base: string | null, target: string) => actions.current.choose({ commitId: target, path: '', view: 'changes', baseCommitId: base, beforePath: null, afterPath: null });
  const pick = (change: GitComparisonChange) => actions.current.choose({ ...current.current, beforePath: change.before?.path ?? null, afterPath: change.after?.path ?? null });
  const index = visible && chosen ? visible.changes.findIndex(item => item.id === chosen.id) : -1;
  return <div className="repository-comparison">
    <div className="repository-comparison-controls">
      <form onSubmit={event => { event.preventDefault(); if ((baseInput === 'empty' || isGitObjectId(baseInput)) && isGitObjectId(targetInput) && (baseInput === 'empty' || baseInput.length === targetInput.length)) compare(baseInput === 'empty' ? null : baseInput, targetInput); }}>
        <label className="field"><span>Base commit (or empty)</span><input aria-label="Comparison base commit" value={baseInput} onChange={event => setBaseInput(event.target.value.trim())} spellCheck={false}/></label>
        <label className="field"><span>Target commit</span><input aria-label="Comparison target commit" value={targetInput} onChange={event => setTargetInput(event.target.value.trim())} spellCheck={false}/></label>
        <button className="button primary" disabled={!(baseInput === 'empty' || isGitObjectId(baseInput)) || !isGitObjectId(targetInput) || baseInput !== 'empty' && baseInput.length !== targetInput.length}>Compare Exact Commits</button>
      </form>
      <div className="small-actions"><button className="button" disabled={selection.baseCommitId == null} onClick={() => compare(selection.commitId, selection.baseCommitId!)}>Swap Commits</button><button className="button" disabled={loading || fileLoading} onClick={() => setReload(value => value + 1)}>Reload Comparison</button>
        {visible && <label className="field"><span>Compare target with</span><select aria-label="Comparison parent" value={selection.baseCommitId === null ? 'empty' : visible.targetCommit.parentIds.includes(selection.baseCommitId!) ? selection.baseCommitId : 'custom'} onChange={event => { if (event.target.value !== 'custom') compare(event.target.value === 'empty' ? null : event.target.value, selection.commitId); }}><option value="custom" disabled>Custom exact base</option><option value="empty">Empty tree{visible.targetCommit.parentIds.length === 0 ? ' · initial commit' : ''}</option>{visible.targetCommit.parentIds.map((parent, ordinal) => <option key={parent} value={parent}>Parent {ordinal + 1} · {short(parent)}</option>)}</select></label>}
      </div>
      <p className="repository-comparison-pair"><strong>Exact comparison</strong><code>{selection.baseCommitId ?? 'Empty tree'}</code><span>→</span><code>{selection.commitId}</code></p>
      <p className="small muted">This compares two committed trees. Reference updates never move this pair. Merge parents are compared individually; branch reachability is not shown.</p>
      {visible && visible.targetCommit.parentIds.length > 1 && <p className="info-strip">Merge commit · {selection.baseCommitId && visible.targetCommit.parentIds.includes(selection.baseCommitId) ? `comparing parent ${visible.targetCommit.parentIds.indexOf(selection.baseCommitId) + 1} with the target.` : 'comparing the selected custom base or empty tree with the target.'}</p>}
    </div>
    <RepositoryPatch id={id} selection={selection} expected={visible} online={online} generation={generation} cached={cached} saveCache={saveCache} dropCache={dropCache}/>
    {(!online || saved || savedFile) && <p className="info-strip">Reading saved comparison snapshots. Only previously loaded commit pairs and changed files are available offline.</p>}
    {loading && <p className="card-body" role="status">Loading changed files…</p>}{error && <p className="info-strip" role="alert">{error}</p>}
    {visible && <>
      <div className="panel-heading"><h3>Changed Paths <span className="muted">({visible.changes.length})</span></h3><small>Rename/copy similarity: 50%. Copies from unchanged files are not exhaustively detected.</small></div>
      {!visible.changes.length ? <p className="card-body">No file changes between these exact trees.</p> : <div className="repository-change-list" aria-label="Changed files">{visible.changes.map(change => <button className={`repository-change-row${change.id === chosen?.id ? ' selected' : ''}`} key={change.id} onClick={() => pick(change)}><span className={`repository-change-status ${change.status}`}>{labels[change.status]}</span><strong>{title(change)}</strong><small>{change.before && change.after && change.before.mode !== change.after.mode ? `Mode ${change.before.mode} → ${change.after.mode}` : types[(change.after ?? change.before)!.type]}{change.similarity !== null ? ` · ${change.similarity}% similar` : ''}</small></button>)}</div>}
      {chosen && <div className="repository-selected-change"><div className="repository-change-navigation"><button className="button" disabled={index <= 0} onClick={() => pick(visible.changes[index - 1]!)}>Previous Change</button><span>Change {index + 1} of {visible.changes.length}</span><button className="button" disabled={index < 0 || index >= visible.changes.length - 1} onClick={() => pick(visible.changes[index + 1]!)}>Next Change</button></div><h3>{labels[chosen.status]} · {title(chosen)}</h3>
        {chosen.before && chosen.after && chosen.before.mode !== chosen.after.mode && <p className="info-strip">Mode changed: {chosen.before.mode} → {chosen.after.mode}{chosen.before.objectId === chosen.after.objectId ? '. File contents are unchanged.' : '.'}</p>}
        {fileLoading && <p role="status">Loading exact file sides…</p>}{fileError && <p className="info-strip" role="alert">{fileError}</p>}
        {currentFile && <><div className="repository-comparison-sides"><ComparisonSide label="Base" side={currentFile.before}/><ComparisonSide label="Target" side={currentFile.after}/></div><GitFileDifference file={currentFile}/><div className="small-actions">{currentFile.before && <button className="button" onClick={() => choose({ commitId: currentFile.before!.commitId, path: currentFile.before!.path, view: currentFile.before!.state === 'tree' ? 'tree' : 'file' })}>Open Base Source</button>}{currentFile.after && <button className="button" onClick={() => choose({ commitId: currentFile.after!.commitId, path: currentFile.after!.path, view: currentFile.after!.state === 'tree' ? 'tree' : 'file' })}>Open Target Source</button>}</div></>}
      </div>}
      {!chosen && (selection.beforePath != null || selection.afterPath != null) && <p className="info-strip">The selected change is not part of this inventory. Select a changed file to continue.</p>}
    </>}
  </div>;
}

function ComparisonSide({ label, side }: { label: string; side: GitComparisonSide | null }) {
  const messages = { binary: 'Binary file. Text comparison is unavailable.', oversized: 'File exceeds the text preview limit. No partial source is shown.', unsupported_encoding: 'File is not valid UTF-8. No replacement characters are substituted.', symlink: 'Symbolic link. Its target is never followed.', submodule: 'Submodule reference. Its repository is never opened or fetched.', tree: 'Directory tree. Select changed files to inspect their contents.' };
  return <section className="repository-comparison-side" aria-label={`${label} file identity`}><h4>{label}</h4>{side ? <><code>{side.path}</code><p>Mode {side.mode} · {side.size === null ? side.state === 'tree' ? 'Tree' : 'Gitlink' : `${side.size.toLocaleString()} bytes`}</p><code>{side.objectId}</code>{side.state !== 'text' && <p className="info-strip">{messages[side.state]}</p>}</> : <p>Absent from this tree.</p>}</section>;
}
function GitFileDifference({ file }: { file: GitComparisonFile }) {
  const result = useMemo(() => {
    if (file.before !== null && file.before.state !== 'text' || file.after !== null && file.after.state !== 'text') return null;
    const path = file.change.after?.path ?? file.change.before!.path;
    return compareFile(file.before ? { path, content: file.before.content } : null, file.after ? { path, content: file.after.content } : null, 'lines');
  }, [file]);
  if (!result) return <p className="info-strip">This change includes a non-text entry. Its exact identities and states are shown above.</p>;
  if (result.status === 'too_large') return <p className="info-strip">This text comparison exceeds the display limits. No partial diff is shown. Open either exact source to read it.</p>;
  return <div className="repository-literal-comparison">{result.fileChange === 'unchanged' && <p className="info-strip">No text changes. Path and mode changes are shown separately.</p>}<ComparisonLines comparison={result} passageIndex={-1} canComment={false} onLine={() => {}} selectedLine={null}/></div>;
}
