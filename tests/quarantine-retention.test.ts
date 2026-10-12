import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceClient, retainedDraftLockName } from '../client/offline.ts';
import { activateSession, lockSession, SessionChangedError } from '../client/session.ts';
import type { ObjectAccess } from '../shared/policy.ts';

const access = (id: string): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });
const key = 'revision-author-draft:D1', requestKey = 'revision-author-request:D1';
const first = { message: 'First draft — café 😀\r\n  ' }, second = { message: 'Other tab’s independent work' };
const intent = { id: 'confirmed-request', revisionId: 'D1', body: first, draft: first };

function fixture() {
  const descriptors = Object.fromEntries(['localStorage', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const entries = new Map<string, string>(), pending: { name: string; run: () => void }[] = [], calls: string[] = [];
  let quota = false, enabled = true;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(name, value); },
    removeItem: (name: string) => entries.delete(name),
  } });
  const locks = { request: (name: string, commit: () => unknown) => { calls.push(name); return new Promise((resolve, reject) => pending.push({ name, run: () => { try { resolve(commit()); } catch (error) { reject(error); } } })); } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { get locks() { return enabled ? locks : undefined; } } });
  const state = { mode: 'local' as const, workspaceId: 'quarantine-retention', account: null, sessionContext: null, csrfToken: null, expiresAt: null };
  const session = activateSession(state), client = createWorkspaceClient(session);
  client.reconcileAccess({ D1: access('D1'), T1: access('T1') }, 1, ['S1']);
  const settle = async <T,>(promise: Promise<T>): Promise<T> => {
    let done = false; promise.then(() => { done = true; }, () => { done = true; });
    for (let count = 0; !done && count < 30; count++) { pending.shift()?.run(); await new Promise<void>(resolve => setImmediate(resolve)); }
    assert.equal(done, true, 'bounded lock scheduling completed'); return promise;
  };
  return { client, session, entries, calls, pending, settle,
    physical: (name: string) => { const json = entries.get(client.storageKey(name)); return json === undefined ? null : JSON.parse(json) as unknown; },
    elsewhere: (name: string, value: unknown) => entries.set(client.storageKey(name), JSON.stringify(value)),
    reload: () => createWorkspaceClient(activateSession(state)),
    failWrites: () => { quota = true; }, allowWrites: () => { quota = false; }, disableLocks: () => { enabled = false; },
    close: () => { lockSession(); for (const [name, descriptor] of Object.entries(descriptors)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}

test('different held values at the same logical key survive reload with independent identities', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.retireUnavailableObject('D1');
    assert.deepEqual(f.physical(key), first, 'automatic quarantine preserves the original without an unlocked delete');
    const selected = f.client.quarantinedDrafts()[0]!;
    f.elsewhere(key, second);
    const records = f.client.quarantinedDrafts().filter(row => row.key === key);
    assert.equal(records.length, 2); assert.equal(new Set(records.map(row => row.recoveryId)).size, 2);
    assert.deepEqual(records.find(row => row.recoveryId === selected.recoveryId)?.value, first);
    const restored = f.reload();
    assert.equal(restored.readStored(key, null), null); assert.equal(restored.draftIsHeld(key), true);
    assert.deepEqual(restored.quarantinedDrafts().filter(row => row.key === key).map(row => row.value), [first, second]);
  } finally { f.close(); }
});

test('clicked recovery discard uses the writer lock and preserves a later same-key original and held record', async () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.retireUnavailableObject('D1');
    const selected = f.client.quarantinedDrafts()[0]!, discarding = f.client.discardQuarantinedDraft(selected);
    assert.equal(f.pending[0]!.name, f.client.storageKey(retainedDraftLockName(key)!));
    assert.deepEqual(f.physical(key), first, 'nothing is removed before the writer lock');
    f.elsewhere(key, second); await f.settle(discarding);
    assert.deepEqual(f.physical(key), second);
    const left = f.client.quarantinedDrafts().filter(row => row.key === key);
    assert.equal(left.length, 1); assert.deepEqual(left[0]!.value, second);
    assert.notEqual(left[0]!.recoveryId, selected.recoveryId);
  } finally { f.close(); }
});

test('legacy string discard pins its record before waiting rather than resolving the latest logical key', async () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.retireUnavailableObject('D1');
    const discarding = f.client.discardQuarantinedDraft(key); f.elsewhere(key, second);
    await f.settle(discarding); assert.deepEqual(f.client.quarantinedDrafts().map(row => row.value), [second]);
  } finally { f.close(); }
});

test('another tab discarding the last held record cannot release a different original observed later', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.retireUnavailableObject('D1');
    const selected = f.client.quarantinedDrafts()[0]!;
    f.client.reconcileAccess({ D1: access('D1'), T1: access('T1') }, 2, ['S1']);
    f.elsewhere(key, second); f.entries.delete(f.client.storageKey(`quarantined-drafts:${selected.recoveryId}`));
    assert.deepEqual(f.client.quarantinedDrafts().map(row => row.value), [second]);
    assert.equal(f.client.readStored(key, null), null); assert.equal(f.client.draftIsHeld(key), true);
  } finally { f.close(); }
});

test('durable quarantine cleanup without Web Locks preserves original and recovery copies', async () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.retireUnavailableObject('D1'); f.disableLocks();
    const selected = f.client.quarantinedDrafts()[0]!, before = new Map(f.entries);
    await assert.rejects(f.client.discardQuarantinedDraft(selected), /Web Locks/);
    assert.deepEqual(f.entries, before); assert.deepEqual(f.client.quarantinedDrafts(), [selected]);
    await assert.rejects(f.client.acknowledgeRevisionAuthorIntent(requestKey, intent, key, first), /Web Locks/);
    assert.deepEqual(f.entries, before);
  } finally { f.close(); }
});

test('queued recovery discard cannot delete from a retired session', async () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.retireUnavailableObject('D1');
    const discarding = f.client.discardQuarantinedDraft(f.client.quarantinedDrafts()[0]!);
    const before = new Map(f.entries); lockSession();
    await assert.rejects(f.settle(discarding), SessionChangedError); assert.deepEqual(f.entries, before);
  } finally { f.close(); }
});

test('quota recovery retains differing held originals until every immutable copy is saved', () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.failWrites(); f.client.retireUnavailableObject('D1');
    f.elsewhere(key, second);
    assert.deepEqual(f.client.quarantinedDrafts().filter(row => row.key === key).map(row => row.value), [first, second]);
    assert.ok(f.client.quarantineWarning()); f.allowWrites(); assert.equal(f.client.retryQuarantineStorage(), true);
    assert.deepEqual(f.reload().quarantinedDrafts().filter(row => row.key === key).map(row => row.value), [first, second]);
  } finally { f.close(); }
});

test('legacy physical recovery paths keep stable identities and remain independently discardable', async () => {
  const f = fixture();
  try {
    const legacy = `quarantined-drafts:${encodeURIComponent(key)}`;
    f.elsewhere(legacy, { key, objectId: 'D1', value: first, reason: 'Legacy recovery' });
    f.elsewhere(key, second);
    const records = f.client.quarantinedDrafts(), selected = records.find(row => row.value && JSON.stringify(row.value) === JSON.stringify(first))!;
    assert.equal(selected.recoveryId, encodeURIComponent(key));
    await f.settle(f.client.discardQuarantinedDraft(selected));
    assert.equal(f.physical(legacy), null); assert.deepEqual(f.physical(key), second);
    assert.deepEqual(f.client.quarantinedDrafts().map(row => row.value), [second]);
  } finally { f.close(); }
});

test('outbox recovery removes only the clicked exact mutation under the outbox writer lock', async () => {
  const f = fixture();
  try {
    const queued = { id: 'same-id', path: '/api/tasks/T1/comments', method: 'POST', body: { body: 'First comment' }, label: 'Comment', createdAt: 'now' };
    f.client.writeStored('outbox', [queued]); f.client.retireUnavailableObject('T1');
    const selected = f.client.quarantinedDrafts().find(row => row.key === 'outbox:same-id')!;
    const newer = { ...queued, body: { body: 'Other tab mutation with same ID' } }, unrelated = { ...queued, id: 'unrelated' };
    const discarding = f.client.discardQuarantinedDraft(selected); f.elsewhere('outbox', [newer, unrelated]);
    assert.equal(f.pending[0]!.name, f.client.storageKey('outbox-write'));
    await f.settle(discarding); assert.deepEqual(f.physical('outbox'), [newer, unrelated]);
    assert.deepEqual(f.client.quarantinedDrafts().find(row => row.key === 'outbox:same-id')?.value, newer);
    assert.deepEqual(f.client.readStored('outbox', []), [unrelated]);
  } finally { f.close(); }
});

test('verified authorship handoff clears exact held copies after view loss using both writer locks', async () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.writeStored(requestKey, intent); f.client.retireUnavailableObject('D1');
    f.elsewhere(key, second); f.client.quarantinedDrafts();
    await f.settle(f.client.acknowledgeRevisionAuthorIntent(requestKey, intent, key, first));
    assert.deepEqual(f.calls, [requestKey, key].map(name => f.client.storageKey(retainedDraftLockName(name)!)));
    assert.equal(f.physical(requestKey), null); assert.deepEqual(f.physical(key), second);
    assert.deepEqual(f.client.quarantinedDrafts().map(row => row.value), [second]);
  } finally { f.close(); }
});

test('authorship cleanup cannot erase a same-text edit created after acknowledgement begins', async () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.writeStored(requestKey, intent);
    const cleaning = f.client.acknowledgeRevisionAuthorIntent(requestKey, intent, key, first);
    const laterEdit = f.client.retainDraft(key, first, first);
    await f.settle(cleaning); assert.equal(await laterEdit, 'saved');
    assert.deepEqual(f.physical(key), first); assert.deepEqual(f.client.readStored(key, null), first);
    assert.equal(f.physical(requestKey), null);
  } finally { f.close(); }
});

test('authorship cleanup preserves a newer edit returning to the submitted text within an existing retention generation', async () => {
  const f = fixture();
  try {
    f.client.writeStored(key, first); f.client.writeStored(requestKey, intent);
    assert.equal(await f.settle(f.client.retainDraft(key, second, first)), 'saved');
    const cleaning = f.client.acknowledgeRevisionAuthorIntent(requestKey, intent, key, first);
    const laterEdit = f.client.retainDraft(key, first, second);
    const draftWriter = f.pending.findIndex(row => row.name === f.client.storageKey(retainedDraftLockName(key)!));
    assert.notEqual(draftWriter, -1); f.pending.splice(draftWriter, 1)[0]!.run();
    assert.equal(await laterEdit, 'saved', 'the new draft saves while request cleanup is still waiting');
    await f.settle(cleaning);
    assert.deepEqual(f.physical(key), first); assert.deepEqual(f.client.readStored(key, null), first);
    assert.equal(f.physical(requestKey), null);
  } finally { f.close(); }
});

test('the same mounted editor can durably start its next action after acknowledged authorship cleanup', async () => {
  const f = fixture();
  try {
    assert.equal(await f.settle(f.client.retainDraft(key, first, null)), 'saved');
    f.client.writeStored(requestKey, intent);
    await f.settle(f.client.acknowledgeRevisionAuthorIntent(requestKey, intent, key, first));
    assert.equal(f.physical(key), null);
    assert.equal(await f.settle(f.client.retainDraft(key, second, first)), 'saved', 'the mounted hook still supplies its last submitted value');
    assert.deepEqual(f.physical(key), second); assert.equal(f.client.draftHasUnsavedMemory(key), false);
  } finally { f.close(); }
});

test('the same mounted editor can durably restart after its last quarantined copy is discarded under restored access', async () => {
  const f = fixture();
  try {
    assert.equal(await f.settle(f.client.retainDraft(key, first, null)), 'saved');
    f.client.retireUnavailableObject('D1');
    const selected = f.client.quarantinedDrafts().find(row => row.key === key)!;
    f.client.reconcileAccess({ D1: access('D1'), T1: access('T1') }, 2, ['S1']);
    await f.settle(f.client.discardQuarantinedDraft(selected));
    assert.equal(f.client.draftIsHeld(key), false); assert.equal(f.physical(key), null);
    assert.equal(await f.settle(f.client.retainDraft(key, second, first)), 'saved');
    assert.deepEqual(f.physical(key), second); assert.equal(f.client.draftHasUnsavedMemory(key), false);
  } finally { f.close(); }
});

test('authorship cleanup restart authorization never replaces a competing durable copy', async () => {
  const f = fixture(), next = { message: 'Next local action' };
  try {
    assert.equal(await f.settle(f.client.retainDraft(key, first, null)), 'saved');
    f.client.writeStored(requestKey, intent);
    const cleaning = f.client.acknowledgeRevisionAuthorIntent(requestKey, intent, key, first);
    f.elsewhere(key, second); await f.settle(cleaning);
    assert.equal(await f.settle(f.client.retainDraft(key, next, first)), 'memory');
    assert.deepEqual(f.physical(key), second); assert.deepEqual(f.client.readStored(key, null), next);
    assert.equal(f.client.draftHasUnsavedMemory(key), true);
  } finally { f.close(); }
});
