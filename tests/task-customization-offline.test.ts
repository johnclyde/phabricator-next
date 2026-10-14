import test from 'node:test';
import assert from 'node:assert/strict';
import { canQueue, createWorkspaceClient } from '../client/offline.ts';
import { activateSession, lockSession } from '../client/session.ts';
import { access } from './revision-subscriptions-client-fixture.ts';

function fixture(password = false) {
  const previous = Object.fromEntries(['localStorage', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)])), entries = new Map<string, string>(); let quota = false;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { get length() { return entries.size; }, key: (index: number) => [...entries.keys()][index] ?? null, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { if (quota) throw new Error('Quota'); entries.set(key, value); }, removeItem: (key: string) => entries.delete(key) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name: string, work: () => unknown) => work() } } });
  const session = activateSession({ mode: password ? 'password' : 'local', workspaceId: 'task-customization', account: password ? { id: 'U1', username: 'alice', displayName: 'Alice', disabled: false } : null, sessionContext: password ? 'alice-context' : null, csrfToken: password ? 'alice-csrf' : null, expiresAt: null }), client = createWorkspaceClient(session);
  client.reconcileAccess({ T1: access('T1') }, 1, ['S1']);
  return { session, client, entries, fail: () => { quota = true; }, close: () => { lockSession(); for (const [name, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } } };
}
const draft = { title: 'An authored change', description: '', status: 'blocked', priority: 'critical', points: 0.29, customFields: { court: 'Federal court', pages: 0, sealed: false }, expectedConfigVersion: 2, expectedVersion: 4, changed: ['points', 'customFields'] };

test('custom task drafts preserve exact typed values/config versions when quota fails and access is revoked', async () => {
  const f = fixture(); try {
    assert.equal(await f.client.retainDraft('task-draft:T1', draft, null), 'saved');
    f.fail(); const newer = { ...draft, customFields: { ...draft.customFields, court: 'Authored during quota failure' } };
    assert.equal(await f.client.retainDraft('task-draft:T1', newer, draft), 'memory');
    f.client.retireUnavailableObject('T1');
    assert.equal(f.client.draftIsHeld('task-draft:T1'), true);
    const retained = JSON.stringify(f.client.quarantinedDrafts());
    assert.ok(retained.includes('Federal court')); assert.ok(retained.includes('Authored during quota failure')); assert.ok(retained.includes('expectedConfigVersion')); assert.ok(retained.includes('0.29'));
    assert.equal(await f.client.removeRetainedDraftIfEqual('task-draft:T1', newer), false);
  } finally { f.close(); }
});

test('exact cleanup never removes another tab’s newer typed task draft', async () => {
  const f = fixture(); try {
    assert.equal(await f.client.retainDraft('task-draft:T1', draft, null), 'saved');
    const other = { ...draft, expectedConfigVersion: 3, customFields: { ...draft.customFields, court: 'Another tab' } };
    f.entries.set(f.client.storageKey('task-draft:T1'), JSON.stringify(other));
    await f.client.removeRetainedDraftIfEqual('task-draft:T1', draft);
    assert.deepEqual(JSON.parse(f.entries.get(f.client.storageKey('task-draft:T1'))!), other);
  } finally { f.close(); }
});

test('authenticated configuration and bulk intents stay separate in memory and clear on account replacement', async () => {
  const f = fixture(true); try {
    const bulk = { id: 'bulk-key', path: '/api/maniphest/bulk', method: 'POST', label: 'Bulk task edit', body: { expectedConfigVersion: 2, expectedAccessEpoch: 1, tasks: [{ id: 'T1', expectedVersion: 4 }], changes: { customFields: { sealed: false }, points: 0 } } };
    const config = { id: 'config-key', path: '/api/maniphest/config', method: 'PUT', label: 'Task configuration', body: { expectedVersion: 2 } };
    assert.equal(await f.client.retainDraft('draft:automation:maniphest:bulk:request', bulk, null), 'saved');
    assert.equal(await f.client.retainDraft('draft:automation:maniphest:config:request', config, null), 'saved');
    assert.deepEqual(f.client.readStored('draft:automation:maniphest:bulk:request', null), bulk); assert.deepEqual(f.client.readStored('draft:automation:maniphest:config:request', null), config);
    assert.equal([...f.entries.keys()].some(key => key.includes('maniphest')), false);
    assert.equal(canQueue(bulk.path, 'POST', bulk.body), false); assert.equal(canQueue('/api/maniphest/bulk/preview', 'POST', bulk.body), false); assert.equal(canQueue(config.path, 'PUT', config.body), false);
    assert.equal(canQueue('/api/tasks/T1', 'PATCH', { expectedVersion: 4, expectedConfigVersion: 2, customFields: { sealed: false }, points: 0 }), true);
    const replacement = createWorkspaceClient(activateSession({ ...f.session.state, account: { id: 'U2', username: 'bob', displayName: 'Bob', disabled: false }, sessionContext: 'bob-context', csrfToken: 'bob-csrf' }));
    assert.equal(f.session.memory.size, 0); assert.equal(replacement.readStored('draft:automation:maniphest:bulk:request', null), null);
  } finally { f.close(); }
});
