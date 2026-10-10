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
import type { AppState, Project, Task, TaskDetail, TaskHistory, TaskTransaction } from '../shared/types.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'reader';
const members = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });
const workspace: Audience = { kind: 'workspace' };

async function start(databasePath = ':memory:') {
  const store = createStore({ path: databasePath });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice Writer', password: 'Alice task transaction test password' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Bob task transaction test password' });
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
  async function create<T>(actor: Actor, path: string, body: unknown, key?: string): Promise<T> {
    const result = await request<T>(actor, path, 'POST', body, key);
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
  }
  const task = (title: string, actor: Actor = 'alice') => create<Task>(actor, '/api/tasks', { title });
  async function detail(id: string, actor: Actor = 'alice'): Promise<TaskDetail> {
    const result = await request<TaskDetail>(actor, `/api/tasks/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function edit(id: string, fields: Record<string, unknown>, actor: Actor = 'alice') {
    const before = await detail(id, actor);
    const result = await request<Task>(actor, `/api/tasks/${id}`, 'PATCH', { expectedVersion: before.task.version, ...fields });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function policy(id: string, changes: Partial<{ view: Audience; edit: Audience; interact: Audience }>, actor: Actor = 'alice') {
    const current = (await request<ObjectAccess>(actor, `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>(actor, `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function depend(id: string, taskId: string, actor: Actor = 'alice', action: 'add' | 'remove' = 'add', key?: string) {
    const current = await detail(id, actor);
    const input = { taskId, action, expectedVersion: current.task.version };
    const result = await request<TaskDetail>(actor, `/api/tasks/${id}/dependencies`, 'POST', input, key);
    assert.equal(result.status, 200, JSON.stringify(result.body)); return { input, result };
  }
  return { ...app, alice, bob, request, create, task, detail, edit, policy, depend, close: async () => { await app.close(); store.close(); } };
}

test('task details retain structured edits, comments and attribution with optimistic updates and idempotency', async () => {
  const app = await start();
  try {
    const task = await app.task('Initial task'); const path = `/api/tasks/${task.id}`;
    const initial = await app.detail(task.id);
    assert.equal(task.version, 1); assert.equal(initial.history.transactions.filter(item => item.kind === 'create').length, 1);
    assert.equal(initial.history.transactions.find(item => item.kind === 'create')!.attribution?.principalId, app.alice.id);
    assert.equal(initial.history.accessEpoch, initial.accessEpoch);
    const input = { expectedVersion: 1, title: 'Updated task', description: 'Preserve this exact text.\r\n😀', priority: 'high' };
    const changed = await app.request<Task>('bob', path, 'PATCH', input, 'edit-once');
    assert.equal(changed.status, 200); assert.equal(changed.body.version, 2);
    assert.deepEqual(await app.request<Task>('bob', path, 'PATCH', input, 'edit-once'), changed);
    assert.equal((await app.request('alice', path, 'PATCH', { expectedVersion: 1, title: 'Stale edit' })).status, 409);
    assert.equal((await app.request('alice', path, 'PATCH', { status: 'resolved' })).status, 400);
    const comment = await app.create<TaskTransaction>('bob', `${path}/comments`, { body: 'A separate review note.' }, 'comment-once');
    assert.equal(comment.kind, 'comment'); assert.equal(comment.comment, 'A separate review note.');
    assert.equal(comment.attribution?.principalId, app.bob.id); assert.equal(comment.actor, 'Bob Reviewer');
    assert.deepEqual(await app.create('bob', `${path}/comments`, { body: 'A separate review note.' }, 'comment-once'), comment);
    const final = await app.detail(task.id);
    assert.equal(final.task.title, 'Updated task'); assert.equal(final.task.description, input.description);
    const edits = final.history.transactions.filter(item => item.kind === 'edit'); assert.equal(edits.length, 1);
    assert.equal(edits[0]!.attribution?.principalId, app.bob.id);
    assert.deepEqual(edits[0]!.changes?.find(change => change.field === 'title'), { field: 'title', oldValue: 'Initial task', newValue: 'Updated task' });
    assert.equal(final.history.transactions.filter(item => item.kind === 'comment').length, 1);
    assert.ok(edits[0]!.attribution?.requestId); assert.ok(edits[0]!.attribution?.credentialId);
    for (const query of ['?limit=0', '?limit=101', '?before=-1', '?before=1&before=2', '?limit=1&extra=1']) {
      assert.equal((await app.request('alice', `${path}/history${query}`)).status, 400, query);
    }
    assert.equal((await app.request('alice', `${path}?limit=1`)).status, 400);
  } finally { await app.close(); }
});

test('task comments, field edits and dependencies enforce distinct capabilities and current target visibility', async () => {
  const app = await start();
  try {
    const source = await app.task('Editable source'); const target = await app.task('Visible reference');
    await app.policy(source.id, { edit: members(app.bob.id), interact: members(app.alice.id) }, 'bob');
    await app.policy(target.id, { edit: members(app.alice.id), interact: members(app.alice.id) });
    const path = `/api/tasks/${source.id}`;
    assert.equal((await app.request('bob', `${path}/comments`, 'POST', { body: 'Not permitted.' })).status, 403);
    assert.equal((await app.request('reader', path, 'PATCH', { expectedVersion: source.version, title: 'Read token' })).status, 403);
    await app.create('alice', `${path}/comments`, { body: 'Interaction without edit access.' });
    await app.depend(source.id, target.id, 'bob');
    assert.equal((await app.detail(source.id, 'bob')).dependsOn[0]!.id, target.id, 'target edit permission is not required');
    await app.policy(target.id, { view: members(app.alice.id) });
    const version = (await app.detail(source.id, 'bob')).task.version;
    const hidden = await app.request('bob', `${path}/dependencies`, 'POST', { taskId: target.id, action: 'remove', expectedVersion: version });
    const missing = await app.request('bob', `${path}/dependencies`, 'POST', { taskId: 'T999999', action: 'remove', expectedVersion: version });
    assert.equal(hidden.status, 400); assert.deepEqual(hidden, missing); assert.equal(hidden.body.error, 'Reference unavailable.');
    for (const suffix of ['', '/history']) {
      const denied = await app.request('bob', `/api/tasks/${target.id}${suffix}`);
      assert.equal(denied.status, 404); assert.equal(denied.body.code, 'OBJECT_UNAVAILABLE');
      assert.deepEqual(denied, await app.request('bob', `/api/tasks/T999999${suffix}`));
    }
  } finally { await app.close(); }
});

test('history filters related tasks before pagination and redacts old and new project references', async () => {
  const app = await start();
  try {
    const first = await app.create<Project>('alice', '/api/projects', { name: 'Secret first project' });
    const second = await app.create<Project>('alice', '/api/projects', { name: 'Secret second project' });
    const task = await app.create<Task>('alice', '/api/tasks', { title: 'Shared task', projectId: first.id });
    const target = await app.task('Secret dependency title');
    await app.edit(task.id, { projectId: second.id });
    await app.depend(task.id, target.id);
    await app.create('alice', `/api/tasks/${task.id}/comments`, { body: 'Visible note one.' });
    await app.edit(target.id, { status: 'resolved' });
    await app.create('alice', `/api/tasks/${task.id}/comments`, { body: 'Visible note two.' });
    await app.edit(task.id, { projectId: null });
    for (const id of [first.id, second.id, target.id]) await app.policy(id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const detail = await app.detail(task.id, 'bob');
    assert.deepEqual(detail.dependsOn, []); assert.equal(detail.task.projectId, null);
    const serialized = JSON.stringify(detail);
    for (const marker of [first.id, second.id, target.id, 'Secret dependency title', 'Secret first project', 'Secret second project']) assert.ok(!serialized.includes(`"${marker}"`), marker);
    assert.equal(detail.history.transactions.some(item => item.kind === 'dependency' || item.kind === 'dependency_status'), false);
    const changes = detail.history.transactions.flatMap(item => item.changes || []).filter(change => change.field === 'projectId');
    assert.ok(changes.some(change => change.oldValueHidden && change.newValueHidden));
    assert.ok(changes.some(change => change.oldValueHidden && change.newValue === null && !change.newValueHidden));
    assert.equal(detail.history.transactions.find(item => item.snapshot)?.snapshot?.projectId, null);
    const expected = detail.history.transactions.map(item => item.id);
    const paged: string[] = []; let before: number | null = null;
    do {
      const result: { status: number; body: TaskHistory } = await app.request<TaskHistory>('bob', `/api/tasks/${task.id}/history?limit=2${before === null ? '' : `&before=${before}`}`);
      assert.equal(result.status, 200); assert.equal(typeof result.body.accessEpoch, 'number');
      if (result.body.nextBefore !== null) assert.equal(result.body.transactions.length, 2, 'a hidden relation must not consume a visible page slot');
      paged.push(...result.body.transactions.map(item => item.id)); before = result.body.nextBefore;
    } while (before !== null);
    assert.deepEqual(paged, expected); assert.equal(new Set(paged).size, paged.length);
    const state = (await app.request<AppState>('bob', '/api/state')).body;
    assert.doesNotMatch(JSON.stringify(state.activity), /Secret dependency title|Secret first project|Secret second project/);
  } finally { await app.close(); }
});

test('dependencies reject cycles through hidden intermediates and status changes never close parent tasks', async () => {
  const app = await start();
  try {
    const parent = await app.task('Parent'); const middle = await app.task('Hidden intermediate'); const leaf = await app.task('Leaf');
    await app.depend(parent.id, middle.id); await app.depend(middle.id, leaf.id);
    await app.policy(middle.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const input = { taskId: parent.id, action: 'add', expectedVersion: (await app.detail(leaf.id, 'bob')).task.version };
    const cycle = await app.request('bob', `/api/tasks/${leaf.id}/dependencies`, 'POST', input);
    assert.equal(cycle.status, 409); assert.ok(!JSON.stringify(cycle.body).includes(middle.id)); assert.doesNotMatch(JSON.stringify(cycle.body), /Hidden intermediate/);
    await app.edit(leaf.id, { status: 'resolved' }, 'bob');
    assert.equal((await app.detail(parent.id)).task.status, 'open'); assert.equal((await app.detail(middle.id)).task.status, 'open');
    const visible = await app.detail(leaf.id, 'bob'); assert.deepEqual(visible.blocks, []);
    const middleDetail = await app.detail(middle.id);
    assert.equal(middleDetail.dependsOn[0]!.status, 'resolved');
    assert.ok(middleDetail.history.transactions.some(item => item.dependencyStatus?.taskId === leaf.id && item.dependencyStatus.newStatus === 'resolved'));
    await app.edit(leaf.id, { status: 'open' }, 'bob');
    assert.equal((await app.detail(middle.id)).dependsOn[0]!.status, 'open');
  } finally { await app.close(); }
});

test('dependency retry responses remain historical, filter current references, and recheck destination access', async () => {
  const app = await start();
  try {
    const source = await app.task('Source'); const first = await app.task('Original reference title'); const second = await app.task('Later reference');
    const path = `/api/tasks/${source.id}/dependencies`;
    const saved = await app.depend(source.id, first.id, 'bob', 'add', 'old-dependency-result');
    const secondSaved = await app.depend(source.id, second.id, 'bob', 'add', 'two-reference-result');
    await app.edit(first.id, { title: 'New reference title', status: 'resolved' });
    const replay = await app.request<TaskDetail>('bob', path, 'POST', saved.input, 'old-dependency-result');
    assert.equal(replay.status, 200); assert.equal(replay.body.task.version, saved.result.body.task.version);
    assert.deepEqual(replay.body.dependsOn, saved.result.body.dependsOn);
    assert.deepEqual(replay.body.history.transactions, saved.result.body.history.transactions);
    assert.equal(replay.body.dependsOn.length, 1); assert.equal(replay.body.dependsOn[0]!.title, 'Original reference title');
    const stored = app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:old-dependency-result') as { body: string };
    await app.policy(first.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    const filtered = await app.request<TaskDetail>('bob', path, 'POST', secondSaved.input, 'two-reference-result');
    assert.equal(filtered.status, 200); assert.deepEqual(filtered.body.dependsOn, secondSaved.result.body.dependsOn.filter(item => item.id !== first.id));
    assert.ok(filtered.body.history.transactions.every(item => item.dependency?.taskId !== first.id && item.dependencyStatus?.taskId !== first.id));
    assert.equal(filtered.body.task.version, secondSaved.result.body.task.version);
    const denied = await app.request('bob', path, 'POST', saved.input, 'old-dependency-result');
    assert.equal(denied.status, 400); assert.equal(denied.body.error, 'Reference unavailable.');
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:old-dependency-result') as { body: string }).body, stored.body);
  } finally { await app.close(); }
});

test('historical task pagination uses only surviving stored transactions after access changes', async () => {
  const app = await start();
  try {
    const source = await app.task('Paged source'); const hidden = await app.task('Old dependency'); const visible = await app.task('Visible dependency');
    const first = await app.depend(source.id, hidden.id);
    const hiddenSequence = first.result.body.history.transactions.find(item => item.dependency?.taskId === hidden.id)!.sequence;
    for (let index = 0; index < 48; index++) await app.create('alice', `/api/tasks/${source.id}/comments`, { body: `Historical note ${index}.` });
    const saved = await app.depend(source.id, visible.id, 'bob', 'add', 'paged-dependency');
    const original = saved.result.body.history;
    assert.equal(original.transactions.length, 50); assert.equal(original.nextBefore, hiddenSequence);
    assert.equal(original.transactions.at(-1)?.dependency?.taskId, hidden.id);
    const stored = (app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:paged-dependency') as { body: string }).body;
    await app.policy(hidden.id, { view: members(app.alice.id), edit: members(app.alice.id), interact: members(app.alice.id) });
    await app.create('alice', `/api/tasks/${source.id}/comments`, { body: 'New note must not enter an old response.' });
    const replay = await app.request<TaskDetail>('bob', `/api/tasks/${source.id}/dependencies`, 'POST', saved.input, 'paged-dependency');
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body.history.transactions, original.transactions.filter(transaction => transaction.dependency?.taskId !== hidden.id));
    assert.equal(replay.body.history.nextBefore, hiddenSequence + 1);
    assert.equal(replay.body.history.transactions.at(-1)?.sequence, replay.body.history.nextBefore);
    const older = await app.request<TaskHistory>('bob', `/api/tasks/${source.id}/history?before=${replay.body.history.nextBefore}`);
    assert.equal(older.status, 200); assert.deepEqual(older.body.transactions.map(transaction => transaction.sequence), first.result.body.history.transactions.filter(transaction => transaction.sequence < hiddenSequence).map(transaction => transaction.sequence));
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:paged-dependency') as { body: string }).body, stored);
  } finally { await app.close(); }
});

test('pre-version task replay does not invent a current version or rewrite stored history', async () => {
  const app = await start();
  try {
    const input = { title: 'Historical task response' };
    const task = await app.create<Task>('alice', '/api/tasks', input, 'legacy-task');
    const { version: _version, ...legacy } = task;
    app.store.database.prepare('UPDATE idempotency SET body = ? WHERE key LIKE ?').run(JSON.stringify(legacy), '%:legacy-task');
    await app.edit(task.id, { title: 'Current title' });
    const replay = await app.request<Record<string, unknown>>('alice', '/api/tasks', 'POST', input, 'legacy-task');
    assert.equal(replay.status, 201); assert.deepEqual(replay.body, legacy); assert.equal('version' in replay.body, false);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:legacy-task') as { body: string }).body, JSON.stringify(legacy));
  } finally { await app.close(); }
});

test('destination policy revocation while waiting for the writer prevents relationship writes and saved-result disclosure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-task-policy-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const phase of ['write', 'replay'] as const) {
      const source = await app.task(`Source ${phase}`); const target = await app.task(`Target ${phase}`);
      const path = `/api/tasks/${source.id}/dependencies`; const input = { taskId: target.id, action: 'add', expectedVersion: source.version }; const key = `task-lock-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('alice', path, 'POST', input, key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const beforeSource = app.store.taskDetail(source.id); const beforeTarget = app.store.taskDetail(target.id);
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${target.id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { view: members(app.bob.id), edit: members(app.bob.id), interact: members(app.bob.id) } };
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
        const denied = await app.request('alice', path, 'POST', input, key);
        assert.equal(entered, 1); assert.equal(denied.status, 400); assert.equal(denied.body.error, 'Reference unavailable.');
        assert.deepEqual(app.store.taskDetail(source.id), beforeSource); assert.deepEqual(app.store.taskDetail(target.id), beforeTarget);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
