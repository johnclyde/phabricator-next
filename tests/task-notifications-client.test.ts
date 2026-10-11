import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeTaskMuteHistory, taskMuteDraft, taskMuteDraftMatches, taskMuteIntent, taskMuteReading, verifiedTaskMuteReceipt, type TaskMuteDraft, type TaskMuteIntent } from '../client/task-notifications.ts';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { retainFileIntent } from '../client/file-client.ts';
import type { TaskMuteHistory, TaskMuteSnapshot, TaskMuteTransaction } from '../shared/task-notifications.ts';
import { access } from './revision-subscriptions-client-fixture.ts';
const id = '61eb8a98-0397-49d3-bf10-cf67fffcf83b', second = '61eb8a98-0397-49d3-bf10-cf67fffcf83c', self = 'local:task-notifications';
const snapshot = (principalId = self): TaskMuteSnapshot => ({ taskId: 'T1', principalId, muted: false, version: 0, updatedAt: null, accessEpoch: 1 });
const reading = (principalId = self) => ({ snapshot: snapshot(principalId), history: { taskId: 'T1', principalId, version: 0, entries: [], nextBefore: null, accessEpoch: 1 } satisfies TaskMuteHistory });
const draft = (principalId = self): TaskMuteDraft => ({ taskId: 'T1', principalId, input: { action: 'mute', expectedMuteVersion: 0, expectedAccessEpoch: 1 } });
const intent = (principalId = self): TaskMuteIntent => ({ id, taskId: 'T1', principalId, body: draft(principalId).input, draft: draft(principalId) });
function fixture(mode: 'local' | 'password' = 'local', verified = true) {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const principalId = mode === 'local' ? self : 'U1', session = activateSession({ mode, workspaceId: 'task-notifications', account: mode === 'password' ? { id: principalId, username: 'reader', displayName: 'Reader', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null }), client = createWorkspaceClient(session);
  if (verified) client.reconcileAccess({ T1: access('T1'), P1: access() }, 1, ['S1']);
  return { principalId, client, session, entries, events, failWrites() { quota = true; }, close() { lockSession(); if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window'); } };
}
test('private task preference reading binds owner, epoch and newest history state', () => {
  assert.ok(taskMuteReading(reading(), 'T1', self)); assert.equal(taskMuteReading(reading(), 'T1', 'U2'), null); assert.equal(taskMuteReading({ ...reading(), history: { ...reading().history, accessEpoch: 2 } }, 'T1', self), null);
  const entry: TaskMuteTransaction = { id, taskId: 'T1', principalId: self, version: 1, before: false, after: true, createdAt: '2026-10-11T00:00:00Z', attribution: { principalId: self, displayName: 'Local', credentialId: null, requestId: 'task-notification-fixture' } };
  const latest = { snapshot: { ...snapshot(), version: 1, muted: true, updatedAt: entry.createdAt }, history: { ...reading().history, version: 1, entries: [entry] } };
  assert.ok(taskMuteReading(latest, 'T1', self)); assert.equal(taskMuteReading({ ...latest, history: { ...latest.history, entries: [] } }, 'T1', self), null); assert.equal(taskMuteReading({ ...latest, snapshot: { ...latest.snapshot, muted: false } }, 'T1', self), null);
});
test('preference history rejects overlaps and changed private versions', () => {
  const entry = (version: number, entryId: string): TaskMuteTransaction => ({ id: entryId, taskId: 'T1', principalId: self, version, before: version % 2 === 0, after: version % 2 !== 0, createdAt: '2026-10-11T00:00:00Z', attribution: { principalId: self, displayName: 'Local', credentialId: null, requestId: 'task-notification-fixture' } });
  const first: TaskMuteHistory = { ...reading().history, version: 2, entries: [entry(2, id)], nextBefore: 2 }, next: TaskMuteHistory = { ...first, entries: [entry(1, second)], nextBefore: null };
  assert.equal(mergeTaskMuteHistory(first, next).entries.length, 2); assert.throws(() => mergeTaskMuteHistory(first, first)); assert.throws(() => mergeTaskMuteHistory(first, { ...next, version: 3 })); assert.throws(() => mergeTaskMuteHistory(first, { ...next, accessEpoch: 2 }));
});
test('exact drafts have no task or owner pins and receipt verification preserves original request', async () => {
  const value = intent(); assert.deepEqual(taskMuteDraft(value.draft, 'T1', self), value.draft); assert.deepEqual(taskMuteIntent(value, 'T1', self), value); assert.equal(taskMuteIntent({ ...value, id: '-'.repeat(36) }, 'T1', self), null); assert.equal(taskMuteIntent({ ...value, body: { ...value.body, expectedMuteVersion: 1 } }, 'T1', self), null);
  assert.equal(taskMuteDraftMatches(value.draft, snapshot()), true); assert.equal(taskMuteDraftMatches(value.draft, { ...snapshot(), accessEpoch: 2 }), false); assert.equal(taskMuteDraftMatches(value.draft, { ...snapshot(), version: 1 }), false);
  const receipt = { taskId: 'T1', operationId: second, inputSha256: createHash('sha256').update(JSON.stringify(value.body)).digest('hex'), changed: true, accessEpoch: 1 }; assert.deepEqual(await verifiedTaskMuteReceipt(receipt, value), receipt); await assert.rejects(verifiedTaskMuteReceipt({ ...receipt, inputSha256: '0'.repeat(64) }, value)); assert.equal(canQueue('/api/tasks/T1/mute', 'POST', value.body), false);
});
test('View-only task readers can mute; Edit and Interact loss do not hold their exact preference', async () => {
  const f = fixture(), oldFetch = fetch; try { f.client.writeStored('task-mute-draft:T1', draft()); f.client.writeStored('task-mute-request:T1', intent()); f.client.reconcileAccess({ T1: access('T1', false, false), P1: access() }, 2, ['S1']); assert.equal(f.client.draftIsHeld('task-mute-draft:T1'), false); assert.equal(f.client.draftIsHeld('task-mute-request:T1'), false); let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ accessEpoch: 2 }); }; await f.client.request('/api/tasks/T1/mute', { method: 'POST', id, body: intent().body }); assert.equal(calls, 1); } finally { globalThis.fetch = oldFetch; f.close(); }
});
test('an informational epoch cannot release a cached task write before initial workspace authority arrives', async () => {
  const f = fixture('local', false), oldFetch = fetch; let release!: (value: Response) => void;
  try {
    globalThis.fetch = async () => Response.json({ accessEpoch: 1 }); await f.client.request('/api/notifications/count'); assert.equal(f.session.accessEpoch, 1); assert.equal(f.session.visibleObjects, null);
    let writes = 0, checks = 0; globalThis.fetch = async (url, init) => { if (String(url).endsWith('/api/state')) { checks++; return new Promise(resolve => { release = resolve; }); } if (init?.method === 'PATCH') writes++; return Response.json({ accessEpoch: 1 }); };
    const pending = f.client.request('/api/tasks/T1', { method: 'PATCH', id, body: { status: 'resolved', expectedVersion: 1 } }); await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(writes, 0); assert.equal(checks, 1);
    release(Response.json({ accessEpoch: 1, access: { T1: access('T1') }, spaces: [{ id: 'S1' }] })); await pending; assert.equal(writes, 1); assert.ok((f.session.visibleObjects as Set<string> | null)?.has('T1'));
  } finally { release?.(Response.json({ accessEpoch: 1, access: {}, spaces: [] })); globalThis.fetch = oldFetch; f.close(); }
});
test('initial authority denial prevents an unknown task write from reaching the server', async () => {
  const f = fixture('local', false), oldFetch = fetch;
  try {
    globalThis.fetch = async () => Response.json({ accessEpoch: 1 }); await f.client.request('/api/notifications/count');
    let writes = 0, checks = 0; globalThis.fetch = async (url, init) => { if (String(url).endsWith('/api/state')) { checks++; return Response.json({ accessEpoch: 1, access: {}, spaces: [{ id: 'S1' }] }); } if (init?.method === 'PATCH') writes++; return Response.json({ accessEpoch: 1 }); };
    await assert.rejects(f.client.request('/api/tasks/T1', { method: 'PATCH', id, body: { status: 'resolved', expectedVersion: 1 } }), RequestError); assert.equal(checks, 1); assert.equal(writes, 0); assert.equal(f.client.unavailableObject('T1'), true);
  } finally { globalThis.fetch = oldFetch; f.close(); }
});
test('a newer informational epoch does not reuse older verified editing rights', async () => {
  const f = fixture(), oldFetch = fetch;
  try {
    globalThis.fetch = async () => Response.json({ accessEpoch: 2 }); await f.client.request('/api/notifications/count'); assert.equal(f.session.accessEpoch, 2); assert.equal(f.session.objectCapabilities.get('T1')?.edit, true);
    let writes = 0, checks = 0; globalThis.fetch = async (url, init) => { if (String(url).endsWith('/api/state')) { checks++; return Response.json({ accessEpoch: 2, access: { T1: access('T1', false, false) }, spaces: [{ id: 'S1' }] }); } if (init?.method === 'PATCH') writes++; return Response.json({ accessEpoch: 2 }); };
    await assert.rejects(f.client.request('/api/tasks/T1', { method: 'PATCH', id, body: { status: 'resolved', expectedVersion: 1 } }), error => error instanceof RequestError && error.code === 'ACTION_FORBIDDEN'); assert.equal(checks, 1); assert.equal(writes, 0); assert.equal(f.client.unavailableObject('T1'), false);
  } finally { globalThis.fetch = oldFetch; f.close(); }
});
test('View or Space loss removes private reading and holds distinct durable and quota drafts', () => {
  for (const reason of ['view', 'space'] as const) { const f = fixture(); try { assert.equal(f.client.writeStored('task-mute:T1', reading()), true); f.client.writeStored('task-mute-draft:T1', draft()); f.failWrites(); assert.equal(f.client.writeStored('task-mute-draft:T1', { ...draft(), input: { ...draft().input, expectedMuteVersion: 1 } }), false); if (reason === 'view') f.client.retireUnavailableObject('T1'); else f.client.reconcileAccess({ P1: { ...access(), policy: { ...access().policy, spaceId: 'S2' } } }, 2, ['S2']); assert.equal(f.client.readStored('task-mute:T1', null), null); assert.equal(f.client.draftIsHeld('task-mute-draft:T1'), true); assert.equal(f.client.quarantinedDrafts().filter(row => row.key.startsWith('task-mute-draft:T1')).length, 2); assert.equal(f.client.unavailableObject('P1'), false); } finally { f.close(); } }
});
test('late preference reads reject epoch and cross-tab cache retirement', async () => {
  for (const reason of ['epoch', 'tab'] as const) { const f = fixture(), oldFetch = fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined; try { const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return response; }; const pending = f.client.request('/api/tasks/T1/mute'); await new Promise<void>(resolve => setImmediate(resolve)); if (reason === 'epoch') f.client.reconcileAccess({ T1: access('T1') }, 2, ['S1']); else { const event = new Event('storage'); Object.assign(event, { key: f.client.storageKey('task-mute:T1'), newValue: null }); f.events.dispatchEvent(event); } assert.equal(signal?.aborted, true); release(snapshot()); await assert.rejects(pending, RequestError); } finally { globalThis.fetch = oldFetch; f.close(); } }
});
test('successful exact cleanup preserves a newer draft and password preference data remains private', async () => {
  const f = fixture('password'), oldFetch = fetch; let release!: (value: Response) => void; try { const first = intent(f.principalId), newer = { ...first.draft, input: { ...first.body, action: 'unmute' as const, expectedMuteVersion: 1 } }; f.client.writeStored('task-mute:T1', reading(f.principalId)); f.client.writeStored('task-mute-draft:T1', first.draft); await retainFileIntent(f.client, 'task-mute-request:T1', first); f.client.writeStored('task-mute-draft:T1', newer); f.client.removeStoredIfEqual('task-mute-request:T1', first); f.client.removeStoredIfEqual('task-mute-draft:T1', first.draft); assert.deepEqual(f.client.readStored('task-mute-draft:T1', null), newer); assert.equal(f.entries.size, 0);
    globalThis.fetch = () => new Promise(resolve => { release = resolve; }); const pending = f.client.request('/api/tasks/T1/mute', { method: 'POST', body: first.body, id }); activateSession({ mode: 'password', workspaceId: 'task-notifications', account: { id: 'U2', username: 'next', displayName: 'Next', disabled: false }, sessionContext: 'next', csrfToken: 'next', expiresAt: null }); release(Response.json({ accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError); assert.equal(f.session.memory.size, 0);
  } finally { globalThis.fetch = oldFetch; f.close(); }
});
