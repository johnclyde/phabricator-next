import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileCode2, Folder, FolderGit2, GitBranch, GitCommitHorizontal, History, RefreshCw } from 'lucide-react';
import RepositoryImport, { parseImportDraft } from './RepositoryImport';
import RepositoryComparison from './RepositoryComparison';
import RepositoryBlame from './RepositoryBlame';
import type { AppState, RevisionDetail } from '../shared/types';
import { isGitObjectId, type GitBlob, type GitCommitResult, type GitHistory, type GitRefs, type GitTree, type RepositoryDetail } from '../shared/repositories';
import { AccessSummary } from './Access';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { putRepositoryCache, repositoryCache, repositorySelection, type RepositorySelection } from './repository-cache';

const apiPath = (id: string, suffix: string) => `/api/repositories/${id}${suffix}`;
const query = (selection: RepositorySelection) => new URLSearchParams({ commit: selection.commitId, path: selection.path }).toString();
const short = (id: string) => id.slice(0, 12);
type Content = { key: string; data: GitTree | GitBlob | GitHistory; cached: boolean };
export default function RepositoryPage({ id, state, online, manageAccess, refreshWorkspace, opened }: { id: string; state: AppState; online: boolean; manageAccess: () => void; refreshWorkspace: () => Promise<void>; opened: (detail: RevisionDetail) => void }) {
  const { request, readStored, writeStored, isActive, unavailableObject, onAccessChange, onRepositorySnapshotChange, repositorySnapshotGeneration, quarantinedDrafts, durable } = useWorkspace();
  const [importing, setImporting] = useState<string | null>(null);
  const cache = useRef(repositoryCache(readStored(`repository:${id}:cache`, null)));
  const cached = <T,>(key: string): T | null => cache.current.entries.find(entry => entry.key === key)?.value as T ?? null;
  const [detail, setDetail] = useState<RepositoryDetail | null>(() => cached('detail'));
  const [refs, setRefs] = useState<GitRefs | null>(() => cached('refs'));
  const [selection, setSelection] = useState<RepositorySelection | null>(() => repositorySelection(readStored(`repository:${id}:selection`, null)));
  const selected = useRef(selection); selected.current = selection;
  const [commit, setCommit] = useState<GitCommitResult | null>(null); const [content, setContent] = useState<Content | null>(null);
  const commitInputDirty = useRef(false);
  const [commitInput, setCommitInput] = useState(selection?.commitId || ''); const [refChoice, setRefChoice] = useState('');
  const [loading, setLoading] = useState(false); const [paging, setPaging] = useState(false); const [refLoading, setRefLoading] = useState(false);
  const [error, setError] = useState(''); const [refError, setRefError] = useState(''); const [warning, setWarning] = useState(''); const [profileCached, setProfileCached] = useState(true);
  const [cacheGeneration, setCacheGeneration] = useState(repositorySnapshotGeneration);
  const mounted = useRef(true); const reads = useRef(0); const refReads = useRef(0); const profileReads = useRef(0);
  const active = () => mounted.current && isActive() && !unavailableObject(id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; refReads.current++; profileReads.current++; }; }, []);
  useEffect(() => onAccessChange(ids => { if (ids.includes(id)) { reads.current++; refReads.current++; profileReads.current++; cache.current = { entries: [] }; setDetail(null); setRefs(null); setCommit(null); setContent(null); } }), []);
  useEffect(() => onRepositorySnapshotChange(() => { reads.current++; refReads.current++; profileReads.current++; setPaging(false); setLoading(false); setRefLoading(false); cache.current = { entries: [] }; setDetail(null); setRefs(null); setCommit(null); setContent(null); setCacheGeneration(repositorySnapshotGeneration()); }), []);
  const saveCache = (key: string, value: unknown) => {
    if (!active()) return false;
    cache.current = putRepositoryCache(cache.current, key, value);
    const included = cache.current.entries.some(entry => entry.key === key), persisted = writeStored(`repository:${id}:cache`, cache.current);
    if (!included) setWarning('This snapshot exceeds the offline cache limit. Keep this tab open or reconnect to load it again.');
    else if (!persisted) setWarning('This snapshot could not be saved in browser storage. Keep this tab open or reconnect to load it again.');
    return included && persisted;
  };
  const dropCache = (key: string) => { if (!active()) return; cache.current = { ...cache.current, entries: cache.current.entries.filter(entry => entry.key !== key) }; writeStored(`repository:${id}:cache`, cache.current); };
  const choose = (next: RepositorySelection, automatic = false) => {
    if (!active()) return;
    next = repositorySelection(next)!;
    // Reopening the same selection must not retire an in-flight read without
    // changing the effect identity which starts its replacement.
    if (JSON.stringify(selected.current) === JSON.stringify(next)) { if (!automatic || !commitInputDirty.current) { setCommitInput(next.commitId); commitInputDirty.current = false; } return; }
    const lineOnly = selected.current?.view === 'blame' && next.view === 'blame' && selected.current.commitId === next.commitId && selected.current.path === next.path;
    if (!lineOnly) { reads.current++; setLoading(false); setPaging(false); setError(''); }
    selected.current = next; setSelection(next); if (!lineOnly && (!automatic || !commitInputDirty.current)) { setCommitInput(next.commitId); commitInputDirty.current = false; }
    if (!writeStored(`repository:${id}:selection`, next)) setWarning('The selected commit could not be saved. It may need to be selected again after reloading.');
  };
  const loadRefs = useCallback(async () => {
    const sequence = ++refReads.current; setRefLoading(true);
    try {
      const next = await request<GitRefs>(apiPath(id, '/refs'));
      if (!active() || sequence !== refReads.current) return;
      if (next.repositoryId !== id || next.refs.some(ref => ref.commitId !== null && !isGitObjectId(ref.commitId, next.objectFormat))) throw new Error('The repository returned an invalid reference snapshot.');
      setRefs(next); saveCache('refs', next); setRefError('');
      // Resolve the first displayed ref only once. Later refreshes never move an existing selection.
      if (!selected.current) {
        const initial = next.headCommit || next.refs.find(ref => ref.name === `refs/heads/${state.repositories.find(repo => repo.id === id)?.defaultBranch}`)?.commitId;
        if (initial && isGitObjectId(initial, next.objectFormat)) choose({ commitId: initial, path: '', view: 'tree' }, true);
      }
    } catch (failure) { if (active() && sequence === refReads.current) { setRefError(isNetworkError(failure) ? 'References could not be refreshed. Previously loaded references may be out of date.' : failure instanceof Error ? failure.message : 'Could not load repository references.'); if (!isNetworkError(failure)) { setRefs(null); dropCache('refs'); } } }
    finally { if (active() && sequence === refReads.current) setRefLoading(false); }
  }, [id]);
  const loadProfile = useCallback(async () => {
    const sequence = ++profileReads.current;
    try { const next = await request<RepositoryDetail>(apiPath(id, '')); if (!active() || sequence !== profileReads.current) return; if (next.repository.id !== id) throw new Error('The repository returned an invalid profile.'); setDetail(next); saveCache('detail', next); setProfileCached(false); if (next.observer.state === 'ready') await loadRefs(); else { reads.current++; refReads.current++; setLoading(false); setPaging(false); setRefLoading(false); setRefs(null); setContent(null); setCommit(null); } }
    catch (failure) { if (active() && sequence === profileReads.current) { setProfileCached(true); setRefError(isNetworkError(failure) ? 'Connection unavailable. Only snapshots previously loaded in this workspace can be read.' : failure instanceof Error ? failure.message : 'Could not load the repository.'); } }
  }, [id, loadRefs]);
  useEffect(() => { void loadProfile(); }, [loadProfile, online, cacheGeneration]);
  const loadContent = useCallback(async () => {
    const current = selected.current; if (!current || !active()) return;
    const sequence = ++reads.current; const key = `${current.view}:${current.commitId}:${current.path}`; const commitKey = `commit:${current.commitId}`;
    setPaging(false); setContent(cached(key) ? { key, data: cached<GitTree | GitBlob | GitHistory>(key)!, cached: true } : null); setCommit(cached(commitKey)); setError(''); setLoading(true);
    const suffix = current.view === 'tree' ? '/tree' : current.view === 'file' ? '/blob' : '/history';
    try {
      if (current.view === 'changes' || current.view === 'blame') {
        const next = await request<GitCommitResult>(apiPath(id, `/commits/${current.commitId}`));
        if (!active() || sequence !== reads.current) return;
        if (next.repositoryId !== id || next.commit.id !== current.commitId) throw new Error('The returned commit does not match the selected target.');
        setContent(null); setCommit(next); saveCache(commitKey, next); return;
      }
      const [nextCommit, next] = await Promise.all([request<GitCommitResult>(apiPath(id, `/commits/${current.commitId}`)), request<GitTree | GitBlob | GitHistory>(apiPath(id, `${suffix}?${query(current)}${current.view === 'history' ? '&limit=25' : ''}`))]);
      if (!active() || sequence !== reads.current) return;
      if (next.repositoryId !== id || next.commitId !== current.commitId || next.path !== current.path || nextCommit.repositoryId !== id || nextCommit.commit.id !== current.commitId) throw new Error('The returned source does not match the selected immutable commit and path. Select the source again explicitly.');
      setCommit(nextCommit); setContent({ key, data: next, cached: false }); saveCache(commitKey, nextCommit); saveCache(key, next);
    } catch (failure) {
      if (!active() || sequence !== reads.current) return;
      if (isNetworkError(failure)) setError(cached(key) ? 'Offline: this is the previously loaded exact snapshot.' : 'This exact commit and path have not been saved here. Reconnect to load them.');
      else { setContent(null); setCommit(null); dropCache(key); setError(failure instanceof Error ? failure.message : 'This source is unavailable.'); }
    } finally { if (active() && sequence === reads.current) setLoading(false); }
  }, [id, selection?.commitId, selection?.path, selection?.view, selection?.baseCommitId, selection?.beforePath, selection?.afterPath]);
  useEffect(() => { void loadContent(); }, [loadContent, online, cacheGeneration]);
  const moreHistory = async () => {
    if (!selection || selection.view !== 'history' || !content || !('commits' in content.data) || content.data.nextAfter === null || paging || loading) return;
    const current = selection; const initial = content.data; const sequence = reads.current; setPaging(true);
    try {
      const next = await request<GitHistory>(apiPath(id, `/history?${query(current)}&after=${initial.nextAfter}&limit=25`));
      if (!active() || sequence !== reads.current) return;
      if (next.repositoryId !== id || next.commitId !== current.commitId || next.path !== current.path || next.accessEpoch !== initial.accessEpoch) throw new Error('Repository visibility changed while loading history. Reload this exact history before continuing.');
      const combined = { ...next, commits: [...new Map([...initial.commits, ...next.commits].map(item => [item.id, item])).values()] };
      setContent({ key: content.key, data: combined, cached: false }); saveCache(content.key, combined);
    } catch (failure) { if (active() && sequence === reads.current) setError(failure instanceof Error ? failure.message : 'Could not load older commits.'); }
    finally { if (active() && sequence === reads.current) setPaging(false); }
  };
  const retainedImport = parseImportDraft(readStored(`repository-import:${id}`, null), id) || quarantinedDrafts().flatMap(item => item.key.replace(/:unsaved-memory$/, '') === `repository-import:${id}` ? [parseImportDraft(item.value, id)] : []).find(Boolean);
  const repository = detail?.repository || state.repositories.find(repo => repo.id === id);
  if (!repository) return <section className="panel card-body"><h1>{id}</h1><p>{refError || 'Loading repository…'}</p><button className="button" onClick={() => void loadProfile()}>Reload Repository</button></section>;
  const currentContent = selection && content?.key === `${selection.view}:${selection.commitId}:${selection.path}` ? content : null;
  const access = detail?.accessEpoch === state.accessEpoch ? detail.access : state.access[id];
  const viewPath = selection && (selection.view === 'file' || selection.view === 'blame' || selection.historyFrom === 'file') ? selection.path.split('/').slice(0, -1).join('/') : selection?.path || '';
  const knownRef = refs?.refs.find(ref => ref.name === refChoice);
  const showChanges = () => { if (selection && commit?.commit.id === selection.commitId) choose({ commitId: selection.commitId, path: '', view: 'changes', baseCommitId: commit.commit.parentIds[0] ?? null, beforePath: null, afterPath: null }); };
  return <div className="repository-detail">
    <a className="back-link" href="#repositories"><ArrowLeft size={14}/>All repositories</a>
    <div className="object-heading"><div><span className="object-id">{id} · Diffusion</span><h1><FolderGit2 size={26}/>{repository.name}</h1><p>{repository.description}</p></div><button className="button" onClick={() => void loadProfile()}><RefreshCw size={15}/>Reload Repository</button></div>
    <AccessSummary access={access} spaces={state.spaces} manage={manageAccess}/>
    {retainedImport && !importing && <section className="panel card-body"><h2>Retained Import Request</h2><p>An import request is saved for this repository. Retrying uses its original commit and input, even if the source is no longer available for browsing.</p><button className="button" disabled={!online || !access?.capabilities.edit} onClick={() => setImporting(retainedImport.input.commitId)}>Review Saved Import</button></section>}
    {importing && <RepositoryImport repositoryId={id} commitId={selection?.commitId || importing} state={state} online={online} close={() => setImporting(null)} refreshWorkspace={refreshWorkspace} opened={opened}/>}
    <div className="repository-metadata"><span>Registered remote: <code>{repository.remoteUrl || 'None'}</code></span><span>Default branch: <code>{repository.defaultBranch}</code></span></div>
    {(!online || profileCached || currentContent?.cached) && <p className="info-strip">{durable ? 'Reading saved repository snapshots. Offline browsing includes only exact commits and paths already loaded on this device.' : 'Reading content retained in this signed-in tab. Reconnect to load other repository paths.'}</p>}
    {warning && <p className="banner warning" role="status">{warning}</p>}
    {detail && detail.observer.state !== 'ready' ? <section className="panel card-body"><h2>{detail.observer.state === 'unconfigured' ? 'Source browsing is not configured' : 'Repository source is unavailable'}</h2><p>{detail.observer.message}</p><p>Registering a remote URL does not clone it. A server operator must configure a local Git repository for browsing.</p></section> : <>
      <section className="panel"><div className="panel-heading"><h2><GitBranch size={17}/>Branches & tags</h2><button className="button" disabled={!online || refLoading} onClick={() => void loadRefs()}>{refLoading ? 'Refreshing…' : 'Refresh References'}</button></div><div className="repository-ref-controls">
        <label className="field"><span>Repository reference</span><select aria-label="Repository reference" value={refChoice} onChange={event => setRefChoice(event.target.value)}><option value="">Choose a branch or tag</option>{refs?.refs.map(ref => <option key={ref.name} value={ref.name} disabled={!ref.commitId}>{ref.name} {ref.commitId ? `· ${short(ref.commitId)}` : '· Does not point to a commit'}</option>)}</select></label><button className="button" disabled={!knownRef?.commitId} onClick={() => { if (knownRef?.commitId) choose({ commitId: knownRef.commitId, path: '', view: 'tree' }); }}>Open Selected Reference</button>
        <form className="repository-commit-form" onSubmit={event => { event.preventDefault(); if (isGitObjectId(commitInput)) choose({ commitId: commitInput, path: '', view: 'tree' }); }}><label className="field"><span>Exact commit ID</span><input aria-label="Exact commit ID" value={commitInput} onChange={event => { commitInputDirty.current = true; setCommitInput(event.target.value.trim()); }} spellCheck={false}/></label><button className="button" disabled={!isGitObjectId(commitInput)}>Open Commit</button></form>
      </div><p className="info-strip">Opening a reference pins its full commit ID. Refreshing references or later branch changes will not move your selected commit.{refs ? ` References observed ${new Date(refs.observedAt).toLocaleString()}.` : ''}</p>{refError && <p className="error-text card-body" role="alert">{refError}</p>}{refs && !refs.refs.length && !refs.headCommit && <p className="card-body">This repository has no commit references yet.</p>}</section>
      {selection && <>
        <section className="panel repository-commit"><div className="panel-heading"><h2><GitCommitHorizontal size={17}/>Pinned commit</h2><button className="button" disabled={!online || !access?.capabilities.edit || !commit || commit.commit.id !== selection.commitId} onClick={() => setImporting(selection.commitId)}>Import as Review</button><button className="button" disabled={!commit || commit.commit.id !== selection.commitId} onClick={showChanges}>Show Commit Changes</button><button className="button" disabled={loading} onClick={() => void loadContent()}>Reload Exact Snapshot</button></div><div className="card-body"><code className="repository-commit-id">{selection.commitId}</code>{commit?.commit.id === selection.commitId && <><pre className="repository-message">{commit.commit.message}</pre>{commit.commit.messageTruncated && <p className="info-strip">This commit message exceeds the display limit and is truncated.</p>}<p className="muted small">Authored by {commit.commit.author.name} &lt;{commit.commit.author.email}&gt; · {new Date(commit.commit.author.timestamp).toLocaleString()}</p><div className="repository-parent-links">Parents: {commit.commit.parentIds.length ? commit.commit.parentIds.map(parent => <button className="text-button" key={parent} onClick={() => choose({ commitId: parent, path: '', view: 'tree' })}>{short(parent)}</button>) : 'Initial commit'}</div></>}</div></section>
        <section className="panel repository-source"><div className="panel-heading"><h2>{selection.view === 'history' ? <History size={17}/> : <FileCode2 size={17}/>}Committed source</h2><div className="segmented"><button className={selection.view === 'tree' || selection.view === 'file' ? 'selected' : ''} onClick={() => choose({ ...selection, path: viewPath, view: 'tree' })}>Browse Files</button><button className={selection.view === 'history' ? 'selected' : ''} onClick={() => choose({ ...selection, view: 'history', historyFrom: selection.view === 'history' ? selection.historyFrom : selection.view === 'file' || selection.view === 'blame' ? 'file' : 'tree' })}>Commit History</button><button className={selection.view === 'changes' ? 'selected' : ''} disabled={!commit || commit.commit.id !== selection.commitId} onClick={() => { if (selection.view !== 'changes') showChanges(); }}>Changes</button>{(selection.view === 'file' || selection.view === 'blame' || selection.historyFrom === 'file') && <button className={selection.view === 'blame' ? 'selected' : ''} onClick={() => { if (selection.view !== 'blame') choose({ commitId: selection.commitId, path: selection.path, view: 'blame' }); }}>Blame</button>}</div></div>
          {selection.view === 'blame' ? <RepositoryBlame id={id} selection={selection} online={online} generation={cacheGeneration} choose={choose} cached={cached} saveCache={saveCache} dropCache={dropCache}/> : selection.view === 'changes' ? <RepositoryComparison id={id} selection={selection} online={online} generation={cacheGeneration} choose={choose} cached={cached} saveCache={saveCache} dropCache={dropCache}/> : <>
          <nav className="repository-path" aria-label="Repository path"><button className="text-button" onClick={() => choose({ ...selection, path: '', view: 'tree' })}>Repository root</button>{selection.path.split('/').filter(Boolean).map((part, index, parts) => <span key={index}> / {index < parts.length - 1 ? <button className="text-button" onClick={() => choose({ ...selection, path: parts.slice(0, index + 1).join('/'), view: 'tree' })}>{part}</button> : <strong>{part}</strong>}</span>)}</nav>
          {loading && <p className="card-body" role="status">Loading the selected snapshot…</p>}{error && <p className="info-strip" role="alert">{error}</p>}
          {currentContent && 'entries' in currentContent.data && <div className="repository-tree">{currentContent.data.entries.map(entry => <button className="repository-entry" key={entry.path} onClick={() => choose({ ...selection, path: entry.path, view: entry.type === 'tree' ? 'tree' : 'file' })}>{entry.type === 'tree' ? <Folder size={18}/> : <FileCode2 size={18}/>}<span>{entry.name}</span><small>{entry.type === 'tree' ? 'Directory' : entry.type === 'symlink' ? 'Symbolic link' : entry.type === 'submodule' ? 'Submodule' : entry.mode === '100755' ? 'Executable file' : 'File'}</small><code>{short(entry.objectId)}</code></button>)}{!currentContent.data.entries.length && <p className="card-body">This directory is empty at the selected commit.</p>}</div>}
          {currentContent && 'state' in currentContent.data && <RepositoryBlob blob={currentContent.data}/>}
          {currentContent && 'commits' in currentContent.data && <><p className="info-strip">History starts at the pinned commit{selection.path ? ` and follows the exact path “${selection.path}”` : ''}. Branches may have advanced since this snapshot.</p><ol className="repository-history">{currentContent.data.commits.map(item => <li key={item.id}><button className="text-button" onClick={() => choose({ commitId: item.id, path: '', view: 'tree' })}>{short(item.id)}</button><pre>{item.message}</pre>{item.messageTruncated && <small>Message truncated.</small>}<p>{item.author.name} · {new Date(item.author.timestamp).toLocaleString()}</p></li>)}</ol>{!currentContent.data.commits.length && <p className="card-body">No commits matched this exact history.</p>}{currentContent.data.nextAfter !== null && <div className="card-body"><button className="button" disabled={!online || paging || loading} onClick={() => void moreHistory()}>{paging ? 'Loading older commits…' : 'Load Older Commits'}</button></div>}</>}
          </>}
        </section>
      </>}
    </>}
  </div>;
}

function RepositoryBlob({ blob }: { blob: GitBlob }) {
  const messages: Record<Exclude<GitBlob['state'], 'text'>, string> = { binary: 'This file is binary. No text preview is available.', oversized: 'This file exceeds the source preview limit. No partial source is shown.', unsupported_encoding: 'This file is not valid UTF-8 text. No replacement characters or partial source are shown.', symlink: 'This is a symbolic link. Its target is never followed or opened by the browser.', submodule: 'This is a submodule reference. Its repository is never fetched or opened automatically.' };
  return <div className="repository-blob"><p className="repository-blob-meta"><code>{blob.objectId}</code><span>{blob.size === null ? 'Gitlink' : `${blob.size.toLocaleString()} bytes`} · mode {blob.mode}</span></p>{blob.state === 'text' ? <>{blob.content === '' ? <p className="card-body">This file is empty.</p> : <pre className="repository-source-text" aria-label="Repository file source">{blob.content}</pre>}</> : <p className="info-strip">{messages[blob.state]}</p>}</div>;
}
