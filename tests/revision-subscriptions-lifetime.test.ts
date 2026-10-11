import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import { prepareSubscriptionDraft } from '../client/revision-subscriptions.ts';
import { access, person, reading as example } from './revision-subscriptions-client-fixture.ts';
const path = '/api/revisions/P1/subscriptions', key = 'revision-subscriptions:P1', draftKey = 'revision-subscription-draft:P1', requestKey = 'revision-subscription-request:P1', requestId = '61eb8a98-0397-49d3-bf10-cf67fffcf83b';
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window'), entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const self = mode === 'password' ? 'U1' : 'local:subscriptions', session = activateSession({ mode, workspaceId: 'subscriptions', account: mode === 'password' ? { id: self, username: 'reader', displayName: 'Reader', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session), reading = { ...example, snapshot: { ...example.snapshot, viewer: person(self), mute: { ...example.snapshot.mute, principalId: self } }, muteHistory: { ...example.muteHistory, principalId: self } };
  client.reconcileAccess({ P1: access(), F1: access('F1'), R1: access('R1') }, 1, ['S1']); assert.equal(client.writeStored(key, reading), true);
  return { client, session, self, reading, entries, events, failWrites() { quota = true; }, removeElsewhere() { const storageKey = client.storageKey(key); entries.delete(storageKey); const event = new Event('storage'); Object.assign(event, { key: storageKey, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}
test('self following and mute remain writable with View alone; others follow action-specific authority and never queue', async () => {
  const f = fixture('password'), previous = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ accessEpoch: 1 }); };
    const self = prepareSubscriptionDraft(f.reading.snapshot, 'mute').input, add = prepareSubscriptionDraft(f.reading.snapshot, 'subscribe', person('U2')).input, remove = prepareSubscriptionDraft(f.reading.snapshot, 'unsubscribe', person('U2')).input;
    f.client.reconcileAccess({ P1: access('P1', false, false) }, 1, ['S1']);
    await f.client.request(path, { method: 'POST', body: self, id: requestId }); assert.equal(calls, 1);
    for (const input of [add, remove]) await assert.rejects(f.client.request(path, { method: 'POST', body: input, id: requestId }), /Permission/);
    f.client.reconcileAccess({ P1: access('P1', false, true) }, 1, ['S1']); await f.client.request(path, { method: 'POST', body: add, id: requestId }); await assert.rejects(f.client.request(path, { method: 'POST', body: remove, id: requestId }), /Permission/);
    f.client.reconcileAccess({ P1: access('P1', true, false) }, 1, ['S1']); await f.client.request(path, { method: 'POST', body: add, id: requestId }); await f.client.request(path, { method: 'POST', body: remove, id: requestId }); assert.equal(calls, 4);
    assert.equal(canQueue(path, 'POST', self), false); await assert.rejects(f.client.request(path, { method: 'POST', body: self, id: requestId, queued: true }), /explicit online/); assert.equal(f.entries.size, 0);
  } finally { globalThis.fetch = previous; f.close(); }
});
test('self drafts survive Edit and Interact loss, while add/remove holds preserve distinct durable and quota copies', () => {
  for (const action of ['subscribe', 'unsubscribe', 'mute'] as const) {
    const f = fixture();
    try {
      const draft = prepareSubscriptionDraft(f.reading.snapshot, action, action === 'mute' ? undefined : person('U2')), intent = { id: requestId, revisionId: 'P1', body: draft.input, draft };
      f.client.writeStored(draftKey, draft); f.client.writeStored(requestKey, intent); f.failWrites(); const newer = prepareSubscriptionDraft(f.reading.snapshot, action === 'mute' ? 'unmute' : action, person('U3')); f.client.writeStored(draftKey, newer);
      f.client.reconcileAccess({ P1: access('P1', false, false) }, 2, ['S1']);
      if (action === 'mute') { assert.equal(f.client.draftIsHeld(draftKey), false); assert.deepEqual(f.client.readStored(draftKey, null), newer); }
      else { const held = f.client.quarantinedDrafts(); assert.deepEqual(held.find(item => item.key === requestKey)?.value, intent); assert.equal(held.filter(item => item.key.startsWith(draftKey)).length, 2); }
      assert.equal(f.client.unavailableObject('P1'), false);
    } finally { f.close(); }
  }
});
test('decoding public and private following reads retire with source, epoch and cross-tab changes', async () => {
  for (const cause of ['epoch', 'file', 'repository', 'tab'] as const) {
    const f = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      f.client.writeStored('revision:P1', { revision: { id: 'P1', repositoryId: 'R1' }, versions: [{ assets: [{ fileId: 'F1' }] }] });
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return response; };
      const pending = f.client.request(path + '/mute-history'); await new Promise<void>(resolve => setImmediate(resolve));
      if (cause === 'epoch') f.client.reconcileAccess({ P1: access() }, 2, ['S1']); else if (cause === 'tab') f.removeElsewhere(); else f.client.retireUnavailableObject(cause === 'file' ? 'F1' : 'R1');
      assert.equal(signal?.aborted, true); release(f.reading.muteHistory); await assert.rejects(pending, RequestError); assert.equal(f.client.readStored(key, null), null);
    } finally { globalThis.fetch = previous; f.close(); }
  }
});
test('private preferences reject another viewer, source denial holds self requests, and conditional cleanup keeps a newer draft', () => {
  const f = fixture();
  try {
    assert.equal(f.client.writeStored(key, example), false);
    const draft = prepareSubscriptionDraft(f.reading.snapshot, 'subscribe'), newer = prepareSubscriptionDraft(f.reading.snapshot, 'mute'), intent = { id: requestId, revisionId: 'P1', body: draft.input, draft };
    f.client.writeStored(draftKey, newer); f.client.writeStored(requestKey, intent); f.client.removeStoredIfEqual(requestKey, intent); f.client.removeStoredIfEqual(draftKey, draft); assert.deepEqual(f.client.readStored(draftKey, null), newer);
    f.client.writeStored(requestKey, intent); f.client.reconcileAccess({}, 2, ['S1']); assert.equal(f.client.readStored(key, null), null); assert.equal(f.client.draftIsHeld(draftKey), true); assert.equal(f.client.draftIsHeld(requestKey), true);
  } finally { f.close(); }
});
test('password session replacement rejects pending preference saves and clears tab-only private history', async () => {
  const f = fixture('password'), previous = globalThis.fetch; let release!: (value: Response) => void;
  try {
    const draft = prepareSubscriptionDraft(f.reading.snapshot, 'mute'); f.client.writeStored(draftKey, draft); globalThis.fetch = () => new Promise(resolve => { release = resolve; }); const pending = f.client.request(path, { method: 'POST', body: draft.input, id: requestId });
    activateSession({ mode: 'password', workspaceId: 'subscriptions', account: { id: 'U2', username: 'next', displayName: 'Next', disabled: false }, sessionContext: 'new', csrfToken: 'new', expiresAt: null }); release(Response.json({ accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError); assert.equal(f.entries.size, 0); assert.equal(f.session.memory.size, 0);
  } finally { globalThis.fetch = previous; f.close(); }
});
