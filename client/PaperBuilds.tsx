import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, RefreshCw } from 'lucide-react';
import type { PaperArtifactKind, PaperBuild, PaperBuildDetail, PaperBuildInput, PaperBuildPage, PaperSyncTeX } from '../shared/paper-builds';
import type { RevisionDetail, RevisionVersion } from '../shared/types';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { onSessionLocked } from './session';
import { paperArtifact, paperRequestMatches, paperRequests, type PaperBuildRequest } from './paper-build-client';

const PaperPdf = lazy(() => import('./PaperPdf'));
const running = (build: PaperBuild) => build.status === 'queued' || build.status === 'running';
const title = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);
const when = (date: string) => new Date(date).toLocaleString();
function download(bytes: Uint8Array<ArrayBuffer>, type: string, name: string, urls: Set<string>) {
  const url = URL.createObjectURL(new Blob([bytes], { type })); urls.add(url);
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
}
export default function PaperBuilds({ detail, version, selectedPath, selectedLine, online, canEdit, accessEpoch, openSource }: {
  detail: RevisionDetail; version: RevisionVersion; selectedPath: string; selectedLine: number | null; online: boolean; canEdit: boolean; accessEpoch: number;
  openSource: (versionId: string, path: string | null, line: number | null) => void;
}) {
  const client = useWorkspace(); const { request, session, isActive, unavailableObject, onAccessChange, readStored, writeStored, storageKey, durable } = client;
  const id = detail.revision.id, key = `revision:${id}:paper-build-requests`;
  const [entrypoint, setEntrypoint] = useState(() => version.files.find(file => /\.tex$/.test(file.path))?.path || '');
  const [page, setPage] = useState<PaperBuildPage | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const pageRef = useRef(page); pageRef.current = page;
  const selectionGeneration = useRef(0), versionRef = useRef(version.id); versionRef.current = version.id;
  const [pending, setPending] = useState(() => paperRequests(readStored(key, []), id)); const pendingRef = useRef(pending); const unsavedRequests = useRef(new Map<string, PaperBuildRequest>());
  const [storageWarning, setStorageWarning] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(''), [loading, setLoading] = useState(false);
  const [pdf, setPdf] = useState<{ buildId: string; bytes: Uint8Array<ArrayBuffer>; mapping: PaperSyncTeX | null } | null>(null);
  const mounted = useRef(true), generation = useRef(0), artifactGeneration = useRef(0), artifactController = useRef<AbortController | null>(null), urls = useRef(new Set<string>());
  const current = () => mounted.current && isActive() && !unavailableObject(id);
  const retireArtifact = useCallback(() => { artifactGeneration.current++; artifactController.current?.abort(); artifactController.current = null; setPdf(null); setBusy(value => value.includes(':') ? '' : value); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); }, []);
  const clear = useCallback(() => { generation.current++; retireArtifact(); setPage(null); setSelectedId(null); pendingRef.current = []; unsavedRequests.current.clear(); setPending([]); setError(''); }, [retireArtifact]);
  useEffect(() => { mounted.current = true; const offAccess = onAccessChange(ids => { if (ids.includes(id) || (detail.revision.repositoryId && ids.includes(detail.revision.repositoryId))) clear(); }); const offSession = onSessionLocked(clear); return () => { mounted.current = false; generation.current++; artifactGeneration.current++; artifactController.current?.abort(); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); offAccess(); offSession(); }; }, [id, detail.revision.repositoryId, clear]);
  useEffect(() => { setEntrypoint(previous => version.files.some(file => file.path === previous && /\.tex$/.test(file.path)) ? previous : version.files.find(file => /\.tex$/.test(file.path))?.path || ''); }, [version.id]);
  useEffect(() => { retireArtifact(); }, [accessEpoch, retireArtifact]);
  const load = useCallback(async (before?: number) => {
    if (!online || !current()) return;
    const ticket = ++generation.current; setLoading(true);
    try {
      const next = await request<PaperBuildPage>(`/api/revisions/${id}/paper-builds?limit=25${before ? `&before=${before}` : ''}`);
      const recent = new Set(next.builds.map(build => build.id));
      const older = await Promise.all((pageRef.current?.builds || []).filter(build => running(build) && !recent.has(build.id)).map(async build => (await request<PaperBuildDetail>(`/api/revisions/${id}/paper-builds/${encodeURIComponent(build.id)}`)).build));
      if (!current() || ticket !== generation.current) return;
      setPage(previous => ({ ...next, builds: previous ? [...new Map([...previous.builds, ...next.builds, ...older].map(build => [build.id, build])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)) : next.builds, nextBefore: before || !previous ? next.nextBefore : previous.nextBefore ?? next.nextBefore })); setError('');
    } catch (failure) { if (current() && ticket === generation.current) setError(isNetworkError(failure) ? 'Reconnect to load paper builds. Compilation is never queued by this browser.' : failure instanceof Error ? failure.message : 'Paper builds could not be loaded.'); }
    finally { if (mounted.current && ticket === generation.current) setLoading(false); }
  }, [id, online]);
  useEffect(() => { void load(); const focus = () => { void load(); }; window.addEventListener('focus', focus); return () => { generation.current++; window.removeEventListener('focus', focus); }; }, [load, accessEpoch]);
  useEffect(() => { if (!online || !page?.builds.some(running)) return; const timer = window.setTimeout(() => { void load(); }, 3000); return () => window.clearTimeout(timer); }, [page, online, load]);
  useEffect(() => { const changed = (event: StorageEvent) => { if (event.key !== storageKey(key) && event.key !== null) return; if (!current()) return; const next = [...new Map([...paperRequests(readStored(key, []), id), ...unsavedRequests.current.values()].map(item => [item.id, item])).values()]; pendingRef.current = next; setPending(next); }; window.addEventListener('storage', changed); return () => window.removeEventListener('storage', changed); }, [key]);
  const journal = async (add: PaperBuildRequest | null, removeId?: string) => {
    const change = () => {
      if (!current()) return false;
      const next = [...new Map([...paperRequests(readStored(key, []), id), ...unsavedRequests.current.values(), ...(add ? [add] : [])].map(item => [item.id, item])).values()].filter(item => item.id !== removeId);
      pendingRef.current = next; setPending(next); const saved = writeStored(key, next); if (removeId) unsavedRequests.current.delete(removeId); if (saved) unsavedRequests.current.clear(); else if (add) unsavedRequests.current.set(add.id, add); setStorageWarning(!saved); return true;
    };
    return navigator.locks ? navigator.locks.request(storageKey(`${key}:write`), change) : change();
  };
  const submit = async (intent: PaperBuildRequest) => {
    if (!current() || busy || !online || !canEdit) return;
    const selectedAtStart = selectionGeneration.current, versionAtStart = versionRef.current;
    setBusy(intent.id); setError('');
    try {
      if (!await journal(intent)) return;
      const path = `/api/revisions/${id}/paper-builds${intent.action === 'compile' ? '' : `/${encodeURIComponent(intent.buildId!)}/${intent.action}`}`;
      const result = await request<PaperBuild>(path, { method: 'POST', id: intent.id, body: intent.action === 'compile' ? intent.input : {} });
      if (!current()) return;
      if (!paperRequestMatches(result, intent)) throw new Error('The returned build does not match the submitted request. Keep this request for exact retry.');
      await journal(null, intent.id); if (!current()) return; if (selectedAtStart === selectionGeneration.current && versionAtStart === versionRef.current) { setSelectedId(result.id); retireArtifact(); } await load();
    } catch (failure) { if (current()) setError(isNetworkError(failure) ? 'The outcome is unknown. Retry this exact request when connected; its request ID prevents a duplicate build.' : `${failure instanceof Error ? failure.message : 'The operation could not be confirmed.'} The original request is retained for exact retry.`); }
    finally { if (mounted.current) setBusy(''); }
  };
  const makeIntent = (action: PaperBuildRequest['action'], build?: PaperBuild): PaperBuildRequest => ({ id: crypto.randomUUID(), revisionId: id, action, buildId: build?.id || null, input: build ? { versionId: build.versionId, contentHash: build.contentHash, entrypoint: build.entrypoint, toolchainId: build.toolchainId } : { versionId: version.id, contentHash: version.contentHash, entrypoint, toolchainId: page!.configuration.toolchainId! }, createdAt: new Date().toISOString() });
  const selected = page?.builds.find(build => build.id === selectedId);
  const artifact = async (build: PaperBuild, kind: PaperArtifactKind, preview = false) => {
    if (!current() || !online || busy) return; const record = build.artifacts.find(item => item.kind === kind); if (!record) return;
    const ticket = ++artifactGeneration.current; artifactController.current?.abort(); const controller = new AbortController(); artifactController.current = controller; setBusy(`${build.id}:${kind}`); setError('');
    try {
      const bytes = await paperArtifact(client, id, build.id, kind, record.bytes, record.sha256, controller.signal);
      if (!current() || ticket !== artifactGeneration.current) return;
      if (preview) {
        let mapping: PaperSyncTeX | null = null;
        if (build.artifacts.some(item => item.kind === 'mapping')) {
          mapping = await request<PaperSyncTeX>(`/api/revisions/${id}/paper-builds/${encodeURIComponent(build.id)}/synctex`);
          if (mapping.versionId !== build.versionId || mapping.contentHash !== build.contentHash || mapping.origin !== 'top-left' || mapping.units !== 'pt') throw new Error('The source map does not belong to this paper version.');
        }
        if (current() && ticket === artifactGeneration.current) setPdf({ buildId: build.id, bytes, mapping });
      } else download(bytes, record.mediaType, record.name, urls.current);
    } catch (failure) { if (current() && ticket === artifactGeneration.current) { setPdf(null); setError(failure instanceof Error ? failure.message : 'The artifact could not be opened.'); void load(); } }
    finally { if (mounted.current && ticket === artifactGeneration.current) setBusy(''); }
  };
  const input: PaperBuildInput | null = page?.configuration.toolchainId ? { versionId: version.id, contentHash: version.contentHash, entrypoint, toolchainId: page.configuration.toolchainId } : null;
  const pinnedPending = pending.some(item => item.action === 'compile' && JSON.stringify(item.input) === JSON.stringify(input));
  const selectedSource = selected && detail.versions.find(item => item.id === selected.versionId && item.contentHash === selected.contentHash);
  return <section className="panel paper-builds" aria-label="Paper compilation"><div className="panel-heading"><h2><FileText size={17}/>Paper Compilation</h2><button className="button" disabled={!online || loading} onClick={() => void load()}><RefreshCw size={15}/>{loading ? 'Refreshing…' : 'Refresh Builds'}</button></div><div className="card-body">
    <p>Compile the saved source in <strong>version {version.number}</strong>. Unsaved editor drafts are excluded. The result stays attached to this exact version.</p>
    <form onSubmit={event => { event.preventDefault(); if (input && !pinnedPending) void submit(makeIntent('compile')); }}><label className="field"><span>TeX entrypoint</span><select aria-label="TeX entrypoint" value={entrypoint} disabled={Boolean(busy)} onChange={event => setEntrypoint(event.target.value)}>{version.files.filter(file => /\.tex$/.test(file.path)).map(file => <option key={file.path} value={file.path}>{file.path}</option>)}{!entrypoint && <option value="">No TeX source in this version</option>}</select></label><button className="button primary" disabled={!online || !canEdit || Boolean(busy) || !entrypoint || !page?.configuration.available || !input || pinnedPending}>Compile Version {version.number}</button></form>
    {!online && <p className="info-strip">Connect to compile, cancel, retry, or load artifacts. No build request is sent automatically after reconnecting.</p>}{!canEdit && <p className="info-strip">Edit access is required to compile, retry, or cancel. Existing authorized builds remain readable.</p>}{page && !page.configuration.available && <p className="info-strip">{page.configuration.reason || 'The operator has not configured an isolated paper compiler.'}</p>}
    {page?.configuration.toolchain && <details><summary>Compiler identity</summary><dl className="paper-build-metadata"><dt>Engine</dt><dd>{page.configuration.toolchain.engine}</dd><dt>Image</dt><dd><code>{page.configuration.toolchain.image}</code></dd><dt>Bundle</dt><dd><code>{page.configuration.toolchain.bundle}</code></dd></dl></details>}
    {storageWarning && <p className="banner warning" role="status">This tab could not save its pending request. Keep it open or export the request before reloading.</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    {pending.length > 0 && <section className="paper-build-pending" aria-label="Unconfirmed paper build requests"><h3>Unconfirmed Requests</h3><p className="small muted">These pins and request IDs stay fixed. Retry only by pressing the matching button. {durable ? 'Retained on this device until confirmed or discarded.' : 'Retained in this signed-in tab; export before signing out.'}</p>{pending.map(intent => <div className="paper-build-request" key={intent.id}><p>{title(intent.action)} · <code>{intent.input.entrypoint}</code> · Version {detail.versions.find(item => item.id === intent.input.versionId)?.number ?? intent.input.versionId}</p><div className="paper-build-actions"><button className="button" disabled={!online || !canEdit || Boolean(busy)} onClick={() => void submit(intent)}>Retry Exact {title(intent.action)} Request</button><button className="button" onClick={() => download(new TextEncoder().encode(JSON.stringify(intent, null, 2)), 'application/json', `${id}-build-request-${intent.id}.json`, urls.current)}>Export Request</button><button className="button" disabled={Boolean(busy)} onClick={() => { if (window.confirm('Discard this request record? Its operation may already have completed. This does not cancel or delete a server build.')) void journal(null, intent.id); }}>Discard Request Record</button></div></div>)}</section>}
    <h3>Build History</h3>{!page ? <p className="muted">{loading ? 'Loading builds…' : 'Reconnect and refresh to load builds.'}</p> : !page.builds.length ? <p className="muted">No builds have been requested for this paper.</p> : <ol className="paper-build-history">{page.builds.map(build => <li key={build.id}><button className="paper-build-select" aria-pressed={selectedId === build.id} onClick={() => { selectionGeneration.current++; setSelectedId(build.id); retireArtifact(); setError(''); }}><span><strong>Version {build.versionNumber} · {build.entrypoint}</strong><small>{when(build.createdAt)} · Attempt {build.attempt}</small></span><span className={`badge paper-build-${build.status}`}>{title(build.status)}</span></button></li>)}</ol>}
    {page?.nextBefore && <button className="button" disabled={!online || loading} onClick={() => void load(page.nextBefore!)}>Load Earlier Builds</button>}
    {selected && <section className="paper-build-detail" aria-label={`Build for version ${selected.versionNumber}`}><h3>Version {selected.versionNumber} · {title(selected.status)}</h3><p><code>{selected.entrypoint}</code> · {selected.id}</p><dl className="paper-build-metadata"><dt>Content</dt><dd><code>{selected.contentHash}</code></dd><dt>Compiler</dt><dd><code>{selected.toolchainId}</code></dd></dl>{selected.error && <p className="error-text">{selected.error}</p>}<div className="paper-build-actions">{running(selected) ? <button className="button danger" disabled={!online || !canEdit || Boolean(busy) || pending.some(item => item.action === 'cancel' && item.buildId === selected.id)} onClick={() => void submit(makeIntent('cancel', selected))}>Cancel Build</button> : <button className="button" disabled={!online || !canEdit || Boolean(busy) || pending.some(item => item.action === 'retry' && item.buildId === selected.id)} onClick={() => void submit(makeIntent('retry', selected))}>Rebuild Same Source</button>}{selected.artifacts.some(item => item.kind === 'pdf') && <><button className="button primary" disabled={!online || Boolean(busy)} onClick={() => void artifact(selected, 'pdf', true)}>Open PDF Preview</button><button className="button" disabled={!online || Boolean(busy)} onClick={() => void artifact(selected, 'pdf')}><Download size={15}/>Download PDF</button></>}{selected.artifacts.filter(item => ['log', 'manifest', 'synctex'].includes(item.kind)).map(item => <button className="button" key={item.kind} disabled={!online || Boolean(busy)} onClick={() => void artifact(selected, item.kind)}>Download {item.kind === 'log' ? 'Build Log' : item.kind === 'manifest' ? 'Source Manifest' : 'SyncTeX'}</button>)}</div>
      {selected.diagnostics.length > 0 && <ul className="paper-build-diagnostics">{selected.diagnostics.map((diagnostic, index) => <li key={index}><strong>{title(diagnostic.severity)}:</strong> {diagnostic.message}{diagnostic.path && selectedSource?.files.some(file => file.path === diagnostic.path) && <button className="button" onClick={() => openSource(selected.versionId, diagnostic.path!, diagnostic.line || null)}>Open original source · {diagnostic.path}{diagnostic.line ? `:${diagnostic.line}` : ''}</button>}</li>)}</ul>}
      {selected.attempts.length > 0 && <details><summary>Worker attempts ({selected.attempts.length})</summary><ol>{selected.attempts.map(attempt => <li key={attempt.number}>Attempt {attempt.number} · {title(attempt.status)} · {when(attempt.startedAt)}{attempt.error && <p>{attempt.error}</p>}</li>)}</ol></details>}
      {pdf?.buildId === selected.id && <Suspense fallback={<p role="status">Loading PDF viewer…</p>}><PaperPdf key={selected.id} bytes={pdf.bytes} mapping={pdf.mapping} versionId={selected.versionId} versionNumber={selected.versionNumber} sourcePath={version.id === selected.versionId ? selectedPath : null} sourceLine={version.id === selected.versionId ? selectedLine : null} openSource={openSource}/></Suspense>}
    </section>}
  </div></section>;
}
