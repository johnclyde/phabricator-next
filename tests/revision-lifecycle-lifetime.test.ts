import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import { DEFAULT_REVISION_LIFECYCLE_CONFIG, revisionLifecycleActions, revisionLifecycleInput, type RevisionLifecycleSnapshot } from '../shared/revision-lifecycle.ts';
import type { LifecycleReading } from '../client/revision-lifecycle.ts';

const path = '/api/revisions/D1/lifecycle', key = 'revision-lifecycle:D1', draftKey = 'revision-lifecycle-draft:D1', requestKey = 'revision-lifecycle-request:D1';
const input = revisionLifecycleInput({ action: 'plan_changes', expectedLifecycleVersion: 0, expectedAuthorVersion: 0, expectedReviewerVersion: 0, expectedVersion: 1, expectedVersionId: 'version-one', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 1, expectedConfigId: 'b'.repeat(64), expectedEvidenceSha256: 'c'.repeat(64), message: 'Original exact decision' });
const intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'D1', body: input, draft: input };
const access = (id: string, edit = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact: false, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'No one' });
const base = { reviewers: { version: 0, accepting: 0, rejecting: 0, olderRejecting: 0, blocking: 0, acceptance: null }, lifecycle: { revisionId: 'D1', version: 0, status: 'needs_review' as const, reviewStarted: true, closedFromAccepted: null, resumeAcceptanceHead: null, updatedAt: null }, head: { versionId: 'version-one', number: 1, contentHash: 'a'.repeat(64) }, authorship: { version: 0, author: { principalId: 'U1', displayName: 'Private lifecycle author' } }, evidence: { sha256: 'c'.repeat(64), reviewIds: [], errorCount: 0 }, config: { ...DEFAULT_REVISION_LIFECYCLE_CONFIG }, configId: 'b'.repeat(64) };
const snapshot: RevisionLifecycleSnapshot = { ...base, reviewers: { version: 0, accepting: 0, rejecting: 0, olderRejecting: 0, blocking: 0, acceptance: null }, access: access('D1'), accessEpoch: 1, actions: revisionLifecycleActions(base, 'U1') };
const reading: LifecycleReading = { snapshot, history: { revisionId: 'D1', lifecycleVersion: 0, transactions: [], nextBefore: null, accessEpoch: 1 } };
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const session = activateSession({ mode, workspaceId: 'revision-lifecycle', account: mode === 'password' ? { id: 'U1', username: 'author', displayName: 'Author', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session); client.reconcileAccess({ D1: access('D1'), F1: access('F1'), R1: access('R1') }, 1, ['S1']); assert.equal(client.writeStored(key, reading), true);
  return { client, session, entries, events, failWrites() { quota = true; }, removeElsewhere() { const storageKey = client.storageKey(key); entries.delete(storageKey); const event = new Event('storage'); Object.assign(event, { key: storageKey, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('lifecycle snapshots are read-only accessible, but fresh actions and exact retries never enter the outbox or bypass edit', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let calls = 0;
  try {
    current.client.reconcileAccess({ D1: access('D1', false) }, 1, ['S1']); globalThis.fetch = async () => { calls++; return Response.json(snapshot); };
    assert.deepEqual(await current.client.request(path), snapshot); assert.equal(canQueue(path, 'POST', input), false);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id, queued: true }), /explicit online save/);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id }), /Permission/); assert.equal(calls, 1); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('late lifecycle and history payloads retire after epoch, historical File, repository or cross-tab changes', async () => {
  for (const cause of ['epoch', 'file', 'repository', 'tab'] as const) {
    const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      current.client.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' }, versions: [{ assets: [{ fileId: 'F1' }] }, { assets: [] }] });
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return response; };
      const pending = current.client.request(path + '/history'); await new Promise<void>(resolve => setImmediate(resolve));
      if (cause === 'epoch') current.client.reconcileAccess({ D1: access('D1') }, 2, ['S1']); else if (cause === 'tab') current.removeElsewhere(); else current.client.retireUnavailableObject(cause === 'file' ? 'F1' : 'R1');
      assert.equal(signal?.aborted, true); release(reading.history); await assert.rejects(pending, (error: unknown) => error instanceof RequestError);
      assert.equal(current.client.readStored(key, null), null); assert.equal([...current.entries.values()].some(value => value.includes('Private lifecycle author')), false);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('edit loss retains exact submitted action and both durable and newer quota-memory drafts', () => {
  const current = fixture();
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent); current.failWrites(); const newer = { ...input, message: 'Newer unsent intention' }; assert.equal(current.client.writeStored(draftKey, newer), false);
    current.client.reconcileAccess({ D1: access('D1', false) }, 2, ['S1']);
    const held = current.client.quarantinedDrafts(); assert.deepEqual(held.find(item => item.key === requestKey)?.value, intent);
    assert.equal(held.filter(item => item.key.startsWith(draftKey)).length, 2); assert.ok(held.some(item => JSON.stringify(item.value) === JSON.stringify(newer)));
    assert.equal(current.client.unavailableObject('D1'), false); current.client.reconcileAccess({ D1: access('D1') }, 3, ['S1']); assert.equal(current.client.draftIsHeld(requestKey), true);
  } finally { current.close(); }
});

test('successful exact cleanup preserves newer drafts and rejects mixed or stale cached lifecycle versions', () => {
  const current = fixture();
  try {
    current.client.writeStored(requestKey, intent); current.client.writeStored(draftKey, { ...input, message: 'Later draft' });
    assert.equal(current.client.removeStoredIfEqual(requestKey, intent), true); current.client.removeStoredIfEqual(draftKey, input); assert.equal(current.client.readStored<{ message: string }>(draftKey, input).message, 'Later draft');
    assert.equal(current.client.writeStored(key, { ...reading, history: { ...reading.history, lifecycleVersion: 1 } }), false);
    assert.equal(current.client.writeStored(key, { ...reading, snapshot: { ...snapshot, accessEpoch: undefined } }), false);
    current.client.reconcileAccess({ D1: access('D1') }, 2, ['S1']); assert.equal(current.client.writeStored(key, reading), false);
  } finally { current.close(); }
});

test('lifecycle mutations have no lost-access bypass and session replacement erases password intents', async () => {
  for (const cause of ['object', 'session'] as const) {
    const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined;
    try {
      current.client.writeStored(requestKey, intent); globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
      const pending = current.client.request(path, { method: 'POST', body: input, id: intent.id });
      if (cause === 'object') current.client.retireUnavailableObject('D1'); else activateSession({ mode: 'password', workspaceId: 'revision-lifecycle', account: { id: 'U2', username: 'next', displayName: 'Next', disabled: false }, sessionContext: 'new', csrfToken: 'new', expiresAt: null });
      assert.equal(signal?.aborted, true); release(Response.json({ revisionId: 'D1', saved: true, accessLost: true, accessEpoch: 2 })); await assert.rejects(pending, cause === 'session' ? SessionChangedError : RequestError);
      assert.equal(current.entries.size, 0);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});
