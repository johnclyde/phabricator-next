import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { isObjectSubscriptionPerson, type ObjectMuteHistory, type ObjectSubscriptionAction, type ObjectSubscriptionHistory, type ObjectSubscriptionPerson, type ObjectSubscriptionSnapshot, type ObjectSubscriptionStatus } from '../shared/object-subscriptions';
import { FOLLOW_HISTORY_LIMIT, FOLLOW_PEOPLE_LIMIT, mergeMuteHistory, mergeSubscribers, mergeSubscriptionHistory, prepareSubscriptionDraft, subscriptionAuthority, subscriptionDraft, subscriptionDraftMatches, subscriptionIntent, subscriptionLabel, subscriptionReading, subscriptionSnapshot, verifiedSubscriptionResult, type SubscriptionDraft, type SubscriptionIntent, type SubscriptionReading } from './object-subscriptions';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { retainFileIntent } from './file-client';
import { onSessionLocked } from './session';

const failure = (error: unknown) => error instanceof Error ? error.message : 'Following could not be loaded.';
function exportFollowing(id: string, value: unknown, kind: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-following-${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
const roles = (_person: ObjectSubscriptionStatus) => 'the paste author';

export default function ObjectSubscriptions({ id, state, online, refreshWorkspace }: { id: string; state: AppState; online: boolean; refreshWorkspace: () => Promise<void> }) {
  const client = useWorkspace(), cacheKey = `object-subscriptions:${id}`, draftKey = `object-subscription-draft:${id}`, requestKey = `object-subscription-request:${id}`;
  const noun = id.startsWith('PA') ? 'Paste' : 'Document', lower = noun.toLowerCase();
  const self = client.session?.state.account?.id || `local:${client.session?.state.workspaceId}`;
  const allowedEpoch = (epoch: number) => epoch === client.session?.accessEpoch || client.durable && !online && client.session?.accessEpoch === -1;
  const cached = () => { const value = subscriptionReading(client.readStored(cacheKey, null), id, self); return value && allowedEpoch(value.snapshot.accessEpoch) ? value : null; };
  const [reading, setReading] = useState<SubscriptionReading | null>(cached), [draft, setDraft] = useState(() => subscriptionDraft(client.readStored(draftKey, null), id)), [pending, setPending] = useState(() => subscriptionIntent(client.readStored(requestKey, null), id));
  const [loading, setLoading] = useState(false), [paging, setPaging] = useState<'people' | 'public' | 'private' | null>(null), [saving, setSaving] = useState(false), [checkingPerson, setCheckingPerson] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true), [draftSaved, setDraftSaved] = useState(!client.draftHasUnsavedMemory(draftKey)), [target, setTarget] = useState('');
  const mounted = useRef(false), generation = useRef(0), personGeneration = useRef(0), current = useRef(reading), latest = useRef(draft), stateRef = useRef(state), refreshRef = useRef(refreshWorkspace), loadRef = useRef<() => void>(() => {});
  stateRef.current = state; refreshRef.current = refreshWorkspace; latest.current = draft;
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const show = (value: SubscriptionReading | null) => { current.current = value; setReading(value); };
  const sync = () => { const value = subscriptionDraft(client.readStored(draftKey, null), id); latest.current = value; setDraft(value); setPending(subscriptionIntent(client.readStored(requestKey, null), id)); setDraftSaved(!client.draftHasUnsavedMemory(draftKey)); };
  const load = useCallback(async () => {
    if (!active()) return;
    const ticket = ++generation.current; personGeneration.current++; setCheckingPerson(false); setPaging(null); setError('');
    if (!online) { const memory = current.current; show(memory && allowedEpoch(memory.snapshot.accessEpoch) ? memory : cached()); setLoading(false); return; }
    show(null); setLoading(true);
    try {
      const snapshot = await client.request<ObjectSubscriptionSnapshot>(`/api/objects/${id}/subscriptions?limit=50`);
      if (!active() || ticket !== generation.current) return;
      if (!subscriptionSnapshot(snapshot, id, self)) throw new Error('The following snapshot could not be verified.');
      const [history, muteHistory] = await Promise.all([
        client.request<ObjectSubscriptionHistory>(`/api/objects/${id}/subscriptions/history?limit=25&expectedSubscriptionVersion=${snapshot.subscriptionVersion}`),
        client.request<ObjectMuteHistory>(`/api/objects/${id}/subscriptions/mute-history?limit=25&expectedMuteVersion=${snapshot.mute.version}`),
      ]);
      if (!active() || ticket !== generation.current) return;
      const next = subscriptionReading({ snapshot, history, muteHistory }, id, self);
      if (!next || snapshot.accessEpoch !== client.session?.accessEpoch) throw new Error('Following changed while loading. Reload Following.');
      show(next); setSaved(client.writeStored(cacheKey, next));
      if (snapshot.accessEpoch > stateRef.current.accessEpoch) void refreshRef.current();
    } catch (error) { if (!active() || ticket !== generation.current) return; if (!isNetworkError(error)) { client.removeStored(cacheKey); void refreshRef.current(); } setError(failure(error)); }
    finally { if (mounted.current && ticket === generation.current) setLoading(false); }
  }, [id, online]);
  loadRef.current = () => void load();
  useEffect(() => {
    mounted.current = true; void load();
    const retire = () => { generation.current++; personGeneration.current++; show(null); setLoading(false); setPaging(null); setCheckingPerson(false); sync(); queueMicrotask(() => { if (active()) loadRef.current(); }); };
    const offSnapshot = client.onTaskSnapshotChange(retire), offAccess = client.onAccessChange(retire), offSession = onSessionLocked(() => { generation.current++; personGeneration.current++; show(null); setDraft(null); setPending(null); });
    const focus = () => loadRef.current(), storage = (event: StorageEvent) => { if (!event.key || [draftKey, requestKey].some(key => client.storageKey(key) === event.key)) sync(); };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => { mounted.current = false; generation.current++; personGeneration.current++; offSnapshot(); offAccess(); offSession(); window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); };
  }, [load]);
  const more = async (kind: 'people' | 'public' | 'private') => {
    const before = current.current; if (!before || !online || paging) return;
    const snapshot = before.snapshot, ticket = generation.current; setPaging(kind); setError('');
    try {
      let next: SubscriptionReading;
      if (kind === 'people') {
        if (snapshot.nextAfter === null) return;
        const page = await client.request<ObjectSubscriptionSnapshot>(`/api/objects/${id}/subscriptions?limit=50&after=${encodeURIComponent(snapshot.nextAfter)}&expectedSubscriptionVersion=${snapshot.subscriptionVersion}`);
        next = { ...before, snapshot: mergeSubscribers(snapshot, page) };
      } else if (kind === 'public') {
        if (before.history.nextBefore === null) return;
        const page = await client.request<ObjectSubscriptionHistory>(`/api/objects/${id}/subscriptions/history?limit=25&before=${before.history.nextBefore}&expectedSubscriptionVersion=${snapshot.subscriptionVersion}`);
        next = { ...before, history: mergeSubscriptionHistory(before.history, page) };
      } else {
        if (before.muteHistory.nextBefore === null) return;
        const page = await client.request<ObjectMuteHistory>(`/api/objects/${id}/subscriptions/mute-history?limit=25&before=${before.muteHistory.nextBefore}&expectedMuteVersion=${snapshot.mute.version}`);
        next = { ...before, muteHistory: mergeMuteHistory(before.muteHistory, page) };
      }
      if (!active() || ticket !== generation.current || current.current !== before) return;
      show(next); setSaved(client.writeStored(cacheKey, next));
    } catch (error) { if (active() && ticket === generation.current) { show(null); client.removeStored(cacheKey); setError(failure(error)); } }
    finally { if (mounted.current && ticket === generation.current) setPaging(null); }
  };
  const authorityAllowed = (value: SubscriptionDraft['input']) => { const access = current.current?.snapshot.access.capabilities, authority = subscriptionAuthority(value, self); return Boolean(access?.view && (authority === 'view' || authority === 'interact_or_edit' && (access.interact || access.edit) || authority === 'edit' && access.edit)); };
  const update = (value: SubscriptionDraft) => { if (!client.isActive() || client.draftIsHeld(draftKey)) return; latest.current = value; setDraft(value); setDraftSaved(client.writeStored(draftKey, value)); };
  const begin = (action: ObjectSubscriptionAction, person?: ObjectSubscriptionStatus, inspected?: ObjectSubscriptionPerson) => {
    const snapshot = current.current?.snapshot; if (!snapshot || saving) return;
    const next = prepareSubscriptionDraft(snapshot, action, person, inspected);
    if (!authorityAllowed(next.input) || latest.current && !window.confirm('Replace this retained following draft? Export it first to keep a copy.')) return;
    update(next); setError(''); setNotice('');
  };
  const inspectPerson = async (principalId: string) => {
    if (!online || checkingPerson || !principalId) return;
    const before = current.current; if (!before) return;
    const ticket = generation.current, personTicket = ++personGeneration.current; setCheckingPerson(true); setError('');
    try {
      const result = await client.request<ObjectSubscriptionPerson>(`/api/objects/${id}/subscriptions/person?principalId=${encodeURIComponent(principalId)}`);
      if (!active() || ticket !== generation.current || personTicket !== personGeneration.current || current.current !== before) return;
      if (!isObjectSubscriptionPerson(result, id, principalId) || result.accessEpoch !== before.snapshot.accessEpoch) throw new Error('Following access changed while checking this person. Reload Following before preparing the action.');
      begin('subscribe', result.status, result);
    } catch (error) { if (active() && ticket === generation.current && personTicket === personGeneration.current) setError(failure(error)); }
    finally { if (mounted.current && personTicket === personGeneration.current) setCheckingPerson(false); }
  };
  const send = async (intent: SubscriptionIntent) => {
    if (!online || saving || !active() || !authorityAllowed(intent.body) || client.draftIsHeld(requestKey)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(subscriptionIntent(retained.intent, id));
      if (!retained.accepted) throw new Error('A different unconfirmed following request is retained. Retry or export it first.');
      if (!retained.persisted && mounted.current) setNotice('This request is only retained in this tab. Keep it open and export it.');
      const result = await client.request<unknown>(`/api/objects/${id}/subscriptions`, { method: 'POST', body: intent.body, id: intent.id }), taskGeneration = client.taskSnapshotGeneration();
      const receipt = await verifiedSubscriptionResult(result, id, intent.body, self);
      if (!client.isActive() || client.unavailableObject(id) || receipt.accessEpoch !== client.session?.accessEpoch || taskGeneration !== client.taskSnapshotGeneration()) return;
      client.removeStoredIfEqual(requestKey, intent); client.removeStoredIfEqual(draftKey, intent.draft); client.removeStored(cacheKey);
      if (mounted.current) { sync(); setNotice(receipt.changed ? 'Preference saved. Your inspected source is unchanged.' : 'This preference was already set. No history entry was added.'); }
      await refreshRef.current(); if (active()) await load();
    } catch (error) { if (mounted.current && client.isActive()) { setError(failure(error)); void refreshRef.current(); } }
    finally { if (mounted.current) setSaving(false); }
  };
  const snapshot = reading?.snapshot, busy = loading || saving || checkingPerson, drifted = Boolean(draft && snapshot && !subscriptionDraftMatches(draft, snapshot));
  const people = state.principals.filter(person => !person.disabled && !snapshot?.subscribers.some(item => item.principalId === person.id && item.state === 'subscribed') && person.id !== self), targetId = people.some(person => person.id === target) ? target : people[0]?.id || '';
  const targetStatus = draft && snapshot ? draft.input.principalId === self ? snapshot.viewer : snapshot.subscribers.find(item => item.principalId === draft.input.principalId) : undefined;
  const forbiddenAutomatic = Boolean(draft && ['subscribe', 'unsubscribe'].includes(draft.input.action) && draft.input.principalId === self && targetStatus?.automatic.length);
  const submitAllowed = Boolean(online && snapshot && draft && authorityAllowed(draft.input) && !drifted && !forbiddenAutomatic && snapshot.accessEpoch === client.session?.accessEpoch && !pending && !busy && !client.draftIsHeld(draftKey));
  const personName = (principalId: string) => snapshot?.subscribers.find(person => person.principalId === principalId)?.displayName ?? (principalId === self ? 'You' : state.principals.find(person => person.id === principalId)?.displayName) ?? principalId;
  return <section className="panel object-subscriptions" aria-label="Following"><details className="object-following-disclosure"><summary><span>Following &amp; Notifications</span>{pending && !client.draftIsHeld(requestKey) ? <small>Unconfirmed change</small> : draft && !client.draftIsHeld(draftKey) ? <small>Saved choice</small> : null}</summary><div className="panel-heading"><h2>Following</h2><button className="button" disabled={!online || busy} onClick={() => void load()}>{loading ? 'Loading Following…' : 'Reload Following'}</button></div><div className="card-body">
    <p className="small muted">Following sends updates to your inbox while you can view this {lower}. It does not grant access or change its content.</p>
    {snapshot ? <><p>{snapshot.viewer.automatic.length ? `You follow automatically as ${roles(snapshot.viewer)}.` : snapshot.viewer.following ? `You are following this ${lower}.` : `You are not following this ${lower}.`}</p><div className="file-actions"><button className="button" disabled={busy || snapshot.viewer.automatic.length > 0} onClick={() => begin(snapshot.viewer.following ? 'unsubscribe' : 'subscribe')}>{snapshot.viewer.following ? `Unfollow ${noun}` : `Follow ${noun}`}</button></div>{snapshot.viewer.automatic.length > 0 && <p className="small muted">The paste author follows automatically. You can mute below.</p>}
      <ul className="object-subscriber-list">{snapshot.subscribers.map(person => <li key={person.principalId} data-follower-id={person.principalId}><div><strong>{person.displayName ?? person.principalId}</strong>{person.state === 'subscribed' && <small>Explicit following</small>}{person.automatic.length > 0 && <small>Automatic · {roles(person)}</small>}</div>{person.state === 'subscribed' && person.principalId !== self && snapshot.access.capabilities.edit && <button className="button" disabled={busy} onClick={() => begin('unsubscribe', person)}>{person.automatic.length ? 'Remove Explicit Following' : 'Remove Follower'}</button>}</li>)}</ul>{!snapshot.subscribers.length && <p className="muted">No followers on this page.</p>}{snapshot.nextAfter !== null && <button className="button" disabled={!online || busy || Boolean(paging) || snapshot.subscribers.length >= FOLLOW_PEOPLE_LIMIT} onClick={() => void more('people')}>Load More Followers</button>}
      {(snapshot.access.capabilities.interact || snapshot.access.capabilities.edit) && <div><label className="field"><span>Add a follower</span><select value={targetId} disabled={checkingPerson} onChange={event => { personGeneration.current++; setCheckingPerson(false); setTarget(event.target.value); }}>{!people.length && <option value="">No additional enabled people</option>}{people.map(person => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><button className="button" disabled={!online || !targetId || busy} onClick={() => void inspectPerson(targetId)}>{checkingPerson ? 'Checking Following…' : 'Add Follower'}</button></div>}
      <section className="object-mute-controls" aria-label="Personal mute preference"><h3>Your Mute Preference</h3><p>{snapshot.mute.muted ? 'Muted for you.' : 'Not muted for you.'} Mute stops new inbox notifications for this {lower}. Following stays unchanged; existing notifications remain. No email or push delivery is implemented.</p><button className="button" disabled={busy} onClick={() => begin(snapshot.mute.muted ? 'unmute' : 'mute')}>{snapshot.mute.muted ? `Unmute ${noun}` : `Mute ${noun}`}</button></section>
    </> : <p role="status">{loading ? 'Loading authorized following…' : 'Following is unavailable. Reconnect and reload before preparing an action.'}</p>}
    {!online && <p className="info-strip">Saved following snapshot. Drafts stay retained; reconnect and submit explicitly. Reconnecting never follows, unfollows, or changes mute.</p>}{!saved && <p className="banner warning">This following snapshot could not be saved for offline reading.</p>}{error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
    {draft && !client.draftIsHeld(draftKey) && <section className="object-subscription-editor" aria-label="Following action draft"><h3>{subscriptionLabel(draft.input.action, noun)}</h3><p>{personName(draft.input.principalId)} · {draft.input.action === 'mute' || draft.input.action === 'unmute' ? 'Only your private mute preference changes.' : 'Only explicit following changes; automatic roles remain in effect.'}</p><p className="small muted">Your saved choice is kept when this {lower} changes.</p>{drifted && <p className="banner warning">This preference or your access changed. Export your saved choice before preparing a new action.</p>}{forbiddenAutomatic && <p className="banner warning">You currently follow automatically. Your original draft stays available for export.</p>}<div className="file-actions"><button className="button primary" disabled={!submitAllowed} onClick={() => void send({ id: crypto.randomUUID(), objectId: id, body: draft.input, draft })}>{saving ? 'Saving Following…' : 'Confirm Following Change'}</button><button className="button" onClick={() => exportFollowing(id, draft, 'draft')}>Export Following Draft</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Discard this following draft? An already submitted request remains separate.')) { client.removeStoredIfEqual(draftKey, draft); sync(); } }}>Discard Following Draft</button></div>{!draftSaved && <p className="banner warning">This draft is only in this tab. Keep it open and export it.</p>}</section>}
    {pending && !client.draftIsHeld(requestKey) && <section className="object-subscription-recovery" aria-label="Unconfirmed following change"><h3>Unconfirmed Following Change</h3><p>The preference may already have changed. Retry confirms the original saved request without replacing your newer choice. Reconnecting never retries it.</p><p>{subscriptionLabel(pending.body.action, noun)} · {personName(pending.body.principalId)}</p><div className="file-actions"><button className="button" disabled={!online || !authorityAllowed(pending.body) || busy} onClick={() => void send(pending)}>Retry Exact Following Change</button><button className="button" onClick={() => exportFollowing(id, pending, 'request')}>Export Following Request</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Forget this request? Any completed preference remains recorded.')) { client.removeStoredIfEqual(requestKey, pending); sync(); } }}>Forget Following Request</button></div>{client.draftHasUnsavedMemory(requestKey) && <p className="banner warning">This request is only in this tab.</p>}</section>}
    {reading && <><details className="object-subscription-history"><summary>Following History</summary><p className="small muted">Explicit following changes are visible to document and paste readers. Paste comments start explicit following only when the person has not opted out and is not following automatically.</p><ol>{reading.history.transactions.map(item => <li key={item.id}><strong>{item.attribution.displayName}</strong> · {item.displayName} {item.after === 'subscribed' ? 'started following' : 'stopped explicit following'}{item.reason === 'comment' ? ' after commenting' : ''}<small>{new Date(item.createdAt).toLocaleString()} · following history {item.subscriptionVersion}</small></li>)}</ol>{!reading.history.transactions.length && <p>No explicit following changes recorded.</p>}{reading.history.nextBefore !== null && <button className="button" disabled={!online || busy || Boolean(paging) || reading.history.transactions.length >= FOLLOW_HISTORY_LIMIT} onClick={() => void more('public')}>Load Older Following History</button>}</details><details className="object-subscription-history"><summary>Your Private Mute History</summary><p className="small muted">Only your mute history is shown. It is separate from the public following history.</p><ol>{reading.muteHistory.transactions.map(item => <li key={item.id}>You {item.after ? 'muted' : 'unmuted'} this {lower}.<small>{new Date(item.createdAt).toLocaleString()} · preference {item.version}</small></li>)}</ol>{!reading.muteHistory.transactions.length && <p>No personal mute changes recorded.</p>}{reading.muteHistory.nextBefore !== null && <button className="button" disabled={!online || busy || Boolean(paging) || reading.muteHistory.transactions.length >= FOLLOW_HISTORY_LIMIT} onClick={() => void more('private')}>Load Older Private Mute History</button>}</details></>}
  </div></details></section>;
}
