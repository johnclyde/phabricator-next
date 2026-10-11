import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { DependencySnapshot } from '../client/revision-dependencies.ts';

const time = '2026-10-11T12:00:00Z', path = '/api/revisions/D1/dependencies', key = 'revision-dependencies:D1';
const draftKey = 'revision-dependency-draft:D1', requestKey = 'revision-dependency-request:D1';
const input = { direction: 'parents' as const, add: ['P2'], remove: [], expectedRelationshipVersion: 0, expectedAccessEpoch: 1 };
const intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'D1', body: input, draft: input };
const snapshot: DependencySnapshot = {
  revisionId: 'D1', relationshipVersion: 0, accessEpoch: 1,
  parents: { revisionId: 'D1', direction: 'parents', relationshipVersion: 0, accessEpoch: 1, revisions: [{ id: 'P2', title: 'Private peer title', kind: 'paper', status: 'needs_review', currentVersion: 1, updatedAt: time }], nextAfter: null },
  children: { revisionId: 'D1', direction: 'children', relationshipVersion: 0, accessEpoch: 1, revisions: [], nextAfter: null },
  history: { revisionId: 'D1', relationshipVersion: 0, accessEpoch: 1, transactions: [], nextBefore: null },
};
const access = (id: string, edit = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact: true, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
function fixture(mode: 'local' | 'password' = 'local', editable = true) {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const session = activateSession({ mode, workspaceId: 'revision-dependencies', account: mode === 'password' ? { id: 'U1', username: 'reader', displayName: 'Reader', disabled: false } : null, sessionContext: mode === 'password' ? 'original-context' : null, csrfToken: mode === 'password' ? 'original-csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session);
  client.reconcileAccess({ D1: access('D1', editable), P2: access('P2', false), L3: access('L3'), F1: access('F1'), R1: access('R1') }, 1, ['S1']);
  client.writeStored(key, snapshot);
  return { client, session, entries, events, failWrites() { quota = true; }, removeElsewhere() { const storageKey = client.storageKey(key), oldValue = entries.get(storageKey) ?? null; entries.delete(storageKey); const event = new Event('storage'); Object.assign(event, { key: storageKey, oldValue, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('dependency readers can load pages but changes never enter the outbox or bypass source edit', async () => {
  const current = fixture('password', false), previous = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json(snapshot.parents); };
    assert.deepEqual(await current.client.request(path + '?direction=parents'), snapshot.parents);
    assert.equal(canQueue(path, 'POST', input), false);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id, queued: true }), /explicit online save/);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id }, input.add), /Permission/);
    assert.equal(calls, 1); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('peer view loss retires labels and holds original intent without making the source revision unavailable', () => {
  const current = fixture();
  try {
    const { client, session } = current;
    client.writeStored(draftKey, input); client.writeStored(requestKey, intent);
    assert.equal(session.revisionFiles.has('D1'), false, 'relationship IDs do not become source dependencies');
    client.retireUnavailableObject('P2');
    assert.equal(client.unavailableObject('D1'), false); assert.equal(client.readStored(key, null), null);
    assert.equal(client.draftIsHeld(draftKey), true); assert.equal(client.draftIsHeld(requestKey), true);
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === draftKey)?.value, input);
    assert.deepEqual(client.quarantinedDrafts().find(item => item.key === requestKey)?.value, intent);
    assert.equal([...current.entries.values()].some(value => value.includes('Private peer title')), false);
    client.reconcileAccess({ D1: access('D1'), P2: access('P2') }, 2, ['S1']);
    assert.equal(client.draftIsHeld(requestKey), true, 'restored permission does not silently resubmit or change original pins');
  } finally { current.close(); }
});

test('source edit loss preserves durable and quota-memory relationship selections independently', () => {
  const current = fixture();
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent);
    current.failWrites(); const later = { ...input, add: ['L3'], expectedRelationshipVersion: 2 };
    assert.equal(current.client.writeStored(draftKey, later), false);
    current.client.reconcileAccess({ D1: access('D1', false), P2: access('P2'), L3: access('L3') }, 2, ['S1']);
    const held = current.client.quarantinedDrafts().filter(item => item.key === draftKey || item.key === `${draftKey}:unsaved-memory`);
    assert.equal(held.length, 2); assert.ok(held.some(item => JSON.stringify(item.value) === JSON.stringify(input))); assert.ok(held.some(item => JSON.stringify(item.value) === JSON.stringify(later)));
    assert.deepEqual(current.client.quarantinedDrafts().find(item => item.key === requestKey)?.value, intent);
    assert.equal(current.client.unavailableObject('D1'), false);
  } finally { current.close(); }
});

test('dependency reads for every revision kind discard late decoded pages after authority retirement', async () => {
  for (const source of ['D1', 'P2', 'L3']) {
    const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) });
      globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return response; };
      const pending = current.client.request(`/api/revisions/${source}/dependencies?direction=parents`); await new Promise<void>(resolve => setImmediate(resolve));
      current.client.reconcileAccess({ D1: access('D1'), P2: access('P2'), L3: access('L3') }, 2, ['S1']);
      assert.equal(signal?.aborted, true); release({ ...snapshot.parents, revisionId: source });
      await assert.rejects(pending, (error: unknown) => error instanceof RequestError && error.code === 'ACCESS_CHANGED');
      assert.equal(current.client.readStored(key, null), null); assert.equal([...current.entries.values()].some(value => value.includes('Private peer title')), false);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('cross-tab dependency snapshot retirement cancels pending history and rejects mismatched or stale cache families', async () => {
  const current = fixture(), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined;
  try {
    globalThis.fetch = async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
    const pending = current.client.request(path + '/history'); current.removeElsewhere();
    assert.equal(signal?.aborted, true); release(Response.json(snapshot.history)); await assert.rejects(pending, /visibility changed|Access changed/);
    assert.equal(current.client.readStored(key, null), null);
    assert.equal(current.client.writeStored(key, { ...snapshot, children: { ...snapshot.children, relationshipVersion: 1 } }), false);
    assert.equal(current.client.writeStored(key, { ...snapshot, accessEpoch: undefined }), false);
    current.client.reconcileAccess({ D1: access('D1'), P2: access('P2') }, 2, ['S1']); assert.equal(current.client.writeStored(key, snapshot), false);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('password session changes erase relation labels and submitted intents and reject late mutation replies', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void;
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent);
    globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
    const pending = current.client.request(path, { method: 'POST', body: input, id: intent.id }, input.add);
    const next = createWorkspaceClient(activateSession({ mode: 'password', workspaceId: 'revision-dependencies', account: { id: 'U2', username: 'other', displayName: 'Other', disabled: false }, sessionContext: 'next-context', csrfToken: 'next-csrf', expiresAt: null }));
    release(Response.json({ revisionId: 'D1', operationId: 'old-operation', accessEpoch: 1 })); await assert.rejects(pending, SessionChangedError);
    for (const name of [key, draftKey, requestKey]) assert.equal(next.readStored(name, null), null);
    assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});
