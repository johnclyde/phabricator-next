import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { REVISION_LIFECYCLE_LIMITS, revisionLifecycleActionLabel, type RevisionLifecycleAction, type RevisionLifecycleHistory, type RevisionLifecycleInput, type RevisionLifecycleSnapshot } from '../shared/revision-lifecycle';
import { revisionStatusLabel } from '../shared/revision-status';
import { LIFECYCLE_HISTORY_LIMIT, lifecycleDraft, lifecycleDraftMatches, lifecycleIntent, lifecycleReading, lifecycleSnapshot, mergeLifecycleHistory, revisionRefreshDirection, prepareLifecycleDraft, verifiedLifecycleResult, type LifecycleIntent, type LifecycleReading } from './revision-lifecycle';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { retainFileIntent } from './file-client';
import { onSessionLocked } from './session';

const failureText = (error: unknown) => error instanceof Error ? error.message : 'Lifecycle could not be loaded.';
function exportLifecycle(id: string, value: unknown, kind: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-lifecycle-${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function RevisionLifecycle({ id, state, online, selectedVersionId, headVersionId, evidenceKey, refreshWorkspace, reloadRevision, notify }: { id: string; state: AppState; online: boolean; selectedVersionId: string; headVersionId: string; evidenceKey: string; refreshWorkspace: () => Promise<void>; reloadRevision: () => Promise<unknown>; notify: (message: string) => void }) {
  const client = useWorkspace(), cacheKey = `revision-lifecycle:${id}`, draftKey = `revision-lifecycle-draft:${id}`, requestKey = `revision-lifecycle-request:${id}`;
  const allowedEpoch = (epoch: number) => epoch === client.session?.accessEpoch || (client.durable && !online && client.session?.accessEpoch === -1);
  const cached = () => { const saved = lifecycleReading(client.readStored(cacheKey, null), id); return saved && allowedEpoch(saved.snapshot.accessEpoch) ? saved : null; };
  const [reading, setReading] = useState<LifecycleReading | null>(cached), [draft, setDraft] = useState(() => lifecycleDraft(client.readStored(draftKey, null))), [pending, setPending] = useState(() => lifecycleIntent(client.readStored(requestKey, null), id));
  const [loading, setLoading] = useState(false), [paging, setPaging] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true), [draftSaved, setDraftSaved] = useState(!client.draftHasUnsavedMemory(draftKey));
  const mounted = useRef(false), generation = useRef(0), current = useRef(reading), latest = useRef(draft), loadRef = useRef<() => void>(() => {}), refreshRef = useRef(refreshWorkspace), stateRef = useRef(state);
  const detailRef = useRef({ reload: reloadRevision, head: headVersionId, evidence: evidenceKey });
  detailRef.current = { reload: reloadRevision, head: headVersionId, evidence: evidenceKey };
  latest.current = draft; refreshRef.current = refreshWorkspace; stateRef.current = state;
  const show = (value: LifecycleReading | null) => { current.current = value; setReading(value); };
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const sync = () => { const next = lifecycleDraft(client.readStored(draftKey, null)); latest.current = next; setDraft(next); setPending(lifecycleIntent(client.readStored(requestKey, null), id)); setDraftSaved(!client.draftHasUnsavedMemory(draftKey)); };
  const load = useCallback(async () => {
    if (!active()) return;
    const ticket = ++generation.current; setPaging(false); setError('');
    if (!online) { show(cached()); setLoading(false); return; }
    show(null); setLoading(true);
    try {
      const snapshot = await client.request<RevisionLifecycleSnapshot>(`/api/revisions/${id}/lifecycle`);
      if (!active() || ticket !== generation.current) return;
      if (!lifecycleSnapshot(snapshot, id)) throw new Error('The lifecycle snapshot could not be verified.');
      const history = await client.request<RevisionLifecycleHistory>(`/api/revisions/${id}/lifecycle/history?limit=25&expectedLifecycleVersion=${snapshot.lifecycle.version}`);
      if (!active() || ticket !== generation.current) return;
      const next = lifecycleReading({ snapshot, history }, id);
      if (!next || snapshot.accessEpoch !== client.session?.accessEpoch) throw new Error('Lifecycle changed while loading. Reload Lifecycle.');
      show(next); setSaved(client.writeStored(cacheKey, next));
      const metadata = stateRef.current.revisions.find(item => item.id === id);
      if (snapshot.accessEpoch > stateRef.current.accessEpoch || revisionRefreshDirection(metadata, { currentVersion: snapshot.head.number, authorVersion: snapshot.authorship.version, lifecycleVersion: snapshot.lifecycle.version, reviewerVersion: snapshot.reviewers.version, status: snapshot.lifecycle.status }) === 'workspace') void refreshRef.current();
      if (snapshot.head.versionId === detailRef.current.head && JSON.stringify([...snapshot.evidence.reviewIds].sort()) !== detailRef.current.evidence) void detailRef.current.reload();
    } catch (error) {
      if (!active() || ticket !== generation.current) return;
      if (!isNetworkError(error)) { client.removeStored(cacheKey); void refreshRef.current(); }
      setError(failureText(error));
    } finally { if (mounted.current && ticket === generation.current) setLoading(false); }
  }, [id, online]);
  loadRef.current = () => void load();
  useEffect(() => {
    mounted.current = true; void load();
    const retire = () => { generation.current++; show(null); setLoading(false); setPaging(false); sync(); queueMicrotask(() => { if (active()) loadRef.current(); }); };
    const offSnapshot = client.onTaskSnapshotChange(retire), offAccess = client.onAccessChange(retire), offSession = onSessionLocked(() => { generation.current++; show(null); setDraft(null); setPending(null); });
    const focus = () => loadRef.current(), storage = (event: StorageEvent) => { if (!event.key || [draftKey, requestKey].some(key => client.storageKey(key) === event.key)) sync(); };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => { mounted.current = false; generation.current++; offSnapshot(); offAccess(); offSession(); window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); };
  }, [load]);
  const priorEvidence = useRef(evidenceKey);
  useEffect(() => { if (priorEvidence.current !== evidenceKey) { priorEvidence.current = evidenceKey; generation.current++; show(null); loadRef.current(); } }, [evidenceKey]);
  const metadata = state.revisions.find(item => item.id === id);
  useEffect(() => { const prior = current.current?.snapshot; if (prior && metadata && revisionRefreshDirection(metadata, { currentVersion: prior.head.number, authorVersion: prior.authorship.version, lifecycleVersion: prior.lifecycle.version, reviewerVersion: prior.reviewers.version, status: prior.lifecycle.status }) === 'revision') { generation.current++; show(null); loadRef.current(); } }, [metadata?.reviewerVersion, metadata?.lifecycleVersion, metadata?.authorVersion, metadata?.currentVersion, metadata?.status]);
  const more = async () => {
    const before = current.current; if (!before || before.history.nextBefore === null || !online || paging) return;
    const ticket = generation.current; setPaging(true); setError('');
    try {
      const page = await client.request<RevisionLifecycleHistory>(`/api/revisions/${id}/lifecycle/history?limit=25&expectedLifecycleVersion=${before.snapshot.lifecycle.version}&before=${before.history.nextBefore}`);
      if (!active() || ticket !== generation.current || current.current !== before) return;
      const next = { ...before, history: mergeLifecycleHistory(before.history, page) }; show(next); setSaved(client.writeStored(cacheKey, next));
    } catch (error) { if (active() && ticket === generation.current) { show(null); client.removeStored(cacheKey); setError(failureText(error)); } }
    finally { if (mounted.current && ticket === generation.current) setPaging(false); }
  };
  const update = (next: RevisionLifecycleInput) => { if (!client.isActive() || client.draftIsHeld(draftKey)) return; latest.current = next; setDraft(next); setDraftSaved(client.writeStored(draftKey, next)); };
  const begin = (action: RevisionLifecycleAction) => { const snapshot = current.current?.snapshot; if (!snapshot || pending || !snapshot.actions.some(option => option.action === action && option.available)) return; if (latest.current && !window.confirm('Replace this retained lifecycle draft? Export it first to keep a copy.')) return; update(prepareLifecycleDraft(snapshot, action)); setError(''); setNotice(''); };
  const send = async (intent: LifecycleIntent) => {
    if (!online || saving || !active() || !current.current?.snapshot.access.capabilities.edit || client.draftIsHeld(requestKey) || client.draftIsHeld(draftKey)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(lifecycleIntent(retained.intent, id));
      if (!retained.accepted) throw new Error('A different unconfirmed lifecycle request is retained. Retry or export that original request first.');
      if (!retained.persisted && mounted.current) setNotice('This submitted request is only retained in this tab. Keep it open and export the request.');
      const result = await client.request<unknown>(`/api/revisions/${id}/lifecycle`, { method: 'POST', body: intent.body, id: intent.id });
      const receipt = await verifiedLifecycleResult(result, id, intent.body, stateRef.current.currentPrincipalId);
      if (!client.isActive() || client.unavailableObject(id) || receipt.accessEpoch !== client.session?.accessEpoch) return;
      client.removeStoredIfEqual(requestKey, intent); client.removeStoredIfEqual(draftKey, intent.draft); client.removeStored(cacheKey); client.invalidateRevisionStacks();
      notify(`${revisionLifecycleActionLabel(intent.body.action)} saved. Source versions are unchanged.`);
      if (mounted.current) { sync(); setNotice('Lifecycle action saved. Your inspected source version is unchanged.'); }
      await refreshRef.current();
      if (active()) { await reloadRevision(); await load(); }
    } catch (error) { if (mounted.current && client.isActive()) { setError(failureText(error)); void refreshRef.current(); } }
    finally { if (mounted.current) setSaving(false); }
  };
  const snapshot = reading?.snapshot, knownEpoch = client.session?.accessEpoch ?? -1, enabled = Boolean(snapshot?.access.capabilities.edit && !client.unavailableObject(id));
  const drifted = Boolean(draft && snapshot && !lifecycleDraftMatches(draft, snapshot)), selectedAction = snapshot?.actions.find(option => option.action === draft?.action);
  const submitAllowed = Boolean(online && enabled && snapshot?.accessEpoch === knownEpoch && draft && !drifted && selectedAction?.available && !pending && !loading && !saving && !client.draftIsHeld(draftKey));
  return <section className="panel revision-lifecycle" aria-label="Revision Lifecycle"><div className="panel-heading"><h2>Revision Lifecycle</h2><button className="button" disabled={!online || loading || saving} onClick={() => void load()}>{loading ? 'Loading Lifecycle…' : 'Reload Lifecycle'}</button></div><div className="card-body">
    {snapshot ? <><div className="revision-lifecycle-current"><span className={`badge badge-${snapshot.lifecycle.status}`} data-testid="lifecycle-status">{revisionStatusLabel(snapshot.lifecycle.status)}</span><span>Current source version {snapshot.head.number} · lifecycle {snapshot.lifecycle.version}</span></div><p className="small muted">Actions apply to the current revision and preserve its source versions. Accept Reviewed Version uses recorded checks. Named reviewer decisions are recorded separately in Reviewers; neither establishes factual verification.</p>{selectedVersionId !== snapshot.head.versionId && <p className="info-strip">You are inspecting an earlier source. Actions below apply to current source version {snapshot.head.number}; your inspected version stays fixed.</p>}<div className="revision-lifecycle-actions">{snapshot.actions.map(option => <div key={option.action}><button className="button" disabled={!enabled || !option.available || Boolean(pending) || saving || loading} onClick={() => begin(option.action)} aria-describedby={`${id}-lifecycle-${option.action}-reason`}>{option.label}</button><p id={`${id}-lifecycle-${option.action}-reason`} className="small muted">{option.reason ?? `Move to ${revisionStatusLabel(option.targetStatus!)}.`}</p></div>)}</div></> : <p role="status">{loading ? 'Loading authorized lifecycle…' : 'Lifecycle is unavailable. Reconnect and reload before preparing an action.'}</p>}
    {!online && <p className="info-strip">Saved lifecycle snapshot. Drafts are retained; reconnect and submit explicitly. Reconnecting never changes status.</p>}{!saved && <p className="banner warning">This lifecycle snapshot could not be saved for offline reading.</p>}{error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
    {draft && !client.draftIsHeld(draftKey) && <section className="revision-lifecycle-editor" aria-label="Lifecycle draft"><h3>{revisionLifecycleActionLabel(draft.action)}</h3><p className="small muted">Prepared from lifecycle {draft.expectedLifecycleVersion}, authorship {draft.expectedAuthorVersion}, and source version {draft.expectedVersion}. This request keeps the exact source, evidence, configuration, and access snapshot.</p>{!drifted && selectedAction?.targetStatus && snapshot && <p>{revisionStatusLabel(snapshot.lifecycle.status)} → {revisionStatusLabel(selectedAction.targetStatus)}</p>}<label className="field"><span>Lifecycle message</span><textarea maxLength={REVISION_LIFECYCLE_LIMITS.message} rows={3} value={draft.message} onChange={event => update({ ...draft, message: event.target.value })}/></label>{drifted && <p className="banner warning">Lifecycle, reviewers, source, author, evidence, configuration, or access changed. This draft keeps its original versions. Export it, then start a new action after reloading.</p>}<div className="file-actions"><button className="button primary" disabled={!submitAllowed} onClick={() => void send({ id: crypto.randomUUID(), revisionId: id, body: draft, draft })}>{saving ? 'Saving Action…' : 'Confirm Lifecycle Action'}</button><button className="button" onClick={() => exportLifecycle(id, draft, 'draft')}>Export Lifecycle Draft</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Discard this lifecycle draft? A submitted request is retained separately.')) { client.removeStoredIfEqual(draftKey, draft); sync(); } }}>Discard Lifecycle Draft</button></div>{!draftSaved && <p className="banner warning">This draft is only in this tab. Keep it open and export it.</p>}</section>}
    {pending && !client.draftIsHeld(requestKey) && <section className="revision-lifecycle-recovery" aria-label="Unconfirmed lifecycle change"><h3>Unconfirmed Lifecycle Change</h3><p>The action may already have completed. Retry sends the same request ID, action, message, and exact versions. Reconnecting never retries it.</p><p>{revisionLifecycleActionLabel(pending.body.action)} · source version {pending.body.expectedVersion} · lifecycle {pending.body.expectedLifecycleVersion}</p><div className="file-actions"><button className="button" disabled={!online || !enabled || saving || loading} onClick={() => void send(pending)}>Retry Exact Lifecycle Change</button><button className="button" onClick={() => exportLifecycle(id, pending, 'request')}>Export Lifecycle Request</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Forget this request? Any completed lifecycle action remains in history.')) { client.removeStoredIfEqual(requestKey, pending); sync(); } }}>Forget Lifecycle Request</button></div>{client.draftHasUnsavedMemory(requestKey) && <p className="banner warning">This request is only retained in this tab.</p>}</section>}
    {reading && <details className="revision-lifecycle-history"><summary>Lifecycle History</summary><ol>{reading.history.transactions.map(item => <li key={item.id}><strong>{item.attribution?.displayName ?? 'Actor not recorded'}</strong> · {item.action === 'source_updated' ? 'Source updated' : item.action === 'review_invalidated' ? 'Acceptance invalidated by review' : item.action === 'reviewer_reassessed' ? 'Reviewer decisions reassessed' : revisionLifecycleActionLabel(item.action)}<p>{revisionStatusLabel(item.fromStatus)} → {revisionStatusLabel(item.toStatus)}</p><small>{new Date(item.createdAt).toLocaleString()} · lifecycle {item.lifecycleVersion} · source version {item.head.number}</small>{item.message && <p>{item.message}</p>}</li>)}</ol>{!reading.history.transactions.length && <p className="small muted">No lifecycle changes recorded.</p>}{reading.history.nextBefore !== null && <button className="button" disabled={!online || loading || paging || reading.history.transactions.length >= LIFECYCLE_HISTORY_LIMIT} onClick={() => void more()}>Load Older Lifecycle History</button>}<p className="small muted">Up to {LIFECYCLE_HISTORY_LIMIT} history entries are retained in this reading view.</p></details>}
  </div></section>;
}
