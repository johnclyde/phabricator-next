import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, RequestError, type PendingMutation } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { SessionState } from '../shared/auth.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const identity = (name = 'alice'): SessionState => ({ mode: 'password', workspaceId: 'policy-test', account: { id: name, username: name, displayName: name, disabled: false }, sessionContext: `context-${name}`, csrfToken: `csrf-${name}`, expiresAt: null });
const access = (id: string, edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace members', editLabel: 'Workspace members', interactLabel: 'Workspace members' });
const withCode = (code: string) => (error: unknown) => error instanceof RequestError && error.code === code;

test('task writes verify initial access once before dispatch and retain guards for later epoch changes', async () => {
  const fetch = globalThis.fetch;
  try {
    const session = activateSession(identity()); const client = createWorkspaceClient(session);
    client.writeStored('state', { accessEpoch: 7, access: { T1: access('T1'), T2: access('T2') } });
    let releaseState!: (response: Response) => void;
    const writes: { body: string; release: (response: Response) => void }[] = [];
    let reads = 0;
    globalThis.fetch = async (path, options) => {
      if (String(path).endsWith('/state')) { reads++; return await new Promise<Response>(resolve => { releaseState = resolve; }); }
      return await new Promise<Response>(resolve => { writes.push({ body: String(options?.body), release: resolve }); });
    };
    const first = client.request('/api/tasks/T1', { method: 'PATCH', body: { status: 'resolved', expectedVersion: 1 } });
    const second = client.request('/api/tasks/T2/projects', { method: 'POST', body: { action: 'add', projectIds: ['PROJ1'], expectedVersion: 4 } });
    assert.equal(reads, 1, 'concurrent startup writes share permission verification');
    assert.equal(writes.length, 0, 'cached permissions alone cannot send a task write');
    releaseState(Response.json({ accessEpoch: 7, access: { T1: access('T1'), T2: access('T2') } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(writes.length, 2);
    assert.deepEqual(JSON.parse(writes[0]!.body), { status: 'resolved', expectedVersion: 1 });
    assert.deepEqual(JSON.parse(writes[1]!.body), { action: 'add', projectIds: ['PROJ1'], expectedVersion: 4 });
    client.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 7);
    writes[0]!.release(Response.json({ id: 'T1', status: 'resolved', version: 2 }));
    assert.deepEqual(await first, { id: 'T1', status: 'resolved', version: 2 });
    client.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 8);
    writes[1]!.release(Response.json({ task: { id: 'T2', projectIds: ['PROJ1'] }, accessEpoch: 7 }));
    await assert.rejects(second, withCode('ACCESS_CHANGED'));
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('initial task verification cannot send a newly quarantined queued change', async () => {
  const storage = localStorageFixture(); const fetch = globalThis.fetch;
  try {
    const client = storage.reopen();
    const item = queuedTask('T1'); client.writeStored('outbox', [item]);
    let calls = 0;
    globalThis.fetch = async path => { calls++; assert.ok(String(path).endsWith('/state')); return Response.json({ accessEpoch: 1, access: { T1: access('T1', false) } }); };
    await assert.rejects(client.request(item.path, { method: item.method, body: item.body, id: item.id, queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(calls, 1);
    assert.deepEqual(client.quarantinedDrafts().map(draft => draft.value), [item]);
  } finally { storage.close(); globalThis.fetch = fetch; }
});

test('failed, malformed or superseded initial task verification never dispatches the write', async () => {
  const fetch = globalThis.fetch; const body = { status: 'resolved', expectedVersion: 1 };
  try {
    const client = createWorkspaceClient(activateSession(identity())); let calls = 0;
    globalThis.fetch = async path => { calls++; assert.ok(String(path).endsWith('/state')); throw new TypeError('Failed to fetch'); };
    await assert.rejects(client.request('/api/tasks/T1', { method: 'PATCH', body }), TypeError);
    globalThis.fetch = async path => { calls++; assert.ok(String(path).endsWith('/state')); return Response.json({}); };
    await assert.rejects(client.request('/api/tasks/T1', { method: 'PATCH', body }), withCode('ACCESS_CHANGED'));
    let release!: (response: Response) => void;
    globalThis.fetch = async path => { calls++; assert.ok(String(path).endsWith('/state')); return await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/tasks/T1', { method: 'PATCH', body });
    activateSession(identity('bob'));
    release(Response.json({ accessEpoch: 1, access: { T1: access('T1') } }));
    await assert.rejects(pending, /session changed/i);
    assert.equal(calls, 3, 'failed verification releases its shared promise for an explicit later attempt');
  } finally { lockSession(); globalThis.fetch = fetch; }
});

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
    const item = (id: string): PendingMutation => ({ id, path: `/api/tasks/${id}`, method: 'PATCH', body: { status: 'resolved', expectedVersion: 1 }, label: id, createdAt: '2026-10-10' });
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
const queuedTask = (id: string): PendingMutation => ({ id, path: `/api/tasks/${id}`, method: 'PATCH', body: { status: 'resolved', expectedVersion: 1 }, label: id, createdAt: '2026-10-10' });

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


test('thread replies use interaction permission and preserve their fixed parent in durable quarantine after access returns', async () => {
  const storage = localStorageFixture(); const fetch = globalThis.fetch;
  try {
    const client = storage.reopen();
    client.reconcileAccess({ D1: access('D1', false, true), W1: access('W1') }, 1, ['S1']);
    const path = '/api/revisions/D1/threads/root-comment/replies';
    const key = 'comment-source:D1:reply:root-comment:V2';
    const body = { body: 'A reply while inspecting the second version', viewedVersionId: 'V2' };
    const queued: PendingMutation = { id: 'queued-reply', path, method: 'POST', body, label: 'Reply', createdAt: '2026-10-10' };
    client.writeStored(key, { ...body, threadId: 'root-comment' });
    client.writeStored('draft:document:W1:v1', { content: 'Independent wiki work' });
    client.writeStored('outbox', [queued]);
    assert.equal(canQueue(path, 'POST'), true);
    assert.equal(canQueue('/api/revisions/D1/threads/root-comment', 'PATCH'), false, 'thread resolution always requires a live server');
    let sent = 0;
    globalThis.fetch = async (_path, options) => { sent++; assert.deepEqual(JSON.parse(String(options?.body)), body); return Response.json({ id: 'saved-reply' }); };
    await client.request(path, { method: 'POST', body, id: queued.id, queued: true });
    assert.equal(sent, 1, 'a member who can interact may reply without edit access');
    await assert.rejects(client.request('/api/revisions/D1/threads/root-comment', { method: 'PATCH', body: { status: 'resolved' } }), withCode('ACTION_FORBIDDEN'));
    client.reconcileAccess({ D1: access('D1', false, false), W1: access('W1') }, 2, ['S1']);
    assert.equal(client.quarantinedDrafts().length, 2);
    assert.deepEqual(client.readStored('outbox', []), []);
    assert.equal(client.readStored(key, null), null);
    assert.deepEqual(client.readStored('draft:document:W1:v1', null), { content: 'Independent wiki work' });
    await assert.rejects(client.request(path, { method: 'POST', body }), withCode('ACTION_FORBIDDEN'));
    client.reconcileAccess({ D1: access('D1', true, true), W1: access('W1') }, 3, ['S1']);
    const reopened = storage.reopen();
    assert.deepEqual(reopened.quarantinedDrafts().find(draft => draft.key === `outbox:${queued.id}`)?.value, queued);
    assert.equal(reopened.readStored(key, null), null, 'a new reply slot cannot restore a held draft');
    await assert.rejects(reopened.request(path, { method: 'POST', body, id: queued.id, queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(sent, 1, 'revoked replies never automatically resume when access returns');
  } finally { globalThis.fetch = fetch; storage.close(); }
});

test('suggestion drafts with an empty explanation or deletion remain exportable and survive access-loss quarantine', () => {
  const key = 'comment-source:D1:V1';
  const draft = { body: '', versionId: 'V1', filePath: 'argument.md', line: null, passage: { start: 0, end: 5, quote: 'words' }, suggestion: { replacement: '' } };
  const protectedClient = createWorkspaceClient(activateSession(identity()));
  protectedClient.writeStored(key, draft);
  assert.deepEqual(protectedClient.draftRecords(), [{ key, value: draft }], 'a deletion is unsaved work even before its explanation is typed');
  lockSession();
  const storage = localStorageFixture();
  try {
    const client = storage.reopen();
    client.reconcileAccess({ D1: access('D1') }, 1, ['S1']);
    client.writeStored(key, draft);
    client.reconcileAccess({ D1: access('D1', true, false) }, 2, ['S1']);
    assert.deepEqual(client.quarantinedDrafts().map(item => item.value), [draft]);
    const reopened = storage.reopen();
    assert.deepEqual(reopened.quarantinedDrafts().map(item => item.value), [draft]);
    assert.equal(reopened.readStored(key, null), null);
    assert.equal(canQueue('/api/revisions/D1/suggestions/root-comment/apply', 'POST'), false, 'applying a proposal is never offline replay');
  } finally { storage.close(); }
});

test('task relation snapshots are invalidated across epoch changes while unrelated drafts survive and late histories cannot restore them', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 1, ['S1']);
    client.writeStored('task:T1', { dependsOn: [{ id: 'T2', title: 'Hidden next epoch' }], duplicateOf: [{ id: 'T2', title: 'Hidden duplicate' }], duplicates: [], accessEpoch: 1 });
    client.writeStored('task-draft:T1', { title: 'Keep my edit', expectedVersion: 1 });
    client.writeStored('task-comment:T1', { body: 'Keep my comment' });
    let release!: (response: Response) => void; let signal: AbortSignal | null | undefined; let changed = 0;
    client.onTaskSnapshotChange(() => { changed++; });
    globalThis.fetch = async (_path, options) => { signal = options?.signal; return new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/tasks/T1/history?before=10');
    client.reconcileAccess({ T1: access('T1') }, 2, ['S1']);
    assert.equal(signal?.aborted, true);
    assert.ok(changed > 0, 'mounted task pages must be told to drop previously rendered relation history');
    assert.equal(client.readStored('task:T1', null), null);
    assert.deepEqual(client.readStored('task-draft:T1', null), { title: 'Keep my edit', expectedVersion: 1 });
    assert.deepEqual(client.readStored('task-comment:T1', null), { body: 'Keep my comment' });
    release(Response.json({ transactions: [{ dependency: { taskId: 'T2' } }, { merge: { taskId: 'T2', direction: 'merged_from' } }], accessEpoch: 1 }));
    await assert.rejects(pending, withCode('ACCESS_CHANGED'));
    assert.equal(client.writeStored('task:T1', { accessEpoch: 1, dependsOn: ['T2'] }), false);
  } finally { globalThis.fetch = fetch; lockSession(); }
});

test('task visibility invalidation drops delayed mutation responses without aborting mutations and quarantines task drafts by capability', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 1, ['S1']);
    client.writeStored('task-draft:T1', { title: 'Field edit', expectedVersion: 1 });
    client.writeStored('task-comment:T1', { body: 'Comment draft' });
    let release!: (response: Response) => void; let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_path, options) => { signal = options?.signal; return new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/tasks/T1/dependencies', { method: 'POST', body: { taskId: 'T2', action: 'add', expectedVersion: 1 } });
    client.reconcileAccess({ T1: access('T1', false, true), T2: access('T2') }, 2, ['S1']);
    assert.equal(signal?.aborted, false, 'unknown committed writes must not be canceled by related-visibility refresh');
    assert.deepEqual(client.quarantinedDrafts().map(item => item.key), ['task-draft:T1']);
    assert.deepEqual(client.readStored('task-comment:T1', null), { body: 'Comment draft' });
    release(Response.json({ accessEpoch: 1, dependsOn: ['T2'] }));
    await assert.rejects(pending, withCode('ACCESS_CHANGED'));
    client.reconcileAccess({ T1: access('T1', false, false), T2: access('T2') }, 3, ['S1']);
    assert.deepEqual(new Set(client.quarantinedDrafts().map(item => item.key)), new Set(['task-draft:T1', 'task-comment:T1']));
    assert.equal(client.draftRecords().length, 2);
  } finally { globalThis.fetch = fetch; lockSession(); }
});

test('legacy task updates without an expected version are durably held before replay without affecting versioned edits or comments', async () => {
  const storage = localStorageFixture(); const fetch = globalThis.fetch;
  try {
    const client = storage.reopen();
    const legacy = { ...queuedTask('T1'), body: { status: 'resolved' } };
    const versioned = queuedTask('T2');
    const comment: PendingMutation = { id: 'comment', path: '/api/tasks/T1/comments', method: 'POST', body: { body: 'Independent discussion' }, label: 'Comment', createdAt: '2026-10-10' };
    client.writeStored('outbox', [legacy, versioned, comment]);
    assert.deepEqual(client.readStored<PendingMutation[]>('outbox', []).map(item => item.id), ['T2', 'comment']);
    assert.deepEqual(client.quarantinedDrafts().map(item => item.value), [legacy]);
    assert.match(client.quarantinedDrafts()[0]!.reason, /no source version/);
    const reopened = storage.reopen();
    let sent = 0; globalThis.fetch = async () => { sent++; return Response.json({}); };
    await assert.rejects(reopened.request(legacy.path, { method: legacy.method, body: legacy.body, id: legacy.id, queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(sent, 0);
    assert.deepEqual(reopened.readStored<PendingMutation[]>('outbox', []).map(item => item.id), ['T2', 'comment']);
  } finally { globalThis.fetch = fetch; storage.close(); }
});

test('failed local task draft writes retain a separate memory recovery copy without overwriting another durable draft', () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ T1: access('T1') }, 1, ['S1']);
    client.writeStored('task-draft:T1', { title: 'Durable previous copy', expectedVersion: 1 });
    storage.failWrites(true);
    assert.equal(client.writeStored('task-draft:T1', { title: 'Newest unsaved words', expectedVersion: 1 }), false);
    assert.deepEqual(client.readStored('task-draft:T1', null), { title: 'Newest unsaved words', expectedVersion: 1 });
    client.reconcileAccess({ T1: access('T1', false) }, 2, ['S1']);
    assert.deepEqual(new Set(client.quarantinedDrafts().map(item => (item.value as { title: string }).title)), new Set(['Durable previous copy', 'Newest unsaved words']));
    assert.match(client.quarantineWarning(), /Export the drafts now/);
    storage.failWrites(false);
    assert.equal(client.retryQuarantineStorage(), true);
    const reopened = storage.reopen();
    assert.deepEqual(new Set(reopened.quarantinedDrafts().map(item => (item.value as { title: string }).title)), new Set(['Durable previous copy', 'Newest unsaved words']));
  } finally { storage.close(); }
});

test('successful task submission cleanup compares durable and memory copies independently', () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen();
    const key = 'task-draft:T1';
    const first = { title: 'Submitted draft', expectedVersion: 1 };
    const other = { title: 'Another tab draft', expectedVersion: 1 };
    client.writeStored(key, other);
    storage.failWrites(true);
    client.writeStored(key, first);
    assert.deepEqual(client.readStored(key, null), first);
    assert.equal(client.removeStoredIfEqual(key, first), true);
    assert.equal(client.session?.memory.has(`${key}:unsaved-memory`), false);
    assert.deepEqual(JSON.parse(storage.stored.get(client.storageKey(key))!), other, 'a matching memory copy cannot authorize deletion of different durable bytes');
    storage.failWrites(false);
    client.writeStored(key, first);
    storage.failWrites(true);
    client.writeStored(key, other);
    assert.equal(client.removeStoredIfEqual(key, first), true);
    assert.equal(storage.stored.has(client.storageKey(key)), false);
    assert.deepEqual(client.readStored(key, null), other, 'a matching durable copy cannot authorize deletion of newer memory bytes');
    const commentKey = 'task-comment:T1';
    storage.failWrites(false); client.writeStored(commentKey, { body: 'Different durable comment' });
    storage.failWrites(true); client.writeStored(commentKey, { body: 'Saved comment' });
    assert.equal(client.removeStoredIfEqual(commentKey, { body: 'Saved comment' }), true);
    assert.deepEqual(client.readStored(commentKey, null), { body: 'Different durable comment' });
  } finally { storage.close(); }
});

test('a quarantined first failed task write holds its base editor through regrant and reload until explicit discard', async () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ T1: access('T1') }, 1, ['S1']);
    const key = 'task-comment:T1'; const draft = { body: 'First write could not reach storage' };
    storage.failWrites(true);
    assert.equal(client.writeStored(key, draft), false);
    assert.equal(storage.stored.has(client.storageKey(key)), false);
    client.reconcileAccess({ T1: access('T1', true, false) }, 2, ['S1']);
    client.reconcileAccess({ T1: access('T1') }, 3, ['S1']);
    assert.equal(client.quarantinedDrafts().some(item => item.key === `${key}:unsaved-memory`), true);
    assert.equal(client.draftIsHeld(key), true);
    assert.equal(client.readStored(key, null), null);
    assert.equal(client.writeStored(key, { body: 'Should not replace recovery' }), false);
    assert.equal(client.removeStoredIfEqual(key, draft), false, 'a late successful callback cannot clear a recovery copy');
    storage.failWrites(false); assert.equal(client.retryQuarantineStorage(), true);
    const reopened = storage.reopen();
    assert.equal(reopened.draftIsHeld(key), true);
    assert.equal(reopened.readStored(key, null), null);
    await reopened.discardQuarantinedDraft(`${key}:unsaved-memory`);
    assert.equal(reopened.draftIsHeld(key), false);
    assert.equal(reopened.readStored(key, null), null);
  } finally { storage.close(); }
});

test('discarding a task recovery record preserves a different draft subsequently stored by another tab', async () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ T1: access('T1') }, 1, ['S1']);
    const key = 'task-draft:T1';
    client.writeStored(key, { title: 'Old quarantined draft', expectedVersion: 1 });
    client.reconcileAccess({ T1: access('T1', false) }, 2, ['S1']);
    client.reconcileAccess({ T1: access('T1') }, 3, ['S1']);
    const newer = { title: 'Newer bytes saved elsewhere', expectedVersion: 2 };
    storage.stored.set(client.storageKey(key), JSON.stringify(newer));
    await client.discardQuarantinedDraft(key);
    assert.deepEqual(client.readStored(key, null), newer);
    assert.deepEqual(JSON.parse(storage.stored.get(client.storageKey(key))!), newer);
    assert.equal(client.quarantinedDrafts().length, 0);
  } finally { storage.close(); }
});

test('a committed owner handoff remains a success after known access loss, removes content and preserves unrelated recovery drafts', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 1, ['S1']);
    client.writeStored('task:T1', { task: { title: 'Private task' }, accessEpoch: 1 });
    client.writeStored('task:T1:subscriptions', { subscribers: ['Secret follower'], accessEpoch: 1 });
    client.writeStored('task-draft:T1', { title: 'Unsaved title', expectedVersion: 1 });
    client.writeStored('task-comment:T1', { body: 'Independent comment' });
    client.writeStored('task-comment:T2', { body: 'Unrelated comment' });
    let release!: (response: Response) => void;
    globalThis.fetch = async (_path, options) => new Promise<Response>((resolve, reject) => { release = resolve; options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
    const pending = client.request('/api/tasks/T1', { method: 'PATCH', body: { ownerId: 'bob', expectedVersion: 1 } });
    client.reconcileAccess({ T2: access('T2') }, 2, ['S1']);
    release(Response.json({ id: 'T1', saved: true, accessLost: true, accessEpoch: 2, unexpectedContent: 'must not return' }));
    assert.deepEqual(await pending, { id: 'T1', saved: true, accessLost: true, accessEpoch: 2 });
    assert.equal(client.readStored('task:T1', null), null);
    assert.equal(client.readStored('task:T1:subscriptions', null), null);
    assert.deepEqual(new Set(client.quarantinedDrafts().map(item => item.key)), new Set(['task-draft:T1', 'task-comment:T1']));
    assert.deepEqual(client.readStored('task-comment:T2', null), { body: 'Unrelated comment' });
  } finally { globalThis.fetch = fetch; lockSession(); }
});

test('following permits a read-only viewer to change their own membership, with separate gates for other members', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    let sent = 0; globalThis.fetch = async () => { sent++; return Response.json({ accessEpoch: 1 }); };
    client.reconcileAccess({ T1: access('T1', false, false) }, 1, ['S1']);
    await client.request('/api/tasks/T1/subscriptions', { method: 'POST', body: { principalId: 'alice', action: 'subscribe', expectedMembershipVersion: 0 } });
    await assert.rejects(client.request('/api/tasks/T1/subscriptions', { method: 'POST', body: { principalId: 'bob', action: 'subscribe', expectedMembershipVersion: 0 } }), withCode('ACTION_FORBIDDEN'));
    client.reconcileAccess({ T1: access('T1', false, true) }, 1, ['S1']);
    await client.request('/api/tasks/T1/subscriptions', { method: 'POST', body: { principalId: 'bob', action: 'subscribe', expectedMembershipVersion: 0 } });
    await assert.rejects(client.request('/api/tasks/T1/subscriptions', { method: 'POST', body: { principalId: 'bob', action: 'unsubscribe', expectedMembershipVersion: 1 } }), withCode('ACTION_FORBIDDEN'));
    assert.equal(sent, 2);
  } finally { globalThis.fetch = fetch; lockSession(); }
});

test('saved ownership operations are durably held instead of replaying access changes after reconnect', async () => {
  const storage = localStorageFixture(); const fetch = globalThis.fetch;
  try {
    const client = storage.reopen();
    const assignment = { ...queuedTask('T1'), body: { ownerId: null, expectedVersion: 1 } };
    const creation: PendingMutation = { id: 'assigned-create', path: '/api/tasks', method: 'POST', body: { title: 'Assigned offline', ownerId: 'alice' }, label: 'Task', createdAt: '2026-10-10' };
    client.writeStored('outbox', [assignment, creation, queuedTask('T2')]);
    assert.deepEqual(client.readStored<PendingMutation[]>('outbox', []).map(item => item.id), ['T2']);
    assert.equal(client.quarantinedDrafts().length, 2);
    const reopened = storage.reopen(); let sent = 0; globalThis.fetch = async () => { sent++; return Response.json({}); };
    await assert.rejects(reopened.request(assignment.path, { method: assignment.method, body: assignment.body, id: assignment.id, queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(sent, 0); assert.equal(reopened.quarantinedDrafts().length, 2);
  } finally { globalThis.fetch = fetch; storage.close(); }
});

test('legacy project replacement drafts and mixed queued patches are recovered whole while unrelated field deltas and creation aliases remain usable', async () => {
  const storage = localStorageFixture(); const fetch = globalThis.fetch;
  try {
    const client = storage.reopen(); client.reconcileAccess({ T1: access('T1'), T2: access('T2') }, 1, ['S1']);
    const mixed = { title: 'Keep all mixed work', description: 'New description too', projectId: 'PROJ1', expectedVersion: 1, changed: ['title', 'projectId'] };
    const unrelated = { title: 'Usable title edit', projectId: 'PROJ2', expectedVersion: 1, changed: ['title'] };
    client.writeStored('task-draft:T1', mixed); client.writeStored('task-draft:T2', unrelated);
    const patch = { ...queuedTask('T1'), body: { title: 'Whole queued edit', projectId: null, expectedVersion: 1 } };
    const creation: PendingMutation = { id: 'legacy-create', path: '/api/tasks', method: 'POST', body: { title: 'Legacy creation', projectId: 'PROJ1' }, label: 'Create task', createdAt: '2026-10-10' };
    client.writeStored('outbox', [patch, queuedTask('T2'), creation]);
    assert.deepEqual(client.readStored('task-draft:T1', null), null);
    assert.deepEqual(client.readStored('task-draft:T2', null), unrelated);
    assert.deepEqual(client.readStored<PendingMutation[]>('outbox', []).map(item => item.id), ['T2', 'legacy-create']);
    assert.deepEqual(new Set(client.quarantinedDrafts().map(item => item.key)), new Set(['task-draft:T1', 'outbox:T1']));
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === 'task-draft:T1')?.value, mixed);
    const reopened = storage.reopen(); let sends = 0; globalThis.fetch = async () => { sends++; return Response.json({}); };
    await assert.rejects(reopened.request(patch.path, { method: patch.method, body: patch.body, id: patch.id, queued: true }), withCode('ACTION_FORBIDDEN'));
    assert.equal(sends, 0); assert.equal(reopened.quarantinedDrafts().length, 2);
  } finally { globalThis.fetch = fetch; storage.close(); }
});

test('project-tag drafts share task edit quarantine, failed-write retention and independent physical-copy cleanup', async () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ T1: access('T1') }, 1, ['S1']);
    const key = 'task-projects:T1';
    const saved = { action: 'add', projectIds: ['PROJ1'], expectedVersion: 1 };
    const newer = { action: 'set', projectIds: [], expectedVersion: 1 };
    client.writeStored(key, saved); storage.failWrites(true); client.writeStored(key, newer);
    assert.equal(client.removeStoredIfEqual(key, newer), true);
    assert.deepEqual(client.readStored(key, null), saved, 'clearing a submitted memory copy must preserve differing durable tags');
    client.writeStored(key, newer);
    client.reconcileAccess({ T1: access('T1', false, true) }, 2, ['S1']);
    assert.equal(client.quarantinedDrafts().length, 2);
    client.reconcileAccess({ T1: access('T1') }, 3, ['S1']);
    assert.equal(client.draftIsHeld(key), true); assert.equal(client.readStored(key, null), null);
    storage.failWrites(false); assert.equal(client.retryQuarantineStorage(), true);
    const reopened = storage.reopen(); assert.equal(reopened.draftIsHeld(key), true);
    assert.deepEqual(new Set(reopened.quarantinedDrafts().map(item => JSON.stringify(item.value))), new Set([JSON.stringify(saved), JSON.stringify(newer)]));
  } finally { storage.close(); }
});

test('versioned tag outbox operations replay their unchanged payload and stop at conflicts without erasing recovery work', async () => {
  const storage = localStorageFixture(); const fetch = globalThis.fetch;
  try {
    const client = storage.reopen(); client.reconcileAccess({ T1: access('T1') }, 1, ['S1']);
    const change: PendingMutation = { id: 'tag-change', path: '/api/tasks/T1/projects', method: 'POST', body: { action: 'remove', projectIds: ['PROJ1'], expectedVersion: 4 }, label: 'Remove tag', createdAt: '2026-10-10' };
    client.writeStored('outbox', [change]);
    let body: unknown;
    globalThis.fetch = async (_path, options) => { body = JSON.parse(String(options?.body)); return Response.json({ error: 'Task changed from version 4. Reload and review.', code: 'VERSION_CONFLICT' }, { status: 409 }); };
    await assert.rejects(client.request(change.path, { method: change.method, body: change.body, id: change.id, queued: true }), withCode('VERSION_CONFLICT'));
    assert.deepEqual(body, change.body); assert.deepEqual(client.readStored('outbox', []), [change]);
    client.reconcileAccess({ T1: access('T1', false, true) }, 2, ['S1']);
    assert.deepEqual(client.readStored('outbox', []), []);
    assert.deepEqual(client.quarantinedDrafts()[0]!.value, change);
  } finally { globalThis.fetch = fetch; storage.close(); }
});

test('project detail and people caches clear on policy epochs while independent exact metadata drafts remain recoverable', async () => {
  const fetch = globalThis.fetch; const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 1, ['S1']);
    client.writeStored('project:PROJ1', { project: { name: 'Loaded profile' }, accessEpoch: 1 });
    client.writeStored('project:PROJ1:members', { members: [{ principalId: 'alice' }], accessEpoch: 1 });
    const draft = { expectedVersion: 3, values: { description: 'Unsaved metadata' }, changed: ['description'] };
    client.writeStored('project-draft:PROJ1', draft); client.writeStored('project-draft:PROJ2', { expectedVersion: 1, values: { name: 'Other project' }, changed: ['name'] });
    let release!: (response: Response) => void; let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_path, options) => { signal = options?.signal; return await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/projects/PROJ1/members');
    client.reconcileAccess({ PROJ1: access('PROJ1', false), PROJ2: access('PROJ2') }, 2, ['S1']);
    assert.equal(signal?.aborted, true); assert.equal(client.readStored('project:PROJ1', null), null); assert.equal(client.readStored('project:PROJ1:members', null), null);
    assert.equal(client.writeStored('project:PROJ1', { project: { name: 'Late private cache callback' }, accessEpoch: 1 }), false);
    assert.deepEqual(client.quarantinedDrafts().map(item => item.value), [draft]);
    assert.notEqual(client.readStored('project-draft:PROJ2', null), null);
    release(Response.json({ members: [{ principalId: 'alice' }], accessEpoch: 1 }));
    await assert.rejects(pending, withCode('ACCESS_CHANGED'));
    const reopened = storage.reopen(); assert.deepEqual(reopened.quarantinedDrafts().map(item => item.value), [draft]);
    reopened.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 3, ['S1']);
    assert.equal(reopened.readStored('project-draft:PROJ1', null), null);
    await reopened.discardQuarantinedDraft('project-draft:PROJ1'); assert.equal(reopened.quarantinedDrafts().length, 0);
  } finally { storage.close(); globalThis.fetch = fetch; }
});

test('project metadata draft retention compares memory and durable bytes independently and older unversioned work is held whole', () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ PROJ1: access('PROJ1') }, 1, ['S1']);
    const key = 'project-draft:PROJ1'; const durable = { expectedVersion: 2, values: { name: 'Newer saved draft' }, changed: ['name'] }; const memory = { expectedVersion: 1, values: { name: 'Failed local write' }, changed: ['name'] };
    client.writeStored(key, durable); storage.failWrites(true); assert.equal(client.writeStored(key, memory), false); storage.failWrites(false);
    assert.equal(client.removeStoredIfEqual(key, memory), true); assert.deepEqual(client.readStored(key, null), durable);
    const legacy = { name: 'Old draft without known source', description: 'Keep all fields' };
    storage.stored.set(client.storageKey(key), JSON.stringify(legacy));
    const queued: PendingMutation = { id: 'legacy-project', path: '/api/projects/PROJ1', method: 'PATCH', body: { name: 'Old queued name' }, label: 'Legacy project metadata', createdAt: '2026-10-10' };
    const create: PendingMutation = { id: 'project-create', path: '/api/projects', method: 'POST', body: { name: 'Explicit creation', color: '#123456' }, label: 'Create project', createdAt: '2026-10-10' };
    client.writeStored('outbox', [queued, create]); assert.equal(client.readStored(key, null), null);
    assert.deepEqual(client.readStored('outbox', []), [create]); assert.deepEqual(new Set(client.quarantinedDrafts().map(item => JSON.stringify(item.value))), new Set([JSON.stringify(legacy), JSON.stringify(queued)]));
  } finally { storage.close(); }
});

test('a committed project leave receipt survives known view loss without exposing stale project content or replaying metadata drafts', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1'), T1: access('T1') }, 1, ['S1']);
    client.writeStored('project:PROJ1', { project: { name: 'Private project' }, accessEpoch: 1 });
    const draft = { expectedVersion: 1, values: { name: 'Unsaved project edit' }, changed: ['name'] }; client.writeStored('project-draft:PROJ1', draft);
    assert.deepEqual(client.draftRecords(), [{ key: 'project-draft:PROJ1', value: draft }], 'protected session export includes ordinary project metadata drafts before access changes');
    client.writeStored('task-comment:T1', { body: 'Unrelated task comment' });
    let release!: (response: Response) => void; let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_path, options) => { signal = options?.signal; return await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/projects/PROJ1/membership', { method: 'POST', body: { action: 'leave', expectedVersion: 1 } });
    client.reconcileAccess({ T1: access('T1') }, 2, ['S1']); assert.equal(signal?.aborted, false);
    release(Response.json({ id: 'PROJ1', saved: true, accessLost: true, accessEpoch: 2 }));
    assert.deepEqual(await pending, { id: 'PROJ1', saved: true, accessLost: true, accessEpoch: 2 });
    assert.equal(client.readStored('project:PROJ1', null), null); assert.deepEqual(client.quarantinedDrafts().map(item => item.value), [draft]); assert.deepEqual(client.readStored('task-comment:T1', null), { body: 'Unrelated task comment' });
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('child creation keeps parent-bound drafts and unsafe queued conversions held without affecting ordinary project work', async () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 1, ['S1']);
    const draft = { name: 'Exact saved child', preview: { expectedParentVersion: 1, expectedHierarchyVersion: 1, expectedParentMembersVersion: 3, transferMemberCount: 2 } };
    client.writeStored('project-child:PROJ1:project', draft);
    client.writeStored('project-draft:PROJ2', { expectedVersion: 1, values: { name: 'Unrelated edit' }, changed: ['name'] });
    const queued: PendingMutation = { id: 'unsafe-child', path: '/api/projects', method: 'POST', body: { name: 'Child', parentId: 'PROJ1', kind: 'project', expectedHierarchyVersion: 1 }, label: 'Child project', createdAt: '2026-10-10' };
    client.writeStored('outbox', [queued]); assert.deepEqual(client.readStored('outbox', []), []);
    client.reconcileAccess({ PROJ2: access('PROJ2') }, 2, ['S1']);
    assert.deepEqual(new Set(client.quarantinedDrafts().map(item => item.key)), new Set(['outbox:unsafe-child', 'project-child:PROJ1:project']));
    const reopened = storage.reopen(); reopened.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 3, ['S1']);
    assert.equal(reopened.readStored('project-child:PROJ1:project', null), null);
    assert.deepEqual(reopened.quarantinedDrafts().find(item => item.key === 'project-child:PROJ1:project')?.value, draft);
    assert.notEqual(reopened.readStored('project-draft:PROJ2', null), null);
    await assert.rejects(reopened.request('/api/projects', { method: 'POST', body: queued.body, id: queued.id, queued: true }), withCode('ACTION_FORBIDDEN'));
  } finally { storage.close(); }
});

test('late committed child creation returns a content-free receipt after parent access changes and does not cross sessions', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1') }, 1, ['S1']);
    const draft = { name: 'Keep a newer child draft', preview: { expectedHierarchyVersion: 1 } }; client.writeStored('project-child:PROJ1:project', draft);
    assert.deepEqual(client.draftRecords(), [{ key: 'project-child:PROJ1:project', value: draft }]);
    let release!: (response: Response) => void; let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_path, options) => { signal = options?.signal; return new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/projects', { method: 'POST', body: { parentId: 'PROJ1', kind: 'project', name: 'Committed child' } });
    client.reconcileAccess({}, 2, ['S1']); assert.equal(signal?.aborted, false, 'object revocation must not abort a committed creation receipt');
    release(Response.json({ id: 'PROJ3', name: 'Do not expose this stale child', displayName: 'Hidden child' }, { status: 201 }));
    assert.deepEqual(await pending, { id: 'PROJ3', saved: true, refreshRequired: true, accessEpoch: 2 });
    assert.equal(client.readStored('project-child:PROJ1:project', null), null);
    assert.deepEqual(client.quarantinedDrafts().map(item => item.value), [draft]);
    const next = createWorkspaceClient(activateSession(identity('bob'))); next.reconcileAccess({ PROJ1: access('PROJ1') }, 1, ['S1']);
    const pendingOther = next.request('/api/projects', { method: 'POST', body: { parentId: 'PROJ1', kind: 'milestone', name: 'Milestone' } });
    lockSession(); assert.equal(signal?.aborted, true, 'session invalidation still aborts creation');
    release(Response.json({ id: 'PROJ4', saved: true, accessLost: true, accessEpoch: 3 }, { status: 201 }));
    await assert.rejects(pendingOther);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('old project presentation caches never imply direct membership or missing parents while drafts remain readable', () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen();
    client.writeStored('state', { projects: [{ id: 'PROJ1', name: 'Old root assumption' }], access: { PROJ1: access('PROJ1') } });
    client.writeStored('project:PROJ1', { project: { id: 'PROJ1', name: 'Before conversion' }, viewer: { membership: { active: true, version: 1 } } });
    client.writeStored('project:PROJ1:members', { members: [{ principalId: 'alice' }], viewer: { membership: { active: true, version: 1 } } });
    client.writeStored('project-draft:PROJ1', { expectedVersion: 1, values: { description: 'Keep my description' }, changed: ['description'] });
    assert.equal(client.readStored('state', null), null); assert.equal(client.readStored('project:PROJ1', null), null); assert.equal(client.readStored('project:PROJ1:members', null), null);
    assert.notEqual(client.readStored('project-draft:PROJ1', null), null);
    client.reconcileAccess({}, 1, ['S1']); assert.equal(client.quarantinedDrafts()[0]?.key, 'project-draft:PROJ1', 'old cached access still participates in revocation');
  } finally { storage.close(); }
});

const boardMoveDraft = (taskId = 'T1') => ({ input: { taskId, columnId: 'COL1', expectedBoardVersion: 3, expectedTaskVersion: 2, position: { beforeTaskId: 'T2' } }, taskTitle: 'A retained task', columnName: 'Milestone', proxyProjectId: 'PROJ2', referenceTitle: 'Reference task', requestId: `move-${taskId}` });

test('workboard move authority uses board view and task edit; its receipt clears same-epoch aggregate snapshots', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity()));
    client.reconcileAccess({ PROJ1: access('PROJ1', false), PROJ2: access('PROJ2'), T1: access('T1'), T2: access('T2', false) }, 4);
    for (const key of ['task:T1', 'project:PROJ1', 'workboard:PROJ1:open']) client.writeStored(key, { accessEpoch: 4, old: true });
    const input = boardMoveDraft().input; let calls = 0;
    globalThis.fetch = async (_path, options) => { calls++; assert.deepEqual(JSON.parse(String(options?.body)), input); return Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 4, taskId: 'T1', taskVersion: 3, accessEpoch: 4 }); };
    const receipt = await client.request('/api/projects/PROJ1/workboard/moves', { method: 'POST', body: input });
    assert.deepEqual(receipt, { projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 4, accessEpoch: 4 });
    for (const key of ['task:T1', 'project:PROJ1', 'workboard:PROJ1:open']) assert.equal(client.readStored(key, null), null);
    assert.equal(calls, 1);
    client.reconcileAccess({ PROJ1: access('PROJ1'), T1: access('T1', false), T2: access('T2') }, 5);
    await assert.rejects(client.request('/api/projects/PROJ1/workboard/moves', { method: 'POST', body: input }), withCode('ACTION_FORBIDDEN'));
    assert.equal(calls, 1, 'board edit does not grant task edit');
    for (const path of ['/api/projects/PROJ1/workboard', '/api/projects/PROJ1/workboard/moves', '/api/projects/PROJ1/workboard/columns']) assert.equal(canQueue(path, 'POST', input), false);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('committed board receipt survives object revocation but stale layout and a superseded session do not', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1'), T1: access('T1'), T2: access('T2') }, 1);
    let release!: (response: Response) => void; let signal: AbortSignal | null | undefined;
    globalThis.fetch = async (_path, options) => { signal = options?.signal; return await new Promise<Response>(resolve => { release = resolve; }); };
    const pending = client.request('/api/projects/PROJ1/workboard/moves', { method: 'POST', body: boardMoveDraft().input });
    client.reconcileAccess({}, 2); assert.equal(signal?.aborted, false, 'object loss must not abort a committed receipt');
    release(Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 4, accessEpoch: 2 })); assert.equal((await pending as { saved: boolean }).saved, true);
    client.reconcileAccess({ PROJ1: access('PROJ1'), T1: access('T1'), T2: access('T2') }, 3);
    const oldLayout = client.request('/api/projects/PROJ1/workboard'); client.reconcileAccess({ PROJ1: access('PROJ1'), T1: access('T1') }, 4);
    release(Response.json({ projectId: 'PROJ1', cards: ['T2'], accessEpoch: 3 })); await assert.rejects(oldLayout, withCode('ACCESS_CHANGED'));
    client.reconcileAccess({ PROJ1: access('PROJ1'), T1: access('T1'), T2: access('T2') }, 5);
    const oldSession = client.request('/api/projects/PROJ1/workboard/moves', { method: 'POST', body: boardMoveDraft().input });
    activateSession(identity('bob')); assert.equal(signal?.aborted, true);
    release(Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 5, accessEpoch: 5 })); await assert.rejects(oldSession, /session changed/i);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('workboard move drafts retain every reviewed authority and remain held after access returns and local reload', async () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen();
    const rules = { PROJ1: access('PROJ1', false), PROJ2: access('PROJ2'), T1: access('T1'), T2: access('T2'), T3: access('T3') };
    client.reconcileAccess(rules, 1); const draft = boardMoveDraft();
    client.writeStored('workboard-move:PROJ1:T1', draft); client.writeStored('task-draft:T3', { changed: ['title'], title: 'Independent draft' });
    const { PROJ2: _hidden, ...visible } = rules; client.reconcileAccess(visible, 2);
    assert.equal(client.draftIsHeld('workboard-move:PROJ1:T1'), true);
    assert.deepEqual(client.quarantinedDrafts().map(item => item.value), [draft]);
    assert.deepEqual(client.readStored('task-draft:T3', null), { changed: ['title'], title: 'Independent draft' });
    client.reconcileAccess(rules, 3); assert.equal(client.readStored('workboard-move:PROJ1:T1', null), null);
    const reopened = storage.reopen(); assert.equal(reopened.draftIsHeld('workboard-move:PROJ1:T1'), true);
    assert.deepEqual(reopened.quarantinedDrafts()[0]?.value, draft);
    await reopened.discardQuarantinedDraft('workboard-move:PROJ1:T1'); assert.equal(reopened.readStored('workboard-move:PROJ1:T1', null), null);
  } finally { storage.close(); }
});

test('password workboard move drafts are included in explicit unsaved-work export', () => {
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1', false), PROJ2: access('PROJ2'), T1: access('T1'), T2: access('T2') }, 1);
    client.writeStored('workboard-move:PROJ1:T1', boardMoveDraft());
    assert.deepEqual(client.draftRecords(), [{ key: 'workboard-move:PROJ1:T1', value: boardMoveDraft() }]);
  } finally { lockSession(); }
});

for (const revoked of ['T2', 'T3', 'both']) test(`physical workboard drafts keep distinct anchors when ${revoked} is revoked`, () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); const key = 'workboard-move:PROJ1:T1';
    const rules = { PROJ1: access('PROJ1', false), PROJ2: access('PROJ2'), T1: access('T1'), T2: access('T2'), T3: access('T3') };
    client.reconcileAccess(rules, 1); const older = boardMoveDraft(); const newer = { ...boardMoveDraft(), input: { ...boardMoveDraft().input, position: { beforeTaskId: 'T3' } }, referenceTitle: 'Newer reference' };
    assert.equal(client.writeStored(key, older), true); storage.failWrites(true); assert.equal(client.writeStored(key, newer), false);
    assert.equal(client.draftHasUnsavedMemory(key), true, 'the first failed write is distinguishable before more editing');
    storage.failWrites(false);
    client.reconcileAccess(Object.fromEntries(Object.entries(rules).filter(([id]) => revoked === 'both' ? !['T2', 'T3'].includes(id) : id !== revoked)), 2);
    const held = client.quarantinedDrafts();
    assert.deepEqual(held.find(item => item.key === key)?.value, older);
    assert.deepEqual(held.find(item => item.key === `${key}:unsaved-memory`)?.value, newer, 'holding one physical copy secures every copy in this editor family');
    const reopened = storage.reopen();
    assert.deepEqual(reopened.quarantinedDrafts().map(item => item.value), [older, newer], 'both physical copies remain explicitly recoverable after reload');
    assert.equal(reopened.readStored(key, null), null, 'a held physical copy holds the entire editor family');
  } finally { storage.close(); }
});

test('successful move cleanup removes a failed attempt marker without deleting a different saved move', () => {
  const storage = localStorageFixture();
  try {
    const client = storage.reopen(); const key = 'workboard-move:PROJ1:T1'; const original = boardMoveDraft(); const attempted = { ...original, attempted: true };
    client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2'), T1: access('T1'), T2: access('T2') }, 1);
    client.writeStored(key, original); storage.failWrites(true); client.writeStored(key, attempted);
    client.removeStoredIfEqual(key, attempted); client.removeStoredIfEqual(key, original);
    assert.equal(client.readStored(key, null), null, 'both exact pre-submit and submitted physical copies are cleared');
    storage.failWrites(false); const newer = { ...original, columnName: 'Newer draft from another tab', requestId: 'different-request' }; client.writeStored(key, newer);
    storage.failWrites(true); client.writeStored(key, attempted);
    client.removeStoredIfEqual(key, attempted); client.removeStoredIfEqual(key, original);
    assert.deepEqual(client.readStored(key, null), newer);
  } finally { storage.close(); }
});

test('column import captures source view independently from target edit and never queues', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2', false) }, 1);
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 1, accessEpoch: 1 }); };
    const body = { sourceProjectId: 'PROJ2', expectedBoardVersion: 0, expectedSourceBoardVersion: 4 };
    assert.equal((await client.request('/api/projects/PROJ1/workboard/import', { method: 'POST', body }) as { saved: boolean }).saved, true);
    assert.equal(canQueue('/api/projects/PROJ1/workboard/import', 'POST', body), false);
    client.reconcileAccess({ PROJ1: access('PROJ1') }, 2);
    await assert.rejects(client.request('/api/projects/PROJ1/workboard/import', { method: 'POST', body }), withCode('PROJECT_REFERENCE_UNAVAILABLE'));
    assert.equal(client.unavailableObject('PROJ1'), false); assert.equal(calls, 1);
    client.reconcileAccess({ PROJ1: access('PROJ1', false), PROJ2: access('PROJ2') }, 3);
    await assert.rejects(client.request('/api/projects/PROJ1/workboard/import', { method: 'POST', body }), withCode('ACTION_FORBIDDEN'));
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('a late import preview cannot cross source revocation while a committed content-free receipt can', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 1);
    let release!: (response: Response) => void; globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const preview = client.request('/api/projects/PROJ1/workboard/import-preview?sourceProjectId=PROJ2');
    client.reconcileAccess({ PROJ1: access('PROJ1') }, 2); client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 3);
    release(Response.json({ projectId: 'PROJ1', sourceProject: { id: 'PROJ2', name: 'Private source' }, columns: [{ name: 'Private configuration' }], accessEpoch: 1 }));
    await assert.rejects(preview, withCode('PROJECT_REFERENCE_UNAVAILABLE'));
    const receipt = client.request('/api/projects/PROJ1/workboard/import', { method: 'POST', body: { sourceProjectId: 'PROJ2', expectedBoardVersion: 0, expectedSourceBoardVersion: 4 }, id: 'retained-import-request' });
    client.reconcileAccess({ PROJ1: access('PROJ1') }, 4); release(Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 1, accessEpoch: 4 }));
    assert.equal((await receipt as { saved: boolean }).saved, true);
    assert.equal(client.unavailableObject('PROJ1'), false);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('an import source denial invalidates the source preview authority and preserves its target', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 1);
    globalThis.fetch = async () => Response.json({ error: 'Source unavailable', code: 'PROJECT_REFERENCE_UNAVAILABLE' }, { status: 404 });
    await assert.rejects(client.request('/api/projects/PROJ1/workboard/import-preview?sourceProjectId=PROJ2'), withCode('PROJECT_REFERENCE_UNAVAILABLE'));
    assert.equal(client.unavailableObject('PROJ2'), true); assert.equal(client.unavailableObject('PROJ1'), false);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

const bulkMoveInput = () => ({ sourceColumnId: 'COL1', destinationProjectId: 'PROJ2', destinationColumnId: 'COL2', expectedBoardVersion: 3, expectedDestinationBoardVersion: 8, tasks: [{ taskId: 'T1', expectedTaskVersion: 2 }, { taskId: 'T2', expectedTaskVersion: 4 }] });
test('bulk moves require both project views and every task edit but no project edit, and never queue', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); const rules = { PROJ1: access('PROJ1', false), PROJ2: access('PROJ2', false), T1: access('T1'), T2: access('T2') }; client.reconcileAccess(rules, 1);
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 4, destinationProjectId: 'PROJ2', destinationBoardVersion: 9, accessEpoch: 1 }); };
    const result = await client.request<{ destinationBoardVersion: number }>('/api/projects/PROJ1/workboard/bulk-moves', { method: 'POST', body: bulkMoveInput() }); assert.equal(result.destinationBoardVersion, 9);
    assert.equal(canQueue('/api/projects/PROJ1/workboard/bulk-moves', 'POST', bulkMoveInput()), false);
    client.reconcileAccess({ ...rules, T2: access('T2', false) }, 2); await assert.rejects(client.request('/api/projects/PROJ1/workboard/bulk-moves', { method: 'POST', body: bulkMoveInput() }), withCode('ACTION_FORBIDDEN'));
    client.reconcileAccess({ PROJ1: rules.PROJ1, T1: rules.T1, T2: rules.T2 }, 3); await assert.rejects(client.request('/api/projects/PROJ1/workboard/bulk-moves', { method: 'POST', body: bulkMoveInput() }), withCode('PROJECT_REFERENCE_UNAVAILABLE')); assert.equal(calls, 1); assert.equal(client.unavailableObject('PROJ1'), false);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('bulk preview captures destination and milestone authority, and ignores content after task access changes', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); const rules = { PROJ1: access('PROJ1', false), PROJ2: access('PROJ2', false), PROJ3: access('PROJ3', false), T1: access('T1'), T2: access('T2') }; client.reconcileAccess(rules, 1);
    let release!: (response: Response) => void; globalThis.fetch = async () => await new Promise<Response>(resolve => { release = resolve; });
    const path = '/api/projects/PROJ1/workboard/bulk-move-preview?sourceColumnId=COL1&destinationProjectId=PROJ2&destinationColumnId=COL2';
    const preview = client.request(path, undefined, ['PROJ3']); client.reconcileAccess({ PROJ1: rules.PROJ1, PROJ2: rules.PROJ2, T1: rules.T1, T2: rules.T2 }, 2); client.reconcileAccess(rules, 3);
    release(Response.json({ projectId: 'PROJ1', tasks: [{ title: 'Revoked milestone contents' }], accessEpoch: 1 })); await assert.rejects(preview, withCode('COLUMN_UNAVAILABLE'));
    const lateTask = client.request(path, undefined, ['PROJ3']); client.reconcileAccess({ ...rules, T2: access('T2', false) }, 4); release(Response.json({ projectId: 'PROJ1', tasks: [{ id: 'T2', title: 'No longer editable' }], accessEpoch: 3 })); await assert.rejects(lateTask, withCode('ACCESS_CHANGED'));
    client.reconcileAccess(rules, 5); const saved = client.request('/api/projects/PROJ1/workboard/bulk-moves', { method: 'POST', body: bulkMoveInput(), id: 'exact-bulk-request' }, ['PROJ3']); client.reconcileAccess({ PROJ1: rules.PROJ1, PROJ2: rules.PROJ2, T1: rules.T1 }, 6);
    release(Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 4, destinationProjectId: 'PROJ2', destinationBoardVersion: 9, accessEpoch: 6 })); assert.equal((await saved as { saved: boolean }).saved, true);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('bulk destination denial clears only destination authority while unavailable columns leave the parent readable', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1'), PROJ2: access('PROJ2') }, 1);
    const path = '/api/projects/PROJ1/workboard/bulk-move-preview?sourceColumnId=COL1&destinationProjectId=PROJ2&destinationColumnId=COL2';
    globalThis.fetch = async () => Response.json({ code: 'COLUMN_UNAVAILABLE', error: 'Column unavailable' }, { status: 404 }); await assert.rejects(client.request(path), withCode('COLUMN_UNAVAILABLE')); assert.equal(client.unavailableObject('PROJ1'), false); assert.equal(client.unavailableObject('PROJ2'), false);
    globalThis.fetch = async () => Response.json({ code: 'PROJECT_REFERENCE_UNAVAILABLE', error: 'Destination unavailable' }, { status: 404 }); await assert.rejects(client.request(path), withCode('PROJECT_REFERENCE_UNAVAILABLE')); assert.equal(client.unavailableObject('PROJ1'), false); assert.equal(client.unavailableObject('PROJ2'), true);
  } finally { lockSession(); globalThis.fetch = fetch; }
});

test('malformed bulk receipts cannot clear the exact retry request as a success', async () => {
  const fetch = globalThis.fetch;
  try {
    const client = createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1', false), PROJ2: access('PROJ2', false), T1: access('T1'), T2: access('T2') }, 1);
    for (const destination of [{}, { destinationProjectId: 'PROJ3', destinationBoardVersion: 9 }, { destinationProjectId: 'PROJ2', destinationBoardVersion: -1 }]) {
      globalThis.fetch = async () => Response.json({ projectId: 'PROJ1', saved: true, refreshRequired: true, boardVersion: 4, ...destination });
      await assert.rejects(client.request('/api/projects/PROJ1/workboard/bulk-moves', { method: 'POST', body: bulkMoveInput(), id: 'unchanged-request' }), withCode('INVALID_RECEIPT'));
    }
  } finally { lockSession(); globalThis.fetch = fetch; }
});

for (const mode of ['local', 'password'] as const) test(`submitted bulk recovery stays minimal in ${mode} session memory and clears only exact records`, () => {
  const storage = mode === 'local' ? localStorageFixture() : null;
  try {
    const client = storage ? storage.reopen() : createWorkspaceClient(activateSession(identity())); client.reconcileAccess({ PROJ1: access('PROJ1', false), PROJ2: access('PROJ2', false), PROJ3: access('PROJ3'), T1: access('T1'), T2: access('T2') }, 1);
    const value = { projectId: 'PROJ1', sourceProxyId: 'PROJ3', requestId: 'retained-bulk', input: bulkMoveInput(), title: 'Must not retain titles', preview: { content: 'Must not retain previews' } };
    const retained = client.retainSubmittedBulkMove(value); assert.equal(JSON.stringify(retained).includes('Must not'), false); assert.equal(retained.sourceProxyId, 'PROJ3');
    client.reconcileAccess({ PROJ2: access('PROJ2', false) }, 2);
    assert.deepEqual(client.submittedBulkMoves(), [retained], 'source/proxy/task revocation cannot delete only recovery record'); assert.deepEqual(client.draftRecords(), [{ key: 'submitted-bulk:retained-bulk', value: retained }]);
    assert.deepEqual(createWorkspaceClient(client.session).submittedBulkMoves(), [retained], 'page/client remount in same session retains request');
    if (storage) assert.equal([...storage.stored.keys()].some(key => key.includes('submitted-bulk:')), false, 'local mode never writes request recovery to durable browser storage');
    assert.equal(client.clearSubmittedBulkMove({ ...retained, input: { ...retained.input, expectedBoardVersion: 99 } }), false);
    assert.throws(() => client.retainSubmittedBulkMove({ ...retained, input: { ...retained.input, expectedBoardVersion: 99 } }), /cannot change/);
    const newer = client.retainSubmittedBulkMove({ ...retained, requestId: 'newer-bulk', input: { ...retained.input, expectedBoardVersion: 4 } });
    assert.equal(client.clearSubmittedBulkMove(retained), true); assert.deepEqual(client.submittedBulkMoves(), [newer]);
    const nextSession = activateSession(identity('bob')); const next = createWorkspaceClient(nextSession); next.retainSubmittedBulkMove({ ...newer, requestId: 'bob-request' }); assert.equal(client.clearSubmittedBulkMove(newer), false); assert.deepEqual(client.submittedBulkMoves(), []); assert.equal(next.submittedBulkMoves().length, 1);
    lockSession(); assert.deepEqual(next.submittedBulkMoves(), []); assert.equal(nextSession.memory.size, 0);
  } finally { if (storage) storage.close(); else lockSession(); }
});
