import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitBlame } from '../shared/repositories';
import { gitSourceLines, validGitBlame } from '../shared/git-blame';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import type { RepositorySelection } from './repository-cache';
import { blameCacheKey, blamePage, blameQuery } from './repository-blame';

type Props = { id: string; selection: RepositorySelection; online: boolean; generation: number; choose: (selection: RepositorySelection) => void; cached: <T>(key: string) => T | null; saveCache: (key: string, value: unknown) => void; dropCache: (key: string) => void };
const short = (id: string) => id.slice(0, 12);
export default function RepositoryBlame({ id, selection, online, generation, choose, cached, saveCache, dropCache }: Props) {
  const { request, isActive, unavailableObject, onRepositorySnapshotChange, onAccessChange } = useWorkspace();
  const key = blameCacheKey(selection);
  const [snapshot, setSnapshot] = useState<GitBlame | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [reload, setReload] = useState(0);
  const [lineInput, setLineInput] = useState('1'), [parent, setParent] = useState('');
  const reads = useRef(0), mounted = useRef(true), details = useRef<HTMLElement | null>(null);
  const actions = useRef({ cached, saveCache, dropCache }); actions.current = { cached, saveCache, dropCache };
  const active = () => mounted.current && isActive() && !unavailableObject(id);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  useEffect(() => onRepositorySnapshotChange(() => { reads.current++; setSnapshot(null); setLoading(false); }), []);
  useEffect(() => onAccessChange(ids => { if (ids.includes(id)) { reads.current++; setSnapshot(null); setLoading(false); setError('This repository is no longer available.'); } }), [id]);
  useEffect(() => { const focus = () => { if (active()) setReload(value => value + 1); }; window.addEventListener('focus', focus); return () => window.removeEventListener('focus', focus); }, []);
  useEffect(() => {
    const sequence = ++reads.current, retained = actions.current.cached<unknown>(key);
    const usable = validGitBlame(retained, id, selection.commitId, selection.path) ? retained : null;
    setSnapshot(usable); setSaved(Boolean(usable)); setLoading(true); setError('');
    void (async () => {
      try {
        const next = await request<unknown>(`/api/repositories/${id}/blame?${blameQuery(selection)}`);
        if (!active() || sequence !== reads.current) return;
        if (!validGitBlame(next, id, selection.commitId, selection.path)) throw new Error('The returned line provenance does not match this exact commit and path.');
        setSnapshot(next); setSaved(false); actions.current.saveCache(key, next);
      } catch (failure) {
        if (!active() || sequence !== reads.current) return;
        if (isNetworkError(failure)) setError(usable ? 'Offline: reading previously loaded line provenance for this exact file.' : 'Line provenance for this exact file has not been saved here. Reconnect to load it.');
        else { setSnapshot(null); actions.current.dropCache(key); setError(failure instanceof Error ? failure.message : 'Line provenance is unavailable.'); }
      } finally { if (active() && sequence === reads.current) setLoading(false); }
    })();
    return () => { reads.current++; };
  }, [id, key, online, generation, reload]);
  const visible = snapshot && validGitBlame(snapshot, id, selection.commitId, selection.path) ? snapshot : null;
  const source = useMemo(() => visible?.blob.state === 'text' ? gitSourceLines(visible.blob.content) : [], [visible]);
  const lineNumber = Math.min(selection.selectedLine ?? 1, source.length), line = visible?.lines?.[lineNumber - 1], origin = visible?.commits.find(commit => commit.id === line?.commitId);
  const page = blamePage(lineNumber, source.length);
  useEffect(() => { setLineInput(String(lineNumber || 1)); }, [lineNumber, key]);
  useEffect(() => { setParent(origin?.parentIds[0] ?? ''); }, [origin?.id]);
  const select = (number: number, focus = false) => { choose({ commitId: selection.commitId, path: selection.path, view: 'blame', selectedLine: number }); if (focus) requestAnimationFrame(() => details.current?.focus()); };
  const messages = { binary: 'This file is binary. Line provenance is unavailable.', oversized: 'This file exceeds the source preview limit. No partial source or attribution is shown.', unsupported_encoding: 'This file is not valid UTF-8 text. No replacement characters or partial attribution are shown.', symlink: 'This is a symbolic link. Its target is never followed; line provenance is unavailable.', submodule: 'This is a submodule reference. Its repository is never opened; line provenance is unavailable.' };
  return <div className="repository-blame">
    <div className="card-body"><div className="repository-blame-heading"><h3>Blame · Line provenance</h3><button className="button" disabled={loading} onClick={() => setReload(value => value + 1)}>Reload Line Provenance</button></div><p><code>{selection.path}</code> at <code>{selection.commitId}</code></p><p className="small muted">Git attributes each line to an origin commit. This is repository history, not review evidence or an authorship guarantee. Reference updates never move this exact file.</p></div>
    {(!online || saved) && <p className="info-strip">Reading saved line provenance. Only previously loaded exact files are available offline.</p>}
    {loading && <p className="card-body" role="status">Loading exact line provenance…</p>}{error && <p className="info-strip" role="alert">{error}</p>}
    {visible && <><p className="repository-blob-meta"><code>{visible.blob.objectId}</code><span>{visible.blob.size === null ? 'Gitlink' : `${visible.blob.size.toLocaleString()} bytes`} · mode {visible.blob.mode}</span></p>
      {visible.blob.state !== 'text' ? <p className="info-strip">{messages[visible.blob.state]}</p> : !source.length ? <p className="card-body">This file is empty. There are no lines to attribute.</p> : <>
        {line && origin && <section className="repository-blame-origin card-body" aria-label="Selected line origin" ref={details} tabIndex={-1}><h3>Line {line.lineNumber} origin</h3><code>{origin.id}</code><p>Authored by {origin.author.name} &lt;{origin.author.email}&gt; · {new Date(origin.author.timestamp).toLocaleString()}</p><p>Original line {line.originalLine} in <code>{line.path}</code></p><pre className="repository-message">{origin.message}</pre>{origin.messageTruncated && <p className="info-strip">Commit message truncated.</p>}<div className="small-actions"><button className="button" onClick={() => choose({ commitId: origin.id, path: line.path, view: 'file' })}>Open Origin Source</button><button className="button" onClick={() => choose({ commitId: origin.id, path: '', view: 'changes', baseCommitId: origin.parentIds[0] ?? null, beforePath: null, afterPath: null })}>Show Origin Commit Changes</button></div>
          {origin.parentIds.length ? <div className="repository-blame-parent"><label className="field"><span>Earlier history from this origin</span><select aria-label="Origin parent" value={parent} onChange={event => setParent(event.target.value)}>{origin.parentIds.map((value, index) => <option value={value} key={value}>Parent {index + 1} · {short(value)}</option>)}</select></label><button className="button" disabled={!origin.parentIds.includes(parent)} onClick={() => choose({ commitId: parent, path: line.path, view: 'blame' })}>Blame Parent at Same Path</button><p className="small muted">Opens the exact origin path in the selected parent. That path may not exist there; this action does not infer a renamed path.</p></div> : <p className="small muted">Initial commit: no earlier parent.</p>}
        </section>}
        <div className="repository-blame-controls"><button className="button" disabled={page.start === 0} onClick={() => select(page.start)}>Previous Lines</button><span>Lines {page.start + 1}–{page.end} of {source.length}</span><button className="button" disabled={page.end === source.length} onClick={() => select(page.end + 1)}>Next Lines</button><form onSubmit={event => { event.preventDefault(); const value = Number(lineInput); if (Number.isSafeInteger(value) && value > 0 && value <= source.length) select(value); }}><label className="field"><span>Go to line</span><input aria-label="Provenance line number" inputMode="numeric" value={lineInput} onChange={event => setLineInput(event.target.value)}/></label><button className="button" disabled={!Number.isSafeInteger(Number(lineInput)) || Number(lineInput) < 1 || Number(lineInput) > source.length}>Go to Line</button></form></div>
        <p className="info-strip">Select a line’s origin to inspect its commit. Up to 100 lines are displayed at a time. Source text preserves carriage returns and any byte-order mark.</p>
        {!visible.blob.content.endsWith('\n') && <p className="info-strip">This file has no final newline.</p>}
        <div className="repository-blame-lines" aria-label="Source with line provenance">{visible.lines!.slice(page.start, page.end).map(item => <div className={`repository-blame-line${item.lineNumber === lineNumber ? ' selected' : ''}`} key={item.lineNumber}><button aria-label={`Show origin of line ${item.lineNumber}`} aria-pressed={item.lineNumber === lineNumber} onClick={() => select(item.lineNumber, true)}><strong>{item.lineNumber}</strong><code>{short(item.commitId)}</code></button><pre>{source[item.lineNumber - 1]}</pre></div>)}</div>
      </>}
    </>}
  </div>;
}
