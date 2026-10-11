import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { REVISION_REVIEWER_LIMITS, revisionReviewerActionLabel, type RevisionReviewerAction, type RevisionReviewerHistory, type RevisionReviewerInput, type RevisionReviewerSnapshot } from '../shared/revision-reviewers';
import { revisionRefreshDirection } from './revision-lifecycle';
import { revisionStatusLabel } from '../shared/revision-status';
import { reviewerAuthority, reviewerStatusLabel, reviewerReadingCurrent, REVIEWER_HISTORY_LIMIT, reviewerDraft, reviewerDraftMatches, reviewerIntent, reviewerReading, reviewerSnapshot, mergeReviewerHistory, prepareReviewerDraft, verifiedReviewerResult, type ReviewerIntent, type ReviewerReading } from './revision-reviewers';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { retainFileIntent } from './file-client';
import { onSessionLocked } from './session';

const failureText = (error: unknown) => error instanceof Error ? error.message : 'Reviewer could not be loaded.';
function exportReviewer(id: string, value: unknown, kind: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-reviewer-${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function RevisionReviewers({ id, state, online, selectedVersionId, headVersionId, evidenceKey, refreshWorkspace, reloadRevision, notify }: { id: string; state: AppState; online: boolean; selectedVersionId: string; headVersionId: string; evidenceKey: string; refreshWorkspace: () => Promise<void>; reloadRevision: () => Promise<unknown>; notify: (message: string) => void }) {
  const client = useWorkspace(), cacheKey = `revision-reviewers:${id}`, draftKey = `revision-reviewer-draft:${id}`, requestKey = `revision-reviewer-request:${id}`;
  const allowedEpoch = (epoch: number) => epoch === client.session?.accessEpoch || (client.durable && !online && client.session?.accessEpoch === -1);
  const cached = (knownState = state, knownHead = headVersionId, knownEvidence = evidenceKey) => { const saved = reviewerReading(client.readStored(cacheKey, null), id); return saved && allowedEpoch(saved.snapshot.accessEpoch) && reviewerReadingCurrent(saved, knownState.revisions.find(item => item.id === id), knownHead, knownEvidence) ? saved : null; };
  const [reading, setReading] = useState<ReviewerReading | null>(cached), [draft, setDraft] = useState(() => reviewerDraft(client.readStored(draftKey, null))), [pending, setPending] = useState(() => reviewerIntent(client.readStored(requestKey, null), id));
  const [loading, setLoading] = useState(false), [paging, setPaging] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true), [draftSaved, setDraftSaved] = useState(!client.draftHasUnsavedMemory(draftKey));
  const mounted = useRef(false), generation = useRef(0), current = useRef(reading), latest = useRef(draft), loadRef = useRef<() => void>(() => {}), refreshRef = useRef(refreshWorkspace), stateRef = useRef(state);
  const metadataRetry = useRef<string | null>(null);
  const detailRef = useRef({ reload: reloadRevision, head: headVersionId, evidence: evidenceKey });
  detailRef.current = { reload: reloadRevision, head: headVersionId, evidence: evidenceKey };
  latest.current = draft; refreshRef.current = refreshWorkspace; stateRef.current = state;
  const show = (value: ReviewerReading | null) => { current.current = value; setReading(value); };
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const sync = () => { const next = reviewerDraft(client.readStored(draftKey, null)); latest.current = next; setDraft(next); setPending(reviewerIntent(client.readStored(requestKey, null), id)); setDraftSaved(!client.draftHasUnsavedMemory(draftKey)); };
  const load = useCallback(async () => {
    if (!active()) return;
    const ticket = ++generation.current; setPaging(false); setError('');
    if (!online) { show(cached(stateRef.current, detailRef.current.head, detailRef.current.evidence)); setLoading(false); return; }
    show(null); setLoading(true);
    try {
      const snapshot = await client.request<RevisionReviewerSnapshot>(`/api/revisions/${id}/reviewers`);
      if (!active() || ticket !== generation.current) return;
      if (!reviewerSnapshot(snapshot, id)) throw new Error('The reviewer snapshot could not be verified.');
      const history = await client.request<RevisionReviewerHistory>(`/api/revisions/${id}/reviewers/history?limit=25&expectedReviewerVersion=${snapshot.reviewers.version}`);
      if (!active() || ticket !== generation.current) return;
      const next = reviewerReading({ snapshot, history }, id);
      if (!next || snapshot.accessEpoch !== client.session?.accessEpoch) throw new Error('Reviewer changed while loading. Reload Reviewer.');
      const metadata = stateRef.current.revisions.find(item => item.id === id);
      const direction = revisionRefreshDirection(metadata, { currentVersion: snapshot.head.number, authorVersion: snapshot.authorship.version, lifecycleVersion: snapshot.lifecycle.version, reviewerVersion: snapshot.reviewers.version, status: snapshot.lifecycle.status });
      if (direction === 'revision') {
        client.removeStored(cacheKey);
        const identity = JSON.stringify([metadata?.currentVersion, metadata?.authorVersion, metadata?.lifecycleVersion, metadata?.reviewerVersion]);
        if (metadataRetry.current !== identity) {
          metadataRetry.current = identity;
          queueMicrotask(() => { if (active() && ticket === generation.current) loadRef.current(); });
        } else setError('A newer revision state is available. Reload Reviewers. Your draft keeps its original versions.');
        return;
      }
      metadataRetry.current = null;
      show(next); setSaved(client.writeStored(cacheKey, next));
      if (snapshot.accessEpoch > stateRef.current.accessEpoch || direction === 'workspace') void refreshRef.current();
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
      const page = await client.request<RevisionReviewerHistory>(`/api/revisions/${id}/reviewers/history?limit=25&expectedReviewerVersion=${before.snapshot.reviewers.version}&before=${before.history.nextBefore}`);
      if (!active() || ticket !== generation.current || current.current !== before) return;
      const next = { ...before, history: mergeReviewerHistory(before.history, page) }; show(next); setSaved(client.writeStored(cacheKey, next));
    } catch (error) { if (active() && ticket === generation.current) { show(null); client.removeStored(cacheKey); setError(failureText(error)); } }
    finally { if (mounted.current && ticket === generation.current) setPaging(false); }
  };
  const update = (next: RevisionReviewerInput) => { if (!client.isActive() || client.draftIsHeld(draftKey)) return; latest.current = next; setDraft(next); setDraftSaved(client.writeStored(draftKey, next)); };
  const begin = (action: RevisionReviewerAction, reviewerId?: string) => { const snapshot = current.current?.snapshot; if (!snapshot || pending || !snapshot.actions.some(option => option.action === action && option.available)) return; if (latest.current && !window.confirm('Replace this retained reviewer draft? Export it first to keep a copy.')) return; update(prepareReviewerDraft(snapshot, action, reviewerId)); setError(''); setNotice(''); };
  const send = async (intent: ReviewerIntent) => {
    if (!online || saving || !active() || !current.current?.snapshot.access.capabilities[reviewerAuthority(intent.body) ?? 'edit'] || client.draftIsHeld(requestKey)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(reviewerIntent(retained.intent, id));
      if (!retained.accepted) throw new Error('A different unconfirmed reviewer request is retained. Retry or export that original request first.');
      if (!retained.persisted && mounted.current) setNotice('This submitted request is only retained in this tab. Keep it open and export the request.');
      const result = await client.request<unknown>(`/api/revisions/${id}/reviewers`, { method: 'POST', body: intent.body, id: intent.id });
      const receipt = await verifiedReviewerResult(result, id, intent.body, stateRef.current.currentPrincipalId);
      if (!client.isActive() || client.unavailableObject(id) || receipt.accessEpoch !== client.session?.accessEpoch) return;
      client.removeStoredIfEqual(requestKey, intent); client.removeStoredIfEqual(draftKey, intent.draft); client.removeStored(cacheKey); client.invalidateRevisionStacks();
      notify(`${revisionReviewerActionLabel(intent.body.action)} saved. Source versions are unchanged.`);
      if (mounted.current) { sync(); setNotice('Reviewer action saved. Your inspected source version is unchanged.'); }
      await refreshRef.current();
      if (active()) { await reloadRevision(); await load(); }
    } catch (error) { if (mounted.current && client.isActive()) { setError(failureText(error)); void refreshRef.current(); } }
    finally { if (mounted.current) setSaving(false); }
  };
  const snapshot = reading?.snapshot, knownEpoch = client.session?.accessEpoch ?? -1;
  const authorityAllowed = (value: RevisionReviewerInput) => Boolean(snapshot?.access.capabilities[reviewerAuthority(value) ?? 'edit'] && !client.unavailableObject(id));
  const [target, setTarget] = useState('');
  const people = state.principals.filter(person => !person.disabled && (snapshot?.config.allowSelfAccept || person.id !== snapshot?.authorship.author?.principalId) && !snapshot?.reviewers.members.some(member => member.principalId === person.id));
  const targetId = people.some(person => person.id === target) ? target : people[0]?.id || '';
  const canBegin = (action: RevisionReviewerAction) => Boolean(snapshot?.actions.find(option => option.action === action)?.available && !pending && !saving && !loading);
  const label = (action: RevisionReviewerAction) => snapshot?.actions.find(option => option.action === action)?.label ?? revisionReviewerActionLabel(action);
  const drifted = Boolean(draft && snapshot && !reviewerDraftMatches(draft, snapshot)), selectedAction = snapshot?.actions.find(option => option.action === draft?.action);
  const submitAllowed = Boolean(online && draft && authorityAllowed(draft) && snapshot?.accessEpoch === knownEpoch && draft && !drifted && selectedAction?.available && !pending && !loading && !saving && !client.draftIsHeld(draftKey));
  return <section className="panel revision-reviewers" aria-label="Reviewers"><div className="panel-heading"><h2>Reviewers</h2><button className="button" disabled={!online || loading || saving} onClick={() => void load()}>{loading ? 'Loading Reviewers…' : 'Reload Reviewers'}</button></div><div className="card-body">
    {snapshot ? <><p className="small muted">Named people review current source version {snapshot.head.number}. Decisions record the person and exact source; they do not run automated checks or verify factual correctness.</p>{selectedVersionId !== snapshot.head.versionId && <p className="info-strip">You are inspecting an earlier source. Reviewer actions apply to current source version {snapshot.head.number}; your inspected version stays fixed.</p>}
      <p className="small" data-testid="reviewer-summary">{revisionStatusLabel(snapshot.lifecycle.status)} · reviewer list {snapshot.reviewers.version}</p>{snapshot.reviewers.acceptance && <p className="small muted">Acceptance basis: {snapshot.reviewers.acceptance.kind === 'reviewers' ? 'named reviewer decisions' : snapshot.reviewers.acceptance.kind === 'evidence' ? 'recorded checks' : 'legacy status'}.</p>}
      <ul className="revision-reviewer-list">{snapshot.reviewers.members.map(member => <li key={member.principalId} data-reviewer-id={member.principalId}><div><strong>{member.displayName}</strong><span className="badge">{reviewerStatusLabel(member.status)}{member.decision?.invalidated && ' · earlier decision'}</span></div>{member.decision && <p className="small">Decision on source version {member.decision.head.number} · {member.decision.attribution.displayName} · {new Date(member.decision.createdAt).toLocaleString()}{member.decision.invalidated && <><br/><strong>Decision from an earlier review state.</strong> {member.decision.invalidated.reason === 'source_updated' ? 'Source changed.' : member.decision.invalidated.reason === 'request_review' ? 'Review was requested again.' : 'New checks reported errors.'}</>}</p>}{snapshot.access.capabilities.edit && <div className="file-actions"><button className="button" disabled={!canBegin('remove')} onClick={() => begin('remove', member.principalId)}>Remove Reviewer</button><button className="button" disabled={!canBegin(member.status === 'blocking' ? 'unblock' : 'block') || member.status !== 'blocking' && (!snapshot.config.allowSelfAccept && member.principalId === snapshot.authorship.author?.principalId || !state.principals.some(person => person.id === member.principalId && !person.disabled))} onClick={() => begin(member.status === 'blocking' ? 'unblock' : 'block', member.principalId)}>{label(member.status === 'blocking' ? 'unblock' : 'block')}</button></div>}</li>)}</ul>
      {!snapshot.reviewers.members.length && <p className="muted">No named reviewers.</p>}
      {snapshot.access.capabilities.edit && <div className="revision-reviewer-add"><label className="field"><span>Add a reviewer</span><select value={targetId} onChange={event => setTarget(event.target.value)}>{!people.length && <option value="">No additional enabled people</option>}{people.map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><button className="button" disabled={!targetId || !canBegin('add')} onClick={() => begin('add', targetId)}>Add Reviewer</button></div>}
      <div className="revision-reviewer-decisions">{snapshot.actions.filter(option => ['accept', 'request_changes', 'resign'].includes(option.action)).map(option => <div key={option.action}><button className="button" disabled={!canBegin(option.action)} onClick={() => begin(option.action)} aria-describedby={`${id}-reviewer-${option.action}-reason`}>{option.label}</button><p id={`${id}-reviewer-${option.action}-reason`} className="small muted">{option.reason ?? 'Record your decision on the current source version.'}</p></div>)}</div>
    </> : <p role="status">{loading ? 'Loading authorized reviewers…' : 'Reviewers are unavailable. Reconnect and reload before preparing an action.'}</p>}
    {!online && <p className="info-strip">Saved reviewer snapshot. Drafts are retained; reconnect and submit explicitly. Reconnecting never records a decision.</p>}{!saved && <p className="banner warning">This reviewer snapshot could not be saved for offline reading.</p>}{error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
    {draft && !client.draftIsHeld(draftKey) && <section className="revision-reviewer-editor" aria-label="Reviewer action draft"><h3>{label(draft.action)}</h3><p className="small muted">Prepared for source version {draft.expectedVersion}, reviewer list {draft.expectedReviewerVersion}, and lifecycle {draft.expectedLifecycleVersion}. The authorship, evidence, configuration, and access versions stay fixed.</p>{'reviewerId' in draft && <p>Reviewer: {snapshot?.reviewers.members.find(member => member.principalId === draft.reviewerId)?.displayName ?? state.principals.find(person => person.id === draft.reviewerId)?.displayName ?? draft.reviewerId}</p>}<label className="field"><span>Reviewer message</span><textarea maxLength={REVISION_REVIEWER_LIMITS.message} rows={3} value={draft.message} onChange={event => update({ ...draft, message: event.target.value })}/></label>{drifted && <p className="banner warning">Reviewers, source, author, lifecycle, evidence, configuration, or access changed. This draft keeps its original versions. Export it, then start a new action after reloading.</p>}<div className="file-actions"><button className="button primary" disabled={!submitAllowed} onClick={() => void send({ id: crypto.randomUUID(), revisionId: id, body: draft, draft })}>{saving ? 'Saving Reviewer Action…' : 'Confirm Reviewer Action'}</button><button className="button" onClick={() => exportReviewer(id, draft, 'draft')}>Export Reviewer Draft</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Discard this reviewer draft? A submitted request is retained separately.')) { client.removeStoredIfEqual(draftKey, draft); sync(); } }}>Discard Reviewer Draft</button></div>{!draftSaved && <p className="banner warning">This draft is only in this tab. Keep it open and export it.</p>}</section>}
    {pending && !client.draftIsHeld(requestKey) && <section className="revision-reviewer-recovery" aria-label="Unconfirmed reviewer change"><h3>Unconfirmed Reviewer Change</h3><p>The action may already have completed. Retry sends the same request ID, action, message, and exact versions. Reconnecting never retries it.</p><p>{label(pending.body.action)} · source version {pending.body.expectedVersion} · reviewer list {pending.body.expectedReviewerVersion}</p><div className="file-actions"><button className="button" disabled={!online || !authorityAllowed(pending.body) || saving || loading} onClick={() => void send(pending)}>Retry Exact Reviewer Change</button><button className="button" onClick={() => exportReviewer(id, pending, 'request')}>Export Reviewer Request</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Forget this request? Any completed reviewer action remains in history.')) { client.removeStoredIfEqual(requestKey, pending); sync(); } }}>Forget Reviewer Request</button></div>{client.draftHasUnsavedMemory(requestKey) && <p className="banner warning">This request is only retained in this tab.</p>}</section>}
    {reading && <details className="revision-reviewer-history"><summary>Reviewer History</summary><ol>{reading.history.transactions.map(item => <li key={item.id}><strong>{item.attribution?.displayName ?? 'Actor not recorded'}</strong> · {item.action === 'source_updated' ? 'Source updated' : item.action === 'request_review' ? 'Review requested again' : item.action === 'review_error' ? 'Review errors recorded' : item.action === 'author_changed' ? 'Current author changed' : item.action === 'evidence_accepted' ? 'Recorded checks accepted' : revisionReviewerActionLabel(item.action)}{item.reviewerId && <p>Reviewer: {[...item.after, ...item.before].find(member => member.principalId === item.reviewerId)?.displayName ?? item.reviewerId}</p>}<p>{revisionStatusLabel(item.fromStatus)} → {revisionStatusLabel(item.toStatus)}</p><small>{new Date(item.createdAt).toLocaleString()} · reviewer list {item.reviewerVersion} · source version {item.head.number}</small>{item.message && <p>{item.message}</p>}</li>)}</ol>{!reading.history.transactions.length && <p className="small muted">No reviewer changes recorded.</p>}{reading.history.nextBefore !== null && <button className="button" disabled={!online || loading || paging || reading.history.transactions.length >= REVIEWER_HISTORY_LIMIT} onClick={() => void more()}>Load Older Reviewer History</button>}<p className="small muted">Up to {REVIEWER_HISTORY_LIMIT} history entries are retained in this reading view.</p></details>}
  </div></section>;
}
