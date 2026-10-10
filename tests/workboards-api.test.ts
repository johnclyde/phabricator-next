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
import type { ObjectAccess } from '../shared/policy.ts';
import type { Project, ProjectChildPreview, Task, TaskDetail, TaskHistory } from '../shared/types.ts';
import type { MoveWorkboardCardInput, WorkboardCardPage, WorkboardDetail, WorkboardHistory, WorkboardReceipt } from '../shared/workboards.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'reader';
const selected = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const base = (id: string) => `/api/projects/${id}/workboard`;

async function start(path = ':memory:') {
  const store = createStore({ path });
  const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await operator.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice workboard testing password' });
  const bob = await operator.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob workboard testing password' });
  const app = createApp({ store, seed: false, authMode: 'password' });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }).token,
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }).token,
    reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request<T = ErrorBody>(actor: Actor, path: string, method = 'GET', body?: unknown, key?: string) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  async function project(name: string, fields: Record<string, unknown> = {}) { const result = await request<Project>('alice', '/api/projects', 'POST', { name, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function child(parentId: string, name: string, kind: 'project' | 'milestone' = 'project') {
    const preview = await request<ProjectChildPreview>('alice', `/api/projects/${parentId}/children/preview?kind=${kind}`); assert.equal(preview.status, 200);
    const p = preview.body; return project(name, { parentId, kind, expectedParentVersion: p.expectedParentVersion, expectedHierarchyVersion: p.expectedHierarchyVersion, expectedParentMembersVersion: p.expectedParentMembersVersion, confirmMembershipConversion: p.conversionRequired });
  }
  async function task(title: string, fields: Record<string, unknown> = {}) { const result = await request<Task>('alice', '/api/tasks', 'POST', { title, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function taskDetail(id: string, actor: Actor = 'alice') { const result = await request<TaskDetail>(actor, `/api/tasks/${id}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function policy(id: string, fields: Record<string, unknown>) {
    const current = (await request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>('alice', `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...fields }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body;
  }
  async function board(id: string, actor: Actor = 'alice', query = '') { const result = await request<WorkboardDetail>(actor, base(id) + query); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function enable(id: string) {
    const current = await board(id); const result = await request<WorkboardReceipt>('alice', base(id), 'PUT', { enabled: true, expectedBoardVersion: current.board.version }); assert.equal(result.status, 200, JSON.stringify(result.body)); return board(id);
  }
  async function column(id: string, name: string) {
    const result = await request<WorkboardReceipt>('alice', `${base(id)}/columns`, 'POST', { name, expectedBoardVersion: (await board(id)).board.version }); assert.equal(result.status, 201, JSON.stringify(result.body)); assert.ok(result.body.columnId); return result.body.columnId;
  }
  async function moveInput(projectId: string, taskId: string, columnId: string, position: MoveWorkboardCardInput['position'] = { edge: 'end' }): Promise<MoveWorkboardCardInput> {
    return { taskId, columnId, expectedBoardVersion: (await board(projectId)).board.version, expectedTaskVersion: (await taskDetail(taskId)).task.version, position };
  }
  async function move(projectId: string, taskId: string, columnId: string, actor: Actor = 'alice', key?: string, position: MoveWorkboardCardInput['position'] = { edge: 'end' }) {
    const input = await moveInput(projectId, taskId, columnId, position); const result = await request<WorkboardReceipt>(actor, `${base(projectId)}/moves`, 'POST', input, key); assert.equal(result.status, 200, JSON.stringify(result.body)); return { input, result };
  }
  return { ...app, alice, bob, request, project, child, task, taskDetail, policy, board, enable, column, moveInput, move, close: async () => { await app.close(); store.close(); } };
}

function receipt(body: WorkboardReceipt) {
  assert.equal(body.saved, true); assert.equal(body.refreshRequired, true); assert.ok(body.boardVersion >= 1); assert.equal(typeof body.accessEpoch, 'number');
  assert.ok(Object.keys(body).every(key => ['projectId', 'saved', 'refreshRequired', 'boardVersion', 'columnId', 'taskId', 'taskVersion', 'accessEpoch'].includes(key)));
}

test('board administration requires project edit while card moves require task edit, board view and write scope', async () => {
  const app = await start();
  try {
    const project = await app.project('Shared review board');
    const untouched = await app.board(project.id); assert.equal(untouched.board.version, 0); assert.equal(untouched.board.enabled, false);
    const disabled = await app.request<WorkboardReceipt>('alice', base(project.id), 'PUT', { enabled: false, expectedBoardVersion: 0 }); assert.equal(disabled.status, 200); assert.equal(disabled.body.boardVersion, 0); assert.equal(disabled.body.refreshRequired, true);
    const enabled = await app.enable(project.id); assert.equal(enabled.columns[0]?.name, 'Backlog');
    const destination = await app.column(project.id, 'Under discussion'); const task = await app.task('A paper to review');
    await app.policy(project.id, { edit: selected(app.alice.id) });
    const bob = await app.board(project.id, 'bob'); assert.equal(bob.canEdit, false);
    assert.equal((await app.request('bob', `${base(project.id)}/columns`, 'POST', { name: 'Unapproved', expectedBoardVersion: bob.board.version })).status, 403);
    const input = await app.moveInput(project.id, task.id, destination);
    assert.equal((await app.request('reader', `${base(project.id)}/moves`, 'POST', input)).status, 403);
    const moved = await app.request<WorkboardReceipt>('bob', `${base(project.id)}/moves`, 'POST', input, 'bob-move'); assert.equal(moved.status, 200); receipt(moved.body);
    const scoped = await app.board(project.id, 'reader'); assert.equal(scoped.canEdit, false); assert.equal(scoped.columns.find(item => item.id === destination)!.cards.cards[0]!.canMove, false);
    const detail = await app.taskDetail(task.id); assert.equal(detail.task.status, 'open'); assert.deepEqual(detail.task.projectIds, [project.id]);
    const transaction = detail.history.transactions.find(item => item.kind === 'column')!; assert.ok(transaction); assert.equal(transaction.attribution?.principalId, app.bob.id); assert.ok(transaction.attribution?.requestId);
    await app.policy(project.id, { edit: { kind: 'workspace' } }); await app.policy(task.id, { edit: selected(app.alice.id) });
    const readOnly = await app.board(project.id, 'bob'); assert.equal(readOnly.canEdit, true); assert.equal(readOnly.columns.find(item => item.id === destination)!.cards.cards[0]!.canMove, false);
    assert.equal((await app.request('bob', `${base(project.id)}/moves`, 'POST', await app.moveInput(project.id, task.id, enabled.columns[0]!.id))).status, 403);
    assert.equal((await app.request('reader', base(project.id), 'PUT', { enabled: false, expectedBoardVersion: readOnly.board.version })).status, 403);
  } finally { await app.close(); }
});

test('visible card counts, filtered pages, owner filters and child failures do not disclose hidden tasks or unrelated columns', async () => {
  const app = await start();
  try {
    const project = await app.project('Paginated board'); await app.enable(project.id); const destination = await app.column(project.id, 'Reading');
    const other = await app.project('Other board'); await app.enable(other.id); const foreign = await app.column(other.id, 'Other column');
    const visible = await app.task('Visible title', { projectIds: [project.id], ownerId: app.alice.id });
    const hidden = await app.task('Secret task title', { projectIds: [project.id] }); const last = await app.task('Last visible title', { projectIds: [project.id] });
    await app.move(project.id, visible.id, destination); await app.move(project.id, hidden.id, destination); await app.move(project.id, last.id, destination);
    assert.equal((await app.request('alice', `${base(project.id)}/columns/${destination}`, 'PATCH', { pointLimit: 2, expectedBoardVersion: (await app.board(project.id)).board.version })).status, 200);
    assert.equal((await app.board(project.id)).columns.find(item => item.id === destination)!.overLimit, true);
    await app.policy(hidden.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const board = await app.board(project.id, 'bob', '?limit=1'); const column = board.columns.find(item => item.id === destination)!;
    assert.equal(column.visibleCardCount, 2); assert.equal(column.overLimit, false); assert.equal(column.cards.cards.length, 1); assert.ok(column.cards.nextAfter); assert.equal(column.cards.accessEpoch, board.accessEpoch);
    assert.doesNotMatch(JSON.stringify(board), /Secret task title|hiddenCount|restrictedCount/); assert.ok(!JSON.stringify(board).includes(`"${hidden.id}"`));
    const page = await app.request<WorkboardCardPage>('bob', `${base(project.id)}/columns/${destination}/cards?limit=1&expectedBoardVersion=${board.board.version}&after=${encodeURIComponent(column.cards.nextAfter!)}`);
    assert.equal(page.status, 200); assert.equal(page.body.cards.length, 1); assert.equal(page.body.nextAfter, null); assert.deepEqual(page.body.filter, board.filter);
    assert.deepEqual(new Set([...column.cards.cards, ...page.body.cards].map(item => item.id)), new Set([visible.id, last.id]));
    const unassigned = await app.board(project.id, 'bob', '?ownerId=null'); assert.deepEqual(unassigned.columns.flatMap(item => item.cards.cards.map(card => card.id)), [last.id]);
    app.auth.setAccountDisabled(app.alice.id, true);
    const disabledOwner = await app.board(project.id, 'bob', `?ownerId=${app.alice.id}`); assert.deepEqual(disabledOwner.columns.flatMap(item => item.cards.cards.map(card => card.id)), [visible.id]);
    const input = { taskId: visible.id, columnId: foreign, expectedTaskVersion: (await app.taskDetail(visible.id, 'bob')).task.version, expectedBoardVersion: board.board.version, position: { edge: 'end' } };
    const wrong = await app.request('bob', `${base(project.id)}/moves`, 'POST', input); const missing = await app.request('bob', `${base(project.id)}/moves`, 'POST', { ...input, columnId: 'COL999999' });
    assert.deepEqual(wrong, missing); assert.equal(wrong.body.code, 'COLUMN_UNAVAILABLE');
    const hiddenAnchor = await app.request('bob', `${base(project.id)}/moves`, 'POST', { ...input, columnId: destination, position: { beforeTaskId: hidden.id } });
    assert.deepEqual(hiddenAnchor, await app.request('bob', `${base(project.id)}/moves`, 'POST', { ...input, columnId: destination, position: { beforeTaskId: 'T999999' } })); assert.equal(hiddenAnchor.body.code, 'TASK_REFERENCE_UNAVAILABLE');
    const hiddenMoved = await app.request('bob', `${base(project.id)}/moves`, 'POST', { ...input, columnId: destination, taskId: hidden.id });
    assert.deepEqual(hiddenMoved, await app.request('bob', `${base(project.id)}/moves`, 'POST', { ...input, columnId: destination, taskId: 'T999999' }));
    assert.equal((await app.board(project.id, 'bob')).project.id, project.id);
    for (const query of ['?status=closed', '?showHidden=1', '?limit=0', '?limit=101', '?status=open&status=all', '?ownerId=unknown', '?unknown=x']) assert.equal((await app.request('bob', base(project.id) + query)).status, 400, query);
    assert.equal((await app.request('bob', `${base(project.id)}/columns/${destination}/cards`)).status, 400);
    assert.equal((await app.request('bob', `${base(project.id)}/columns/${foreign}/cards?expectedBoardVersion=${board.board.version}`)).body.code, 'COLUMN_UNAVAILABLE');
    const resolved = await app.request<Task>('bob', `/api/tasks/${visible.id}`, 'PATCH', { expectedVersion: input.expectedTaskVersion, status: 'resolved' }); assert.equal(resolved.status, 200);
    assert.equal((await app.request('bob', `${base(project.id)}/columns/${destination}/cards?expectedBoardVersion=${board.board.version}&after=${encodeURIComponent(column.cards.nextAfter!)}`)).status, 409);
    assert.deepEqual((await app.board(project.id, 'bob')).columns.flatMap(item => item.cards.cards.map(card => card.id)), [last.id]);
    assert.deepEqual(new Set((await app.board(project.id, 'bob', '?status=all')).columns.flatMap(item => item.cards.cards.map(card => card.id))), new Set([visible.id, last.id]));
  } finally { await app.close(); }
});

test('milestone moves update tags atomically, ordinary proxies remain unavailable, and column changes return only receipts', async () => {
  const app = await start();
  try {
    const project = await app.project('Delivery'); const milestone = await app.child(project.id, 'First release', 'milestone'); const ordinary = await app.child(project.id, 'Private implementation');
    await app.enable(project.id); const normal = await app.column(project.id, 'Drafts');
    const board = await app.board(project.id); const proxy = board.columns.find(item => item.proxyProjectId === milestone.id)!; assert.ok(proxy);
    assert.equal(board.columns.some(item => item.proxyProjectId === ordinary.id), false);
    const task = await app.task('Milestone draft'); await app.move(project.id, task.id, proxy.id);
    assert.deepEqual((await app.taskDetail(task.id)).task.projectIds, [milestone.id]);
    await app.move(project.id, task.id, normal); assert.deepEqual((await app.taskDetail(task.id)).task.projectIds, [project.id]);
    const current = await app.board(project.id);
    const edit = await app.request<WorkboardReceipt>('alice', `${base(project.id)}/columns/${normal}`, 'PATCH', { expectedBoardVersion: current.board.version, name: 'Revised drafts', pointLimit: 1 }); assert.equal(edit.status, 200); receipt(edit.body);
    const order = await app.request<WorkboardReceipt>('alice', `${base(project.id)}/columns/${normal}/reorder`, 'POST', { expectedBoardVersion: (await app.board(project.id)).board.version, position: { edge: 'start' } }); assert.equal(order.status, 200); receipt(order.body);
    const invalid = await app.request('alice', `${base(project.id)}/columns/${proxy.id}`, 'PATCH', { expectedBoardVersion: (await app.board(project.id)).board.version, hidden: true }); assert.equal(invalid.status, 400);
    const proxyLimit = await app.request<WorkboardReceipt>('alice', `${base(project.id)}/columns/${proxy.id}`, 'PATCH', { expectedBoardVersion: (await app.board(project.id)).board.version, pointLimit: 2 }); assert.equal(proxyLimit.status, 200); receipt(proxyLimit.body);
    const rawProxy = app.store.database.prepare('SELECT id FROM workboard_columns WHERE proxy_project_id = ?').get(ordinary.id) as { id: string };
    assert.ok(rawProxy);
    await app.policy(ordinary.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const proxyInput = await app.moveInput(project.id, task.id, rawProxy.id);
    const ordinaryMove = await app.request('bob', `${base(project.id)}/moves`, 'POST', proxyInput); assert.equal(ordinaryMove.body.code, 'COLUMN_UNAVAILABLE');
    assert.deepEqual(ordinaryMove, await app.request('bob', `${base(project.id)}/moves`, 'POST', { ...proxyInput, columnId: 'COL999999' }));
  } finally { await app.close(); }
});

test('saved move receipts survive later anchor movement and CAS changes but reauthorize every original reference', async () => {
  const app = await start();
  try {
    const project = await app.project('Retry board'); await app.enable(project.id); const first = await app.column(project.id, 'First'); const second = await app.column(project.id, 'Second');
    const anchor = await app.task('Relative anchor'); const task = await app.task('Moving task');
    await app.move(project.id, anchor.id, first);
    const saved = await app.move(project.id, task.id, first, 'bob', 'stable-move', { beforeTaskId: anchor.id }); receipt(saved.result.body);
    const key = `${app.auth.workspaceId}:${app.bob.id}:stable-move`;
    const bytes = (app.store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get(key) as { body: string }).body;
    await app.move(project.id, anchor.id, second);
    const before = app.store.taskDetail(task.id); const replay = await app.request<WorkboardReceipt>('bob', `${base(project.id)}/moves`, 'POST', saved.input, 'stable-move');
    assert.deepEqual(replay, saved.result); assert.deepEqual(app.store.taskDetail(task.id), before);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get(key) as { body: string }).body, bytes);
    assert.equal((await app.request('bob', `${base(project.id)}/moves`, 'POST', saved.input, 'fresh-stale')).status, 409);
    await app.policy(anchor.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const denied = await app.request('bob', `${base(project.id)}/moves`, 'POST', saved.input, 'stable-move'); assert.equal(denied.status, 404); assert.equal(denied.body.code, 'TASK_REFERENCE_UNAVAILABLE');
    assert.equal((await app.board(project.id, 'bob')).project.id, project.id);
    await app.policy(task.id, { edit: selected(app.alice.id) });
    assert.equal((await app.request('bob', `${base(project.id)}/moves`, 'POST', saved.input, 'stable-move')).status, 403);
  } finally { await app.close(); }
});

test('board and task history remove whole hidden-reference events before pagination and on historical replay', async () => {
  const app = await start();
  try {
    const project = await app.project('History board'); await app.enable(project.id); const column = await app.column(project.id, 'Discussion');
    const anchor = await app.task('Secret anchor'); const task = await app.task('Public task'); await app.move(project.id, anchor.id, column);
    await app.move(project.id, task.id, column, 'bob', 'history-move', { beforeTaskId: anchor.id });
    const privateEvents = app.store.workboardHistory(project.id).transactions.filter(item => item.relatedTaskIds.includes(anchor.id)).map(item => item.id); assert.ok(privateEvents.length >= 2);
    await app.policy(anchor.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const full = await app.request<WorkboardHistory>('bob', `${base(project.id)}/history?limit=100`); assert.equal(full.status, 200);
    assert.equal(full.body.transactions.some(item => privateEvents.includes(item.id)), false); assert.ok(!JSON.stringify(full.body).includes(`"${anchor.id}"`));
    const seen: string[] = []; let before: number | null = null;
    do {
      const page: { status: number; body: WorkboardHistory } = await app.request<WorkboardHistory>('bob', `${base(project.id)}/history?limit=2${before === null ? '' : `&before=${before}`}`);
      assert.equal(page.status, 200); if (page.body.nextBefore !== null) assert.equal(page.body.transactions.length, 2);
      seen.push(...page.body.transactions.map(item => item.id)); before = page.body.nextBefore;
    } while (before !== null);
    assert.deepEqual(seen, full.body.transactions.map(item => item.id));
    const dependency = await app.task('Related public task');
    const input = { taskId: dependency.id, action: 'add', expectedVersion: (await app.taskDetail(task.id)).task.version };
    const saved = await app.request<TaskDetail>('bob', `/api/tasks/${task.id}/dependencies`, 'POST', input, 'old-task-detail'); assert.equal(saved.status, 200); assert.ok(saved.body.history.transactions.some(item => item.column));
    const key = `${app.auth.workspaceId}:${app.bob.id}:old-task-detail`; const bytes = (app.store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get(key) as { body: string }).body;
    await app.policy(project.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const taskHistory = await app.request<TaskHistory>('bob', `/api/tasks/${task.id}/history?limit=1`); assert.equal(taskHistory.status, 200); assert.equal(taskHistory.body.transactions.some(item => item.column), false);
    const replay = await app.request<TaskDetail>('bob', `/api/tasks/${task.id}/dependencies`, 'POST', input, 'old-task-detail'); assert.equal(replay.status, 200);
    assert.equal(replay.body.history.transactions.some(item => item.column), false); assert.ok(!JSON.stringify(replay.body).includes(`"${project.id}"`));
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get(key) as { body: string }).body, bytes);
    assert.equal((await app.request('bob', base(project.id))).body.code, 'OBJECT_UNAVAILABLE');
  } finally { await app.close(); }
});

test('writer-lock policy revocation prevents both new moves and saved replay disclosure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-workboard-policy-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const reference of ['task', 'anchor'] as const) for (const phase of ['write', 'replay'] as const) {
      const project = await app.project(`Board ${reference} ${phase}`); await app.enable(project.id); const column = await app.column(project.id, 'Destination');
      const anchor = await app.task(`Anchor ${reference} ${phase}`); const task = await app.task(`Task ${reference} ${phase}`); await app.move(project.id, anchor.id, column);
      const path = `${base(project.id)}/moves`; const input = await app.moveInput(project.id, task.id, column, { beforeTaskId: anchor.id }); const key = `lock-${reference}-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') {
        assert.equal((await app.request('bob', path, 'POST', input, key)).status, 200);
        replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key = ?').run(replay.key);
      }
      const capture = () => ['entities', 'task_transactions', 'activity', 'workboard_columns', 'workboard_positions', 'workboard_transactions'].map(table => app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = capture(); const id = reference === 'task' ? task.id : anchor.id;
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, [reference === 'task' ? 'edit' : 'view']: selected(app.alice.id) } };
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
        assert.equal(entered, 1); assert.equal(denied.status, reference === 'task' ? 403 : 404); assert.equal(denied.body.code, reference === 'task' ? 'ACTION_FORBIDDEN' : 'TASK_REFERENCE_UNAVAILABLE'); assert.deepEqual(capture(), before);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
