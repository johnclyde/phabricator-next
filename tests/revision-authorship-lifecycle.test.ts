import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import { revisionAuthorInput, type RevisionAuthorInput } from '../shared/revision-authorship.ts';
import type { AuthorReading } from '../client/revision-authorship.ts';

const path = '/api/revisions/D1/authorship', key = 'revision-authorship:D1', draftKey = 'revision-author-draft:D1', requestKey = 'revision-author-request:D1';
let navigatorDescriptor: PropertyDescriptor | undefined;
beforeEach(() => { navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator'); Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, commit: () => unknown) => commit() } } }); });
afterEach(() => { if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); else Reflect.deleteProperty(globalThis, 'navigator'); });
const input = revisionAuthorInput({ action: 'assign', authorId: 'U2', expectedAuthorVersion: 0, expectedVersion: 1, expectedVersionId: 'version-one', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 1, message: 'Original exact message' });
const hash = (body: RevisionAuthorInput) => createHash('sha256').update(JSON.stringify(revisionAuthorInput(body))).digest('hex');
const intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'D1', body: input, draft: input };
const ack = { revisionId: 'D1', operationId: 'stored-operation', inputSha256: hash(input), saved: true, accessLost: true, accessEpoch: 2 };
const access = (id: string, edit = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact: false, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'No one' });
const snapshot: AuthorReading = { snapshot: { authorship: { revisionId: 'D1', version: 0, author: { principalId: 'U1', displayName: 'Private author name' }, originalAuthor: { principalId: 'U1', displayName: 'Private author name' }, updatedAt: null }, head: { versionId: 'version-one', number: 1, contentHash: 'a'.repeat(64) }, status: 'needs_review', closeOnAccept: false, reviewerVersion: 0, lifecycleVersion: 0, access: access('D1'), accessEpoch: 1 }, history: { revisionId: 'D1', authorVersion: 0, transactions: [], nextBefore: null, accessEpoch: 1 } };
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const session = activateSession({ mode, workspaceId: 'revision-authorship', account: mode === 'password' ? { id: 'U1', username: 'author', displayName: 'Author', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session); client.reconcileAccess({ D1: access('D1'), F1: access('F1'), R1: access('R1') }, 1, ['S1']); client.writeStored(key, snapshot);
  return { client, session, entries, events, failWrites() { quota = true; }, restoreWrites() { quota = false; }, removeElsewhere() { const storageKey = client.storageKey(key); entries.delete(storageKey); const event = new Event('storage'); Object.assign(event, { key: storageKey, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('authorship reading is available without edit but writes never enter or replay from the outbox', async () => {
  const current = fixture('password'), previous = globalThis.fetch;
  try {
    current.client.reconcileAccess({ D1: access('D1', false) }, 1, ['S1']); globalThis.fetch = async () => Response.json(snapshot.snapshot);
    assert.deepEqual(await current.client.request(path), snapshot.snapshot); assert.equal(canQueue(path, 'POST', input), false);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id, queued: true }), /explicit online save/);
    assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('late decoded authorship pages retire on access, source dependency or cross-tab change', async () => {
  for (const cause of ['epoch', 'file', 'repository', 'tab'] as const) {
    const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      current.client.writeStored('revision:D1', { revision: { id: 'D1', repositoryId: 'R1' }, versions: [{ assets: [{ fileId: 'F1' }] }, { assets: [] }] });
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) });
      globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return response; };
      const pending = current.client.request(path + '/history'); await new Promise<void>(resolve => setImmediate(resolve));
      if (cause === 'epoch') current.client.reconcileAccess({ D1: access('D1') }, 2, ['S1']); else if (cause === 'tab') current.removeElsewhere(); else current.client.retireUnavailableObject(cause === 'file' ? 'F1' : 'R1');
      assert.equal(signal?.aborted, true); release(snapshot.history); await assert.rejects(pending, (error: unknown) => error instanceof RequestError);
      assert.equal(current.client.readStored(key, null), null); assert.equal([...current.entries.values()].some(value => value.includes('Private author name')), false);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('only a digest-bound handoff acknowledgement survives object retirement and still retires drafts', async () => {
  for (const valid of [true, false]) {
    const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined;
    try {
      current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent);
      globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
      const pending = current.client.request(path, { method: 'POST', body: input, id: intent.id }); current.client.retireUnavailableObject('D1');
      assert.equal(signal?.aborted, false, 'object retirement must permit only the eventual content-free acknowledgement');
      release(Response.json(valid ? ack : { ...ack, inputSha256: 'f'.repeat(64) }));
      if (valid) assert.deepEqual(await pending, ack); else await assert.rejects(pending, /different request|unavailable/);
      assert.equal(current.client.readStored(key, null), null); assert.equal(current.client.draftIsHeld(requestKey), true); assert.deepEqual(current.client.quarantinedDrafts().find(item => item.key === draftKey)?.value, input);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('exact self-handoff recovery can be sent explicitly after view or edit retirement but cannot leak full historical metadata', async () => {
  const current = fixture('password'), previous = globalThis.fetch;
  try {
    current.client.retireUnavailableObject('D1'); globalThis.fetch = async () => Response.json(ack);
    assert.deepEqual(await current.client.request(path, { method: 'POST', body: input, id: intent.id }), ack);
    const full = { revisionId: 'D1', operationId: 'stored-operation', inputSha256: hash(input), accessEpoch: 2, transaction: { id: 'transaction', operationId: 'stored-operation', revisionId: 'D1', authorVersion: 1, action: 'assign', previousAuthor: { principalId: 'U1', displayName: 'Private author name' }, author: { principalId: 'U2', displayName: 'Next' }, head: snapshot.snapshot.head, message: input.message, attribution: { principalId: 'U1', displayName: 'Author', credentialId: null, requestId: 'request' }, createdAt: '2026-10-11T00:00:00Z' } };
    globalThis.fetch = async () => Response.json(full); await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id }), /unavailable/);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('confirmation clears exact held submitted copies while preserving a newer quota-memory draft', async () => {
  const current = fixture();
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent);
    const newer = { ...input, authorId: 'U3', message: 'Newer unsent work' }; current.failWrites(); assert.equal(current.client.writeStored(draftKey, newer), false);
    current.client.reconcileAccess({ D1: access('D1', false) }, 2, ['S1']);
    assert.equal(current.client.quarantinedDrafts().filter(item => item.key.startsWith(draftKey)).length, 2);
    current.restoreWrites(); await current.client.acknowledgeRevisionAuthorIntent(requestKey, intent, draftKey, input);
    assert.equal(current.client.quarantinedDrafts().some(item => item.key === requestKey), false);
    const remaining = current.client.quarantinedDrafts().filter(item => item.key.startsWith(draftKey)); assert.equal(remaining.length, 1); assert.deepEqual(remaining[0]!.value, newer);
    assert.equal(current.entries.get(current.client.storageKey(requestKey)), undefined);
  } finally { current.close(); }
});

test('confirmation preserves a different submitted request and different durable recovery from another tab', async () => {
  const current = fixture();
  try {
    const newer = { ...input, message: 'Next request' }, other = { ...intent, id: 'other-request', body: newer, draft: newer };
    current.client.writeStored(requestKey, other); current.client.writeStored(draftKey, newer); current.client.retireUnavailableObject('D1');
    await current.client.acknowledgeRevisionAuthorIntent(requestKey, intent, draftKey, input);
    assert.deepEqual(current.client.quarantinedDrafts().find(item => item.key === requestKey)?.value, other); assert.deepEqual(current.client.quarantinedDrafts().find(item => item.key === draftKey)?.value, newer);
  } finally { current.close(); }
});

test('authorship caches require consistent versions and epoch; session replacement rejects even valid minimal acknowledgement', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    assert.equal(current.client.writeStored(key, { ...snapshot, history: { ...snapshot.history, authorVersion: 1 } }), false);
    assert.equal(current.client.writeStored(key, { ...snapshot, snapshot: { ...snapshot.snapshot, accessEpoch: undefined } }), false);
    current.client.reconcileAccess({ D1: access('D1') }, 2, ['S1']); assert.equal(current.client.writeStored(key, snapshot), false);
    current.client.writeStored(requestKey, intent); globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
    const pending = current.client.request(path, { method: 'POST', body: input, id: intent.id });
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'revision-authorship', account: { id: 'U2', username: 'next', displayName: 'Next', disabled: false }, sessionContext: 'new', csrfToken: 'new', expiresAt: null }));
    release(Response.json(ack)); await assert.rejects(pending, SessionChangedError); assert.equal(next.readStored(requestKey, null), null); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
