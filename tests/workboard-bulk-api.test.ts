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
import type { BulkMoveWorkboardCardsInput, WorkboardBulkMovePreview, WorkboardBulkMoveQuery, WorkboardBulkMoveReceipt, WorkboardDetail, WorkboardHistory, WorkboardReceipt } from '../shared/workboards.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'reader';
const selected = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const base = (id: string) => `/api/projects/${id}/workboard`;
const previewPath = (id: string, query: WorkboardBulkMoveQuery) => `${base(id)}/bulk-move-preview?${new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]))}`;
const input = (preview: WorkboardBulkMovePreview): BulkMoveWorkboardCardsInput => ({ sourceColumnId: preview.sourceColumn.id, destinationProjectId: preview.destinationProject.id, destinationColumnId: preview.destinationColumn.id,
  expectedBoardVersion: preview.expectedBoardVersion, expectedDestinationBoardVersion: preview.expectedDestinationBoardVersion, tasks: preview.tasks.map(task => ({ taskId: task.id, expectedTaskVersion: task.version })) });

async function start(path = ':memory:', basePath = '/') {
  const store = createStore({ path });
  const operator = createAuth({ database: store.database, mode: 'local', basePath, provisioning: true });
  const alice = await operator.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice bulk moving testing password' });
  const bob = await operator.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob bulk moving testing password' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath });
  const tokens = { alice: app.auth.createToken(alice.id, { name: 'Alice', scopes: ['read', 'write'] }).token,
    bob: app.auth.createToken(bob.id, { name: 'Bob', scopes: ['read', 'write'] }).token,
    reader: app.auth.createToken(bob.id, { name: 'Reader', scopes: ['read'] }).token };
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`; const prefix = basePath.replace(/\/$/, '');
  async function request<T = ErrorBody>(actor: Actor, path: string, method = 'GET', body?: unknown, key?: string) {
    const response = await fetch(origin + prefix + path, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as T };
  }
  async function project(name: string, fields: Record<string, unknown> = {}) { const result = await request<Project>('alice', '/api/projects', 'POST', { name, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function child(parentId: string, name: string, kind: 'project' | 'milestone' = 'milestone') {
    const result = await request<ProjectChildPreview>('alice', `/api/projects/${parentId}/children/preview?kind=${kind}`); assert.equal(result.status, 200); const p = result.body;
    return project(name, { parentId, kind, expectedParentVersion: p.expectedParentVersion, expectedHierarchyVersion: p.expectedHierarchyVersion, expectedParentMembersVersion: p.expectedParentMembersVersion, confirmMembershipConversion: p.conversionRequired });
  }
  async function policy(id: string, fields: Record<string, unknown>) {
    const current = (await request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>('alice', `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...fields }); assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  async function task(title: string, fields: Record<string, unknown> = {}) { const result = await request<Task>('alice', '/api/tasks', 'POST', { title, ...fields }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; }
  async function board(id: string, actor: Actor = 'alice', query = '') { const result = await request<WorkboardDetail>(actor, base(id) + query); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function enable(id: string) { const result = await request<WorkboardReceipt>('alice', base(id), 'PUT', { enabled: true, expectedBoardVersion: (await board(id)).board.version }); assert.equal(result.status, 200, JSON.stringify(result.body)); return board(id); }
  async function column(id: string, name: string) { const result = await request<WorkboardReceipt>('alice', `${base(id)}/columns`, 'POST', { name, expectedBoardVersion: (await board(id)).board.version }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.columnId!; }
  async function preview(id: string, query: WorkboardBulkMoveQuery, actor: Actor = 'bob') { const result = await request<WorkboardBulkMovePreview>(actor, previewPath(id, query)); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function pair(name: string) { const source = await project(`Source ${name}`); const destination = await project(`Destination ${name}`); const sourceColumnId = (await enable(source.id)).columns[0]!.id; const destinationColumnId = (await enable(destination.id)).columns[0]!.id; return { source, destination, query: { sourceColumnId, destinationProjectId: destination.id, destinationColumnId } }; }
  const capture = () => ['entities', 'sequences', 'activity', 'task_transactions', 'task_projects', 'project_workboards', 'workboard_columns', 'workboard_positions', 'workboard_transactions'].map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { ...app, alice, bob, request, project, child, task, policy, board, enable, column, preview, pair, capture, origin, prefix, close: async () => { await app.close(); store.close(); } };
}

function receipt(body: WorkboardBulkMoveReceipt) {
  assert.deepEqual(Object.keys(body).sort(), ['accessEpoch', 'boardVersion', 'destinationBoardVersion', 'destinationProjectId', 'projectId', 'refreshRequired', 'saved']);
  assert.equal(body.saved, true); assert.equal(body.refreshRequired, true); assert.ok(body.boardVersion >= 1 && body.destinationBoardVersion >= 1); assert.equal(typeof body.accessEpoch, 'number');
}

test('mounted bulk preview captures all filtered editable cards beyond one page and read tokens cannot submit', async () => {
  const app = await start(':memory:', '/review/');
  try {
    const { source, destination, query } = await app.pair('permission matrix');
    await app.policy(source.id, { edit: selected(app.alice.id) }); await app.policy(destination.id, { edit: selected(app.alice.id) });
    const movable: Task[] = []; for (let index = 0; index < 53; index++) movable.push(await app.task(`Movable ${index}`, { projectIds: [source.id] }));
    const hidden = await app.task('Private selected task', { projectIds: [source.id] }); await app.policy(hidden.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const readOnly = await app.task('Visible no edit', { projectIds: [source.id] }); await app.policy(readOnly.id, { edit: selected(app.alice.id) });
    const closed = await app.task('Closed source task', { projectIds: [source.id], status: 'resolved', ownerId: app.alice.id });
    assert.equal((await app.board(source.id, 'bob')).columns[0]!.cards.cards.length, 50);
    const preview = await app.preview(source.id, query); assert.equal(preview.tasks.length, 53); assert.equal(typeof preview.accessEpoch, 'number');
    assert.deepEqual(preview.tasks.map(task => task.id), movable.map(task => task.id).reverse());
    assert.ok(!JSON.stringify(preview).includes(`"${hidden.id}"`)); assert.ok(!JSON.stringify(preview).includes(`"${readOnly.id}"`)); assert.doesNotMatch(JSON.stringify(preview), /hiddenCount|skippedCount|hasMore/);
    const scoped = await app.preview(source.id, query, 'reader'); assert.deepEqual(scoped, preview);
    assert.deepEqual((await app.preview(source.id, { ...query, status: 'all', ownerId: app.alice.id })).tasks.map(task => task.id), [closed.id]);
    assert.equal((await app.request('reader', `${base(source.id)}/bulk-moves`, 'POST', input(preview))).status, 403);
    assert.equal((await fetch(app.origin + app.prefix + previewPath(source.id, query))).status, 401);
    const result = await app.request<WorkboardBulkMoveReceipt>('bob', `${base(source.id)}/bulk-moves`, 'POST', input(preview), 'mounted-bulk'); assert.equal(result.status, 200, JSON.stringify(result.body)); receipt(result.body);
    const final = await app.board(destination.id, 'bob', '?limit=100'); assert.deepEqual(final.columns[0]!.cards.cards.map(task => task.id), movable.map(task => task.id));
    assert.deepEqual(app.store.taskDetail(hidden.id).task.projectIds, [source.id]); assert.deepEqual(app.store.taskDetail(readOnly.id).task.projectIds, [source.id]); assert.equal(app.store.taskDetail(closed.id).task.status, 'resolved');
  } finally { await app.close(); }
});

test('bulk bounds and syntax are validated before per-task authorization, with no partial write or expanded selection', async () => {
  const app = await start();
  try {
    const { source, query } = await app.pair('bounds'); const task = await app.task('Reviewed task', { projectIds: [source.id] }); const outsider = await app.task('Injected task');
    const preview = await app.preview(source.id, query); const original = input(preview); const before = app.capture();
    const invalid: unknown[] = [null, [], { ...original, extra: true }, { ...original, tasks: [] }, { ...original, tasks: 'all' },
      { ...original, tasks: [original.tasks[0], original.tasks[0]] }, { ...original, tasks: [{ taskId: task.id, expectedTaskVersion: 0 }] },
      { ...original, tasks: [{ taskId: 'T01', expectedTaskVersion: 1 }] }, { ...original, tasks: [{ taskId: task.id, expectedTaskVersion: 1, title: 'injected' }] },
      { ...original, expectedBoardVersion: '1' }, { ...original, expectedDestinationBoardVersion: -1 }];
    for (const body of invalid) assert.equal((await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', body)).status, 400, JSON.stringify(body));
    const access = app.policies.access.bind(app.policies); let taskChecks = 0;
    app.policies.access = (id, principalId) => { if (/^T\d+$/.test(id)) taskChecks++; return access(id, principalId); };
    try { assert.equal((await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', { ...original, tasks: Array.from({ length: 101 }, (_, index) => ({ taskId: `T${index + 1}`, expectedTaskVersion: 1 })) })).status, 400); assert.equal(taskChecks, 0); } finally { app.policies.access = access; }
    assert.equal((await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', { ...original, tasks: [...original.tasks, { taskId: outsider.id, expectedTaskVersion: outsider.version }] })).status, 409);
    assert.deepEqual(app.capture(), before);
    await app.task('Arrived after preview', { projectIds: [source.id] }); const changed = app.capture();
    assert.equal((await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', original, 'stale-selection')).status, 409); assert.deepEqual(app.capture(), changed);
    for (let index = 0; index < 99; index++) app.store.createTask({ title: `Cap ${index}`, projectIds: [source.id] });
    const capped = await app.request('bob', previewPath(source.id, query)); assert.equal(capped.status, 409); assert.doesNotMatch(JSON.stringify(capped.body), /Cap 98|Arrived after preview/);
    for (const suffix of ['&limit=50', '&sourceColumnId=COL999', '&status=closed', '&showHidden=1', '&ownerId=unknown', '&unexpected=1']) assert.equal((await app.request('bob', previewPath(source.id, query) + suffix)).status, 400, suffix);
    assert.equal((await app.request('bob', `${base(source.id)}/bulk-move-preview`)).status, 400);
  } finally { await app.close(); }
});

test('source hidden and disabled columns remain selectable while destination and child reference failures are scoped', async () => {
  const app = await start();
  try {
    const { source, destination, query } = await app.pair('references'); const sourceColumnId = await app.column(source.id, 'Hidden source');
    const task = await app.task('Hidden column task', { projectIds: [source.id] });
    assert.equal((await app.request('alice', `${base(source.id)}/moves`, 'POST', { taskId: task.id, columnId: sourceColumnId, expectedTaskVersion: task.version, expectedBoardVersion: (await app.board(source.id)).board.version, position: { edge: 'start' } })).status, 200);
    assert.equal((await app.request('alice', `${base(source.id)}/columns/${sourceColumnId}`, 'PATCH', { hidden: true, expectedBoardVersion: (await app.board(source.id)).board.version })).status, 200);
    assert.equal((await app.request('alice', base(source.id), 'PUT', { enabled: false, expectedBoardVersion: (await app.board(source.id)).board.version })).status, 200);
    const preview = await app.preview(source.id, { ...query, sourceColumnId }); assert.equal(preview.sourceColumn.hidden, true); assert.deepEqual(preview.tasks.map(item => item.id), [task.id]);
    const foreign = await app.project('Foreign board'); const foreignColumn = (await app.enable(foreign.id)).columns[0]!.id;
    for (const field of ['sourceColumnId', 'destinationColumnId'] as const) {
      const wrong = await app.request('bob', previewPath(source.id, { ...query, sourceColumnId, [field]: foreignColumn }));
      const missing = await app.request('bob', previewPath(source.id, { ...query, sourceColumnId, [field]: 'COL999999' })); assert.deepEqual(wrong, missing); assert.equal(wrong.body.code, 'COLUMN_UNAVAILABLE');
    }
    await app.policy(foreign.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const hidden = await app.request('bob', previewPath(source.id, { ...query, sourceColumnId, destinationProjectId: foreign.id, destinationColumnId: foreignColumn }));
    assert.deepEqual(hidden, await app.request('bob', previewPath(source.id, { ...query, sourceColumnId, destinationProjectId: 'PROJ999999' }))); assert.equal(hidden.body.code, 'PROJECT_REFERENCE_UNAVAILABLE');
    const targetHidden = await app.column(destination.id, 'Hidden destination');
    assert.equal((await app.request('alice', `${base(destination.id)}/columns/${targetHidden}`, 'PATCH', { hidden: true, expectedBoardVersion: (await app.board(destination.id)).board.version })).status, 200);
    assert.equal((await app.request('bob', previewPath(source.id, { ...query, sourceColumnId, destinationColumnId: targetHidden }))).status, 409);
    const milestone = await app.child(destination.id, 'Proxy destination'); const proxy = (await app.board(destination.id)).columns.find(column => column.proxyProjectId === milestone.id)!;
    assert.equal((await app.request('bob', previewPath(source.id, { ...query, sourceColumnId, destinationColumnId: proxy.id }))).status, 400);
    const ordinary = await app.child(source.id, 'Unrendered source', 'project'); await app.enable(source.id);
    const ordinaryColumn = (app.store.database.prepare('SELECT id FROM workboard_columns WHERE proxy_project_id=?').get(ordinary.id) as { id: string }).id;
    assert.equal((await app.request('bob', previewPath(source.id, { ...query, sourceColumnId: ordinaryColumn }))).body.code, 'COLUMN_UNAVAILABLE');
    const fresh = await app.preview(source.id, { ...query, sourceColumnId });
    const moved = await app.request<WorkboardBulkMoveReceipt>('bob', `${base(source.id)}/bulk-moves`, 'POST', input(fresh)); assert.equal(moved.status, 200, JSON.stringify(moved.body)); receipt(moved.body);
    assert.deepEqual(app.store.taskDetail(task.id).task.projectIds, [destination.id]);
  } finally { await app.close(); }
});

test('milestone source tags survive unrelated cross-board moves and hidden bulk provenance is removed from current and saved histories', async () => {
  const app = await start();
  try {
    const source = await app.project('Source parent'); const milestone = await app.child(source.id, 'Retained milestone'); const sourceBoard = await app.enable(source.id);
    const destination = await app.project('Destination parent'); const destinationBoard = await app.enable(destination.id);
    const task = await app.task('Two-board task', { projectIds: [milestone.id] });
    const query = { sourceColumnId: sourceBoard.columns.find(column => column.proxyProjectId === milestone.id)!.id, destinationProjectId: destination.id, destinationColumnId: destinationBoard.columns[0]!.id };
    const preview = await app.preview(source.id, query); const submitted = input(preview);
    const saved = await app.request<WorkboardBulkMoveReceipt>('bob', `${base(source.id)}/bulk-moves`, 'POST', submitted, 'milestone-transfer'); assert.equal(saved.status, 200); receipt(saved.body);
    const detail = app.store.taskDetail(task.id); assert.deepEqual(new Set(detail.task.projectIds), new Set([milestone.id, destination.id])); assert.equal(detail.task.status, 'open');
    assert.deepEqual((await app.board(source.id)).columns.find(column => column.id === query.sourceColumnId)!.cards.cards.map(card => card.id), [task.id]);
    const columnEvent = detail.history.transactions.find(event => event.column?.bulkSource)!; assert.equal(columnEvent.column!.bulkSource!.column.proxyProjectId, milestone.id); assert.equal(columnEvent.attribution?.principalId, app.bob.id);
    const related = await app.task('Public dependency'); const dependency = { taskId: related.id, action: 'add', expectedVersion: detail.task.version };
    const snapshot = await app.request<TaskDetail>('bob', `/api/tasks/${task.id}/dependencies`, 'POST', dependency, 'saved-task-history'); assert.equal(snapshot.status, 200); assert.ok(snapshot.body.history.transactions.some(event => event.column?.bulkSource));
    const key = `${app.auth.workspaceId}:${app.bob.id}:saved-task-history`; const bytes = (app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body;
    await app.policy(source.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const visible = await app.board(destination.id, 'bob'); assert.deepEqual(visible.columns[0]!.cards.cards[0]!.projectIds, [destination.id]);
    const boardHistory = await app.request<WorkboardHistory>('bob', `${base(destination.id)}/history?limit=1`); assert.equal(boardHistory.status, 200); assert.equal(boardHistory.body.transactions.some(event => event.bulkMove || event.move?.bulkSource), false);
    const history = await app.request<TaskHistory>('bob', `/api/tasks/${task.id}/history?limit=100`); assert.equal(history.status, 200); assert.equal(history.body.transactions.some(event => event.column?.bulkSource), false);
    const replay = await app.request<TaskDetail>('bob', `/api/tasks/${task.id}/dependencies`, 'POST', dependency, 'saved-task-history'); assert.equal(replay.status, 200); assert.equal(replay.body.history.transactions.some(event => event.column?.bulkSource), false);
    assert.ok(!JSON.stringify(replay.body).includes(`"${source.id}"`)); assert.ok(!JSON.stringify(replay.body).includes(`"${milestone.id}"`));
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body, bytes);
  } finally { await app.close(); }
});

test('successful bulk retry is a historical receipt after placement and enabled-state changes but rechecks every task and board', async () => {
  const app = await start();
  try {
    const { source, destination, query } = await app.pair('retry'); const first = await app.task('First reviewed task', { projectIds: [source.id] }); await app.task('Second reviewed task', { projectIds: [source.id] });
    const submitted = input(await app.preview(source.id, query)); const saved = await app.request<WorkboardBulkMoveReceipt>('bob', `${base(source.id)}/bulk-moves`, 'POST', submitted, 'saved-bulk'); assert.equal(saved.status, 200);
    const key = `${app.auth.workspaceId}:${app.bob.id}:saved-bulk`; const bytes = (app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body;
    const later = await app.column(destination.id, 'Later placement');
    assert.equal((await app.request('alice', `${base(destination.id)}/moves`, 'POST', { taskId: first.id, columnId: later, expectedTaskVersion: app.store.taskDetail(first.id).task.version, expectedBoardVersion: (await app.board(destination.id)).board.version, position: { edge: 'start' } })).status, 200);
    assert.equal((await app.request('alice', base(destination.id), 'PUT', { enabled: false, expectedBoardVersion: (await app.board(destination.id)).board.version })).status, 200);
    const before = app.capture(); assert.deepEqual(await app.request<WorkboardBulkMoveReceipt>('bob', `${base(source.id)}/bulk-moves`, 'POST', submitted, 'saved-bulk'), saved); assert.deepEqual(app.capture(), before);
    assert.equal((await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', submitted, 'fresh-stale-bulk')).status, 409);
    await app.policy(first.id, { edit: selected(app.alice.id) }); assert.equal((await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', submitted, 'saved-bulk')).status, 403);
    await app.policy(first.id, { view: selected(app.alice.id) }); const hiddenTask = await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', submitted, 'saved-bulk'); assert.equal(hiddenTask.body.code, 'TASK_REFERENCE_UNAVAILABLE');
    const missingTask = await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', { ...submitted, tasks: [{ taskId: 'T999999', expectedTaskVersion: 1 }] }); assert.deepEqual(hiddenTask, missingTask);
    await app.policy(destination.id, { view: selected(app.alice.id), edit: selected(app.alice.id) }); assert.equal((await app.request('bob', `${base(source.id)}/bulk-moves`, 'POST', submitted, 'saved-bulk')).body.code, 'PROJECT_REFERENCE_UNAVAILABLE');
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body, bytes);
  } finally { await app.close(); }
});

test('writer-lock revocation of either board or any selected task prevents fresh and saved bulk responses', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-bulk-policy-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const reference of ['source', 'destination', 'task'] as const) for (const phase of ['write', 'replay'] as const) {
      const { source, destination, query } = await app.pair(`${reference} ${phase}`); const task = await app.task(`Task ${reference} ${phase}`, { projectIds: [source.id] });
      const path = `${base(source.id)}/bulk-moves`; const body = input(await app.preview(source.id, query)); const key = `lock-${reference}-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') { assert.equal((await app.request('bob', path, 'POST', body, key)).status, 200); replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key); }
      const before = app.capture(); const id = reference === 'source' ? source.id : reference === 'destination' ? destination.id : task.id;
      const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, [reference === 'task' ? 'edit' : 'view']: selected(app.alice.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads'; import { DatabaseSync } from 'node:sqlite';
        const database=new DatabaseSync(workerData.databasePath); database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy),workerData.policy.objectId);
        database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if(workerData.replay){const r=workerData.replay;database.prepare('INSERT INTO idempotency (key,fingerprint,status,body,created_at) VALUES (?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at);}
        parentPort.once('message',()=>{database.exec('COMMIT');database.close();parentPort.close();});parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request('bob', path, 'POST', body, key); assert.equal(entered, 1);
        assert.equal(denied.status, reference === 'task' ? 403 : 404); assert.equal(denied.body.code, reference === 'source' ? 'OBJECT_UNAVAILABLE' : reference === 'destination' ? 'PROJECT_REFERENCE_UNAVAILABLE' : 'ACTION_FORBIDDEN'); assert.deepEqual(app.capture(), before);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
