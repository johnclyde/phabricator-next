import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, canQueue, retainedDraftLockName } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { ReviewDraftPayload, ReviewDraftSnapshot } from '../shared/review-drafts.ts';
import type { Intent } from '../client/review-draft-model.ts';
const entryId = 'a0000000-0000-4000-8000-000000000001', requestId = 'b0000000-0000-4000-8000-000000000002';
const key = `review-draft-edit:L1:${entryId}`, requestKey = 'review-draft-request:L1';
const payload: ReviewDraftPayload = { kind: 'summary', body: 'Private exact prose 😀\r\n  ', versionId: 'source-one', contentHash: 'a'.repeat(64) };
const draft = { id: entryId, expectedEntryVersion: 0, payload };
const access = (id: string, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'principals', principalIds: [] }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: false, interact, managePolicy: false }, viewLabel: 'Workspace', editLabel: 'Nobody', interactLabel: 'Workspace' });
function fixture(password = false) {
  const previous = Object.fromEntries(['localStorage', 'navigator', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, work: () => unknown) => work() } } });
  const session = activateSession({ mode: password ? 'password' : 'local', workspaceId: 'private-review-storage', account: password ? { id: 'U1', username: 'alice', displayName: 'Alice', disabled: false } : null, sessionContext: password ? 'session-one' : null, csrfToken: password ? 'csrf-one' : null, expiresAt: null });
  const client = createWorkspaceClient(session), principalId = password ? 'U1' : 'local:private-review-storage'; client.reconcileAccess({ L1: access('L1'), F1: access('F1') }, 1, ['S1']);
  const snapshot: ReviewDraftSnapshot = { revisionId: 'L1', principalId, setVersion: 0, entries: [], head: { versionId: 'source-one', contentHash: 'a'.repeat(64), number: 1 }, accessEpoch: 1 };
  const intent: Intent = { id: requestId, revisionId: 'L1', principalId, kind: 'save', entryId, input: { expectedEntryVersion: 0, expectedAccessEpoch: 1, payload }, entries: [], cleanup: { key, value: draft } };
  return { client, session, principalId, snapshot, intent, values, close: () => { lockSession(); for (const [key, desc] of Object.entries(previous)) { if (desc) Object.defineProperty(globalThis, key, desc); else Reflect.deleteProperty(globalThis, key); } } };
}

test('private review authored drafts share locked retention, preserve exact competing copies, and never queue', async () => {
  const f = fixture(); try {
    assert.equal(retainedDraftLockName(key), `file-intent:${key}`); assert.equal(retainedDraftLockName(requestKey), `file-intent:${requestKey}`); assert.equal(retainedDraftLockName('review-drafts:L1'), null);
    assert.equal(await f.client.retainDraft(key, draft, null), 'saved');
    const contender = { ...draft, payload: { ...payload, body: 'Other tab exact private draft' } }; f.values.set(f.client.storageKey(key), JSON.stringify(contender));
    assert.deepEqual(createWorkspaceClient(f.session).readStored(key, null), draft); assert.equal(f.client.draftHasUnsavedMemory(key), true);
    assert.deepEqual(f.client.draftRecords().find(item => item.key === `${key}:unsaved-memory`)?.value, draft);
    assert.equal(await f.client.removeRetainedDraftIfEqual(key, draft), true); assert.deepEqual(JSON.parse(f.values.get(f.client.storageKey(key))!), contender);
    for (const path of [`/api/revisions/L1/review-drafts/${entryId}`, `/api/revisions/L1/review-drafts/${entryId}/discard`, '/api/revisions/L1/review-drafts/publish']) for (const method of ['POST', 'PUT'] as const) assert.equal(canQueue(path, method, f.intent.input), false);
  } finally { f.close(); }
});

test('private snapshot is own-account cache; malformed writes cannot replace recovery and source revocation holds authored work', async () => {
  const f = fixture(); try {
    assert.equal(f.client.writeStored('review-drafts:L1', f.snapshot), true); assert.equal(f.client.writeStored('review-drafts:L1', { ...f.snapshot, principalId: 'another-account' }), false);
    assert.deepEqual(f.client.readStored('review-drafts:L1', null), f.snapshot); assert.deepEqual(f.client.draftRecords(), []);
    assert.equal(f.client.writeStored(requestKey, f.intent), true); assert.equal(f.client.writeStored(requestKey, { ...f.intent, principalId: 'another-account' }), false); assert.deepEqual(f.client.readStored(requestKey, null), f.intent);
    assert.equal(await f.client.retainDraft(key, draft, null), 'saved'); assert.equal(await f.client.retainDraft(key, { ...draft, id: 'bad-id' }, draft), 'unavailable'); assert.deepEqual(f.client.readStored(key, null), draft);
    f.client.writeStored('revision:L1', { revision: { id: 'L1' }, versions: [{ docx: { sourceFile: { fileId: 'F1' } } }], accessEpoch: 1 });
    f.client.retireUnavailableObject('F1'); assert.equal(f.client.readStored('review-drafts:L1', null), null); assert.equal(f.values.has(f.client.storageKey('review-drafts:L1')), false);
    assert.equal(f.client.readStored(key, null), null); assert.equal(f.client.readStored(requestKey, null), null); assert.ok(f.client.quarantinedDrafts().some(item => item.key === key && JSON.stringify(item.value) === JSON.stringify(draft)));
    assert.ok(f.client.quarantinedDrafts().some(item => item.key === requestKey && JSON.stringify(item.value) === JSON.stringify(f.intent)));
  } finally { f.close(); }
});

test('Interact loss holds authored private edits while View permits a fresh exact discard intent', () => {
  const f = fixture(); try {
    f.client.writeStored(key, draft); f.client.writeStored(requestKey, f.intent);
    f.client.reconcileAccess({ L1: access('L1', false), F1: access('F1') }, 2, ['S1']);
    assert.equal(f.client.readStored(key, null), null); assert.ok(f.client.quarantinedDrafts().some(item => item.key === key));
    const separate = createWorkspaceClient(f.session), discard: Intent = { ...f.intent, kind: 'discard', input: { expectedEntryVersion: 1, expectedAccessEpoch: 2 } };
    // A held prior request is never overwritten merely because a new operation is permitted.
    assert.equal(separate.writeStored(requestKey, discard), false);
    assert.equal(separate.writeStored('review-drafts:L1', { ...f.snapshot, accessEpoch: 2 }), true);
  } finally { f.close(); }
});

test('protected private drafts and server cache remain tab memory and expire with account replacement', async () => {
  const f = fixture(true); try {
    assert.equal(await f.client.retainDraft(key, draft, null), 'saved'); assert.equal(f.client.writeStored(requestKey, f.intent), true); assert.equal(f.client.writeStored('review-drafts:L1', f.snapshot), true);
    assert.equal([...f.values.keys()].some(key => key.includes('review-draft')), false); assert.ok(f.client.draftRecords().some(item => item.key === key));
    const other = createWorkspaceClient(activateSession({ ...f.session.state, account: { id: 'U2', username: 'bob', displayName: 'Bob', disabled: false }, sessionContext: 'session-two' }));
    assert.equal(f.session.memory.size, 0); for (const name of [key, requestKey, 'review-drafts:L1']) { assert.equal(other.readStored(name, null), null); assert.equal(f.client.readStored(name, null), null); }
    assert.equal(f.client.writeStored(key, draft), false);
  } finally { f.close(); }
});

test('request fence uses Interact for private saves, View for discard, and rejects queued publication before fetch', async () => {
  const f = fixture(); let calls = 0; try {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { calls++; return new Response(JSON.stringify({ accessEpoch: f.session.accessEpoch }), { status: 200, headers: { 'Content-Type': 'application/json' } }); } });
    await f.client.request(`/api/revisions/L1/review-drafts/${entryId}`, { method: 'PUT', id: requestId, body: f.intent.input }); assert.equal(calls, 1, 'an editor is not required to save an interacting reviewer’s draft');
    f.client.reconcileAccess({ L1: access('L1', false), F1: access('F1') }, 2, ['S1']);
    await assert.rejects(f.client.request(`/api/revisions/L1/review-drafts/${entryId}`, { method: 'PUT', id: requestId, body: f.intent.input }), /Permission/); assert.equal(calls, 1);
    await f.client.request(`/api/revisions/L1/review-drafts/${entryId}/discard`, { method: 'POST', id: requestId, body: { expectedEntryVersion: 1, expectedAccessEpoch: 2 } }); assert.equal(calls, 2);
    await assert.rejects(f.client.request('/api/revisions/L1/review-drafts/publish', { method: 'POST', id: requestId, body: {}, queued: true }), /cannot submit from the outbox/); assert.equal(calls, 2);
  } finally { f.close(); }
});
