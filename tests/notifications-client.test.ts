import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeNotifications, notificationCache, notificationIntent, notificationIntentObjectId, notificationSummary, verifiedNotificationReceipt, type NotificationPage } from '../client/notification-client.ts';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { access } from './revision-subscriptions-client-fixture.ts';
const id = '61eb8a98-0397-49d3-bf10-cf67fffcf83b', eventId = '61eb8a98-0397-49d3-bf10-cf67fffcf83c', horizon = 'a'.repeat(40), cursor = 'b'.repeat(40);
const page = (principalId = 'local:notifications'): NotificationPage => ({ principalId, filter: 'all', horizon, unreadCount: 1, readVersion: 0, accessEpoch: 1, nextBefore: cursor, items: [{ id, read: false, version: 0, event: { format: 'phabricator.notification-event.v2', id: eventId, objectId: 'P1', kind: 'commented', cause: { type: 'comment', id: 'comment-1' }, actor: { principalId: 'U1', displayName: 'Reader' }, createdAt: '2026-10-11T00:00:00Z', context: { kind: 'revision', head: { versionId: 'version-1', number: 1, contentHash: 'a'.repeat(64) } } }, object: { id: 'P1', title: 'Private paper', kind: 'paper' } }] });
const intent = (principalId = 'local:notifications') => ({ id, principalId, body: { action: 'read' as const, notificationId: id, expectedVersion: 0, expectedAccessEpoch: 1 }, revisionId: 'P1' });
function fixture(mode: 'local' | 'password' = 'local') {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const self = mode === 'local' ? 'local:notifications' : 'U1', session = activateSession({ mode, workspaceId: 'notifications', account: mode === 'password' ? { id: self, username: 'reader', displayName: 'Reader', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null }), client = createWorkspaceClient(session), key = `notifications:${self}`, requestKey = `notification-request:${self}`, first = page(self), reading = { summary: notificationSummary(first), pages: [first] };
  client.reconcileAccess({ P1: access(), F1: access('F1') }, 1, ['S1']); assert.equal(client.writeStored(key, reading), true);
  return { self, client, session, key, requestKey, reading, entries, events, failWrites() { quota = true; }, close() { lockSession(); if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window'); } };
}
test('inbox cache is private and validates filters, event identity and read snapshots', () => {
  const first = page(), cache = { summary: notificationSummary(first), pages: [first] };
  assert.ok(notificationCache(cache, first.principalId)); assert.equal(notificationCache(cache, 'U2'), null);
  assert.equal(notificationCache({ ...cache, pages: [{ ...first, filter: 'read' }] }, first.principalId), null);
  assert.equal(notificationCache({ ...cache, pages: [{ ...first, readVersion: 1 }] }, first.principalId), null);
  assert.equal(notificationCache({ ...cache, pages: [{ ...first, items: [...first.items, ...first.items] }] }, first.principalId), null);
  const next = { ...first, nextBefore: null, items: [{ ...first.items[0], id: '61eb8a98-0397-49d3-bf10-cf67fffcf83d', event: { ...first.items[0].event, id: '61eb8a98-0397-49d3-bf10-cf67fffcf83e', createdAt: '2026-10-10T00:00:00Z' } }] };
  assert.equal(mergeNotifications(first, next).items.length, 2);
  assert.equal(mergeNotifications(first, { ...next, horizon: 'c'.repeat(40), items: next.items.map(item => ({ ...item, event: { ...item.event, createdAt: '2026-10-12T00:00:00Z' } })) }).items.length, 2);
  for (const changed of [{ ...next, readVersion: 2 }, { ...next, items: first.items }, { ...next, nextBefore: cursor }]) assert.throws(() => mergeNotifications(first, changed));
});
test('exact intents preserve opaque boundary and receipt digest, without source payload', async () => {
  const value = intent(); assert.deepEqual(notificationIntent(value, value.principalId), value); assert.equal(notificationIntent({ ...value, id: '-'.repeat(36) }, value.principalId), null); assert.equal(notificationIntent({ ...value, title: 'do not retain' }, value.principalId), null);
  const receipt = { operationId: eventId, inputSha256: createHash('sha256').update(JSON.stringify(value.body)).digest('hex'), changed: true, accessEpoch: 1 };
  assert.deepEqual(await verifiedNotificationReceipt(receipt, value), receipt); await assert.rejects(verifiedNotificationReceipt({ ...receipt, inputSha256: '0'.repeat(64) }, value));
  assert.equal(canQueue('/api/notifications/read', 'POST', value.body), false);
});
test('schema31 cached revision items project safely while old exact read requests retain their bytes', async () => {
  const modern = page(), item = modern.items[0]!, event = item.event;
  assert.equal(event.context.kind, 'revision');
  const legacyItem = { id: item.id, event: { id: event.id, revisionId: event.objectId, kind: event.kind, cause: event.cause, actor: event.actor, createdAt: event.createdAt, head: event.context.kind === 'revision' ? event.context.head : null }, revision: item.object, read: item.read, version: item.version };
  const cache = { summary: notificationSummary(modern), pages: [{ ...modern, items: [legacyItem] }] }, original = JSON.stringify(cache);
  assert.deepEqual(notificationCache(cache, modern.principalId), { summary: notificationSummary(modern), pages: [modern] }); assert.equal(JSON.stringify(cache), original);
  assert.equal(notificationCache({ ...cache, pages: [{ ...modern, items: [{ ...legacyItem, extra: 'untrusted' }] }] }, modern.principalId), null);
  const old = { ...intent(), body: { action: 'read_object' as const, revisionId: 'P1', horizon, expectedAccessEpoch: 1 } }, oldBytes = JSON.stringify(old);
  const parsed = notificationIntent(old, old.principalId)!; assert.equal(JSON.stringify(parsed), oldBytes); assert.equal(notificationIntentObjectId(parsed), 'P1');
  await verifiedNotificationReceipt({ operationId: eventId, inputSha256: createHash('sha256').update(JSON.stringify(old.body)).digest('hex'), changed: false, accessEpoch: 1 }, parsed);
  assert.equal(notificationIntent({ ...old, objectId: 'P1' }, old.principalId), null);
});
test('task inbox items and read intents use task authority without denying visible revisions', async () => {
  const f = fixture(), oldFetch = fetch;
  try {
    f.client.reconcileAccess({ P1: access(), T1: access('T1', false, false) }, 1, ['S1']);
    const taskPage: NotificationPage = { ...page(), items: [{ ...page().items[0]!, event: { ...page().items[0]!.event, kind: 'task_commented', objectId: 'T1', context: { kind: 'task', taskVersion: 3 } }, object: { id: 'T1', title: 'Task notification', kind: 'task' } }] };
    assert.equal(f.client.writeStored(f.key, { summary: notificationSummary(taskPage), pages: [taskPage] }), true);
    const taskIntent = { id, principalId: f.self, objectId: 'T1', body: { action: 'read_object' as const, objectId: 'T1', horizon, expectedAccessEpoch: 1 } };
    assert.deepEqual(notificationIntent(taskIntent, f.self), taskIntent); assert.equal(canQueue('/api/notifications/read', 'POST', taskIntent.body), false);
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ operationId: eventId, inputSha256: createHash('sha256').update(JSON.stringify(taskIntent.body)).digest('hex'), changed: true, accessEpoch: 1 }); };
    const receipt = await f.client.request('/api/notifications/read', { method: 'POST', body: taskIntent.body, id }, ['T1']); await verifiedNotificationReceipt(receipt, taskIntent); assert.equal(calls, 1);
    f.client.writeStored(f.requestKey, taskIntent); f.client.retireUnavailableObject('T1'); assert.equal(f.client.readStored(f.key, null), null); assert.equal(f.client.draftIsHeld(f.requestKey), true); assert.equal(f.client.unavailableObject('P1'), false);
    assert.equal(notificationIntent({ ...taskIntent, revisionId: 'T1', objectId: undefined }, f.self), null);
  } finally { globalThis.fetch = oldFetch; f.close(); }
});
test('notification retirement is independent of manuscript snapshot generation', () => {
  const f = fixture(); try { const before = f.client.taskSnapshotGeneration(); let notices = 0; f.client.onNotificationChange(() => notices++); f.client.invalidateNotifications(); assert.equal(f.client.taskSnapshotGeneration(), before); assert.equal(f.client.readStored(f.key, null), null); assert.equal(notices, 1); } finally { f.close(); }
});
test('read-only viewers can mark notifications; private event denial never denies source', async () => {
  const f = fixture(), oldFetch = fetch; try { f.client.reconcileAccess({ P1: access('P1', false, false) }, 1, ['S1']); let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ error: 'Unavailable', code: 'NOTIFICATION_UNAVAILABLE' }, { status: 404 }); }; await assert.rejects(f.client.request('/api/notifications/read', { method: 'POST', body: intent().body, id }, ['P1']), error => error instanceof RequestError && error.code === 'NOTIFICATION_UNAVAILABLE'); assert.equal(calls, 1); assert.equal(f.client.unavailableObject('P1'), false); } finally { globalThis.fetch = oldFetch; f.close(); }
});
test('source denial retires inbox and holds distinct durable/quota requests without stale labels', () => {
  const f = fixture(); try { f.client.writeStored(f.requestKey, intent()); f.failWrites(); f.client.writeStored(f.requestKey, { ...intent(), id: eventId, body: { ...intent().body, action: 'unread' } }); f.client.retireUnavailableObject('P1'); assert.equal(f.client.readStored(f.key, null), null); assert.equal(f.client.draftIsHeld(f.requestKey), true); assert.equal(f.client.quarantinedDrafts().filter(item => item.key.startsWith(f.requestKey)).length, 2); } finally { f.close(); }
});
test('already-decoding reads reject epoch and cross-tab retirement', async () => {
  for (const reason of ['epoch', 'tab'] as const) { const f = fixture(), oldFetch = fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined; try { const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return response; }; const pending = f.client.request('/api/notifications'); await new Promise<void>(resolve => setImmediate(resolve)); if (reason === 'epoch') f.client.reconcileAccess({ P1: access() }, 2, ['S1']); else { const event = new Event('storage'); Object.assign(event, { key: f.client.storageKey(f.key), newValue: null }); f.events.dispatchEvent(event); } assert.equal(signal?.aborted, true); release(page()); await assert.rejects(pending, RequestError); } finally { globalThis.fetch = oldFetch; f.close(); } }
});
test('protected inbox and uncertain read changes remain tab-only and reject account replacement', async () => {
  const f = fixture('password'), oldFetch = fetch; let release!: (value: Response) => void; try { f.client.writeStored(f.requestKey, intent(f.self)); assert.equal(f.entries.size, 0); globalThis.fetch = () => new Promise(resolve => { release = resolve; }); const pending = f.client.request('/api/notifications/read', { method: 'POST', body: intent(f.self).body, id }); activateSession({ mode: 'password', workspaceId: 'notifications', account: { id: 'U2', username: 'next', displayName: 'Next', disabled: false }, sessionContext: 'next', csrfToken: 'next', expiresAt: null }); release(Response.json({ accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError); assert.equal(f.session.memory.size, 0); } finally { globalThis.fetch = oldFetch; f.close(); }
});
