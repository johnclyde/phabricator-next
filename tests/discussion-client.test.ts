import test from 'node:test';
import assert from 'node:assert/strict';
import { discussionChoice, discussionPreferences } from '../client/discussion-state.ts';
import { createWorkspaceClient, canQueue, RequestError } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ObjectAccess } from '../shared/policy.ts';
const session = (mode: 'local' | 'password' = 'password', id = 'alice'): SessionState => ({ mode, workspaceId: 'discussion', account: mode === 'local' ? null : { id, username: id, displayName: id, disabled: false }, sessionContext: id, csrfToken: 'csrf', expiresAt: null });
const access: ObjectAccess = { policy: { objectId: 'D1', version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: false, interact: false, managePolicy: false }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' };
const choice = { revisionId: 'D1', threadId: 'thread-1', collapsed: true, expectedVersion: 0, requestId: 'exact-choice', attempted: false };
const preference = { revisionId: 'D1', threadId: 'thread-1', collapsed: false, version: 0, updatedAt: null };
const key = 'discussion-choice:D1:thread-1';
const cache = { revisionId: 'D1', preferences: [preference], accessEpoch: 1 };

test('personal presentation metadata validates exact identities and strips unrelated source', () => {
  assert.deepEqual(discussionChoice({ ...choice, body: 'not stored' }, 'D1', 'thread-1'), choice);
  assert.equal(discussionChoice({ ...choice, expectedVersion: -1 }, 'D1', 'thread-1'), null);
  assert.equal(discussionChoice({ ...choice, collapsed: 'yes' }, 'D1', 'thread-1'), null);
  assert.equal(discussionChoice(choice, 'D2', 'thread-1'), null);
  assert.deepEqual(discussionPreferences({ ...cache, source: 'excluded' }, 'D1'), cache);
  assert.equal(discussionPreferences({ ...cache, preferences: [preference, preference] }, 'D1'), null);
  assert.equal(discussionPreferences({ ...cache, accessEpoch: -1 }, 'D1'), null);
});

test('view-only personal preferences never queue and account switch clears presentation', async () => {
  const previous = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(session())); client.reconcileAccess({ D1: access }, 1);
    assert.equal(await client.writeDiscussionChoice(key, null, choice), 'saved');
    globalThis.fetch = async () => Response.json({ ...preference, collapsed: true, version: 1 });
    await client.request('/api/revisions/D1/threads/thread-1/preference', { method: 'PATCH', body: { collapsed: true, expectedVersion: 0 }, id: choice.requestId });
    assert.equal(canQueue('/api/revisions/D1/threads/thread-1/preference', 'PATCH', choice), false);
    assert.equal(client.draftIsHeld(key), false);
    const next = createWorkspaceClient(activateSession(session('password', 'bob')));
    assert.equal(next.readStored(key, null), null); assert.equal(await client.writeDiscussionChoice(key, choice, { ...choice, collapsed: false }), 'unavailable');
  } finally { globalThis.fetch = previous; lockSession(); }
});

test('source revocation purges personal choices and rejects held reads and writes without quarantining presentation', async () => {
  const previous = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(session())); client.reconcileAccess({ D1: access, R1: access }, 1);
    client.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' } });
    client.writeStored('discussion-preferences:D1', cache); await client.writeDiscussionChoice(key, null, choice);
    let releaseGet!: (value: Response) => void; let releasePatch!: (value: Response) => void;
    globalThis.fetch = async (_path, options) => new Promise(resolve => { if (options?.method === 'PATCH') releasePatch = resolve; else releaseGet = resolve; });
    const pendingGet = client.request('/api/revisions/D1/discussion-preferences');
    const pendingPatch = client.request('/api/revisions/D1/threads/thread-1/preference', { method: 'PATCH', body: { collapsed: true, expectedVersion: 0 }, id: choice.requestId });
    client.reconcileAccess({ D1: access }, 2);
    releaseGet(Response.json(cache)); releasePatch(Response.json({ ...preference, collapsed: true, version: 1 }));
    await assert.rejects(pendingGet, RequestError); await assert.rejects(pendingPatch, RequestError);
    assert.equal(client.readStored(key, null), null); assert.equal(client.readStored('discussion-preferences:D1', null), null); assert.equal(client.quarantinedDrafts().length, 0);
    client.reconcileAccess({ D1: access, R1: access }, 3); assert.equal(client.readStored(key, null), null);
    assert.equal(client.writeStored('discussion-preferences:D1', cache), false);
  } finally { globalThis.fetch = previous; lockSession(); }
});

test('locked choice writes compare both physical copies, preserve other tabs and honor retired callbacks', async () => {
  const previous = globalThis.localStorage; const values = new Map<string, string>(); let fail = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] || null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { if (fail && key.includes('discussion-choice:')) throw new Error('quota'); values.set(key, value); }, removeItem: (key: string) => values.delete(key) } });
  try {
    const client = createWorkspaceClient(activateSession(session('local'))); client.reconcileAccess({ D1: access }, 1);
    assert.equal(await client.writeDiscussionChoice(key, null, choice), 'saved');
    const attempted = { ...choice, attempted: true }; assert.equal(await client.writeDiscussionChoice(key, choice, attempted), 'saved');
    assert.equal(await client.writeDiscussionChoice(key, choice, { ...choice, collapsed: false }), 'changed');
    assert.deepEqual(client.readStored(key, null), attempted);
    client.removeStored(key); fail = true; assert.equal(await client.writeDiscussionChoice(key, null, choice), 'memory'); fail = false;
    const other = { ...choice, requestId: 'other-tab', collapsed: false }; values.set(client.storageKey(key), JSON.stringify(other));
    assert.equal(await client.writeDiscussionChoice(key, choice, attempted), 'changed');
    assert.deepEqual(JSON.parse(values.get(client.storageKey(key))!), other); assert.equal(client.draftRecords().length, 1);
    assert.equal(await client.writeDiscussionChoice(key, choice, attempted, () => false), 'unavailable');
    client.removeStoredIfEqual(key, choice); assert.deepEqual(client.readStored(key, null), other);
  } finally { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous }); lockSession(); }
});
