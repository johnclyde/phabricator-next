import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { REVISION_METADATA_LIMITS, revisionMetadataInput, type RevisionMetadataHistory, type RevisionMetadataSnapshot } from '../shared/revision-metadata';
import { METADATA_HISTORY_LIMIT, metadataDraft, metadataDraftError, metadataDraftMatches, metadataIntent, metadataReading, metadataReadingCurrent, metadataSnapshot, mergeMetadataHistory, prepareMetadataDraft, verifiedMetadataResult, type MetadataDraft, type MetadataIntent, type MetadataReading } from './revision-metadata';
import RevisionTestPlan from './RevisionTestPlan';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { retainFileIntent } from './file-client';
import { onSessionLocked } from './session';

function exportMetadata(id: string, value: unknown, kind: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-revision-details-${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
const failureText = (error: unknown) => error instanceof Error ? error.message : 'Revision details could not be loaded.';

export default function RevisionMetadata({ id, state, online, selectedVersionId, refreshWorkspace, reloadRevision, notify }: { id: string; state: AppState; online: boolean; selectedVersionId: string; refreshWorkspace: () => Promise<void>; reloadRevision: () => Promise<unknown>; notify: (message: string) => void }) {
  const client = useWorkspace(), cacheKey = `revision-metadata:${id}`, draftKey = `revision-metadata-draft:${id}`, requestKey = `revision-metadata-request:${id}`;
  const cached = (knownState = state) => { const saved = metadataReading(client.readStored(cacheKey, null), id); return saved && (saved.snapshot.accessEpoch === client.session?.accessEpoch || client.durable && !online && client.session?.accessEpoch === -1) && metadataReadingCurrent(saved, knownState.revisions.find(item => item.id === id)) ? saved : null; };
  const [reading, setReading] = useState<MetadataReading | null>(cached), [draft, setDraft] = useState(() => metadataDraft(client.readStored(draftKey, null))), [pending, setPending] = useState(() => metadataIntent(client.readStored(requestKey, null), id));
  const [loading, setLoading] = useState(false), [paging, setPaging] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true), [draftSaved, setDraftSaved] = useState(!client.draftHasUnsavedMemory(draftKey));
  const mounted = useRef(false), generation = useRef(0), current = useRef(reading), latest = useRef(draft), stateRef = useRef(state), loadRef = useRef<() => void>(() => {}), refreshRef = useRef(refreshWorkspace), reloadRef = useRef(reloadRevision), metadataRetry = useRef<string | null>(null);
  latest.current = draft; stateRef.current = state; refreshRef.current = refreshWorkspace; reloadRef.current = reloadRevision;
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const show = (next: MetadataReading | null) => { current.current = next; setReading(next); };
  const sync = () => { const next = metadataDraft(client.readStored(draftKey, null)); latest.current = next; setDraft(next); setPending(metadataIntent(client.readStored(requestKey, null), id)); setDraftSaved(!client.draftHasUnsavedMemory(draftKey)); };
  const load = useCallback(async () => {
    if (!active()) return;
    const ticket = ++generation.current; setPaging(false); setError('');
    if (!online) { show(cached(stateRef.current)); setLoading(false); return; }
    show(null); setLoading(true);
    try {
      const snapshot = await client.request<RevisionMetadataSnapshot>(`/api/revisions/${id}/metadata`);
      if (!active() || ticket !== generation.current) return;
      if (!metadataSnapshot(snapshot, id)) throw new Error('Revision details could not be verified.');
      const history = await client.request<RevisionMetadataHistory>(`/api/revisions/${id}/metadata/history?limit=25&expectedMetadataVersion=${snapshot.metadata.version}`);
      if (!active() || ticket !== generation.current) return;
      const next = metadataReading({ snapshot, history }, id);
      if (!next || snapshot.accessEpoch !== client.session?.accessEpoch) throw new Error('Revision details changed while loading. Reload Revision Details.');
      const known = stateRef.current.revisions.find(item => item.id === id);
      if (!metadataReadingCurrent(next, known)) {
        client.removeStored(cacheKey);
        const identity = JSON.stringify([known?.currentVersion, known?.metadataVersion]);
        if (metadataRetry.current !== identity) { metadataRetry.current = identity; queueMicrotask(() => { if (active() && ticket === generation.current) loadRef.current(); }); }
        else setError('Newer revision details are available. Reload Revision Details; your draft keeps its original versions.');
        return;
      }
      metadataRetry.current = null; show(next); setSaved(client.writeStored(cacheKey, next));
      if (!known || snapshot.accessEpoch > stateRef.current.accessEpoch || snapshot.metadata.version > (known.metadataVersion ?? -1) || snapshot.head.number > known.currentVersion) { void refreshRef.current(); void reloadRef.current(); }
    } catch (failure) { if (active() && ticket === generation.current) { if (!isNetworkError(failure)) { client.removeStored(cacheKey); void refreshRef.current(); } setError(failureText(failure)); } }
    finally { if (mounted.current && ticket === generation.current) setLoading(false); }
  }, [id, online]);
  loadRef.current = () => void load();
  useEffect(() => {
    mounted.current = true; void load();
    const retire = () => { generation.current++; show(null); setLoading(false); setPaging(false); sync(); queueMicrotask(() => { if (active()) loadRef.current(); }); };
    const offSnapshot = client.onTaskSnapshotChange(retire), offAccess = client.onAccessChange(retire), offSession = onSessionLocked(() => { generation.current++; show(null); setDraft(null); setPending(null); });
    const focus = () => loadRef.current(), storage = (event: StorageEvent) => { if (!event.key || [draftKey, requestKey].some(key => event.key === client.storageKey(key))) sync(); };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => { mounted.current = false; generation.current++; offSnapshot(); offAccess(); offSession(); window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); };
  }, [load]);
  const known = state.revisions.find(item => item.id === id);
  useEffect(() => { if (current.current && !metadataReadingCurrent(current.current, known)) { generation.current++; show(null); loadRef.current(); } }, [known?.metadataVersion, known?.currentVersion]);
  const more = async () => {
    const before = current.current; if (!before || before.history.nextBefore === null || !online || paging) return;
    const ticket = generation.current; setPaging(true); setError('');
    try { const page = await client.request<RevisionMetadataHistory>(`/api/revisions/${id}/metadata/history?limit=25&expectedMetadataVersion=${before.snapshot.metadata.version}&before=${before.history.nextBefore}`); if (!active() || ticket !== generation.current || current.current !== before) return; const next = { ...before, history: mergeMetadataHistory(before.history, page) }; show(next); setSaved(client.writeStored(cacheKey, next)); }
    catch (failure) { if (active() && ticket === generation.current) { show(null); client.removeStored(cacheKey); setError(failureText(failure)); } }
    finally { if (mounted.current && ticket === generation.current) setPaging(false); }
  };
  const update = (next: MetadataDraft) => { if (!client.isActive() || client.draftIsHeld(draftKey)) return; latest.current = next; setDraft(next); setDraftSaved(client.writeStored(draftKey, next)); };
  const begin = () => { const snapshot = current.current?.snapshot; if (!snapshot?.access.capabilities.edit || pending) return; if (latest.current && !window.confirm('Replace this retained revision details draft? Export it first to keep a copy.')) return; update(prepareMetadataDraft(snapshot)); setError(''); setNotice(''); };
  const send = async (intent: MetadataIntent) => {
    if (!online || saving || !active() || !current.current?.snapshot.access.capabilities.edit || client.draftIsHeld(requestKey)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(metadataIntent(retained.intent, id));
      if (!retained.accepted) throw new Error('Another unconfirmed revision details request is retained. Retry or export that exact request first.');
      if (!retained.persisted && mounted.current) setNotice('This submitted request is only retained in this tab. Keep it open and export the request.');
      const result = await client.request<unknown>(`/api/revisions/${id}/metadata`, { method: 'POST', body: intent.body, id: intent.id });
      const receipt = await verifiedMetadataResult(result, id, intent.body, stateRef.current.currentPrincipalId);
      if (!client.isActive() || client.unavailableObject(id) || receipt.accessEpoch !== client.session?.accessEpoch) return;
      client.removeStoredIfEqual(requestKey, intent); client.removeStoredIfEqual(draftKey, intent.draft); client.removeStored(cacheKey); if (receipt.changed) client.invalidateRevisionStacks();
      const message = receipt.changed ? 'Revision details saved. Source versions and acceptance are unchanged.' : 'Revision details already matched this request. No new history entry was created.';
      notify(message); if (mounted.current) { sync(); setNotice(message); }
      await refreshRef.current(); if (active()) { await reloadRef.current(); await load(); }
    } catch (failure) { if (mounted.current && client.isActive()) { setError(failureText(failure)); void refreshRef.current(); } }
    finally { if (mounted.current) setSaving(false); }
  };
  const snapshot = reading?.snapshot, enabled = Boolean(snapshot?.access.capabilities.edit && !client.unavailableObject(id)), drifted = Boolean(draft && snapshot && !metadataDraftMatches(draft, snapshot)), invalid = draft ? metadataDraftError(draft, snapshot?.config.requireTestPlan ?? true) : null;
  const submitAllowed = Boolean(online && enabled && draft && snapshot?.accessEpoch === client.session?.accessEpoch && !drifted && !invalid && !pending && !loading && !saving && !client.draftIsHeld(draftKey));
  return <section className="panel revision-metadata" aria-label="Revision Details"><div className="panel-heading"><h2>Revision Details</h2><div className="file-actions"><button className="button" disabled={!online || loading || saving} onClick={() => void load()}>{loading ? 'Loading Details…' : 'Reload Revision Details'}</button>{enabled && <button className="button" disabled={loading || saving || Boolean(pending)} onClick={begin}>Edit Revision</button>}</div></div><div className="card-body">
    {snapshot ? <><p className="small muted">Current title, summary, and Test Plan apply across source versions. Editing these details preserves source versions, review decisions, and acceptance.</p>{selectedVersionId !== snapshot.head.versionId && <p className="info-strip">You are inspecting an earlier source version. These are the current revision details; saving them keeps your source selection fixed.</p>}<h3>{snapshot.metadata.title}</h3><h4>Summary</h4><div className="revision-metadata-text">{snapshot.metadata.summary || 'No summary provided.'}</div><h4>Test Plan</h4><div className="revision-metadata-text">{snapshot.metadata.testPlan === null ? 'No Test Plan was recorded for this older revision.' : snapshot.metadata.testPlan || 'No Test Plan provided.'}</div><p className="small muted">Revision details version {snapshot.metadata.version}. The Test Plan describes verification; it does not record checks or reviewer decisions.</p></> : <p role="status">{loading ? 'Loading authorized revision details…' : 'Revision details are unavailable. Reconnect and reload before editing.'}</p>}
    {!online && <p className="info-strip">Saved revision details. Drafts stay retained; reconnect and save explicitly. Reconnecting never submits them.</p>}{!saved && <p className="banner warning">This snapshot could not be saved for offline reading.</p>}{error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
    {draft && !client.draftIsHeld(draftKey) && <section className="revision-metadata-editor" aria-label="Revision details draft"><h3>Edit Revision</h3><p className="small muted">Prepared from revision details version {draft.expectedMetadataVersion} and source version {draft.expectedVersion}. The source, configuration, and access versions remain fixed.</p><label className="field"><span>Revision title</span><input aria-label="Revision title" maxLength={REVISION_METADATA_LIMITS.titleBytes} value={draft.title} onChange={event => update({ ...draft, title: event.target.value })}/></label><label className="field"><span>Revision summary</span><textarea aria-label="Revision summary" rows={4} maxLength={REVISION_METADATA_LIMITS.corpus} value={draft.summary} onChange={event => update({ ...draft, summary: event.target.value })}/></label><RevisionTestPlan value={draft.testPlan} required={snapshot?.config.requireTestPlan ?? true} change={testPlan => update({ ...draft, testPlan })}/><label className="field"><span>Edit explanation</span><textarea aria-label="Edit explanation" rows={2} maxLength={REVISION_METADATA_LIMITS.message} value={draft.message} onChange={event => update({ ...draft, message: event.target.value })}/></label>{invalid && <p className="small muted">{invalid}</p>}{drifted && <p className="banner warning">Revision details, source, configuration, or access changed. This draft keeps its original versions. Export it before preparing a new edit.</p>}<div className="file-actions"><button className="button primary" disabled={!submitAllowed} onClick={() => { const body = revisionMetadataInput(draft); void send({ id: crypto.randomUUID(), revisionId: id, body, draft }); }}>{saving ? 'Saving Details…' : 'Save Revision Details'}</button><button className="button" onClick={() => exportMetadata(id, draft, 'draft')}>Export Revision Details Draft</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Discard this revision details draft? Any submitted request is retained separately.')) { client.removeStoredIfEqual(draftKey, draft); sync(); } }}>Discard Revision Details Draft</button></div>{!draftSaved && <p className="banner warning">This draft is only in this tab. Keep it open and export it.</p>}</section>}
    {pending && !client.draftIsHeld(requestKey) && <section className="revision-metadata-recovery" aria-label="Unconfirmed revision details"><h3>Unconfirmed Revision Details</h3><p>This change may already have completed. Retry sends the same title, summary, Test Plan, message, request ID, and exact versions. Reconnecting never retries it.</p><div className="file-actions"><button className="button" disabled={!online || !enabled || loading || saving} onClick={() => void send(pending)}>Retry Exact Revision Details</button><button className="button" onClick={() => exportMetadata(id, pending, 'request')}>Export Revision Details Request</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Forget this request? A completed edit remains in history.')) { client.removeStoredIfEqual(requestKey, pending); sync(); } }}>Forget Revision Details Request</button></div>{client.draftHasUnsavedMemory(requestKey) && <p className="banner warning">This request is only retained in this tab.</p>}</section>}
    {reading && <details className="revision-metadata-history"><summary>Revision Details History</summary><ol>{reading.history.transactions.map(item => <li key={item.id}><strong>{item.attribution.displayName}</strong> edited revision details<small>{new Date(item.createdAt).toLocaleString()} · details version {item.metadataVersion} · source version {item.head.number}</small>{item.message && <p>{item.message}</p>}<details><summary>Inspect Changed Fields</summary>{(['title', 'summary', 'testPlan'] as const).filter(field => item.before[field] !== item.after[field]).map(field => <div key={field}><h4>{field === 'testPlan' ? 'Test Plan' : field === 'title' ? 'Title' : 'Summary'}</h4><p className="small muted">Before</p><pre>{item.before[field] === null ? 'Not recorded' : item.before[field] || '(Empty)'}</pre><p className="small muted">After</p><pre>{item.after[field] || '(Empty)'}</pre></div>)}</details></li>)}</ol>{!reading.history.transactions.length && <p className="small muted">No revision detail changes recorded.</p>}{reading.history.nextBefore !== null && <button className="button" disabled={!online || loading || paging || reading.history.transactions.length >= METADATA_HISTORY_LIMIT} onClick={() => void more()}>Load Older Revision Details</button>}<p className="small muted">Up to {METADATA_HISTORY_LIMIT} history entries are retained in this reading view.</p></details>}
  </div></section>;
}
