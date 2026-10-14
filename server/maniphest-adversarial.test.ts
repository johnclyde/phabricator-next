import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.ts';
import { createStore } from './store.ts';
import { createAuth } from './auth.ts';
import { readManiphestConfig } from './maniphest.ts';
import type { Task } from '../shared/types.ts';
import type { ManiphestBulkInput } from '../shared/maniphest.ts';

async function fixture() {
  const store = createStore({ path: ':memory:' }), provision = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provision.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice adversarial password' }), bob = await provision.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob adversarial password' }), charlie = await provision.createAccount({ username: 'charlie', displayName: 'Charlie', password: 'Charlie adversarial password' });
  const app = createApp({ store, seed: false, authMode: 'password', maniphestAdminPrincipalIds: [alice.id] });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Admin', scopes: ['read', 'write'] }).token, bob: app.auth.createToken(bob.id, { name: 'Editor', scopes: ['read', 'write'] }).token, read: app.auth.createToken(alice.id, { name: 'Read-only', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const request = async <T = { error: string }>(actor: keyof typeof tokens, path: string, body?: unknown, key: string = randomUUID()) => { const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() as T }; };
  const task = async (title: string) => { const response = await request<Task>('alice', '/api/tasks', { title }); assert.equal(response.status, 201); return response.body; };
  const input = (tasks: Task[], changes: ManiphestBulkInput['changes']): ManiphestBulkInput => ({ expectedConfigVersion: readManiphestConfig(store.database).version, expectedAccessEpoch: app.policies.epoch(), tasks: tasks.map(task => ({ id: task.id, expectedVersion: task.version })), changes });
  const privateTask = (id: string) => { const policy = app.policies.policy(id, alice.id); app.policies.setPolicy(id, { spaceId: policy.spaceId, expectedVersion: policy.version, ...policy.rules, view: { kind: 'principals', principalIds: [alice.id] }, edit: { kind: 'principals', principalIds: [alice.id] } }, alice.id); };
  return { ...app, alice, bob, charlie, request, task, input, privateTask, close: async () => { await app.close(); store.close(); } };
}

test('read-only tokens cannot preview/apply bulk changes, and disabled assignment targets abort the complete batch', async () => {
  const f = await fixture(); try {
    const a = await f.task('First original task'), b = await f.task('Second original task'), input = f.input([a, b], { ownerId: f.charlie.id });
    assert.equal((await f.request('read', '/api/maniphest/bulk/preview', input)).status, 403);
    assert.equal((await f.request('read', '/api/maniphest/bulk', input)).status, 403);
    assert.equal((await f.request('alice', '/api/maniphest/bulk/preview', input)).status, 200);
    f.auth.setAccountDisabled(f.charlie.id, true);
    const rejected = await f.request('alice', '/api/maniphest/bulk', input); assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.deepEqual(f.store.taskDetail(a.id).task, a); assert.deepEqual(f.store.taskDetail(b.id).task, b);
    assert.equal(f.store.taskDetail(a.id).history.transactions.filter(transaction => transaction.kind === 'edit').length, 0);
  } finally { await f.close(); }
});

test('policy revocation after preview prevents every write and after success prevents saved receipt disclosure', async () => {
  const f = await fixture(); try {
    const a = await f.task('Public title'), b = await f.task('Revoked title'), first = f.input([a, b], { points: 8 });
    assert.equal((await f.request('bob', '/api/maniphest/bulk/preview', first)).status, 200);
    f.privateTask(b.id);
    const denied = await f.request('bob', '/api/maniphest/bulk', first); assert.equal(denied.status, 404); assert.equal(JSON.stringify(denied.body).includes('Revoked title'), false);
    assert.deepEqual(f.store.taskDetail(a.id).task, a); assert.deepEqual(f.store.taskDetail(b.id).task, b);
    const fresh = f.input([a], { points: 3 }), written = await f.request('bob', '/api/maniphest/bulk', fresh, 'exact-bulk'); assert.equal(written.status, 200);
    f.privateTask(a.id);
    const replay = await f.request('bob', '/api/maniphest/bulk', fresh, 'exact-bulk'); assert.equal(replay.status, 404); assert.equal(JSON.stringify(replay.body).includes('Public title'), false);
    assert.equal(f.store.taskDetail(a.id).task.points, 3);
  } finally { await f.close(); }
});

test('a failure while writing the second task rolls back all tasks, histories, notification deliveries and idempotency', async () => {
  const f = await fixture(); try {
    const a = await f.task('Rollback first'), b = await f.task('Rollback second'), input = f.input([a, b], { priority: 'urgent' });
    const count = (table: string) => Number(f.store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    const tables = ['task_transactions', 'activity', 'notification_events', 'notification_deliveries', 'idempotency'];
    const before = Object.fromEntries(tables.map(table => [table, count(table)]));
    f.store.database.exec(`CREATE TRIGGER reject_second_task BEFORE UPDATE ON entities WHEN NEW.id='${b.id}' BEGIN SELECT RAISE(ABORT,'Injected second-task failure'); END`);
    const result = await f.request('alice', '/api/maniphest/bulk', input, 'rollback-bulk'); assert.equal(result.status, 500);
    assert.deepEqual(f.store.taskDetail(a.id).task, a); assert.deepEqual(f.store.taskDetail(b.id).task, b);
    assert.deepEqual(Object.fromEntries(tables.map(table => [table, count(table)])), before);
    f.store.database.exec('DROP TRIGGER reject_second_task');
    assert.equal((await f.request('alice', '/api/maniphest/bulk', input, 'rollback-bulk')).status, 200, 'The rolled-back key remains available for the original operation.');
    assert.equal(f.store.taskDetail(a.id).task.priority, 'urgent'); assert.equal(f.store.taskDetail(b.id).task.priority, 'urgent');
  } finally { await f.close(); }
});
