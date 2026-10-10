import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { Audience, ObjectAccess, Space } from '../shared/policy.ts';
import type { AppState, Task, TaskDetail, TaskSubscriptionPage, TaskSubscriptionStatus, TaskUpdateResult } from '../shared/types.ts';

type Actor = 'alice' | 'bob' | 'carol' | 'reader';
type ErrorBody = { error: string; code?: string };
const members = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });
const workspace: Audience = { kind: 'workspace' };

async function start(path = ':memory:') {
  const store = createStore({ path });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice task membership password' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob task membership password' });
  const carol = await provisioner.createAccount({ username: 'carol', displayName: 'Carol', password: 'Carol task membership password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }).token,
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }).token,
    carol: app.auth.createToken(carol.id, { name: 'Carol', scopes: ['read', 'write'] }).token,
    reader: app.auth.createToken(bob.id, { name: 'Read only', scopes: ['read'] }).token,
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(actor: Actor, path: string, method = 'GET', body?: unknown, key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  async function create<T>(path: string, body: unknown, actor: Actor = 'alice') {
    const result = await request<T>(actor, path, 'POST', body); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function detail(id: string, actor: Actor = 'alice') { const result = await request<TaskDetail>(actor, `/api/tasks/${id}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function policy(id: string, rules: { view: Audience; edit: Audience; interact: Audience }, actor: Actor = 'alice') {
    const before = (await request<ObjectAccess>(actor, `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>(actor, `/api/policies/${id}`, 'PUT', { expectedVersion: before.version, spaceId: before.spaceId, ...rules }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function status(id: string, principalId: string, actor: Actor = 'alice') {
    const result = await request<TaskSubscriptionStatus>(actor, `/api/tasks/${id}/subscriptions/${encodeURIComponent(principalId)}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function subscribe(id: string, principalId: string, action: 'subscribe' | 'unsubscribe', actor: Actor = 'alice', key?: string) {
    const before = await status(id, principalId, actor); const input = { principalId, action, expectedMembershipVersion: before.version };
    return { input, result: await request<TaskSubscriptionStatus>(actor, `/api/tasks/${id}/subscriptions`, 'POST', input, key) };
  }
  return { ...app, alice, bob, carol, request, create, detail, policy, status, subscribe, close: async () => { await app.close(); store.close(); } };
}

test('owner assignment grants all object capabilities but cannot bypass Space visibility or token scope', async () => {
  const app = await start();
  try {
    const task = await app.create<Task>('/api/tasks', { title: 'Owned task', ownerId: app.bob.id });
    assert.equal(task.authorId, app.alice.id); assert.equal(task.ownerId, app.bob.id);
    const restricted = { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) };
    await app.policy(task.id, restricted);
    const owned = await app.detail(task.id, 'bob');
    assert.deepEqual(owned.access?.capabilities, { view: true, edit: true, interact: true, managePolicy: true });
    assert.deepEqual(owned.access?.automatic, { kind: 'task-owner', principalId: app.bob.id });
    assert.equal((await app.request('reader', `/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'Token scope bypass' })).status, 403);
    assert.equal((await app.request('bob', `/api/tasks/${task.id}/comments`, 'POST', { body: 'Owner interaction.' })).status, 201);
    const space = await app.create<Space>('/api/spaces', { name: 'Alice Space' });
    const privateTask = await app.create<Task>('/api/tasks', { title: 'Outside owner Space', ownerId: app.bob.id, access: { spaceId: space.id } });
    assert.equal((await app.request('bob', `/api/tasks/${privateTask.id}`)).status, 404, 'enabled owner remains selectable without granting Space access');
    app.auth.setAccountDisabled(app.carol.id, true);
    for (const ownerId of [app.carol.id, 'missing-principal']) {
      const denied = await app.request('alice', `/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, ownerId });
      assert.equal(denied.status, 400); assert.equal(denied.body.error, 'Selected member is unavailable.');
    }
    const state = (await app.request<AppState>('bob', '/api/state')).body;
    assert.equal(state.currentPrincipalId, app.bob.id); assert.ok(state.followingTaskIds.includes(task.id)); assert.ok(!state.followingTaskIds.includes(privateTask.id));
  } finally { await app.close(); }
});

test('a fresh owner handoff commits with a safe acknowledgement; replay rechecks current access and preserves historical bytes', async () => {
  const app = await start();
  try {
    const task = await app.create<Task>('/api/tasks', { title: 'Handoff secret', ownerId: app.alice.id });
    await app.policy(task.id, { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) });
    const epoch = app.policies.epoch(); const input = { expectedVersion: task.version, ownerId: app.bob.id }; const path = `/api/tasks/${task.id}`;
    const saved = await app.request<TaskUpdateResult>('alice', path, 'PATCH', input, 'handoff');
    assert.equal(saved.status, 200); assert.deepEqual(saved.body, { id: task.id, saved: true, accessLost: true, accessEpoch: epoch + 1 });
    const after = await app.detail(task.id, 'bob'); assert.equal(after.task.ownerId, app.bob.id); assert.equal(after.task.version, 2);
    const transaction = after.history.transactions.find(item => item.changes?.some(change => change.field === 'ownerId'))!;
    assert.equal(transaction.attribution?.principalId, app.alice.id);
    assert.deepEqual(transaction.changes?.find(change => change.field === 'ownerId'), { field: 'ownerId', oldValue: app.alice.id, newValue: app.bob.id });
    const raw = (app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:handoff') as { body: string }).body;
    assert.equal(JSON.parse(raw).ownerId, app.bob.id); assert.equal(JSON.parse(raw).title, task.title);
    assert.equal((await app.request('alice', path, 'PATCH', input, 'handoff')).status, 404);
    const hiddenState = (await app.request<AppState>('alice', '/api/state')).body;
    assert.ok(!hiddenState.tasks.some(item => item.id === task.id)); assert.ok(!hiddenState.followingTaskIds.includes(task.id));
    assert.equal((await app.request('bob', path, 'PATCH', { expectedVersion: 2, ownerId: app.alice.id })).status, 200);
    const replay = await app.request<Task>('alice', path, 'PATCH', input, 'handoff');
    assert.equal(replay.status, 200); assert.equal(replay.body.ownerId, app.bob.id); assert.equal(replay.body.version, 2, 'replay must not borrow current ownership');
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:handoff') as { body: string }).body, raw);
  } finally { await app.close(); }
});

test('an owner who retains view but surrenders edit receives the committed task and cannot replay the write', async () => {
  const app = await start();
  try {
    const task = await app.create<Task>('/api/tasks', { title: 'Readable after handoff', ownerId: app.alice.id });
    await app.policy(task.id, { view: workspace, edit: members(app.bob.id), interact: members(app.bob.id) });
    const input = { ownerId: null, expectedVersion: task.version }; const path = `/api/tasks/${task.id}`;
    const result = await app.request<Task>('alice', path, 'PATCH', input, 'unassign');
    assert.equal(result.status, 200); assert.equal(result.body.ownerId, null); assert.equal(result.body.version, 2);
    assert.equal((await app.detail(task.id)).access?.capabilities.edit, false);
    assert.equal((await app.request('alice', path, 'PATCH', input, 'unassign')).status, 403);
  } finally { await app.close(); }
});

test('subscription actions distinguish self, interacting members, editors and read-scoped credentials', async () => {
  const app = await start();
  try {
    const task = await app.create<Task>('/api/tasks', { title: 'Subscription permissions' });
    await app.policy(task.id, { view: workspace, edit: members(app.alice.id), interact: members(app.carol.id) });
    const path = `/api/tasks/${task.id}/subscriptions`;
    assert.equal((await app.subscribe(task.id, app.bob.id, 'subscribe', 'bob')).result.status, 200);
    assert.equal((await app.subscribe(task.id, app.bob.id, 'unsubscribe', 'bob')).result.status, 200);
    const input = { principalId: app.bob.id, action: 'subscribe', expectedMembershipVersion: (await app.status(task.id, app.bob.id)).version };
    assert.equal((await app.request('reader', path, 'POST', input)).status, 403);
    assert.equal((await app.subscribe(task.id, app.alice.id, 'subscribe', 'bob')).result.status, 403);
    assert.equal((await app.subscribe(task.id, app.bob.id, 'subscribe', 'carol')).result.status, 200, 'interact is enough to add another subscriber');
    assert.equal((await app.subscribe(task.id, app.bob.id, 'unsubscribe', 'carol')).result.status, 403);
    assert.equal((await app.subscribe(task.id, app.bob.id, 'unsubscribe', 'alice')).result.status, 200, 'edit is enough despite lack of interact');
    assert.equal((await app.subscribe(task.id, app.carol.id, 'subscribe', 'alice')).result.status, 200);
    await app.policy(task.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    assert.equal((await app.subscribe(task.id, app.bob.id, 'subscribe')).result.status, 200, 'recipient visibility is not a membership requirement');
    assert.equal((await app.request('bob', path)).status, 404, 'subscribing never grants object access');
    for (const suffix of ['/subscriptions', `/subscriptions/${encodeURIComponent(app.bob.id)}`]) {
      assert.deepEqual(await app.request('bob', `/api/tasks/${task.id}${suffix}`), await app.request('bob', `/api/tasks/T999999${suffix}`));
    }
    app.auth.setAccountDisabled(app.carol.id, true);
    assert.equal((await app.request('alice', path, 'POST', { principalId: app.carol.id, action: 'subscribe', expectedMembershipVersion: 1 })).status, 400);
    assert.equal((await app.subscribe(task.id, app.carol.id, 'unsubscribe')).result.status, 200, 'disabled members can still be removed');
  } finally { await app.close(); }
});

test('subscription tombstones, attribution, paging and replays retain exact membership history', async () => {
  const app = await start();
  try {
    const task = await app.create<Task>('/api/tasks', { title: 'Subscriptions and comments' }); const path = `/api/tasks/${task.id}`;
    assert.equal((await app.status(task.id, app.alice.id)).state, 'subscribed', 'creator is explicitly subscribed');
    const saved = await app.subscribe(task.id, app.bob.id, 'subscribe', 'bob', 'subscribe-once'); assert.equal(saved.result.status, 200);
    const removed = await app.subscribe(task.id, app.bob.id, 'unsubscribe', 'bob'); assert.equal(removed.result.status, 200);
    assert.equal((await app.request('bob', `${path}/comments`, 'POST', { body: 'Comment after opting out.' })).status, 201);
    assert.equal((await app.status(task.id, app.bob.id)).state, 'unsubscribed');
    const replay = await app.request<TaskSubscriptionStatus>('bob', `${path}/subscriptions`, 'POST', saved.input, 'subscribe-once');
    assert.deepEqual(replay, saved.result); assert.equal((await app.status(task.id, app.bob.id)).state, 'unsubscribed');
    assert.equal((await app.request('bob', `${path}/subscriptions`, 'POST', saved.input)).status, 409);
    assert.equal((await app.request('carol', `${path}/comments`, 'POST', { body: 'First comment implicitly subscribes.' })).status, 201);
    assert.equal((await app.status(task.id, app.carol.id)).state, 'subscribed');
    const rows: string[] = []; let after: string | null = null;
    do {
      const page: { status: number; body: TaskSubscriptionPage } = await app.request<TaskSubscriptionPage>('bob', `${path}/subscriptions?limit=1${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      assert.equal(page.status, 200); assert.equal(page.body.viewer.state, 'unsubscribed'); assert.equal(typeof page.body.accessEpoch, 'number');
      rows.push(...page.body.subscribers.map(item => item.principalId)); after = page.body.nextAfter;
    } while (after !== null);
    assert.deepEqual(rows, [app.alice.id, app.carol.id].sort());
    const detail = await app.detail(task.id); assert.equal(detail.task.version, task.version, 'subscriptions and comments do not conflict with field edits');
    const explicit = detail.history.transactions.find(item => item.subscription?.principalId === app.bob.id && item.subscription.newState === 'unsubscribed')!;
    assert.equal(explicit.attribution?.principalId, app.bob.id); assert.equal(explicit.subscription?.reason, 'explicit');
    assert.ok(detail.history.transactions.some(item => item.subscription?.principalId === app.carol.id && item.subscription.reason === 'commented'));
    for (const query of ['?limit=0', '?limit=101', '?after=x&after=y', '?unknown=1']) assert.equal((await app.request('bob', `${path}/subscriptions${query}`)).status, 400);
  } finally { await app.close(); }
});

test('disabled unchanged owners and historical local memberships remain manageable without allowing new inactive selections', async () => {
  const app = await start();
  try {
    const task = await app.create<Task>('/api/tasks', { title: 'Existing disabled owner', ownerId: app.bob.id });
    app.auth.setAccountDisabled(app.bob.id, true);
    const result = await app.request<Task>('alice', `/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'Unrelated edit', ownerId: app.bob.id });
    assert.equal(result.status, 200); assert.equal(result.body.ownerId, app.bob.id); assert.equal(result.body.title, 'Unrelated edit');
    const other = await app.create<Task>('/api/tasks', { title: 'No new disabled owner' });
    assert.equal((await app.request('alice', `/api/tasks/${other.id}`, 'PATCH', { expectedVersion: other.version, ownerId: app.bob.id })).status, 400);
    const formerLocal = `local:${app.auth.workspaceId}`;
    const attribution = { principalId: app.alice.id, displayName: 'Alice', credentialId: null, requestId: 'historical-membership-fixture' };
    app.store.updateTaskSubscription(task.id, { principalId: formerLocal, action: 'subscribe', expectedMembershipVersion: 0 }, attribution);
    assert.equal((await app.status(task.id, formerLocal)).subscribed, true, 'encoded former-local identity can be inspected');
    const removed = await app.subscribe(task.id, formerLocal, 'unsubscribe'); assert.equal(removed.result.status, 200); assert.equal(removed.result.body.subscribed, false);
    assert.equal((await app.request('alice', `/api/tasks/${task.id}/subscriptions`, 'POST', { principalId: formerLocal, action: 'subscribe', expectedMembershipVersion: removed.result.body.version })).status, 400);
    assert.equal((await app.request('alice', `/api/tasks/${other.id}/subscriptions/${encodeURIComponent(formerLocal)}`)).status, 400, 'an absent historical local identity is not made selectable');
    assert.equal((await app.request('alice', `/api/tasks/${other.id}`, 'PATCH', { expectedVersion: other.version, ownerId: formerLocal })).status, 400);
  } finally { await app.close(); }
});

test('pre-assignment saved task responses never invent current ownership or authorship', async () => {
  const app = await start();
  try {
    const input = { title: 'Historical task without ownership fields' };
    const created = await app.request<Task>('alice', '/api/tasks', 'POST', input, 'old-task-response');
    assert.equal(created.status, 201);
    const { ownerId: _ownerId, authorId: _authorId, ...historical } = created.body;
    app.store.database.prepare('UPDATE idempotency SET body = ? WHERE key LIKE ?').run(JSON.stringify(historical), '%:old-task-response');
    const updated = await app.request('alice', `/api/tasks/${created.body.id}`, 'PATCH', { expectedVersion: created.body.version, ownerId: app.bob.id });
    assert.equal(updated.status, 200);
    const replay = await app.request<Record<string, unknown>>('alice', '/api/tasks', 'POST', input, 'old-task-response');
    assert.equal(replay.status, 201); assert.deepEqual(replay.body, historical);
    assert.equal('ownerId' in replay.body, false); assert.equal('authorId' in replay.body, false);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:old-task-response') as { body: string }).body, JSON.stringify(historical));
  } finally { await app.close(); }
});

test('owner revocation while a writer waits prevents both a new field write and saved-response disclosure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-owner-lock-')); const path = join(directory, 'workspace.sqlite');
  const app = await start(path); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      const task = await app.create<Task>('/api/tasks', { title: `Owner race ${phase}`, ownerId: app.alice.id });
      await app.policy(task.id, { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) });
      const route = `/api/tasks/${task.id}`; const input = { title: `Changed ${phase}`, expectedVersion: task.version }; const key = `owner-race-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('alice', route, 'PATCH', input, key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const before = app.store.taskDetail(task.id); const revoked = { ...before.task, ownerId: app.bob.id };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(workerData.path); database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify(workerData.task), workerData.task.id);
        database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
        if (workerData.replay) { const r = workerData.replay; database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(r.key, r.fingerprint, r.status, r.body, r.created_at); }
        parentPort.once('message', () => { database.exec('COMMIT'); database.close(); parentPort.close(); }); parentPort.postMessage('locked');
      `)}`), { workerData: { path, task: revoked, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const result = await app.request('alice', route, 'PATCH', input, key);
        assert.equal(entered, 1); assert.equal(result.status, 404); assert.equal(result.body.code, 'OBJECT_UNAVAILABLE');
        const after = app.store.taskDetail(task.id); assert.deepEqual(after.task, revoked); assert.deepEqual(after.history, before.history);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
