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
import type { Audience, ObjectAccess } from '../shared/policy.ts';
import type { AppState, Task, TaskDetail, TaskHistory, TaskMergeInput, TaskMergeInInput, TaskSubscriptionPage } from '../shared/types.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'reader';
const members = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });

async function start(databasePath = ':memory:') {
  const store = createStore({ path: databasePath });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice Writer', password: 'Alice duplicate task test password' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Bob duplicate task test password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = {
    alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }).token,
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }).token,
    reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }).token,
  };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(actor: Actor, path: string, method = 'GET', body?: unknown, key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as T };
  }
  async function task(title: string, actor: Actor = 'alice', fields: Record<string, unknown> = {}): Promise<Task> {
    const result = await request<Task>(actor, '/api/tasks', 'POST', { title, ...fields });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  async function detail(id: string, actor: Actor = 'alice'): Promise<TaskDetail> {
    const result = await request<TaskDetail>(actor, `/api/tasks/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function edit(id: string, fields: Record<string, unknown>) {
    const current = await detail(id);
    const result = await request<Task>('alice', `/api/tasks/${id}`, 'PATCH', { expectedVersion: current.task.version, ...fields });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function policy(id: string, changes: Partial<{ view: Audience; edit: Audience; interact: Audience }>) {
    const current = (await request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>('alice', `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function merge(sourceId: string, targetId: string, actor: Actor = 'alice', key?: string) {
    const input: TaskMergeInput = { taskId: targetId, expectedVersion: (await detail(sourceId, actor)).task.version, expectedTargetVersion: (await detail(targetId, actor)).task.version };
    const response = await request<TaskDetail>(actor, `/api/tasks/${sourceId}/merge`, 'POST', input, key);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return { input, response };
  }
  async function mergeIn(targetId: string, sourceIds: string[], actor: Actor = 'alice', key?: string) {
    const input: TaskMergeInInput = { expectedVersion: (await detail(targetId, actor)).task.version,
      sources: await Promise.all(sourceIds.map(async taskId => ({ taskId, expectedVersion: (await detail(taskId, actor)).task.version }))),
    };
    const response = await request<TaskDetail>(actor, `/api/tasks/${targetId}/merge-in`, 'POST', input, key);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return { input, response };
  }
  return { ...app, alice, bob, request, task, detail, edit, policy, merge, mergeIn, close: async () => { await app.close(); store.close(); } };
}

test('single and batch duplicate actions retain readable sources, paired immutable history and merged subscribers', async () => {
  const app = await start();
  try {
    const source = await app.task('Original report', 'bob', { description: 'Exact source text\r\n😀', ownerId: app.bob.id, priority: 'high' });
    const target = await app.task('Destination', 'alice', { description: 'Destination text', ownerId: app.alice.id });
    const saved = await app.merge(source.id, target.id, 'bob', 'single-merge');
    const sourceDetail = saved.response.body; const targetDetail = await app.detail(target.id);
    assert.equal(sourceDetail.task.status, 'duplicate'); assert.equal(sourceDetail.task.version, source.version + 1);
    assert.equal(sourceDetail.task.description, source.description); assert.equal(sourceDetail.task.ownerId, source.ownerId);
    assert.equal(targetDetail.task.status, 'open'); assert.equal(targetDetail.task.description, target.description);
    assert.equal(targetDetail.task.version, target.version + 1);
    assert.deepEqual(sourceDetail.duplicateOf.map(item => item.id), [target.id]); assert.deepEqual(targetDetail.duplicates.map(item => item.id), [source.id]);
    const outgoing = sourceDetail.history.transactions.find(item => item.merge?.taskId === target.id)!;
    const incoming = targetDetail.history.transactions.find(item => item.merge?.taskId === source.id)!;
    assert.equal(outgoing.merge?.direction, 'merged_into'); assert.equal(incoming.merge?.direction, 'merged_from');
    assert.equal(outgoing.merge?.operationId, incoming.merge?.operationId); assert.ok(outgoing.merge?.operationId);
    assert.equal(outgoing.attribution?.principalId, app.bob.id); assert.equal(incoming.attribution?.principalId, app.bob.id);
    assert.deepEqual(outgoing.changes, [{ field: 'status', oldValue: 'open', newValue: 'duplicate' }]);
    const subscribers = (await app.request<TaskSubscriptionPage>('alice', `/api/tasks/${target.id}/subscriptions`)).body;
    assert.ok(subscribers.subscribers.some(item => item.principalId === app.bob.id && item.subscribed));
    assert.ok(targetDetail.history.transactions.some(item => item.subscription?.principalId === app.bob.id && item.subscription.reason === 'merged'));
    assert.deepEqual((await app.request<TaskDetail>('bob', `/api/tasks/${source.id}/merge`, 'POST', saved.input, 'single-merge')).body, sourceDetail);
    const second = await app.task('Another report'); const third = await app.task('Third report', 'alice', { status: 'resolved' });
    const previous = (await app.detail(target.id)).task.version;
    const batch = await app.mergeIn(target.id, [second.id, third.id], 'bob', 'batch-merge');
    assert.equal(batch.response.body.task.version, previous + 1);
    for (const task of [second, third]) {
      const detail = await app.detail(task.id); assert.equal(detail.task.version, task.version + 1); assert.equal(detail.task.status, 'duplicate');
      assert.deepEqual(detail.duplicateOf.map(item => item.id), [target.id]);
    }
    assert.equal(batch.response.body.duplicates.length, 3);
    assert.equal(batch.response.body.history.accessEpoch, batch.response.body.accessEpoch);
    assert.equal((await app.request<AppState>('alice', '/api/state')).body.tasks.length, 4, 'merged sources are not deleted');
  } finally { await app.close(); }
});

test('merge endpoints require edit on all selected tasks without leaking hidden references or partial writes', async () => {
  const app = await start();
  try {
    const source = await app.task('Shared source'); const target = await app.task('Restricted target'); const other = await app.task('Other source');
    await app.policy(source.id, { interact: members(app.alice.id) });
    await app.policy(target.id, { edit: members(app.alice.id) });
    const input = { taskId: target.id, expectedVersion: source.version, expectedTargetVersion: target.version };
    assert.equal((await app.request('bob', `/api/tasks/${source.id}/merge`, 'POST', input)).status, 403);
    assert.equal((await app.request('reader', `/api/tasks/${source.id}/merge`, 'POST', input)).status, 403);
    const before = [app.store.taskDetail(source.id), app.store.taskDetail(other.id), app.store.taskDetail(target.id)];
    const batch = { expectedVersion: other.version, sources: [{ taskId: source.id, expectedVersion: source.version }, { taskId: target.id, expectedVersion: target.version }] };
    assert.equal((await app.request('bob', `/api/tasks/${other.id}/merge-in`, 'POST', batch)).status, 403);
    assert.deepEqual([app.store.taskDetail(source.id), app.store.taskDetail(other.id), app.store.taskDetail(target.id)], before);
    await app.policy(target.id, { view: members(app.alice.id) });
    const hidden = await app.request('bob', `/api/tasks/${source.id}/merge`, 'POST', input);
    const missing = await app.request('bob', `/api/tasks/${source.id}/merge`, 'POST', { ...input, taskId: 'T999999' });
    assert.deepEqual(hidden, missing); assert.equal(hidden.status, 400); assert.equal(hidden.body.error, 'Reference unavailable.');
    const hiddenBatch = await app.request('bob', `/api/tasks/${other.id}/merge-in`, 'POST', batch);
    const missingBatch = await app.request('bob', `/api/tasks/${other.id}/merge-in`, 'POST', { ...batch, sources: [batch.sources[0], { taskId: 'T999999', expectedVersion: 1 }] });
    assert.deepEqual(hiddenBatch, missingBatch);
    assert.equal((await app.request('bob', `/api/tasks/${target.id}/merge`, 'POST', { ...input, taskId: source.id })).status, 404);
    await app.merge(source.id, other.id, 'bob'); // Edit is sufficient; interaction is not additionally required.
  } finally { await app.close(); }
});

test('duplicate relations allow additional destinations and cycles without redirecting or manufacturing ordinary status transitions', async () => {
  const app = await start();
  try {
    const a = await app.task('First', 'alice', { status: 'resolved' }); const b = await app.task('Second', 'alice', { status: 'resolved' }); const c = await app.task('Third');
    await app.merge(a.id, b.id); await app.merge(a.id, c.id); await app.merge(b.id, a.id);
    assert.deepEqual(new Set((await app.detail(a.id)).duplicateOf.map(task => task.id)), new Set([b.id, c.id]));
    assert.equal((await app.detail(b.id)).duplicateOf[0]!.id, a.id);
    await app.edit(a.id, { status: 'open' }); assert.equal((await app.detail(a.id)).duplicateOf.length, 2, 'reopening does not erase historical merge relations');
    assert.equal((await app.request('alice', '/api/tasks', 'POST', { title: 'No relation', status: 'duplicate' })).status, 400);
    const current = await app.detail(a.id);
    assert.equal((await app.request('alice', `/api/tasks/${a.id}`, 'PATCH', { expectedVersion: current.task.version, status: 'duplicate' })).status, 400);
  } finally { await app.close(); }
});

test('batch versions are atomic and malformed selections never produce partial merges', async () => {
  const app = await start();
  try {
    const target = await app.task('Target'); const first = await app.task('First'); const second = await app.task('Second');
    await app.edit(second.id, { title: 'Changed after selection' });
    const input = { expectedVersion: target.version, sources: [{ taskId: first.id, expectedVersion: first.version }, { taskId: second.id, expectedVersion: second.version }] };
    const before = [target, first, second].map(task => app.store.taskDetail(task.id));
    assert.equal((await app.request('alice', `/api/tasks/${target.id}/merge-in`, 'POST', input, 'stale-batch')).status, 409);
    for (const sources of [[], [input.sources[0], input.sources[0]], Array.from({ length: 101 }, () => input.sources[0]), [null]]) {
      assert.equal((await app.request('alice', `/api/tasks/${target.id}/merge-in`, 'POST', { ...input, sources })).status, 400);
    }
    assert.equal((await app.request('alice', `/api/tasks/${target.id}/merge`, 'POST', { taskId: target.id, expectedVersion: target.version, expectedTargetVersion: target.version })).status, 400);
    assert.deepEqual([target, first, second].map(task => app.store.taskDetail(task.id)), before);
    assert.equal(app.store.database.prepare('SELECT key FROM idempotency WHERE key LIKE ?').get('%:stale-batch'), undefined);
  } finally { await app.close(); }
});

test('hidden merge relations are filtered before paging and historical retries never borrow newer graph or history', async () => {
  const app = await start();
  try {
    const source = await app.task('Shared source'); const first = await app.task('Secret destination title'); const second = await app.task('Visible destination');
    const old = await app.merge(source.id, first.id, 'bob', 'old-merge');
    const saved = await app.merge(source.id, second.id, 'bob', 'new-merge');
    const raw = (app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:new-merge') as { body: string }).body;
    await app.edit(second.id, { title: 'Renamed later' });
    await app.policy(first.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    await app.request('bob', `/api/tasks/${source.id}/comments`, 'POST', { body: 'Later note excluded from replay.' });
    const replay = await app.request<TaskDetail>('bob', `/api/tasks/${source.id}/merge`, 'POST', saved.input, 'new-merge');
    assert.equal(replay.status, 200); assert.equal(replay.body.task.version, saved.response.body.task.version);
    assert.deepEqual(replay.body.duplicateOf, saved.response.body.duplicateOf.filter(task => task.id !== first.id));
    assert.equal(replay.body.duplicateOf[0]!.title, 'Visible destination');
    assert.deepEqual(replay.body.history.transactions, saved.response.body.history.transactions.filter(transaction => transaction.merge?.taskId !== first.id));
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:new-merge') as { body: string }).body, raw);
    const denied = await app.request('bob', `/api/tasks/${source.id}/merge`, 'POST', old.input, 'old-merge');
    assert.equal(denied.status, 400); assert.equal(denied.body.error, 'Reference unavailable.');
    const detail = await app.detail(source.id, 'bob'); const seen: string[] = []; let before: number | null = null;
    do {
      const page: { status: number; body: TaskHistory } = await app.request<TaskHistory>('bob', `/api/tasks/${source.id}/history?limit=2${before === null ? '' : `&before=${before}`}`);
      assert.equal(page.status, 200); if (page.body.nextBefore !== null) assert.equal(page.body.transactions.length, 2);
      seen.push(...page.body.transactions.map(transaction => transaction.id)); before = page.body.nextBefore;
    } while (before !== null);
    assert.deepEqual(seen, detail.history.transactions.map(transaction => transaction.id));
    assert.ok(!JSON.stringify(detail).includes(`"${first.id}"`)); assert.doesNotMatch(JSON.stringify(detail), /Secret destination title/);
    const state = (await app.request<AppState>('bob', '/api/state')).body;
    assert.doesNotMatch(JSON.stringify(state.activity), /Secret destination title/);
    // The batch destination's incoming references are subject to the same filter.
    const destination = await app.task('Batch destination'); const hiddenSource = await app.task('Secret source'); const visibleSource = await app.task('Visible source');
    await app.mergeIn(destination.id, [hiddenSource.id]); const batch = await app.mergeIn(destination.id, [visibleSource.id], 'bob', 'batch-history');
    await app.policy(hiddenSource.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    const filtered = await app.request<TaskDetail>('bob', `/api/tasks/${destination.id}/merge-in`, 'POST', batch.input, 'batch-history');
    assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.duplicates.map(task => task.id), [visibleSource.id]);
    assert.ok(filtered.body.history.transactions.every(transaction => transaction.merge?.taskId !== hiddenSource.id));
    await app.policy(visibleSource.id, { edit: members(app.alice.id) });
    assert.equal((await app.request('bob', `/api/tasks/${destination.id}/merge-in`, 'POST', batch.input, 'batch-history')).status, 403, 'saved batch retries recheck every selected edit capability');
  } finally { await app.close(); }
});

test('pre-merge task replay gains only empty compatibility arrays and rejects merge evidence with missing graph data', async () => {
  const app = await start();
  try {
    const source = await app.task('Legacy task'); const dependency = await app.task('Dependency'); const destination = await app.task('Later destination');
    const input = { taskId: dependency.id, action: 'add', expectedVersion: source.version };
    const saved = await app.request<TaskDetail>('alice', `/api/tasks/${source.id}/dependencies`, 'POST', input, 'legacy-detail');
    assert.equal(saved.status, 200);
    const { duplicateOf: _out, duplicates: _in, ...legacy } = saved.body;
    const bytes = JSON.stringify(legacy);
    app.store.database.prepare('UPDATE idempotency SET body = ? WHERE key LIKE ?').run(bytes, '%:legacy-detail');
    await app.merge(source.id, destination.id);
    const replay = await app.request<TaskDetail>('alice', `/api/tasks/${source.id}/dependencies`, 'POST', input, 'legacy-detail');
    assert.equal(replay.status, 200); assert.deepEqual(replay.body.duplicateOf, []); assert.deepEqual(replay.body.duplicates, []);
    assert.equal(replay.body.task.status, legacy.task.status); assert.deepEqual(replay.body.history.transactions, legacy.history.transactions);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:legacy-detail') as { body: string }).body, bytes);
    const corrupted = { ...legacy, history: { ...legacy.history, transactions: [...legacy.history.transactions, (await app.detail(source.id)).history.transactions.find(transaction => transaction.kind === 'merge')] } };
    app.store.database.prepare('UPDATE idempotency SET body = ? WHERE key LIKE ?').run(JSON.stringify(corrupted), '%:legacy-detail');
    assert.equal((await app.request('alice', `/api/tasks/${source.id}/dependencies`, 'POST', input, 'legacy-detail')).status, 409);
  } finally { await app.close(); }
});

test('a fresh repeated merge recloses a reopened source and refreshes followers while preserving the original link and old replay', async () => {
  const app = await start();
  try {
    const source = await app.task('Source to reopen'); const target = await app.task('Destination'); const parent = await app.task('Dependent parent');
    assert.equal((await app.request('alice', `/api/tasks/${parent.id}/dependencies`, 'POST', { taskId: source.id, action: 'add', expectedVersion: parent.version })).status, 200);
    const first = await app.merge(source.id, target.id, 'bob', 'first-close');
    const originalLink = app.store.database.prepare('SELECT * FROM task_duplicates WHERE source_id = ? AND target_id = ?').get(source.id, target.id);
    const firstOperation = first.response.body.history.transactions.find(transaction => transaction.kind === 'merge')!.merge!.operationId;
    await app.edit(source.id, { status: 'open' });
    assert.equal((await app.request('bob', `/api/tasks/${source.id}/comments`, 'POST', { body: 'A newly interested reviewer after the original merge.' })).status, 201);
    assert.equal((await app.request('bob', `/api/tasks/${target.id}/subscriptions`, 'POST', { principalId: app.bob.id, action: 'unsubscribe', expectedMembershipVersion: 0 })).status, 200);
    const beforeSource = (await app.detail(source.id)).task; const beforeTarget = (await app.detail(target.id)).task; const beforeParent = (await app.detail(parent.id)).task;
    const repeated = await app.merge(source.id, target.id, 'alice', 'reclose');
    assert.equal(repeated.response.body.task.version, beforeSource.version + 1); assert.equal(repeated.response.body.task.status, 'duplicate');
    const destination = await app.detail(target.id); assert.equal(destination.task.version, beforeTarget.version + 1);
    const dependent = await app.detail(parent.id); assert.equal(dependent.task.version, beforeParent.version + 1); assert.equal(dependent.task.status, 'open');
    const merges = repeated.response.body.history.transactions.filter(transaction => transaction.kind === 'merge');
    assert.equal(merges.length, 2); assert.notEqual(merges[0]!.merge!.operationId, firstOperation);
    assert.deepEqual(merges[0]!.changes, [{ field: 'status', oldValue: 'open', newValue: 'duplicate' }]);
    assert.equal(destination.history.transactions.filter(transaction => transaction.kind === 'merge').length, 2);
    assert.equal(app.store.subscriptionStatus(target.id, app.bob.id).state, 'subscribed');
    assert.equal(app.store.subscriptionStatus(target.id, app.bob.id).version, 2, 'explicit repeated merge overrides a destination opt-out');
    assert.ok(destination.history.transactions.some(transaction => transaction.subscription?.principalId === app.bob.id && transaction.subscription.reason === 'merged' && transaction.attribution?.principalId === app.alice.id));
    assert.deepEqual(app.store.database.prepare('SELECT * FROM task_duplicates WHERE source_id = ? AND target_id = ?').get(source.id, target.id), originalLink);
    assert.equal(repeated.response.body.duplicateOf.length, 1); assert.equal(destination.duplicates.length, 1);
    const beforeReplay = [app.store.taskDetail(source.id), app.store.taskDetail(target.id), app.store.taskDetail(parent.id)];
    assert.deepEqual(await app.request<TaskDetail>('alice', `/api/tasks/${source.id}/merge`, 'POST', repeated.input, 'reclose'), repeated.response);
    assert.deepEqual(await app.request<TaskDetail>('bob', `/api/tasks/${source.id}/merge`, 'POST', first.input, 'first-close'), first.response);
    assert.deepEqual([app.store.taskDetail(source.id), app.store.taskDetail(target.id), app.store.taskDetail(parent.id)], beforeReplay);
  } finally { await app.close(); }
});

test('mixed batch merge accepts existing and new links as one fresh operation without inventing a second status change', async () => {
  const app = await start();
  try {
    const target = await app.task('Batch destination'); const existing = await app.task('Already duplicate'); const incoming = await app.task('New duplicate', 'bob'); const parent = await app.task('Parent of already duplicate');
    assert.equal((await app.request('alice', `/api/tasks/${parent.id}/dependencies`, 'POST', { taskId: existing.id, action: 'add', expectedVersion: parent.version })).status, 200);
    await app.merge(existing.id, target.id);
    const firstLink = app.store.database.prepare('SELECT * FROM task_duplicates WHERE source_id = ? AND target_id = ?').get(existing.id, target.id);
    assert.equal((await app.request('alice', `/api/tasks/${target.id}/subscriptions`, 'POST', { principalId: app.alice.id, action: 'unsubscribe', expectedMembershipVersion: 1 })).status, 200);
    const before = [target, existing, incoming, parent].map(task => app.store.taskDetail(task.id));
    const batch = await app.mergeIn(target.id, [existing.id, incoming.id], 'bob', 'mixed-batch');
    assert.equal(batch.response.body.task.version, before[0]!.task.version + 1);
    assert.deepEqual(new Set(batch.response.body.duplicates.map(task => task.id)), new Set([existing.id, incoming.id]));
    const repeated = await app.detail(existing.id); const added = await app.detail(incoming.id);
    assert.equal(repeated.task.version, before[1]!.task.version + 1); assert.equal(added.task.version, before[2]!.task.version + 1);
    assert.equal(repeated.task.status, 'duplicate'); assert.equal(added.task.status, 'duplicate');
    const remerge = repeated.history.transactions.find(transaction => transaction.kind === 'merge')!;
    const newMerge = added.history.transactions.find(transaction => transaction.kind === 'merge')!;
    assert.equal(remerge.merge!.operationId, newMerge.merge!.operationId); assert.equal(remerge.changes, undefined);
    assert.deepEqual(newMerge.changes, [{ field: 'status', oldValue: 'open', newValue: 'duplicate' }]);
    const parentAfter = app.store.taskDetail(parent.id);
    assert.deepEqual(parentAfter.task, before[3]!.task, 'already duplicate status has no new derived parent version');
    assert.deepEqual(parentAfter.history, before[3]!.history); assert.deepEqual(parentAfter.activity, before[3]!.activity);
    assert.equal(parentAfter.dependsOn[0]!.version, repeated.task.version, 'live reference metadata reflects the fresh merge');
    assert.deepEqual(app.store.database.prepare('SELECT * FROM task_duplicates WHERE source_id = ? AND target_id = ?').get(existing.id, target.id), firstLink);
    assert.equal(app.store.subscriptionStatus(target.id, app.alice.id).state, 'subscribed');
    assert.equal(app.store.subscriptionStatus(target.id, app.bob.id).state, 'subscribed');
    const after = [target, existing, incoming, parent].map(task => app.store.taskDetail(task.id));
    assert.deepEqual(await app.request<TaskDetail>('bob', `/api/tasks/${target.id}/merge-in`, 'POST', batch.input, 'mixed-batch'), batch.response);
    assert.deepEqual([target, existing, incoming, parent].map(task => app.store.taskDetail(task.id)), after);
  } finally { await app.close(); }
});

test('selected-task edit revocation while waiting for the writer prevents merge writes and saved-result disclosure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-duplicate-policy-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const mode of ['single', 'batch'] as const) for (const phase of ['write', 'replay'] as const) {
      const source = await app.task(`Source ${mode} ${phase}`); const target = await app.task(`Target ${mode} ${phase}`);
      const anchor = mode === 'single' ? source : target; const selected = mode === 'single' ? target : source;
      const path = `/api/tasks/${anchor.id}/${mode === 'single' ? 'merge' : 'merge-in'}`;
      const input = mode === 'single' ? { taskId: target.id, expectedVersion: source.version, expectedTargetVersion: target.version }
        : { expectedVersion: target.version, sources: [{ taskId: source.id, expectedVersion: source.version }] };
      const key = `merge-lock-${mode}-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('bob', path, 'POST', input, key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const beforeSource = app.store.taskDetail(source.id); const beforeTarget = app.store.taskDetail(target.id);
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${selected.id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, edit: members(app.alice.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(workerData.databasePath); database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE object_policies SET data = ? WHERE object_id = ?').run(JSON.stringify(workerData.policy), workerData.policy.objectId);
        database.prepare("UPDATE policy_meta SET value = value + 1 WHERE name = 'epoch'").run();
        if (workerData.replay) { const r = workerData.replay; database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(r.key, r.fingerprint, r.status, r.body, r.created_at); }
        parentPort.once('message', () => { database.exec('COMMIT'); database.close(); parentPort.close(); }); parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request('bob', path, 'POST', input, key);
        assert.equal(entered, 1); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'ACTION_FORBIDDEN');
        assert.deepEqual(app.store.taskDetail(source.id), beforeSource); assert.deepEqual(app.store.taskDetail(target.id), beforeTarget);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
