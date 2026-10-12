import { useDraftRetention } from './draft-retention';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { isTaskMuteSnapshot, type TaskMuteHistory, type TaskMuteSnapshot } from '../shared/task-notifications';
import { mergeTaskMuteHistory, taskMuteDraft, taskMuteDraftMatches, taskMuteIntent, taskMuteReading, verifiedTaskMuteReceipt, TASK_MUTE_HISTORY_LIMIT, type TaskMuteDraft, type TaskMuteIntent, type TaskMuteReading } from './task-notifications';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { onSessionLocked } from './session';
import { retainFileIntent } from './file-client';
function exportPreference(id: string, value: unknown, kind: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = `${id}-notification-${kind}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
const failure = (value: unknown) => value instanceof Error ? value.message : 'Task notifications could not be loaded.';
export default function TaskNotifications({ id, state, online, refreshWorkspace }: { id: string; state: AppState; online: boolean; refreshWorkspace: () => Promise<void> }) {
  const client = useWorkspace(), self = client.session?.state.account?.id || `local:${client.session?.state.workspaceId}`, cacheKey = `task-mute:${id}`, draftKey = `task-mute-draft:${id}`, requestKey = `task-mute-request:${id}`;
  const allowedEpoch = (epoch: number) => epoch === client.session?.accessEpoch || client.durable && !online && client.session?.accessEpoch === -1;
  const cached = () => { const value = taskMuteReading(client.readStored(cacheKey, null), id, self); return value && allowedEpoch(value.snapshot.accessEpoch) ? value : null; };
  const [reading, setReading] = useState<TaskMuteReading | null>(cached), [draft, setDraft] = useState(() => taskMuteDraft(client.readStored(draftKey, null), id, self)), [pending, setPending] = useState(() => taskMuteIntent(client.readStored(requestKey, null), id, self));
  const [loading, setLoading] = useState(false), [paging, setPaging] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [saved, setSaved] = useState(true), [draftSaved, setDraftSaved] = useState(!client.draftHasUnsavedMemory(draftKey));
  const retainDraft = useDraftRetention(client, draftKey, setDraftSaved);
  const mounted = useRef(false), generation = useRef(0), current = useRef(reading), latest = useRef(draft), stateRef = useRef(state), refreshRef = useRef(refreshWorkspace), loadRef = useRef<() => void>(() => {}), saveLock = useRef(false);
  latest.current = draft; stateRef.current = state; refreshRef.current = refreshWorkspace;
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id);
  const show = (value: TaskMuteReading | null) => { current.current = value; setReading(value); };
  const sync = () => { const value = taskMuteDraft(client.readStored(draftKey, null), id, self); latest.current = value; setDraft(value); setPending(taskMuteIntent(client.readStored(requestKey, null), id, self)); setDraftSaved(!client.draftHasUnsavedMemory(draftKey)); };
  const load = useCallback(async () => {
    if (!active()) return; const ticket = ++generation.current; setPaging(false); setError('');
    if (!online) { const retained = current.current; show(retained && allowedEpoch(retained.snapshot.accessEpoch) ? retained : cached()); setLoading(false); return; }
    show(null); setLoading(true);
    try {
      const snapshot = await client.request<TaskMuteSnapshot>(`/api/tasks/${id}/mute`);
      if (!active() || ticket !== generation.current) return;
      if (!isTaskMuteSnapshot(snapshot, id, self)) throw new Error('The personal notification preference is invalid. Reload Task Notifications.');
      if (snapshot.accessEpoch > stateRef.current.accessEpoch) await refreshRef.current();
      if (!active() || ticket !== generation.current) return;
      const history = await client.request<TaskMuteHistory>(`/api/tasks/${id}/mute/history?limit=25&expectedMuteVersion=${snapshot.version}`), next = taskMuteReading({ snapshot, history }, id, self);
      if (!active() || ticket !== generation.current) return;
      if (!next || snapshot.accessEpoch !== client.session?.accessEpoch || client.session.visibleObjects !== null && !client.session.visibleObjects.has(id)) throw new Error('Your notification preference changed while loading. Reload Task Notifications.');
      show(next); setSaved(client.writeStored(cacheKey, next));
    } catch (value) { if (active() && ticket === generation.current) { if (!isNetworkError(value)) client.removeStored(cacheKey); setError(failure(value)); } }
    finally { if (mounted.current && ticket === generation.current) setLoading(false); }
  }, [id, online]);
  loadRef.current = () => void load();
  useEffect(() => {
    mounted.current = true; void load();
    const retire = () => { generation.current++; show(null); setLoading(false); setPaging(false); sync(); queueMicrotask(() => { if (active()) loadRef.current(); }); };
    const snapshot = client.onTaskSnapshotChange(retire), access = client.onAccessChange(retire), locked = onSessionLocked(() => { generation.current++; show(null); setDraft(null); setPending(null); });
    const focus = () => loadRef.current(), storage = (event: StorageEvent) => { if (!event.key || [draftKey, requestKey].some(key => event.key === client.storageKey(key))) sync(); };
    window.addEventListener('focus', focus); window.addEventListener('storage', storage);
    return () => { mounted.current = false; generation.current++; snapshot(); access(); locked(); window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); };
  }, [load]);
  const more = async () => {
    const before = current.current; if (!before?.history.nextBefore || !online || paging) return; const ticket = generation.current; setPaging(true); setError('');
    try { const page = await client.request<TaskMuteHistory>(`/api/tasks/${id}/mute/history?limit=25&before=${before.history.nextBefore}&expectedMuteVersion=${before.snapshot.version}`); if (!active() || ticket !== generation.current || current.current !== before) return; const next = { ...before, history: mergeTaskMuteHistory(before.history, page) }; show(next); setSaved(client.writeStored(cacheKey, next)); }
    catch (value) { if (active() && ticket === generation.current) { show(null); client.removeStored(cacheKey); setError(failure(value)); } }
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
  const start = () => { const snapshot = current.current?.snapshot; if (!snapshot || client.draftIsHeld(draftKey)) return; const next: TaskMuteDraft = { taskId: id, principalId: self, input: { action: snapshot.muted ? 'unmute' : 'mute', expectedMuteVersion: snapshot.version, expectedAccessEpoch: snapshot.accessEpoch } }; latest.current = next; setDraft(next); retainDraft(next); setError(''); };
  const send = async (intent: TaskMuteIntent) => {
    if (!online || saveLock.current || !active() || client.draftIsHeld(requestKey)) return; saveLock.current = true; setSaving(true); setError('');
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (mounted.current) setPending(taskMuteIntent(retained.intent, id, self)); if (!retained.accepted) throw new Error('An earlier notification preference needs confirmation. Retry or export its exact request first.');
      if (!retained.persisted) setNotice('The exact request remains in this tab only. Keep this tab open or export it.');
      const result = await client.request<unknown>(`/api/tasks/${id}/mute`, { method: 'POST', id: intent.id, body: intent.body }); const snapshotGeneration = client.taskSnapshotGeneration(), receipt = await verifiedTaskMuteReceipt(result, intent);
      if (!client.isActive() || snapshotGeneration !== client.taskSnapshotGeneration() || receipt.accessEpoch !== client.session?.accessEpoch || client.unavailableObject(id)) return;
      const cleanupTicket = generation.current;
      const cleanupCurrent = () => active() && generation.current === cleanupTicket && snapshotGeneration === client.taskSnapshotGeneration() && receipt.accessEpoch === client.session?.accessEpoch;
      await client.removeRetainedDraftIfEqual(requestKey, intent, cleanupCurrent);
      await client.removeRetainedDraftIfEqual(draftKey, intent.draft, cleanupCurrent);
      if (!cleanupCurrent()) return;
      if (mounted.current) { sync(); setNotice(receipt.changed ? 'Your task notification preference was saved.' : 'Your task notification preference already matched this request.'); await load(); }
    } catch (value) { if (mounted.current) setError(failure(value)); }
    finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  };
  const held = client.draftIsHeld(draftKey) || client.draftIsHeld(requestKey), snapshot = reading?.snapshot, fresh = Boolean(draft && snapshot && taskMuteDraftMatches(draft, snapshot) && snapshot.accessEpoch === client.session?.accessEpoch);
  return <section className="panel task-notifications" aria-label="Task notifications"><div className="panel-heading"><h2>Task Notifications</h2><button className="button" disabled={!online || loading} onClick={() => void load()}>Reload Task Notifications</button></div><div className="card-body">
    <p>Mute stops new inbox notifications for this task, including project watching. It leaves existing notifications and following unchanged. No email or push notifications are sent.</p>
    {snapshot ? <><p><strong>{snapshot.muted ? 'Muted for you.' : 'Not muted for you.'}</strong> This preference and its history are private to you.</p><button className="button" disabled={held || saving || Boolean(draft)} onClick={start}>{snapshot.muted ? 'Unmute Task' : 'Mute Task'}</button></> : <p>{loading ? 'Loading your notification preference…' : 'No authorized notification preference is available. Reconnect and reload.'}</p>}
    {!online && <p className="info-strip">Offline · saved preference. Drafts stay with their inspected preference version and never submit automatically.</p>}{!saved && <p className="info-strip">This preference could not be saved on the device. Keep this tab open.</p>}{held && <p className="info-strip">Your saved notification change is set aside for export because task access changed.</p>}
    {draft && <section className="task-mute-draft" aria-label="Task notification draft"><h3>{draft.input.action === 'mute' ? 'Mute this task for you' : 'Unmute this task for you'}</h3><p>Based on personal preference version {draft.input.expectedMuteVersion}. Task edits and ownership changes do not change this choice.</p>{snapshot && !taskMuteDraftMatches(draft, snapshot) && <p className="info-strip">Your preference or access changed. Export or discard this draft before choosing from the current preference.</p>}<p className={draftSaved ? 'muted small' : 'error-text small'}>{draftSaved ? client.durable ? 'Draft saved on this device.' : 'Draft stays in this tab only.' : 'Draft storage failed. Keep this tab open or export the draft.'}</p><div className="task-notification-actions"><button className="button" onClick={() => exportPreference(id, draft, 'draft')}>Export Notification Draft</button><button className="button" disabled={saving || held} onClick={() => { if (window.confirm('Discard this notification preference draft?')) { void discardStored(draftKey, draft); } }}>Discard Notification Draft</button><button className="button primary" disabled={!online || saving || held || !fresh || Boolean(pending)} onClick={() => void send({ id: crypto.randomUUID(), taskId: id, principalId: self, body: draft.input, draft })}>Confirm Notification Preference</button></div></section>}
    {pending && <div className="task-mute-request"><strong>Unconfirmed task notification change</strong><p>The original preference and access version are retained for this exact retry.</p><div className="task-notification-actions"><button className="button" disabled={!online || saving || held} onClick={() => void send(pending)}>Retry Exact Preference</button><button className="button" onClick={() => exportPreference(id, pending, 'request')}>Export Notification Request</button><button className="button" disabled={saving} onClick={() => { if (window.confirm('Discard this exact request? Its server outcome may still be unknown.')) { void discardStored(requestKey, pending); } }}>Discard Notification Request</button></div></div>}
    {error && <p role="alert" className="error-text">{error}</p>}{notice && <p role="status" className="muted small">{notice}</p>}
    {reading && <details className="task-mute-history"><summary>Your Notification Preference History</summary><ol>{reading.history.entries.map(entry => <li key={entry.id}><strong>{entry.after ? 'Muted' : 'Unmuted'}</strong> · {new Date(entry.createdAt).toLocaleString()} · Preference version {entry.version}</li>)}</ol>{!reading.history.entries.length && <p>No saved preference changes.</p>}{reading.history.nextBefore !== null && <button className="button" disabled={!online || paging || reading.history.entries.length >= TASK_MUTE_HISTORY_LIMIT} onClick={() => void more()}>Load Older Preference History</button>}</details>}
  </div></section>;
}
