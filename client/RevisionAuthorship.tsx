import { useDraftRetention } from './draft-retention';
import { revisionRefreshDirection } from './revision-lifecycle';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { REVISION_AUTHOR_LIMITS, type RevisionAuthorHistory, type RevisionAuthorInput, type RevisionAuthorshipSnapshot } from '../shared/revision-authorship';
import { AUTHOR_HISTORY_LIMIT, authorDraft, authorDraftMatches, authorIntent, authorReading, authorSnapshot, mergeAuthorHistory, prepareAuthorDraft, verifiedAuthorResult, type AuthorIntent, type AuthorReading } from './revision-authorship';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { retainFileIntent } from './file-client';
import { onSessionLocked } from './session';

const failureText = (error: unknown) => error instanceof Error ? error.message : 'Authorship could not be loaded.';
function exportAuthor(id: string, value: unknown, kind: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-authorship-${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function RevisionAuthorship({ id, state, online, refreshWorkspace, reloadRevision, notify }: { id: string; state: AppState; online: boolean; refreshWorkspace: () => Promise<void>; reloadRevision: () => Promise<unknown>; notify: (message: string) => void }) {
  const client = useWorkspace(), cacheKey = `revision-authorship:${id}`, draftKey = `revision-author-draft:${id}`, requestKey = `revision-author-request:${id}`;
  const allowedEpoch = (epoch: number) => epoch === client.session?.accessEpoch || (client.durable && !online && client.session?.accessEpoch === -1);
  const cached = () => { const saved = authorReading(client.readStored(cacheKey, null), id); return saved && allowedEpoch(saved.snapshot.accessEpoch) ? saved : null; };
  const [reading, setReading] = useState<AuthorReading | null>(cached), [draft, setDraft] = useState(() => authorDraft(client.readStored(draftKey, null))), [pending, setPending] = useState(() => authorIntent(client.readStored(requestKey, null), id));
  const [loading, setLoading] = useState(false), [paging, setPaging] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true), [draftSaved, setDraftSaved] = useState(!client.draftHasUnsavedMemory(draftKey));
  const retainDraft = useDraftRetention(client, draftKey, setDraftSaved);
  const mounted = useRef(false), generation = useRef(0), current = useRef(reading), latest = useRef(draft), loadRef = useRef<() => void>(() => {}), refreshRef = useRef(refreshWorkspace), stateRef = useRef(state);
  latest.current = draft; refreshRef.current = refreshWorkspace; stateRef.current = state;
  const show = (value: AuthorReading | null) => { current.current = value; setReading(value); };
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const sync = () => { const next = authorDraft(client.readStored(draftKey, null)); latest.current = next; setDraft(next); setPending(authorIntent(client.readStored(requestKey, null), id)); setDraftSaved(!client.draftHasUnsavedMemory(draftKey)); };
  const load = useCallback(async () => {
    if (!active()) return;
    const ticket = ++generation.current; setPaging(false); setError('');
    if (!online) { show(cached()); setLoading(false); return; }
    show(null); setLoading(true);
    try {
      const snapshot = await client.request<RevisionAuthorshipSnapshot>(`/api/revisions/${id}/authorship`);
      if (!active() || ticket !== generation.current) return;
      if (!authorSnapshot(snapshot, id)) throw new Error('The current author snapshot could not be verified.');
      const history = await client.request<RevisionAuthorHistory>(`/api/revisions/${id}/authorship/history?limit=25&expectedAuthorVersion=${snapshot.authorship.version}`);
      if (!active() || ticket !== generation.current) return;
      const next = authorReading({ snapshot, history }, id);
      if (!next || snapshot.accessEpoch !== client.session?.accessEpoch) throw new Error('Authorship changed while loading. Reload Current Author.');
      show(next); setSaved(client.writeStored(cacheKey, next));
      if (snapshot.accessEpoch > stateRef.current.accessEpoch || revisionRefreshDirection(stateRef.current.revisions.find(item => item.id === id), { currentVersion: snapshot.head.number, authorVersion: snapshot.authorship.version, lifecycleVersion: snapshot.lifecycleVersion, reviewerVersion: snapshot.reviewerVersion, status: snapshot.status }) === 'workspace') void refreshRef.current();
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
  const metadata = state.revisions.find(item => item.id === id);
  useEffect(() => { const prior = current.current?.snapshot; if (prior && metadata && revisionRefreshDirection(metadata, { currentVersion: prior.head.number, authorVersion: prior.authorship.version, lifecycleVersion: prior.lifecycleVersion, reviewerVersion: prior.reviewerVersion, status: prior.status }) === 'revision') { generation.current++; show(null); loadRef.current(); } }, [metadata?.reviewerVersion, metadata?.lifecycleVersion, metadata?.authorVersion, metadata?.currentVersion, metadata?.status]);
  const more = async () => {
    const before = current.current; if (!before || before.history.nextBefore === null || !online || paging) return;
    const ticket = generation.current; setPaging(true); setError('');
    try {
      const page = await client.request<RevisionAuthorHistory>(`/api/revisions/${id}/authorship/history?limit=25&expectedAuthorVersion=${before.snapshot.authorship.version}&before=${before.history.nextBefore}`);
      if (!active() || ticket !== generation.current || current.current !== before) return;
      const next = { ...before, history: mergeAuthorHistory(before.history, page) }; show(next); setSaved(client.writeStored(cacheKey, next));
    } catch (error) { if (active() && ticket === generation.current) { show(null); client.removeStored(cacheKey); setError(failureText(error)); } }
    finally { if (mounted.current && ticket === generation.current) setPaging(false); }
  };
  const discardStored = async (key: string, expected: unknown) => {
    const ticket = generation.current, epoch = client.session?.accessEpoch;
    const current = () => active() && generation.current === ticket && client.session?.accessEpoch === epoch;
    const cleared = await client.removeRetainedDraftIfEqual(key, expected, current);
    if (!current()) return;
    if (!cleared) { setError('This draft or request changed while it was being cleared. Its recoverable copy is retained.'); return; }
    sync();
  };
  const update = (next: RevisionAuthorInput) => { if (!client.isActive() || client.draftIsHeld(draftKey)) return; latest.current = next; setDraft(next); retainDraft(next); };
  const begin = (action: 'commandeer' | { authorId: string }) => { if (!current.current || pending) return; if (latest.current && !window.confirm('Replace this retained authorship draft? Export it first to keep a copy.')) return; update(prepareAuthorDraft(current.current.snapshot, action)); setError(''); setNotice(''); };
  const send = async (intent: AuthorIntent) => {
    if (!online || saving || !client.isActive()) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(authorIntent(retained.intent, id));
      if (!retained.accepted) throw new Error('A different unconfirmed authorship request is retained. Retry or export that original request first.');
      if (!retained.persisted && mounted.current) setNotice('This submitted request is only retained in this tab. Keep it open and export the request.');
      const result = await client.request<unknown>(`/api/revisions/${id}/authorship`, { method: 'POST', body: intent.body, id: intent.id });
      const receipt = await verifiedAuthorResult(result, id, intent.body, stateRef.current.currentPrincipalId);
      if (!client.isActive()) return;
      await client.acknowledgeRevisionAuthorIntent(requestKey, intent, draftKey, intent.draft);
      if (!client.isActive()) return;
      client.removeStored(cacheKey); client.invalidateRevisionStacks();
      const lost = 'accessLost' in receipt;
      notify(lost ? 'Authorship changed. Your permission to view or edit this revision changed; other drafts are set aside for export.' : 'Current author changed. Source versions are unchanged. Reviewers and acceptance have been reassessed.');
      if (mounted.current) { sync(); setNotice(lost ? 'Authorship changed. Reloading your current viewing and editing permissions.' : 'Current author changed. Source versions are unchanged. Reviewers and acceptance have been reassessed.'); }
      await refreshRef.current();
      if (active()) { await reloadRevision(); await load(); }
    } catch (error) { if (mounted.current && client.isActive()) { setError(failureText(error)); void refreshRef.current(); } }
    finally { if (mounted.current) setSaving(false); }
  };
  const snapshot = reading?.snapshot, knownEpoch = client.session?.accessEpoch ?? -1;
  const labelsAllowed = state.accessEpoch === knownEpoch || client.durable && !online && knownEpoch < 0;
  const people = labelsAllowed ? state.principals.filter(person => !person.disabled) : [];
  const self = state.currentPrincipalId, enabled = Boolean(snapshot && snapshot.access.capabilities.edit && !client.unavailableObject(id));
  const available = people.filter(person => person.id !== snapshot?.authorship.author?.principalId), first = available[0];
  const drifted = Boolean(draft && snapshot && !authorDraftMatches(draft, snapshot));
  const submitAllowed = Boolean(online && enabled && snapshot?.accessEpoch === knownEpoch && draft && !drifted && !pending && !loading && !saving && !client.draftIsHeld(draftKey) && (draft.action === 'commandeer' ? !(snapshot?.status === 'closed' || snapshot?.status === 'accepted' && snapshot.closeOnAccept) && snapshot?.authorship.author?.principalId !== self : available.some(person => person.id === draft.authorId)));
  const visibleDraft = draft && !client.draftIsHeld(draftKey);
  const canConfirmHandoff = pending?.body.action === 'assign' && pending.body.authorId !== self;
  return <section className="panel revision-authorship" aria-label="Current Author"><div className="panel-heading"><h2>Current Author</h2><button className="button" disabled={!online || loading || saving} onClick={() => void load()}>{loading ? 'Loading Author…' : 'Reload Current Author'}</button></div><div className="card-body">
    <p className="small muted">Authorship applies to this revision across source versions. Changing it preserves source and original attribution. The previous author joins Reviewers, the new author leaves Reviewers, and acceptance is reassessed.</p>
    {snapshot ? <><dl className="metadata"><dt>Current author</dt><dd data-testid="current-author">{snapshot.authorship.author?.displayName ?? 'Unassigned'}</dd><dt>Original author</dt><dd>{snapshot.authorship.originalAuthor?.displayName ?? 'Not recorded'}</dd><dt>Authorship version</dt><dd>{snapshot.authorship.version}</dd></dl><p className="small muted">The current author automatically has view and edit access within the Space and any repository or source File boundaries. Comment and review access still follows the Interact rule. A transfer can remove your access.</p>{(snapshot.status === 'closed' || snapshot.status === 'accepted' && snapshot.closeOnAccept) && <p className="info-strip">Closed revisions can be transferred. Commandeer is unavailable while closed{snapshot.status === 'accepted' ? ' by the accept policy' : ''}.</p>}{enabled && <div className="file-actions"><button className="button" disabled={!first || Boolean(pending) || saving} onClick={() => first && begin({ authorId: first.id })}>Transfer Authorship</button><button className="button" disabled={snapshot.status === 'closed' || snapshot.status === 'accepted' && snapshot.closeOnAccept || snapshot.authorship.author?.principalId === self || Boolean(pending) || saving} onClick={() => begin('commandeer')}>Commandeer This Revision</button></div>}</> : <p role="status">{loading ? 'Loading authorized authorship…' : 'Current author is unavailable. Reconnect and reload; original attribution does not establish current authorship.'}</p>}
    {!online && <p className="info-strip">Saved authorship snapshot. Drafts are retained; reconnect and submit explicitly. Reconnecting never changes the author.</p>}{!saved && <p className="banner warning">This authorship snapshot could not be saved for offline reading.</p>}{error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
    {visibleDraft && <section className="revision-author-editor" aria-label="Authorship draft"><h3>{draft.action === 'commandeer' ? 'Commandeer This Revision' : 'Transfer Authorship'}</h3><p className="small muted">Prepared from authorship version {draft.expectedAuthorVersion} and source version {draft.expectedVersion}. This request also retains its exact reviewer and lifecycle pins.</p>{draft.action === 'assign' ? <label className="field"><span>New author</span><select aria-label="New author" value={draft.authorId} onChange={event => update({ ...draft, authorId: event.target.value })}>{!people.some(person => person.id === draft.authorId) && <option value={draft.authorId} disabled>Unavailable selected member ({draft.authorId})</option>}{people.map(person => <option key={person.id} value={person.id}>{person.displayName} (@{person.username})</option>)}</select></label> : <p>You will become the current author. The original author remains recorded.</p>}<label className="field"><span>Authorship message</span><textarea maxLength={REVISION_AUTHOR_LIMITS.message} rows={3} value={draft.message} onChange={event => update({ ...draft, message: event.target.value })}/></label>{drifted && <p className="banner warning">This draft does not match the current authorship, reviewers, lifecycle, source, or access snapshot. It keeps its original versions. Export it, then start a new action after reloading.</p>}<div className="file-actions"><button className="button primary" disabled={!submitAllowed} onClick={() => void send({ id: crypto.randomUUID(), revisionId: id, body: draft, draft })}>{saving ? 'Saving Author…' : draft.action === 'commandeer' ? 'Confirm Commandeer' : 'Confirm Transfer'}</button><button className="button" onClick={() => exportAuthor(id, draft, 'draft')}>Export Authorship Draft</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Discard this authorship draft? A submitted request is retained separately.')) { void discardStored(draftKey, draft); } }}>Discard Authorship Draft</button></div>{!draftSaved && <p className="banner warning">This draft is only in this tab. Keep it open and export it.</p>}</section>}
    {pending && !client.draftIsHeld(requestKey) && <section className="revision-author-recovery" aria-label="Unconfirmed authorship change"><h3>Unconfirmed Authorship Change</h3><p>The change may already have completed. Retry sends the same request ID, author action, message, and exact versions. Without edit access, only a confirmed earlier handoff can be acknowledged.</p><p>{pending.body.action === 'assign' ? `Transfer to member ${pending.body.authorId}` : 'Commandeer for yourself'} · source version {pending.body.expectedVersion} · authorship version {pending.body.expectedAuthorVersion}</p><div className="file-actions"><button className="button" disabled={!online || (!enabled && !canConfirmHandoff) || saving} onClick={() => void send(pending)}>Retry Exact Authorship Change</button><button className="button" onClick={() => exportAuthor(id, pending, 'request')}>Export Authorship Request</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Forget this request? Any completed authorship change remains in history.')) { void discardStored(requestKey, pending); } }}>Forget Authorship Request</button></div>{client.draftHasUnsavedMemory(requestKey) && <p className="banner warning">This request is only retained in this tab.</p>}</section>}
    {reading && <details className="revision-author-history"><summary>Authorship History</summary><ol>{reading.history.transactions.map(item => <li key={item.id}><strong>{item.attribution.displayName}</strong> {item.action === 'commandeer' ? 'commandeered this revision' : `transferred authorship from ${item.previousAuthor?.displayName ?? 'Unassigned'} to ${item.author.displayName}`}<small>{new Date(item.createdAt).toLocaleString()} · authorship version {item.authorVersion} · source version {item.head.number}</small>{item.message && <p>{item.message}</p>}</li>)}</ol>{!reading.history.transactions.length && <p className="small muted">No authorship changes recorded.</p>}{reading.history.nextBefore !== null && <button className="button" disabled={!online || loading || paging || reading.history.transactions.length >= AUTHOR_HISTORY_LIMIT} onClick={() => void more()}>Load Older Authorship History</button>}<p className="small muted">Up to {AUTHOR_HISTORY_LIMIT} history entries are retained in this reading view.</p></details>}
  </div></section>;
}
