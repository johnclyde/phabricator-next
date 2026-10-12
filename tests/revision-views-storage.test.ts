import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, retainedDraftLockName } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import { builtinRevisionView } from '../client/revision-view-model.ts';

const stateKey = 'revision-view-state:paper', requestKey = 'revision-view-request';
const filters = { kind: 'paper', query: 'Exact manuscript query', status: 'all', projectId: 'PROJ1', following: false, authored: true };
const draft = { name: 'Literature review', filters };
const intent = { id: 'exact-request', path: '/api/revision-views/RV1', method: 'PUT', body: { expectedVersion: 2, expectedAccessEpoch: 1, ...draft } };
function fixture(password = false) {
  const previous = Object.fromEntries(['localStorage', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values = new Map<string, string>(); let failWrites = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (failWrites) throw new Error('Quota exceeded'); values.set(key, value); }, removeItem: (key: string) => values.delete(key) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, work: () => unknown) => work() } } });
  const session = activateSession({ mode: password ? 'password' : 'local', workspaceId: 'revision-views', account: password ? { id: 'U1', username: 'alice', displayName: 'Alice', disabled: false } : null, sessionContext: password ? 'session-one' : null, csrfToken: password ? 'csrf-one' : null, expiresAt: null });
  const client = createWorkspaceClient(session);
  return { client, session, values, fail: () => { failWrites = true; }, close: () => { lockSession(); for (const [key, desc] of Object.entries(previous)) { if (desc) Object.defineProperty(globalThis, key, desc); else Reflect.deleteProperty(globalThis, key); } } };
}

test('saved-view drafts use exact writer/cleanup locks and preserve another tab’s newer bytes', async () => {
  const f = fixture(); try {
    for (const key of [stateKey, requestKey]) assert.equal(retainedDraftLockName(key), `file-intent:${key}`);
    assert.equal(retainedDraftLockName('revision-views-cache'), null);
    assert.equal(await f.client.retainDraft(stateKey, draft, null), 'saved');
    const newer = { ...draft, name: 'Another tab' }; f.values.set(f.client.storageKey(stateKey), JSON.stringify(newer));
    assert.deepEqual(createWorkspaceClient(f.session).readStored(stateKey, null), draft);
    assert.equal(f.client.draftHasUnsavedMemory(stateKey), true);
    assert.ok(f.client.draftRecords().some(row => row.key === stateKey + ':unsaved-memory'));
    assert.equal(await f.client.removeRetainedDraftIfEqual(stateKey, draft), true);
    assert.deepEqual(JSON.parse(f.values.get(f.client.storageKey(stateKey))!), newer);
    for (const [path, method] of [['/api/revision-views', 'POST'], ['/api/revision-views/RV1', 'PUT'], ['/api/revision-views/RV1/delete', 'POST']] as const) assert.equal(canQueue(path, method, intent.body), false);
  } finally { f.close(); }
});

test('quota-failed saved-view filters and exact requests remain exportable, including after project loss', async () => {
  const f = fixture(); try {
    f.fail();
    assert.equal(await f.client.retainDraft(stateKey, draft, null), 'memory');
    assert.equal(await f.client.retainDraft(requestKey, intent, null), 'memory');
    f.client.retireUnavailableObject('PROJ1');
    assert.deepEqual(f.client.readStored(stateKey, null), draft);
    assert.deepEqual(f.client.readStored(requestKey, null), intent);
    assert.equal(f.client.quarantinedDrafts().length, 0, 'a personal filter remains owned even if its referenced project is unavailable');
    assert.deepEqual(f.client.draftRecords().map(row => row.key).sort(), [requestKey + ':unsaved-memory', stateKey + ':unsaved-memory'].sort());
  } finally { f.close(); }
});

test('authenticated view inventory, filter drafts and pending requests stay in memory and clear on account replacement', async () => {
  const f = fixture(true); try {
    assert.equal(await f.client.retainDraft(stateKey, builtinRevisionView('paper', 'following'), null), 'saved');
    assert.deepEqual(f.client.draftRecords(), [], 'merely opening a built-in view is not unsaved authored work');
    assert.equal(await f.client.removeRetainedDraftIfEqual(stateKey, builtinRevisionView('paper', 'following')), true);
    assert.equal(await f.client.retainDraft(stateKey, draft, null), 'saved');
    assert.equal(await f.client.retainDraft(requestKey, intent, null), 'saved');
    assert.equal(f.client.writeStored('revision-views-cache', { views: [], accessEpoch: 1 }), true);
    assert.equal([...f.values.keys()].some(key => key.includes('revision-view')), false);
    assert.deepEqual(f.client.draftRecords().map(row => row.key).sort(), [requestKey, stateKey].sort());
    const other = createWorkspaceClient(activateSession({ ...f.session.state, account: { id: 'U2', username: 'bob', displayName: 'Bob', disabled: false }, sessionContext: 'session-two' }));
    assert.equal(f.session.memory.size, 0);
    for (const key of [stateKey, requestKey, 'revision-views-cache']) { assert.equal(f.client.readStored(key, null), null); assert.equal(other.readStored(key, null), null); }
    assert.equal(await f.client.retainDraft(requestKey, intent, null), 'unavailable');
  } finally { f.close(); }
});
