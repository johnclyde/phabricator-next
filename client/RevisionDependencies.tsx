import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { REVISION_DEPENDENCY_LIMITS, revisionDependencyInput, validRevisionDependencyReceipt, type RevisionDependencyDirection, type RevisionDependencyHistory, type RevisionDependencyPage, type RevisionDependencyReceipt } from '../shared/revision-dependencies';
import { dependencyDraft, dependencyIntent, dependencyPage, dependencySnapshot, emptyDependencyDraft, mergeDependencyHistory, mergeDependencyPage, DEPENDENCY_DISPLAY_LIMIT, type DependencyDraft, type DependencyIntent, type DependencySnapshot } from './revision-dependencies';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { retainFileIntent } from './file-client';
import { onSessionLocked } from './session';

const title = (direction: RevisionDependencyDirection) => direction === 'parents' ? 'Parent Revisions' : 'Child Revisions';
const message = (error: unknown) => error instanceof Error ? error.message : 'Related revisions could not be loaded.';
function exportRecord(id: string, value: unknown, kind: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-relationships-${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function RevisionDependencies({ id, state, online, canEdit, refreshWorkspace }: { id: string; state: AppState; online: boolean; canEdit: boolean; refreshWorkspace: () => Promise<void> }) {
  const client = useWorkspace(), cacheKey = `revision-dependencies:${id}`, draftKey = `revision-dependency-draft:${id}`, requestKey = `revision-dependency-request:${id}`;
  const [snapshot, setSnapshot] = useState<DependencySnapshot | null>(() => dependencySnapshot(client.readStored(cacheKey, null), id));
  const [draft, setDraft] = useState<DependencyDraft | null>(() => dependencyDraft(client.readStored(draftKey, null))), [pending, setPending] = useState<DependencyIntent | null>(() => dependencyIntent(client.readStored(requestKey, null), id));
  const [loading, setLoading] = useState(false), [paging, setPaging] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true), [draftSaved, setDraftSaved] = useState(!client.draftHasUnsavedMemory(draftKey)), [query, setQuery] = useState('');
  const mounted = useRef(true), generation = useRef(0), current = useRef(snapshot), latest = useRef(draft), loadRef = useRef<() => void>(() => {}), refreshRef = useRef(refreshWorkspace), stateRef = useRef(state);
  latest.current = draft; refreshRef.current = refreshWorkspace; stateRef.current = state;
  const show = (value: DependencySnapshot | null) => { current.current = value; setSnapshot(value); };
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const syncDrafts = () => { const next = dependencyDraft(client.readStored(draftKey, null)); latest.current = next; setDraft(next); setPending(dependencyIntent(client.readStored(requestKey, null), id)); setDraftSaved(!client.draftHasUnsavedMemory(draftKey)); };
  const load = useCallback(async () => {
    const ticket = ++generation.current; setPaging('');
    if (!online) { show(dependencySnapshot(client.readStored(cacheKey, null), id)); setLoading(false); return; }
    setLoading(true); setError('');
    try {
      const parents = await client.request<RevisionDependencyPage>(`/api/revisions/${id}/dependencies?direction=parents&limit=25`);
      if (!active() || ticket !== generation.current) return;
      if (!dependencyPage(parents, id, 'parents')) throw new Error('The parent revision page could not be verified.');
      const suffix = `limit=25&expectedRelationshipVersion=${parents.relationshipVersion}`;
      const [children, history] = await Promise.all([client.request<RevisionDependencyPage>(`/api/revisions/${id}/dependencies?direction=children&${suffix}`), client.request<RevisionDependencyHistory>(`/api/revisions/${id}/dependencies/history?${suffix}`)]);
      if (!active() || ticket !== generation.current) return;
      const next = dependencySnapshot({ revisionId: id, relationshipVersion: parents.relationshipVersion, accessEpoch: parents.accessEpoch, parents, children, history }, id);
      if (!next || next.accessEpoch !== client.session?.accessEpoch) throw new Error('Related revisions changed while loading. Reload Related Revisions.');
      show(next); setSaved(client.writeStored(cacheKey, next));
      if (next.accessEpoch > stateRef.current.accessEpoch) void refreshRef.current();
    } catch (failure) {
      if (!active() || ticket !== generation.current) return;
      if (!isNetworkError(failure)) { show(null); client.removeStored(cacheKey); void refreshRef.current(); }
      setError(message(failure));
    } finally { if (mounted.current && ticket === generation.current) setLoading(false); }
  }, [id, online]);
  loadRef.current = () => void load();
  useEffect(() => {
    mounted.current = true; void load();
    const retire = () => { generation.current++; show(null); setLoading(false); setPaging(''); syncDrafts(); queueMicrotask(() => { if (active()) loadRef.current(); }); };
    const offSnapshot = client.onTaskSnapshotChange(retire), offAccess = client.onAccessChange(() => { syncDrafts(); }), offSession = onSessionLocked(() => { generation.current++; show(null); setDraft(null); setPending(null); });
    const focus = () => loadRef.current(), storage = (event: StorageEvent) => { if (!event.key || [draftKey, requestKey].some(key => client.storageKey(key) === event.key)) syncDrafts(); };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => { mounted.current = false; generation.current++; offSnapshot(); offAccess(); offSession(); window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); };
  }, [load]);
  const more = async (kind: RevisionDependencyDirection | 'history') => {
    const previous = current.current; if (!previous || !online || paging || loading) return;
    const ticket = generation.current, page = previous[kind]; setPaging(kind); setError('');
    try {
      const suffix = `limit=25&expectedRelationshipVersion=${previous.relationshipVersion}`;
      let next: DependencySnapshot;
      if (kind === 'history') {
        const history = await client.request<RevisionDependencyHistory>(`/api/revisions/${id}/dependencies/history?${suffix}&before=${previous.history.nextBefore}`);
        if (!active() || ticket !== generation.current || current.current !== previous) return;
        next = { ...previous, history: mergeDependencyHistory(previous.history, history) };
      } else {
        const incoming = await client.request<RevisionDependencyPage>(`/api/revisions/${id}/dependencies?direction=${kind}&${suffix}&after=${encodeURIComponent((page as RevisionDependencyPage).nextAfter!)}`);
        if (!active() || ticket !== generation.current || current.current !== previous) return;
        next = { ...previous, [kind]: mergeDependencyPage(previous[kind], incoming) };
      }
      show(next); setSaved(client.writeStored(cacheKey, next));
    } catch (failure) { if (active() && ticket === generation.current) { if (!isNetworkError(failure)) { show(null); client.removeStored(cacheKey); } setError(message(failure)); } }
    finally { if (mounted.current && ticket === generation.current) setPaging(''); }
  };
  const update = (next: DependencyDraft) => { if (!active() || client.draftIsHeld(draftKey)) return; latest.current = next; setDraft(next); setDraftSaved(client.writeStored(draftKey, next)); };
  const begin = (direction: RevisionDependencyDirection) => {
    if (!snapshot || !canEdit || saving || pending) return;
    if (draft && (draft.add.length || draft.remove.length) && !window.confirm('Start a new relationship selection? Export the retained draft first if you want to keep it.')) return;
    update(emptyDependencyDraft(snapshot, direction)); setQuery(''); setNotice('');
  };
  const toggle = (peer: string, action: 'add' | 'remove') => {
    const before = latest.current; if (!before) return;
    const existing = before[action].includes(peer);
    if (!existing && before.add.length + before.remove.length >= REVISION_DEPENDENCY_LIMITS.changes) return;
    update({ ...before, [action]: existing ? before[action].filter(item => item !== peer) : [...before[action], peer] });
  };
  const send = async (intent: DependencyIntent) => {
    if (!online || !canEdit || saving || !active() || client.draftIsHeld(requestKey) || client.draftIsHeld(draftKey)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(dependencyIntent(retained.intent, id));
      if (!retained.accepted) throw new Error('Another unconfirmed relationship change is retained. Retry its exact request before submitting another.');
      if (!retained.persisted) setNotice('Request recovery is only in this tab. Keep it open and export the request.');
      const result = await client.request<RevisionDependencyReceipt>(`/api/revisions/${id}/dependencies`, { method: 'POST', body: intent.body, id: intent.id }, [...intent.body.add, ...intent.body.remove]);
      if (!validRevisionDependencyReceipt(result, id, intent.body)) throw new Error('The receipt does not match the original relationship change. Keep the request and retry it exactly.');
      client.removeStoredIfEqual(requestKey, intent); client.removeStoredIfEqual(draftKey, intent.draft);
      for (const peer of [id, ...intent.body.add, ...intent.body.remove]) client.removeStored(`revision-dependencies:${peer}`);
      if (!active()) return;
      syncDrafts(); setNotice('Related revisions updated. Source versions and review acceptance are unchanged.');
      await load();
    } catch (failure) { if (mounted.current) { setError(message(failure)); void refreshRef.current(); } }
    finally { if (mounted.current) setSaving(false); }
  };
  const knownEpoch = client.session?.accessEpoch ?? -1;
  const canUseLabels = state.accessEpoch === knownEpoch || (!online && client.durable && knownEpoch < 0);
  const permittedPeers = canUseLabels ? state.revisions.filter(peer => peer.id !== id && state.access[peer.id]?.capabilities.view && !client.unavailableObject(peer.id)) : [];
  const peerName = (peerId: string) => permittedPeers.find(peer => peer.id === peerId)?.title;
  const changed = Boolean(draft && snapshot && (draft.expectedRelationshipVersion !== snapshot.relationshipVersion || draft.expectedAccessEpoch !== snapshot.accessEpoch));
  const canSave = Boolean(online && canEdit && snapshot && draft && !changed && !pending && !saving && !loading && !client.draftIsHeld(draftKey) && snapshot.accessEpoch === client.session?.accessEpoch && draft.add.length + draft.remove.length && [...draft.add, ...draft.remove].every(peer => permittedPeers.some(item => item.id === peer)));
  const draftVisible = draft && !client.draftIsHeld(draftKey);
  return <section className="panel revision-dependencies" aria-label="Related Revisions">
    <div className="panel-heading"><h2>Related Revisions</h2><button className="button" disabled={!online || loading || saving} onClick={() => void load()}>{loading ? 'Loading Relationships…' : 'Reload Related Revisions'}</button></div>
    <div className="card-body"><p className="small muted">Parent revisions are work this revision depends on. Child revisions depend on this one. Relationships apply to the revision, across source versions; they do not grant access or accept, close, or change any source.</p>
      {!online && <p className="info-strip">Saved relationship snapshot. Reconnect to load more or save explicitly; reconnecting never submits a relationship edit.</p>}
      {!saved && <p className="banner warning">This relationship snapshot could not be saved for offline use.</p>}
      {error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
      {snapshot ? <><div className="revision-dependency-lists">{(['parents', 'children'] as const).map(direction => <section key={direction} aria-label={title(direction)}><div className="file-actions"><h3>{title(direction)}</h3>{canEdit && <button className="button" disabled={loading || saving || Boolean(pending)} onClick={() => begin(direction)}>Edit {title(direction)}</button>}</div><p className="small muted">{direction === 'parents' ? 'This revision depends on these visible revisions.' : 'These visible revisions depend on this revision.'}</p><ul>{snapshot[direction].revisions.map(peer => <li key={peer.id}><a href={`#${peer.id}`}><strong>{peer.id}</strong> {peer.title}</a><span className={`badge badge-${peer.status}`}>{peer.status.replaceAll('_', ' ')}</span><small>{peer.kind} · source version {peer.currentVersion}</small></li>)}</ul>{!snapshot[direction].revisions.length && <p className="muted small">No visible revisions on this page.</p>}{snapshot[direction].nextAfter && <button className="button" disabled={!online || loading || Boolean(paging) || snapshot[direction].revisions.length >= DEPENDENCY_DISPLAY_LIMIT} onClick={() => void more(direction)}>Load More {title(direction)}</button>}</section>)}</div><p className="small muted">Only visible relationships are shown. An empty list does not establish that all dependencies are complete.</p></> : <p role="status">{loading ? 'Loading related revisions…' : 'No authorized relationship snapshot is available. Reload when connected.'}</p>}
      {draftVisible && <section className="revision-dependency-editor" aria-label={`Edit ${title(draft.direction)}`}><h3>Edit {title(draft.direction)}</h3><p className="small muted">Selection based on relationship version {draft.expectedRelationshipVersion}. Saving changes only the selected relationships.</p>{changed && <p className="banner warning">Relationships or access changed. This draft keeps its original versions. Export it, then start a new selection after reloading.</p>}
        <label className="field"><span>Search related revisions</span><input type="search" value={query} onChange={event => setQuery(event.target.value)}/></label>
        <fieldset><legend>Add {title(draft.direction)}</legend>{permittedPeers.filter(peer => !snapshot?.[draft.direction].revisions.some(item => item.id === peer.id) && `${peer.id} ${peer.title}`.toLowerCase().includes(query.toLowerCase())).slice(0, 100).map(peer => <label className="checkbox" key={peer.id}><input type="checkbox" checked={draft.add.includes(peer.id)} disabled={!canEdit || (draft.add.length + draft.remove.length >= 64 && !draft.add.includes(peer.id))} onChange={() => toggle(peer.id, 'add')}/><span>Add {peer.id}: {peer.title}<small>{peer.kind} · {peer.status.replaceAll('_', ' ')}</small></span></label>)}<p className="small muted">Up to 100 matching visible revisions are shown. Narrow the search to find another revision.</p></fieldset>
        <fieldset><legend>Remove {title(draft.direction)}</legend>{snapshot?.[draft.direction].revisions.map(peer => <label className="checkbox" key={peer.id}><input type="checkbox" checked={draft.remove.includes(peer.id)} disabled={!canEdit || (draft.add.length + draft.remove.length >= 64 && !draft.remove.includes(peer.id))} onChange={() => toggle(peer.id, 'remove')}/><span>Remove {peer.id}: {peer.title}</span></label>)}</fieldset>
        {(draft.add.length > 0 || draft.remove.length > 0) && <div className="revision-dependency-selected"><strong>Selected changes</strong>{(['add', 'remove'] as const).flatMap(action => draft[action].map(peer => <p key={`${action}:${peer}`}>{action === 'add' ? 'Add' : 'Remove'} {peer}{peerName(peer) ? `: ${peerName(peer)}` : ' · unavailable revision'}<button className="text-button" aria-label={`Clear ${action} ${peer}`} onClick={() => toggle(peer, action)}>Clear</button></p>))}</div>}
        <div className="file-actions"><button className="button primary" disabled={!canSave} onClick={() => { try { const body = revisionDependencyInput(draft); void send({ id: crypto.randomUUID(), revisionId: id, body, draft }); } catch (failure) { setError(message(failure)); } }}>{saving ? 'Saving Relationships…' : `Save ${title(draft.direction)}`}</button><button className="button" onClick={() => exportRecord(id, draft, 'draft')}>Export Relationship Draft</button>{snapshot && <button className="button" disabled={saving || Boolean(pending)} onClick={() => begin(draft.direction)}>Start New Selection</button>}<button className="button" disabled={saving} onClick={() => { if (!draft.add.length && !draft.remove.length || window.confirm('Discard this relationship selection? Submitted requests are retained separately.')) { client.removeStoredIfEqual(draftKey, draft); syncDrafts(); } }}>Discard Selection</button></div>{!draftSaved && <p className="banner warning">This selection is only in this tab. Keep it open and export it.</p>}
      </section>}
      {pending && !client.draftIsHeld(requestKey) && <section className="revision-dependency-recovery" aria-label="Unconfirmed relationship change"><h3>Unconfirmed Relationship Change</h3><p>The change may already have completed. Retry uses the original request, selected IDs, and versions. Reconnecting never retries it.</p><p>{pending.body.direction === 'parents' ? 'Parents' : 'Children'} · add {pending.body.add.join(', ') || 'none'} · remove {pending.body.remove.join(', ') || 'none'}</p><div className="file-actions"><button className="button" disabled={!online || !canEdit || saving} onClick={() => void send(pending)}>Retry Exact Relationship Change</button><button className="button" onClick={() => exportRecord(id, pending, 'request')}>Export Relationship Request</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Forget this request? Any completed relationship change remains in history.')) { client.removeStoredIfEqual(requestKey, pending); syncDrafts(); } }}>Forget Relationship Request</button></div>{client.draftHasUnsavedMemory(requestKey) && <p className="banner warning">This request is only retained in this tab.</p>}</section>}
      {snapshot && <details className="revision-dependency-history"><summary>Relationship History</summary><ol>{snapshot.history.transactions.map(item => <li key={item.id}><strong>{item.actor}</strong> {item.change.action} {item.change.direction === 'parents' ? 'parent' : 'child'} <a href={`#${item.change.revisionId}`}>{item.change.revisionId}</a><small>{new Date(item.createdAt).toLocaleString()} · relationship version {item.relationshipVersion}</small></li>)}</ol>{!snapshot.history.transactions.length && <p className="small muted">No visible relationship history on this page.</p>}{snapshot.history.nextBefore !== null && <button className="button" disabled={!online || loading || Boolean(paging) || snapshot.history.transactions.length >= DEPENDENCY_DISPLAY_LIMIT} onClick={() => void more('history')}>Load Older Relationship History</button>}<p className="small muted">At most {DEPENDENCY_DISPLAY_LIMIT} relationships per direction and history entries are kept in this reading view. Hidden records are omitted.</p></details>}
    </div>
  </section>;
}
