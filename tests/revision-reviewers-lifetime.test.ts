import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient, RequestError } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import { prepareReviewerDraft, type ReviewerReading } from '../client/revision-reviewers.ts';
import { snapshot as example, history as exampleHistory } from './revision-reviewers-client-fixture.ts';

const path = '/api/revisions/P1/reviewers', key = 'revision-reviewers:P1', draftKey = 'revision-reviewer-draft:P1', requestKey = 'revision-reviewer-request:P1';
const input = { ...prepareReviewerDraft(example, 'accept'), expectedAccessEpoch: 1, message: 'Original exact decision' };
const memberInput = { ...prepareReviewerDraft(example, 'add', 'U3'), expectedAccessEpoch: 1 };
const intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'P1', body: input, draft: input };
const access = (id: string, edit = true, interact = true): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit, interact, managePolicy: edit }, viewLabel: 'Workspace', editLabel: 'Author', interactLabel: 'Workspace' });
const snapshot = { ...example, access: access('P1'), accessEpoch: 1 };
const reading: ReviewerReading = { snapshot, history: { ...exampleHistory, accessEpoch: 1 } };
function fixture(mode: 'local' | 'password' = 'local') {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), win = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const entries = new Map<string, string>(), events = new EventTarget(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
  const session = activateSession({ mode, workspaceId: 'revision-reviewer', account: mode === 'password' ? { id: 'U1', username: 'author', displayName: 'Author', disabled: false } : null, sessionContext: mode === 'password' ? 'context' : null, csrfToken: mode === 'password' ? 'csrf' : null, expiresAt: null });
  const client = createWorkspaceClient(session); client.reconcileAccess({ P1: access('P1'), F1: access('F1'), R1: access('R1') }, 1, ['S1']); assert.equal(client.writeStored(key, reading), true);
  return { client, session, entries, events, failWrites() { quota = true; }, removeElsewhere() { const storageKey = client.storageKey(key); entries.delete(storageKey); const event = new Event('storage'); Object.assign(event, { key: storageKey, newValue: null }); events.dispatchEvent(event); }, close() { lockSession(); if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage'); if (win) Object.defineProperty(globalThis, 'window', win); else Reflect.deleteProperty(globalThis, 'window'); } };
}

test('interact-only reviewers can decide and recover, while membership remains edit-only and no action enters the outbox', async () => {
  const current = fixture('password'), previous = globalThis.fetch; let calls = 0;
  try {
    current.client.reconcileAccess({ P1: access('P1', false, true) }, 1, ['S1']); globalThis.fetch = async () => { calls++; return Response.json(snapshot); };
    assert.deepEqual(await current.client.request(path), snapshot); assert.equal(canQueue(path, 'POST', input), false);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id, queued: true }), /explicit online save/);
    await assert.rejects(current.client.request(path, { method: 'POST', body: memberInput, id: intent.id }), /Permission/);
    await current.client.request(path, { method: 'POST', body: input, id: intent.id }); assert.equal(calls, 2);
    current.client.reconcileAccess({ P1: access('P1', true, false) }, 1, ['S1']);
    await assert.rejects(current.client.request(path, { method: 'POST', body: input, id: intent.id }), /Permission/);
    await current.client.request(path, { method: 'POST', body: memberInput, id: intent.id }); assert.equal(calls, 3); assert.equal(current.entries.size, 0);
  } finally { globalThis.fetch = previous; current.close(); }
});

test('late reviewer and history payloads retire after epoch, historical File, repository or cross-tab changes', async () => {
  for (const cause of ['epoch', 'file', 'repository', 'tab'] as const) {
    const current = fixture(), previous = globalThis.fetch; let release!: (value: unknown) => void, signal: AbortSignal | undefined;
    try {
      current.client.writeStored('revision:P1', { revision: { id: 'P1', repositoryId: 'R1' }, versions: [{ assets: [{ fileId: 'F1' }] }, { assets: [] }] });
      const response = Response.json({}); Object.defineProperty(response, 'json', { value: () => new Promise(resolve => { release = resolve; }) }); globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return response; };
      const pending = current.client.request(path + '/history'); await new Promise<void>(resolve => setImmediate(resolve));
      if (cause === 'epoch') current.client.reconcileAccess({ P1: access('P1') }, 2, ['S1']); else if (cause === 'tab') current.removeElsewhere(); else current.client.retireUnavailableObject(cause === 'file' ? 'F1' : 'R1');
      assert.equal(signal?.aborted, true); release(reading.history); await assert.rejects(pending, (error: unknown) => error instanceof RequestError);
      assert.equal(current.client.readStored(key, null), null); assert.equal([...current.entries.values()].some(value => value.includes('Current Author')), false);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('interact loss retains exact submitted action and both durable and newer quota-memory drafts', () => {
  const current = fixture();
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent); current.failWrites(); const newer = { ...input, message: 'Newer unsent intention' }; assert.equal(current.client.writeStored(draftKey, newer), false);
    current.client.reconcileAccess({ P1: access('P1', true, false) }, 2, ['S1']);
    const held = current.client.quarantinedDrafts(); assert.deepEqual(held.find(item => item.key === requestKey)?.value, intent);
    assert.equal(held.filter(item => item.key.startsWith(draftKey)).length, 2); assert.ok(held.some(item => JSON.stringify(item.value) === JSON.stringify(newer)));
    assert.equal(current.client.unavailableObject('P1'), false); current.client.reconcileAccess({ P1: access('P1') }, 3, ['S1']); assert.equal(current.client.draftIsHeld(requestKey), true);
  } finally { current.close(); }
});

test('successful exact cleanup preserves newer drafts and rejects mixed or stale cached reviewer versions', () => {
  const current = fixture();
  try {
    current.client.writeStored(requestKey, intent); current.client.writeStored(draftKey, { ...input, message: 'Later draft' });
    assert.equal(current.client.removeStoredIfEqual(requestKey, intent), true); current.client.removeStoredIfEqual(draftKey, input); assert.equal(current.client.readStored<{ message: string }>(draftKey, input).message, 'Later draft');
    assert.equal(current.client.writeStored(key, { ...reading, history: { ...reading.history, reviewerVersion: 1 } }), false);
    assert.equal(current.client.writeStored(key, { ...reading, snapshot: { ...snapshot, accessEpoch: undefined } }), false);
    current.client.reconcileAccess({ P1: access('P1') }, 2, ['S1']); assert.equal(current.client.writeStored(key, reading), false);
  } finally { current.close(); }
});

test('reviewer mutations have no lost-access bypass and session replacement erases password intents', async () => {
  for (const cause of ['object', 'session'] as const) {
    const current = fixture('password'), previous = globalThis.fetch; let release!: (response: Response) => void, signal: AbortSignal | undefined;
    try {
      current.client.writeStored(requestKey, intent); globalThis.fetch = async (_url, init) => { signal = init!.signal as AbortSignal; return new Promise(resolve => { release = resolve; }); };
      const pending = current.client.request(path, { method: 'POST', body: input, id: intent.id });
      if (cause === 'object') current.client.retireUnavailableObject('P1'); else activateSession({ mode: 'password', workspaceId: 'revision-reviewer', account: { id: 'U2', username: 'next', displayName: 'Next', disabled: false }, sessionContext: 'new', csrfToken: 'new', expiresAt: null });
      assert.equal(signal?.aborted, true); release(Response.json({ revisionId: 'P1', saved: true, accessLost: true, accessEpoch: 2 })); await assert.rejects(pending, cause === 'session' ? SessionChangedError : RequestError);
      assert.equal(current.entries.size, 0);
    } finally { globalThis.fetch = previous; current.close(); }
  }
});

test('edit loss leaves decision drafts usable and holds membership drafts without inheriting principal dependencies', () => {
  const current = fixture();
  try {
    current.client.writeStored(draftKey, input); current.client.writeStored(requestKey, intent);
    current.client.reconcileAccess({ P1: access('P1', false, true) }, 2, ['S1']);
    assert.deepEqual(current.client.readStored(draftKey, null), input); assert.equal(current.client.draftIsHeld(requestKey), false);
    current.client.writeStored(draftKey, memberInput); assert.equal(current.client.draftIsHeld(draftKey), true);
    assert.equal(current.client.unavailableObject('P1'), false);
  } finally { current.close(); }
});

test('an exact membership request stays recoverable when a newer decision draft loses Interact', async () => {
  const current = fixture(), previous = globalThis.fetch;
  try {
    const membershipIntent = { ...intent, body: memberInput, draft: memberInput };
    current.client.writeStored(requestKey, membershipIntent); current.client.writeStored(draftKey, input);
    current.client.reconcileAccess({ P1: access('P1', true, false) }, 2, ['S1']);
    assert.equal(current.client.draftIsHeld(draftKey), true); assert.equal(current.client.draftIsHeld(requestKey), false);
    let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({ accessEpoch: 2 }); };
    await current.client.request(path, { method: 'POST', body: memberInput, id: intent.id }); assert.equal(calls, 1);
    assert.ok(current.client.quarantinedDrafts().some(item => item.key === draftKey));
  } finally { globalThis.fetch = previous; current.close(); }
});
