import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, RequestError, type PendingMutation } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const identity = (name = 'alice'): SessionState => ({ mode: 'password', workspaceId: 'policy-test', account: { id: name, username: name, displayName: name, disabled: false }, sessionContext: `context-${name}`, csrfToken: `csrf-${name}`, expiresAt: null });
const access = (id: string, edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace members', editLabel: 'Workspace members', interactLabel: 'Workspace members' });
const withCode = (code: string) => (error: unknown) => error instanceof RequestError && error.code === code;

test('known view revocation quarantines only affected drafts and rejects a late successful response even after access returns', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ W1: access('W1'), W2: access('W2') }, 1);
    client.writeStored('wiki:W1', { content: 'Private server snapshot' });
    client.writeStored('wiki:W1:version:1', { content: 'Private historical version' });
    client.writeStored('draft:document:W1:v1', { content: 'Unsaved work worth keeping' });
    client.writeStored('draft:document:W2:v1', { content: 'Other work' });
    let release!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_path, options) => { signal = options?.signal; return await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/documents/W1');
    client.reconcileAccess({ W2: access('W2') }, 2);
    assert.equal(signal?.aborted, true);
    assert.equal(client.readStored('wiki:W1', null), null);
    assert.equal(client.readStored('wiki:W1:version:1', null), null);
    assert.deepEqual(client.readStored('draft:document:W2:v1', null), { content: 'Other work' });
    assert.deepEqual(client.quarantinedDrafts().map(draft => draft.value), [{ content: 'Unsaved work worth keeping' }]);
    assert.equal(client.writeStored('wiki:W1', { content: 'Late cache write' }), false);
    client.reconcileAccess({ W1: access('W1'), W2: access('W2') }, 3);
    release(Response.json({ content: 'Obsolete response', accessEpoch: 1 }));
    await assert.rejects(pending, withCode('OBJECT_UNAVAILABLE'));
    assert.equal(client.readStored('wiki:W1', null), null);
    assert.equal(client.readStored('draft:document:W1:v1', null), null, 'restoring access must not resubmit or restore quarantined edits');
    assert.equal(client.quarantinedDrafts().length, 1);
    await client.discardQuarantinedDraft('draft:document:W1:v1');
    assert.equal(client.quarantinedDrafts().length, 0);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('a state response started before an explicit denial cannot resurrect a revoked object at the same epoch', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ W1: access('W1') }, 5);
    let release!: (response: Response) => void;
    globalThis.fetch = async path => String(path).endsWith('/state') ? await new Promise<Response>(resolve => { release = resolve; }) : Response.json({ error: 'Unavailable', code: 'OBJECT_UNAVAILABLE' }, { status: 404 });
    const state = client.request('/api/state');
    await assert.rejects(client.request('/api/documents/W1'), withCode('OBJECT_UNAVAILABLE'));
    release(Response.json({ accessEpoch: 5, access: { W1: access('W1') }, documents: [{ content: 'Stale private content' }] }));
    await assert.rejects(state, withCode('ACCESS_CHANGED'));
    assert.equal(client.unavailableObject('W1'), true);
    assert.equal(client.writeStored('wiki:W1', { content: 'Stale private content' }), false);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('edit and interaction revocation preserve readable snapshots and unrelated drafts without creating empty comment drafts', async () => {
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ D1: access('D1'), W1: access('W1') }, 1);
    client.writeStored('revision:D1', { files: ['Readable source'] });
    client.writeStored('version-draft:D1:1', { files: ['Unsaved source'] });
    client.writeStored('comment-source:D1:V1', { body: 'Unsaved comment' });
    client.writeStored('comment-source:D1:V0', { body: '' });
    client.writeStored('draft:document:W1:v1', { content: 'Unrelated wiki work' });
    client.reconcileAccess({ D1: access('D1', false, true), W1: access('W1') }, 2);
    assert.deepEqual(client.readStored('revision:D1', null), { files: ['Readable source'] });
    assert.deepEqual(client.readStored('comment-source:D1:V1', null), { body: 'Unsaved comment' });
    assert.equal(client.quarantinedDrafts().length, 1);
    client.reconcileAccess({ D1: access('D1', false, false), W1: access('W1') }, 3);
    assert.equal(client.quarantinedDrafts().length, 2);
    await assert.rejects(client.request('/api/revisions/D1/comments', { method: 'POST', body: { body: 'Automatic replay must not reach fetch' } }), withCode('ACTION_FORBIDDEN'));
    await assert.rejects(client.request('/api/revisions/D1/versions', { method: 'POST', body: { files: [] } }), withCode('ACTION_FORBIDDEN'));
    assert.equal(client.writeStored('comment-source:D1:V0', { body: '' }), true);
    assert.equal(client.quarantinedDrafts().length, 2);
    client.writeStored('version-draft:D1:1', { files: ['Late draft callback'] });
    assert.deepEqual(client.quarantinedDrafts().find(draft => draft.key.startsWith('version-draft:'))?.value, { files: ['Late draft callback'] });
    assert.deepEqual(client.readStored('draft:document:W1:v1', null), { content: 'Unrelated wiki work' });
    const otherAccount = createWorkspaceClient(activateSession(identity('bob')));
    assert.equal(client.quarantinedDrafts().length, 0);
    assert.equal(otherAccount.quarantinedDrafts().length, 0);
    assert.equal(otherAccount.readStored('revision:D1', null), null);
  } finally { lockSession(); }
});

test('local cache reconciliation removes formerly visible snapshots on a fresh session and takes revoked outbox items out of automatic replay', async () => {
  const stored = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null, getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
  const local = (): SessionState => ({ mode: 'local', workspaceId: 'policy-local-test', account: null, sessionContext: null, csrfToken: null, expiresAt: null });
  try {
    const first = createWorkspaceClient(activateSession(local()));
    first.writeStored('state', { access: { W1: access('W1'), T1: access('T1'), T2: access('T2') }, spaces: [{ id: 'S1' }] });
    first.writeStored('wiki:W1:version:1', { content: 'Previously readable' });
    first.writeStored('draft:document:W1:v1', { content: 'Previously saved draft' });
    const item = (id: string): PendingMutation => ({ id, path: `/api/tasks/${id}`, method: 'PATCH', body: { status: 'resolved' }, label: id, createdAt: '2026-10-10' });
    first.writeStored('outbox', [item('T1'), item('T2')]);
    const reopened = createWorkspaceClient(activateSession(local()));
    reopened.reconcileAccess({ T1: access('T1', false), T2: access('T2') }, 2, ['S1']);
    assert.equal(reopened.readStored('wiki:W1:version:1', null), null);
    assert.equal(stored.has(reopened.storageKey('wiki:W1:version:1')), false);
    assert.deepEqual(reopened.readStored<PendingMutation[]>('outbox', []).map(entry => entry.id), ['T2']);
    assert.deepEqual(new Set(reopened.quarantinedDrafts().map(draft => draft.objectId)), new Set(['W1', 'T1']));
    reopened.reconcileAccess({}, 3);
    assert.deepEqual(reopened.readStored('outbox', []), []);
    reopened.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 4, ['S1']);
    assert.equal(reopened.unavailableObject('S1'), false, 'visible Spaces recover independently of entity access entries');
    assert.deepEqual(reopened.readStored('outbox', []), []);
    const again = createWorkspaceClient(activateSession(local()));
    assert.equal(again.quarantinedDrafts().length, 3, 'local recovery copies survive a verified local session reopening');
    assert.equal(again.quarantinedDrafts().length, 3, 'reading copies for export never discards them');
    assert.deepEqual(again.readStored('outbox', []), []);
    await again.discardQuarantinedDraft('outbox:T1');
    const afterDiscard = createWorkspaceClient(activateSession(local()));
    assert.deepEqual(new Set(afterDiscard.quarantinedDrafts().map(draft => draft.objectId)), new Set(['W1', 'T2']));
    const protectedClient = createWorkspaceClient(activateSession(identity()));
    assert.equal(protectedClient.quarantinedDrafts().length, 0, 'password sessions never load local durable recovery copies');
  } finally { lockSession(); if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('an unavailable historical version does not revoke the readable current object', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ W1: access('W1') }, 1);
    client.writeStored('wiki:W1', { content: 'Current readable version' });
    globalThis.fetch = async () => Response.json({ error: 'Version not found' }, { status: 404 });
    await assert.rejects(client.request('/api/documents/W1/versions/100'), (error: unknown) => error instanceof RequestError && error.status === 404);
    assert.equal(client.unavailableObject('W1'), false);
    assert.deepEqual(client.readStored('wiki:W1', null), { content: 'Current readable version' });
  } finally { lockSession(); globalThis.fetch = fetch; }
});

function localStorageFixture() {
  const stored = new Map<string, string>();
  let rejectWrites = false;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return stored.size; }, key: (index: number) => [...stored.keys()][index] ?? null, getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { if (rejectWrites) throw new Error('Quota exceeded'); stored.set(key, value); }, removeItem: (key: string) => stored.delete(key) } });
  const state: SessionState = { mode: 'local', workspaceId: 'quarantine-test', account: null, sessionContext: null, csrfToken: null, expiresAt: null };
  return { stored, reopen: () => createWorkspaceClient(activateSession(state)), failWrites: (value: boolean) => { rejectWrites = value; }, close: () => { lockSession(); if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); } };
}
const queuedTask = (id: string): PendingMutation => ({ id, path: `/api/tasks/${id}`, method: 'PATCH', body: { status: 'resolved' }, label: id, createdAt: '2026-10-10' });

test('quota failures retain original bytes and durably hold them through reload and permission restoration until explicit recovery', async () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen();
    client.reconcileAccess({ W1: access('W1'), T1: access('T1') }, 1, ['S1']);
    client.writeStored('draft:document:W1:v1', { content: 'Keep every unsaved word' });
    client.writeStored('outbox', [queuedTask('T1')]);
    const originalDraft = storage.stored.get(client.storageKey('draft:document:W1:v1'));
    const originalQueue = storage.stored.get(client.storageKey('outbox'));
    storage.failWrites(true);
    client.reconcileAccess({}, 2, ['S1']);
    assert.equal(storage.stored.get(client.storageKey('draft:document:W1:v1')), originalDraft);
    assert.equal(storage.stored.get(client.storageKey('outbox')), originalQueue);
    assert.match(client.quarantineWarning(), /Export the drafts now/);
    assert.deepEqual(client.readStored('outbox', []), []);
    const reopened = storage.reopen();
    assert.equal(reopened.quarantinedDrafts().length, 2);
    reopened.reconcileAccess({ W1: access('W1'), T1: access('T1') }, 3, ['S1']);
    assert.equal(reopened.readStored('draft:document:W1:v1', null), null);
    assert.deepEqual(reopened.readStored('outbox', []), []);
    await assert.rejects(reopened.request('/api/tasks/T1', { method: 'PATCH', body: {}, id: 'T1', queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(storage.stored.get(client.storageKey('draft:document:W1:v1')), originalDraft);
    storage.failWrites(false);
    assert.equal(reopened.retryQuarantineStorage(), true);
    assert.equal(reopened.quarantineWarning(), '');
    const recovered = storage.reopen();
    assert.equal(recovered.quarantinedDrafts().length, 2);
    await recovered.discardQuarantinedDraft('outbox:T1');
    const last = storage.reopen();
    assert.deepEqual(last.quarantinedDrafts().map(draft => draft.value), [{ content: 'Keep every unsaved word' }]);
    assert.deepEqual(last.readStored('outbox', []), []);
  } finally { storage.close(); }
});

test('cross-tab durable holds and explicit discard stop a previously captured replay even after grants return', async () => {
  const storage = localStorageFixture(); const fetch = globalThis.fetch;
  try {
    const client = storage.reopen(); client.reconcileAccess({ T1: access('T1') }, 1, ['S1']);
    const item = queuedTask('T1'); client.writeStored('outbox', [item]);
    const stale = client.readStored<PendingMutation[]>('outbox', [])[0]!;
    // Another tab writes a separate recovery record before removing the active item.
    const record = client.storageKey(`quarantined-drafts:${encodeURIComponent('outbox:T1')}`);
    storage.stored.set(record, JSON.stringify({ key: 'outbox:T1', objectId: 'T1', value: item, reason: 'Revoked in another tab' }));
    storage.stored.set(client.storageKey('outbox'), '[]');
    let sent = 0; globalThis.fetch = async () => { sent++; return Response.json({}); };
    await assert.rejects(client.request(stale.path, { method: stale.method, body: stale.body, id: stale.id, queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(client.quarantinedDrafts().length, 1);
    // Explicit discard in the other tab must not reauthorize the stale replay id.
    storage.stored.delete(record);
    client.reconcileAccess({ T1: access('T1') }, 2, ['S1']);
    assert.equal(client.quarantinedDrafts().length, 0);
    await assert.rejects(client.request(stale.path, { method: stale.method, body: stale.body, id: stale.id, queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(sent, 0);
  } finally { globalThis.fetch = fetch; storage.close(); }
});

test('queued creations are quarantined when their chosen Space disappears or is archived and never replay after restoration', async () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({}, 1, ['S1', 'S2']);
    const create = (id: string, spaceId: string): PendingMutation => ({ id, path: '/api/tasks', method: 'POST', body: { title: id, access: { spaceId } }, label: id, createdAt: '2026-10-10' });
    client.writeStored('outbox', [create('first', 'S2'), create('second', 'S1')]);
    client.reconcileAccess({}, 2, ['S1']);
    assert.deepEqual(client.readStored<PendingMutation[]>('outbox', []).map(item => item.id), ['second']);
    assert.equal(client.quarantinedDrafts()[0]?.objectId, 'S2');
    client.reconcileAccess({}, 3, ['S1', 'S2'], ['S1']);
    assert.deepEqual(client.readStored('outbox', []), []);
    client.reconcileAccess({}, 4, ['S1', 'S2']);
    assert.deepEqual(client.readStored('outbox', []), []);
    assert.equal(storage.reopen().quarantinedDrafts().length, 2);
  } finally { storage.close(); }
});


test('retrying recovery first captures originals held by another tab before restoring the ready marker', () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen();
    client.writeStored('draft:document:W1:v1', { content: 'Another tab needs this copy' });
    client.writeStored('outbox', [queuedTask('T1')]);
    // Another tab has encountered quota failure; this tab has not received its event.
    storage.stored.delete(client.storageKey('quarantine-ready'));
    assert.equal(client.retryQuarantineStorage(), true);
    const reopened = storage.reopen();
    assert.equal(reopened.quarantinedDrafts().length, 2);
    assert.equal(reopened.readStored('draft:document:W1:v1', null), null);
    assert.deepEqual(reopened.readStored('outbox', []), []);
  } finally { storage.close(); }
});

test('initializing recovery guards on an existing local workspace leaves unrelated saved work available', () => {
  const storage = localStorageFixture();
  try {
    storage.stored.set('phabricator-next:local-storage-workspace', 'quarantine-test');
    storage.stored.set('phabricator-next:draft:document:W1:v1', JSON.stringify({ content: 'Existing offline work' }));
    storage.stored.set('phabricator-next:outbox', JSON.stringify([queuedTask('T1')]));
    const client = storage.reopen();
    assert.equal(client.quarantinedDrafts().length, 0);
    assert.deepEqual(client.readStored('draft:document:W1:v1', null), { content: 'Existing offline work' });
    assert.equal(client.readStored<PendingMutation[]>('outbox', []).length, 1);
  } finally { storage.close(); }
});


test('discard shares the outbox lock and rereads a concurrently queued unrelated change; reconciliation never rewrites the queue', async () => {
  const storage = localStorageFixture();
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let unlock!: () => void;
  const locks: string[] = [];
  const waiting = new Promise<void>(resolve => { unlock = resolve; });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name: string, commit: () => void) => { locks.push(name); await waiting; commit(); } } } });
  try {
    const client = storage.reopen();
    client.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 1, ['S1']);
    client.writeStored('outbox', [queuedTask('T1')]);
    const before = storage.stored.get(client.storageKey('outbox'));
    client.reconcileAccess({ T2: access('T2') }, 2, ['S1']);
    assert.equal(storage.stored.get(client.storageKey('outbox')), before, 'quarantine leaves the shared aggregate untouched');
    assert.deepEqual(client.readStored('outbox', []), []);
    const discard = client.discardQuarantinedDraft('outbox:T1');
    assert.deepEqual(locks, [client.storageKey('outbox-write')]);
    // A normal queue writer finishes before the discard acquires its shared lock.
    storage.stored.set(client.storageKey('outbox'), JSON.stringify([queuedTask('T1'), queuedTask('T2')]));
    unlock(); await discard;
    assert.deepEqual(client.readStored<PendingMutation[]>('outbox', []).map(item => item.id), ['T2']);
    assert.equal(client.quarantinedDrafts().length, 0);
    assert.deepEqual(JSON.parse(storage.stored.get(client.storageKey('outbox')) || '[]').map((item: PendingMutation) => item.id), ['T2']);
  } finally { if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator'); storage.close(); }
});
