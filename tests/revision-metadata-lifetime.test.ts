import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import { prepareMetadataDraft, type MetadataReading } from '../client/revision-metadata.ts';
import { snapshot as example, history } from './revision-metadata-client-fixture.ts';
const path = '/api/revisions/P1/metadata', key = 'revision-metadata:P1', draftKey = 'revision-metadata-draft:P1', requestKey = 'revision-metadata-request:P1';
const input = { ...prepareMetadataDraft(example), title: 'Edited title', message: 'Exact edit' };
const intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'P1', body: input, draft: input };
const access = (id: string, edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const snapshot = { ...example, access: access('P1') };
const reading: MetadataReading = { snapshot, history };
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const session = activateSession({ mode, workspaceId: 'revision-metadata', account: mode === 'password' ? { id: 'U1', username: 'author', displayName: 'Author', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session); client.reconcileAccess({ P1: access('P1'), F1: access('F1'), R1: access('R1') }, 1, ['S1']); assert.equal(client.writeStored(key, reading), true);
  return { client, session, entries, events, failWrites() { quota = true; }, removeElsewhere() { const storageKey = client.storageKey(key); entries.delete(storageKey); const event = new Event('storage'); Object.assign(event, { key: storageKey, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}
test('metadata reads require view while writes and exact retries require edit, with no offline replay', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let calls = 0;
  try {
    current.client.reconcileAccess({ P1: access('P1', false, true) }, 1, ['S1']); globalThis.fetch = async () => { calls++; return Response.json(snapshot); };
    assert.deepEqual(await current.client.request(path), snapshot); assert.equal(canQueue(path, 'POST', input), false);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id, queued: true }), /explicit online save/);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id }), /Permission/); assert.equal(calls, 1);
    current.client.reconcileAccess({ P1: access('P1', true, false) }, 1, ['S1']); await current.client.request(path, { method: 'POST', body: input, id: intent.id }); assert.equal(calls, 2); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
test('metadata and history already decoding cannot return after epoch, source or cross-tab retirement', async () => {
  for (const cause of ['epoch', 'file', 'repository', 'tab'] as const) {
    const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      current.client.writeStored('revision:P1', { revision: { id: 'P1', repositoryId: 'R1' }, versions: [{ assets: [{ fileId: 'F1' }] }, { assets: [] }] });
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return response; };
      const pending = current.client.request(path + '/history'); await new Promise<void>(resolve => setImmediate(resolve));
      if (cause === 'epoch') current.client.reconcileAccess({ P1: access('P1') }, 2, ['S1']); else if (cause === 'tab') current.removeElsewhere(); else current.client.retireUnavailableObject(cause === 'file' ? 'F1' : 'R1');
      assert.equal(signal?.aborted, true); release(history); await assert.rejects(pending, RequestError); assert.equal(current.client.readStored(key, null), null);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});
test('edit loss holds exact requests plus durable and incomplete quota drafts without denying readable source', () => {
  const current = fixture();
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent); current.failWrites(); const newer = { ...input, title: '', message: 'Newer incomplete work' }; assert.equal(current.client.writeStored(draftKey, newer), false);
    current.client.reconcileAccess({ P1: access('P1', false, true) }, 2, ['S1']);
    const held = current.client.quarantinedDrafts(); assert.deepEqual(held.find(item => item.key === requestKey)?.value, intent); assert.equal(held.filter(item => item.key.startsWith(draftKey)).length, 2); assert.ok(held.some(item => JSON.stringify(item.value) === JSON.stringify(newer)));
    assert.equal(current.client.unavailableObject('P1'), false); current.client.reconcileAccess({ P1: access('P1') }, 3, ['S1']); assert.equal(current.client.draftIsHeld(requestKey), true);
  } finally { current.close(); }
});
test('metadata receipt cleanup preserves newer drafts and mixed or old-epoch caches fail closed', () => {
  const current = fixture();
  try {
    const newer = { ...input, testPlan: 'Newer plan' }; current.client.writeStored(requestKey, intent); current.client.writeStored(draftKey, newer);
    current.client.removeStoredIfEqual(requestKey, intent); current.client.removeStoredIfEqual(draftKey, input); assert.deepEqual(current.client.readStored(draftKey, null), newer);
    assert.equal(current.client.writeStored(key, { snapshot, history: { ...history, metadataVersion: 1 } }), false);
    current.client.reconcileAccess({ P1: access('P1') }, 2, ['S1']); assert.equal(current.client.writeStored(key, reading), false);
  } finally { current.close(); }
});
test('password replacement retires pending metadata saves and never persists their text', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (value: Response) => void;
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent); globalThis.fetch = () => new Promise(resolve => { release = resolve; });
    const pending = current.client.request(path, { method: 'POST', body: input, id: intent.id }); activateSession({ mode: 'password', workspaceId: 'revision-metadata', account: { id: 'U2', username: 'next', displayName: 'Next', disabled: false }, sessionContext: 'new', csrfToken: 'new', expiresAt: null });
    release(Response.json({ accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError); assert.equal(current.entries.size, 0); assert.equal(current.session.memory.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
