import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app.ts';
import { createAuth } from '../server/auth.ts';
import { createStore } from '../server/store.ts';
import type { Audience, ObjectAccess } from '../shared/policy.ts';
import type { AppState, Project, Task, TaskDetail, TaskHistory, TaskProjectsInput } from '../shared/types.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'reader';
const members = (...principalIds: string[]): Audience => ({ kind: 'principals', principalIds });

async function start(databasePath = ':memory:') {
  const store = createStore({ path: databasePath });
  const provisioner = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await provisioner.createAccount({ username: 'alice', displayName: 'Alice Writer', password: 'Alice project tags test password' });
  const bob = await provisioner.createAccount({ username: 'bob', displayName: 'Bob Reviewer', password: 'Bob project tags test password' });
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
  async function policy(id: string, changes: Partial<{ view: Audience; edit: Audience; interact: Audience }>, actor: Actor = 'alice') {
    const current = (await request<ObjectAccess>(actor, `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>(actor, `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...changes });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function project(name: string): Promise<Project> {
    const response = await request<Project>('alice', '/api/projects', 'POST', { name });
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body;
  }
  async function tags(id: string, action: TaskProjectsInput['action'], projectIds: string[], actor: Actor = 'alice', key?: string) {
    const input = { action, projectIds, expectedVersion: (await detail(id, actor)).task.version };
    const response = await request<TaskDetail>(actor, `/api/tasks/${id}/projects`, 'POST', input, key);
    assert.equal(response.status, 200, JSON.stringify(response.body)); return { input, response };
  }
  function legacyReplay(key: string, method: string, path: string, input: unknown, body: unknown, status = 200) {
    const bytes = JSON.stringify(body);
    store.database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run(
      `${app.auth.workspaceId}:${alice.id}:${key}`, createHash('sha256').update(JSON.stringify([method, path, input])).digest('hex'), status, bytes, new Date().toISOString());
    return bytes;
  }
  return { ...app, alice, bob, request, task, detail, edit, policy, project, tags, legacyReplay, close: async () => { await app.close(); store.close(); } };
}

test('tasks support attributed multi-project creation, add/remove/set and version-checked no-ops', async () => {
  const app = await start();
  try {
    const first = await app.project('First'); const second = await app.project('Second'); const third = await app.project('Third');
    const task = await app.task('Tagged work', 'alice', { projectIds: [first.id, second.id] });
    assert.deepEqual(new Set(task.projectIds), new Set([first.id, second.id])); assert.equal('projectId' in task, false);
    const initial = await app.detail(task.id); const epoch = initial.accessEpoch;
    const added = await app.tags(task.id, 'add', [third.id], 'bob', 'add-third');
    assert.equal(added.response.body.task.version, task.version + 1); assert.equal(added.response.body.accessEpoch, epoch);
    const event = added.response.body.history.transactions.find(item => item.project?.projectId === third.id)!;
    assert.equal(event.kind, 'project'); assert.equal(event.project?.action, 'added'); assert.ok(event.project?.operationId);
    assert.equal(event.attribution?.principalId, app.bob.id); assert.ok(event.attribution?.credentialId); assert.ok(event.attribution?.requestId);
    const noOp = await app.tags(task.id, 'add', [first.id, third.id]);
    assert.deepEqual(noOp.response.body, added.response.body);
    assert.deepEqual((await app.tags(task.id, 'remove', [])).response.body, noOp.response.body);
    const removed = await app.tags(task.id, 'remove', [first.id]);
    assert.deepEqual(new Set(removed.response.body.task.projectIds), new Set([second.id, third.id]));
    const set = await app.tags(task.id, 'set', [first.id]);
    assert.equal(set.response.body.task.version, removed.response.body.task.version + 1); assert.deepEqual(set.response.body.task.projectIds, [first.id]);
    const changes = set.response.body.history.transactions.filter(item => item.taskVersion === set.response.body.task.version && item.project);
    assert.equal(changes.length, 3); assert.equal(new Set(changes.map(item => item.project!.operationId)).size, 1);
    assert.deepEqual((await app.tags(task.id, 'set', [first.id])).response.body, set.response.body);
    const beforeStale = app.store.taskDetail(task.id);
    assert.equal((await app.request('alice', `/api/tasks/${task.id}/projects`, 'POST', { action: 'add', projectIds: [], expectedVersion: task.version })).status, 409);
    assert.deepEqual(app.store.taskDetail(task.id), beforeStale);
    const empty = await app.tags(task.id, 'set', []); assert.deepEqual(empty.response.body.task.projectIds, []);
    assert.deepEqual((await app.request<AppState>('alice', '/api/state')).body.tasks.find(item => item.id === task.id)?.projectIds, []);
    const alias = await app.task('Legacy creation alias', 'alice', { projectId: first.id }); assert.deepEqual(alias.projectIds, [first.id]); assert.equal('projectId' in alias, false);
    assert.deepEqual((await app.task('Empty creation alias', 'alice', { projectId: null })).projectIds, []);
    assert.equal((await app.request('alice', '/api/tasks', 'POST', { title: 'Ambiguous', projectId: first.id, projectIds: [second.id] })).status, 400);
    for (const projectIds of [[first.id, first.id], Array.from({ length: 101 }, () => first.id), null, [1]]) {
      assert.equal((await app.request('alice', `/api/tasks/${task.id}/projects`, 'POST', { action: 'set', projectIds, expectedVersion: empty.response.body.task.version })).status, 400);
    }
  } finally { await app.close(); }
});

test('ordinary deltas preserve hidden associations while explicit replacement can remove them without project edit access', async () => {
  const app = await start();
  try {
    const visible = await app.project('Visible tag'); const hidden = await app.project('Secret tag'); const added = await app.project('Visible read-only project');
    await app.policy(hidden.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    await app.policy(added.id, { edit: members(app.alice.id) });
    const task = await app.task('Shared task', 'alice', { projectIds: [visible.id, hidden.id] });
    await app.policy(task.id, { interact: members(app.alice.id) });
    assert.deepEqual((await app.detail(task.id, 'bob')).task.projectIds, [visible.id]);
    const edit = await app.request<Task>('bob', `/api/tasks/${task.id}`, 'PATCH', { expectedVersion: task.version, title: 'Unrelated edit' });
    assert.equal(edit.status, 200); assert.deepEqual(edit.body.projectIds, [visible.id]);
    await app.tags(task.id, 'add', [added.id], 'bob'); await app.tags(task.id, 'remove', [visible.id], 'bob');
    assert.deepEqual(new Set((await app.detail(task.id)).task.projectIds), new Set([hidden.id, added.id]));
    const replace = await app.tags(task.id, 'set', [visible.id], 'bob', 'replace-all');
    assert.deepEqual(replace.response.body.task.projectIds, [visible.id]); assert.deepEqual((await app.detail(task.id)).task.projectIds, [visible.id]);
    assert.ok(!JSON.stringify(replace.response.body).includes(`"${hidden.id}"`)); assert.doesNotMatch(JSON.stringify(replace.response.body), /Secret tag|hiddenCount|restrictedCount/);
    assert.equal(replace.response.body.history.transactions.some(item => item.project?.projectId === hidden.id), false);
    const raw = app.store.taskHistory(task.id).transactions.find(item => item.project?.projectId === hidden.id && item.project.action === 'removed'); assert.ok(raw);
    assert.equal(raw.attribution?.principalId, app.bob.id);
    await app.tags(task.id, 'add', [hidden.id]);
    const clear = await app.tags(task.id, 'set', [], 'bob'); assert.deepEqual(clear.response.body.task.projectIds, []); assert.deepEqual((await app.detail(task.id)).task.projectIds, []);
    const activity = (await app.request<AppState>('bob', '/api/state')).body.activity;
    assert.doesNotMatch(JSON.stringify(activity), /Secret tag/);
  } finally { await app.close(); }
});

test('tag changes require task edit and write scope, selected references fail generically, and scalar PATCH rejection is uniform', async () => {
  const app = await start();
  try {
    const project = await app.project('Private tag'); const task = await app.task('Shared task');
    await app.policy(project.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    for (const action of ['add', 'remove', 'set']) {
      const input = { action, projectIds: [project.id], expectedVersion: task.version };
      const hidden = await app.request('bob', `/api/tasks/${task.id}/projects`, 'POST', input);
      assert.deepEqual(hidden, await app.request('bob', `/api/tasks/${task.id}/projects`, 'POST', { ...input, projectIds: ['PROJ999999'] }));
      assert.equal(hidden.status, 400); assert.equal(hidden.body.error, 'Reference unavailable.');
    }
    const hiddenCreation = await app.request('bob', '/api/tasks', 'POST', { title: 'Invalid', projectIds: [project.id] });
    assert.deepEqual(hiddenCreation, await app.request('bob', '/api/tasks', 'POST', { title: 'Invalid', projectIds: ['PROJ999999'] }));
    assert.equal((await app.request('reader', `/api/tasks/${task.id}/projects`, 'POST', { action: 'set', projectIds: [], expectedVersion: task.version })).status, 403);
    const scalarHidden = await app.request('bob', `/api/tasks/${task.id}`, 'PATCH', { projectId: project.id, expectedVersion: task.version });
    const scalarMissing = await app.request('bob', `/api/tasks/${task.id}`, 'PATCH', { projectId: 'PROJ999999', expectedVersion: task.version });
    assert.equal(scalarHidden.status, 400); assert.deepEqual(scalarHidden, scalarMissing); assert.match(scalarHidden.body.error, /project|tag/i);
    assert.equal((await app.request('bob', `/api/tasks/${task.id}`, 'PATCH', { projectIds: [], expectedVersion: task.version })).status, 400);
    await app.policy(task.id, { edit: members(app.alice.id) });
    assert.equal((await app.request('bob', `/api/tasks/${task.id}/projects`, 'POST', { action: 'set', projectIds: [], expectedVersion: task.version })).status, 403);
    await app.policy(task.id, { view: members(app.alice.id) });
    assert.equal((await app.request('bob', `/api/tasks/${task.id}/projects`, 'POST', { action: 'set', projectIds: [], expectedVersion: task.version })).status, 404);
  } finally { await app.close(); }
});

test('project history is filtered before pagination and legacy snapshot scalars are redacted without fabricated history', async () => {
  const app = await start();
  try {
    const projects = await Promise.all(Array.from({ length: 7 }, (_, index) => app.project(`Project ${index}`)));
    const task = await app.task('Paged tags', 'alice', { projectIds: [projects[0]!.id] });
    for (const project of projects.slice(1)) await app.tags(task.id, 'add', [project.id]);
    for (const project of [projects[0]!, projects[2]!, projects[4]!, projects[6]!]) await app.policy(project.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    const detail = await app.detail(task.id, 'bob');
    assert.deepEqual(new Set(detail.task.projectIds), new Set([projects[1]!.id, projects[3]!.id, projects[5]!.id]));
    assert.deepEqual(detail.history.transactions.find(item => item.snapshot)?.snapshot?.projectIds, []);
    const seen: string[] = []; let before: number | null = null;
    do {
      const page: { status: number; body: TaskHistory } = await app.request<TaskHistory>('bob', `/api/tasks/${task.id}/history?limit=2${before === null ? '' : `&before=${before}`}`);
      assert.equal(page.status, 200); if (page.body.nextBefore !== null) assert.equal(page.body.transactions.length, 2);
      seen.push(...page.body.transactions.map(transaction => transaction.id)); before = page.body.nextBefore;
    } while (before !== null);
    assert.deepEqual(seen, detail.history.transactions.map(item => item.id));
    assert.equal(new Set(seen).size, seen.length);
    for (const project of [projects[0]!, projects[2]!, projects[4]!, projects[6]!]) assert.ok(!JSON.stringify(detail).includes(`"${project.id}"`));
  } finally { await app.close(); }
});

test('tag retries retain historical content, recheck selected projects, and remain scoped to their initiating principal', async () => {
  const app = await start();
  try {
    const first = await app.project('First'); const second = await app.project('Second'); const third = await app.project('Third');
    const task = await app.task('Historical task');
    const firstSaved = await app.tags(task.id, 'add', [first.id], 'bob', 'first-tag');
    const saved = await app.tags(task.id, 'add', [second.id], 'bob', 'same-key');
    const originalBytes = (app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:same-key') as { body: string }).body;
    await app.tags(task.id, 'add', [third.id], 'alice', 'same-key');
    await app.policy(first.id, { view: members(app.alice.id), edit: members(app.alice.id) });
    const replay = await app.request<TaskDetail>('bob', `/api/tasks/${task.id}/projects`, 'POST', saved.input, 'same-key');
    assert.equal(replay.status, 200); assert.equal(replay.body.task.version, saved.response.body.task.version); assert.deepEqual(replay.body.task.projectIds, [second.id]);
    assert.deepEqual(replay.body.history.transactions, saved.response.body.history.transactions.filter(item => item.project?.projectId !== first.id));
    assert.equal((await app.detail(task.id)).task.projectIds.length, 3);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get(`${app.auth.workspaceId}:${app.bob.id}:same-key`) as { body: string }).body, originalBytes);
    const denied = await app.request('bob', `/api/tasks/${task.id}/projects`, 'POST', firstSaved.input, 'first-tag'); assert.equal(denied.status, 400); assert.equal(denied.body.error, 'Reference unavailable.');
    const cleared = await app.tags(task.id, 'set', [], 'bob', 'clear-hidden');
    await app.tags(task.id, 'add', [first.id]); const before = app.store.taskDetail(task.id);
    assert.equal((await app.request<TaskDetail>('bob', `/api/tasks/${task.id}/projects`, 'POST', cleared.input, 'clear-hidden')).body.task.projectIds.length, 0);
    assert.deepEqual(app.store.taskDetail(task.id), before, 'replaying a clear must not clear newly added associations');
  } finally { await app.close(); }
});

test('legacy scalar task retries normalize only saved task data, preserve nested evidence and never rewrite bytes', async () => {
  const app = await start();
  try {
    const first = await app.project('Historical tag'); const second = await app.project('Current tag');
    const task = await app.task('Current task', 'alice', { projectIds: [second.id] }); const path = `/api/tasks/${task.id}`;
    const { projectIds: _tags, ownerId: _owner, authorId: _author, ...rest } = task;
    const legacy = { ...rest, title: 'Historical title', projectId: first.id };
    const oldInput = { expectedVersion: 1, projectId: first.id, title: 'Historical title' };
    const bytes = app.legacyReplay('legacy-scalar', 'PATCH', path, oldInput, legacy);
    const replay = await app.request<Record<string, unknown>>('alice', path, 'PATCH', oldInput, 'legacy-scalar');
    assert.equal(replay.status, 200); assert.deepEqual(replay.body.projectIds, [first.id]); assert.equal('projectId' in replay.body, false);
    assert.equal('ownerId' in replay.body, false); assert.equal('authorId' in replay.body, false); assert.equal(replay.body.title, 'Historical title');
    const detail = await app.detail(task.id);
    const oldDetail = { ...detail, task: legacy, history: { ...detail.history, transactions: detail.history.transactions.map(transaction => transaction.snapshot ? { ...transaction, snapshot: legacy } : transaction) } };
    const related = await app.task('Historical dependency');
    const dependencyInput = { taskId: related.id, expectedVersion: 1, action: 'add' };
    app.legacyReplay('legacy-detail-tags', 'POST', `${path}/dependencies`, dependencyInput, oldDetail);
    const detailReplay = await app.request<TaskDetail>('alice', `${path}/dependencies`, 'POST', dependencyInput, 'legacy-detail-tags');
    assert.equal(detailReplay.status, 200); assert.deepEqual(detailReplay.body.task.projectIds, [first.id]); assert.equal('projectId' in detailReplay.body.task, false);
    const snapshot = detailReplay.body.history.transactions.find(transaction => transaction.snapshot)!.snapshot!;
    assert.equal(snapshot.projectId, first.id); assert.equal(snapshot.projectIds, undefined);
    await app.policy(first.id, { view: members(app.bob.id), edit: members(app.alice.id, app.bob.id) }, 'bob');
    // Keep Alice's task access; hidden historical project identities disappear
    // even though a successful old scalar PATCH must remain replayable.
    const hiddenReplay = await app.request<TaskDetail>('alice', `${path}/dependencies`, 'POST', dependencyInput, 'legacy-detail-tags');
    assert.deepEqual(hiddenReplay.body.task.projectIds, []); assert.equal(hiddenReplay.body.history.transactions.find(transaction => transaction.snapshot)!.snapshot!.projectId, null);
    assert.deepEqual((await app.request<Record<string, unknown>>('alice', path, 'PATCH', oldInput, 'legacy-scalar')).body.projectIds, []);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key LIKE ?').get('%:legacy-scalar') as { body: string }).body, bytes);
    assert.deepEqual((await app.detail(task.id)).task.projectIds, [second.id]);
    for (const [key, value] of [['bad-scalar', 'T999'], ['missing-scalar', undefined]] as const) {
      const malformed = { ...rest, ...(value === undefined ? {} : { projectId: value }) };
      app.legacyReplay(key, 'PATCH', path, { expectedVersion: 1, title: key }, malformed);
      assert.equal((await app.request('alice', path, 'PATCH', { expectedVersion: 1, title: key }, key)).status, 409);
    }
  } finally { await app.close(); }
});

test('selected-project revocation while waiting for the writer prevents task creation, tag mutation and saved replay disclosure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-project-policy-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const mode of ['create', 'change'] as const) for (const phase of ['write', 'replay'] as const) {
      const project = await app.project(`Selected ${mode} ${phase}`); const task = await app.task(`Task ${mode} ${phase}`);
      const path = mode === 'create' ? '/api/tasks' : `/api/tasks/${task.id}/projects`;
      const input = mode === 'create' ? { title: `Created ${phase}`, projectIds: [project.id] } : { action: 'add', projectIds: [project.id], expectedVersion: task.version };
      const key = `project-lock-${mode}-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('bob', path, 'POST', input, key)).status, mode === 'create' ? 201 : 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay;
        assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const capture = () => ['entities', 'task_transactions', 'activity'].map(table => app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = capture();
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${project.id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, view: members(app.alice.id) } };
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
        assert.equal(entered, 1); assert.equal(denied.status, 400); assert.equal(denied.body.error, 'Reference unavailable.');
        assert.deepEqual(capture(), before);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
