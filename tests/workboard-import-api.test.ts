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
import type { Project, ProjectChildPreview, Task } from '../shared/types.ts';
import type { ImportWorkboardColumnsInput, WorkboardDetail, WorkboardHistory, WorkboardImportPreview, WorkboardReceipt } from '../shared/workboards.ts';

type ErrorBody = { error: string; code?: string };
type Actor = 'alice' | 'bob' | 'reader';
const selected = (...principalIds: string[]) => ({ kind: 'principals' as const, principalIds });
const base = (id: string) => `/api/projects/${id}/workboard`;

async function start(path = ':memory:') {
  const store = createStore({ path });
  const operator = createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  const alice = await operator.createAccount({ username: 'alice', displayName: 'Alice', password: 'Alice column import testing password' });
  const bob = await operator.createAccount({ username: 'bob', displayName: 'Bob', password: 'Bob column import testing password' });
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
  async function milestone(parentId: string, name: string) {
    const result = await request<ProjectChildPreview>('alice', `/api/projects/${parentId}/children/preview?kind=milestone`); assert.equal(result.status, 200); const p = result.body;
    return project(name, { parentId, kind: 'milestone', expectedParentVersion: p.expectedParentVersion, expectedHierarchyVersion: p.expectedHierarchyVersion, expectedParentMembersVersion: p.expectedParentMembersVersion, confirmMembershipConversion: p.conversionRequired });
  }
  async function policy(id: string, fields: Record<string, unknown>) {
    const current = (await request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
    const result = await request<ObjectAccess>('alice', `/api/policies/${id}`, 'PUT', { expectedVersion: current.version, spaceId: current.spaceId, ...current.rules, ...fields }); assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  async function board(id: string, actor: Actor = 'alice') { const result = await request<WorkboardDetail>(actor, base(id)); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  async function enable(id: string) { const result = await request<WorkboardReceipt>('alice', base(id), 'PUT', { enabled: true, expectedBoardVersion: (await board(id)).board.version }); assert.equal(result.status, 200, JSON.stringify(result.body)); return board(id); }
  async function column(id: string, name: string, pointLimit: number | null = null) { const result = await request<WorkboardReceipt>('alice', `${base(id)}/columns`, 'POST', { name, pointLimit, expectedBoardVersion: (await board(id)).board.version }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.columnId!; }
  async function preview(targetId: string, sourceId: string, actor: Actor = 'bob') { const result = await request<WorkboardImportPreview>(actor, `${base(targetId)}/import-preview?sourceProjectId=${sourceId}`); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
  const input = (preview: WorkboardImportPreview): ImportWorkboardColumnsInput => ({ sourceProjectId: preview.sourceProject.id, expectedBoardVersion: preview.expectedBoardVersion, expectedSourceBoardVersion: preview.expectedSourceBoardVersion });
  return { ...app, alice, bob, request, project, milestone, policy, board, enable, column, preview, input, close: async () => { await app.close(); store.close(); } };
}

function receipt(body: WorkboardReceipt) {
  assert.deepEqual(Object.keys(body).sort(), ['accessEpoch', 'boardVersion', 'projectId', 'refreshRequired', 'saved']);
  assert.equal(body.saved, true); assert.equal(body.refreshRequired, true); assert.equal(body.boardVersion, 1); assert.equal(typeof body.accessEpoch, 'number');
}

test('import requires target edit and source view, preserves disabled archived source configuration, and copies no cards', async () => {
  const app = await start();
  try {
    const source = await app.project('Source design'); const sourceMilestone = await app.milestone(source.id, 'Not copied'); await app.enable(source.id);
    const reading = await app.column(source.id, 'Reading', 0); const hidden = await app.column(source.id, 'Hidden source column', 8);
    assert.equal((await app.request('alice', `${base(source.id)}/columns/${hidden}`, 'PATCH', { hidden: true, expectedBoardVersion: (await app.board(source.id)).board.version })).status, 200);
    assert.equal((await app.request('alice', `${base(source.id)}/columns/${reading}/reorder`, 'POST', { position: { edge: 'start' }, expectedBoardVersion: (await app.board(source.id)).board.version })).status, 200);
    const task = await app.request<Task>('alice', '/api/tasks', 'POST', { title: 'Source-only task', projectIds: [source.id] }); assert.equal(task.status, 201);
    assert.equal((await app.request('alice', `${base(source.id)}/moves`, 'POST', { taskId: task.body.id, columnId: reading, expectedTaskVersion: task.body.version, expectedBoardVersion: (await app.board(source.id)).board.version, position: { edge: 'start' } })).status, 200);
    assert.equal((await app.request('alice', base(source.id), 'PUT', { enabled: false, expectedBoardVersion: (await app.board(source.id)).board.version })).status, 200);
    assert.equal((await app.request('alice', `/api/projects/${source.id}`, 'PATCH', { expectedVersion: app.store.getProject(source.id).version, status: 'archived' })).status, 200);
    await app.policy(source.id, { edit: selected(app.alice.id) });
    const target = await app.project('Destination board'); const targetMilestone = await app.milestone(target.id, 'Own milestone');
    const existing = await app.request<Task>('alice', '/api/tasks', 'POST', { title: 'Already tagged destination', projectIds: [target.id] }); assert.equal(existing.status, 201);
    const preview = await app.preview(target.id, source.id); assert.equal(preview.sourceProject.status, 'archived'); assert.equal(preview.expectedBoardVersion, 0); assert.equal(typeof preview.accessEpoch, 'number');
    assert.deepEqual(preview.columns.map(column => [column.name, column.isDefault, column.pointLimit]), [['Reading', false, 0], ['Backlog', true, null]]);
    assert.ok(!JSON.stringify(preview).includes(sourceMilestone.id)); assert.doesNotMatch(JSON.stringify(preview), /Source-only task|Hidden source column/);
    assert.equal((await app.preview(target.id, source.id, 'reader')).expectedSourceBoardVersion, preview.expectedSourceBoardVersion);
    const input = app.input(preview);
    assert.equal((await app.request('reader', `${base(target.id)}/import`, 'POST', input)).status, 403);
    await app.policy(target.id, { edit: selected(app.alice.id) });
    assert.equal((await app.request('bob', `${base(target.id)}/import-preview?sourceProjectId=${source.id}`)).status, 403);
    assert.equal((await app.request('bob', `${base(target.id)}/import`, 'POST', input)).status, 403);
    await app.policy(target.id, { edit: { kind: 'workspace' } });
    const taskBytes = app.store.database.prepare("SELECT id,data FROM entities WHERE kind='task' ORDER BY id").all();
    const positions = app.store.database.prepare('SELECT * FROM workboard_positions ORDER BY rowid').all();
    const sourceBoard = app.store.database.prepare('SELECT * FROM project_workboards WHERE project_id=?').get(source.id);
    const imported = await app.request<WorkboardReceipt>('bob', `${base(target.id)}/import`, 'POST', input, 'configuration-import'); assert.equal(imported.status, 200, JSON.stringify(imported.body)); receipt(imported.body);
    const targetBoard = await app.board(target.id, 'bob'); assert.deepEqual(targetBoard.columns.filter(column => column.kind === 'normal').map(column => [column.name, column.isDefault, column.pointLimit]), [['Reading', false, 0], ['Backlog', true, null]]);
    assert.equal((app.store.database.prepare('SELECT name FROM workboard_columns WHERE project_id=? AND is_default=1').get(target.id) as { name: string }).name, '', 'display fallback does not replace the exact stored default name');
    assert.deepEqual(targetBoard.columns.filter(column => column.kind === 'proxy').map(column => column.proxyProjectId), [targetMilestone.id]);
    assert.deepEqual(targetBoard.columns.flatMap(column => column.cards.cards.map(card => card.id)), [existing.body.id]);
    assert.deepEqual(app.store.database.prepare("SELECT id,data FROM entities WHERE kind='task' ORDER BY id").all(), taskBytes);
    assert.deepEqual(app.store.database.prepare('SELECT * FROM workboard_positions ORDER BY rowid').all(), positions);
    assert.deepEqual(app.store.database.prepare('SELECT * FROM project_workboards WHERE project_id=?').get(source.id), sourceBoard);
    const history = app.store.workboardHistory(target.id); const importedEvents = history.transactions.filter(event => event.importedFrom);
    assert.equal(importedEvents.length, 4); assert.ok(importedEvents.every(event => event.attribution?.principalId === app.bob.id && event.relatedProjectIds.includes(source.id)));
  } finally { await app.close(); }
});

test('import references and preview parameters are strict without disclosing hidden sources or invalidating the destination', async () => {
  const app = await start();
  try {
    const source = await app.project('Private import source'); await app.enable(source.id); const target = await app.project('Visible destination');
    await app.policy(source.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const unknown = await app.request('bob', `${base(target.id)}/import-preview?sourceProjectId=PROJ999999`);
    assert.equal(unknown.status, 404); assert.equal(unknown.body.code, 'PROJECT_REFERENCE_UNAVAILABLE');
    for (const value of [source.id, 'invalid', 'PROJ0', 'PROJ01', '', 'T1']) assert.deepEqual(await app.request('bob', `${base(target.id)}/import-preview?sourceProjectId=${value}`), unknown);
    for (const query of ['', '?sourceProjectId=PROJ1&sourceProjectId=PROJ2', '?sourceProjectId=PROJ1&extra=1', '?extra=1']) assert.equal((await app.request('bob', `${base(target.id)}/import-preview${query}`)).status, 400);
    const malformed = await app.request('bob', `${base(target.id)}/import`, 'POST', { sourceProjectId: 'PROJ999999', expectedBoardVersion: 0, expectedSourceBoardVersion: 1 });
    assert.deepEqual(malformed, unknown);
    for (const value of [source.id, null, 1, {}, 'PROJ0']) assert.deepEqual(await app.request('bob', `${base(target.id)}/import`, 'POST', { sourceProjectId: value, expectedBoardVersion: 0, expectedSourceBoardVersion: 1 }), unknown);
    assert.equal((await app.board(target.id, 'bob')).board.version, 0);
    await app.policy(source.id, { view: { kind: 'workspace' } }); const input = app.input(await app.preview(target.id, source.id));
    for (const fields of [{ expectedBoardVersion: -1 }, { expectedSourceBoardVersion: 0 }, { expectedSourceBoardVersion: 1.2 }, { expectedBoardVersion: '0' }, { extra: true }]) assert.equal((await app.request('bob', `${base(target.id)}/import`, 'POST', { ...input, ...fields })).status, 400, JSON.stringify(fields));
    const empty = await app.project('No source columns'); assert.equal((await app.request('bob', `${base(target.id)}/import-preview?sourceProjectId=${empty.id}`)).status, 409);
    await app.enable(target.id); assert.equal((await app.request('bob', `${base(target.id)}/import-preview?sourceProjectId=${source.id}`)).status, 409);
    assert.equal((await app.request('bob', `${base(target.id)}/import`, 'POST', input)).status, 409);
  } finally { await app.close(); }
});

test('import CAS and saved receipts preserve history while source policy independently filters import provenance', async () => {
  const app = await start();
  try {
    const source = await app.project('Source history'); await app.enable(source.id); const target = await app.project('Copied configuration');
    const stale = app.input(await app.preview(target.id, source.id)); await app.column(source.id, 'Discussion', 2);
    assert.equal((await app.request('bob', `${base(target.id)}/import`, 'POST', stale, 'stale-import')).status, 409); assert.equal((await app.board(target.id)).board.version, 0);
    assert.equal(app.store.database.prepare('SELECT 1 FROM idempotency WHERE key LIKE ?').get('%:stale-import'), undefined);
    const input = app.input(await app.preview(target.id, source.id)); const result = await app.request<WorkboardReceipt>('bob', `${base(target.id)}/import`, 'POST', input, 'saved-import'); assert.equal(result.status, 200); receipt(result.body);
    const key = `${app.auth.workspaceId}:${app.bob.id}:saved-import`; const bytes = (app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body;
    await app.column(source.id, 'Later source column'); await app.column(target.id, 'Independent target column');
    const before = app.store.database.prepare('SELECT * FROM workboard_transactions ORDER BY rowid').all();
    assert.deepEqual(await app.request<WorkboardReceipt>('bob', `${base(target.id)}/import`, 'POST', input, 'saved-import'), result);
    assert.deepEqual(app.store.database.prepare('SELECT * FROM workboard_transactions ORDER BY rowid').all(), before);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body, bytes);
    assert.equal((await app.request('bob', `${base(target.id)}/import`, 'POST', input, 'new-request')).status, 409);
    await app.policy(source.id, { view: selected(app.alice.id), edit: selected(app.alice.id) });
    const hiddenReplay = await app.request('bob', `${base(target.id)}/import`, 'POST', input, 'saved-import'); assert.equal(hiddenReplay.status, 404); assert.equal(hiddenReplay.body.code, 'PROJECT_REFERENCE_UNAVAILABLE');
    const visible = await app.board(target.id, 'bob'); assert.ok(visible.columns.some(column => column.name === 'Discussion')); assert.ok(!JSON.stringify(visible).includes(`"${source.id}"`));
    const rawHistory = app.store.workboardHistory(target.id); const hiddenIds = rawHistory.transactions.filter(event => event.relatedProjectIds.includes(source.id)).map(event => event.id); assert.ok(hiddenIds.length);
    const history = await app.request<WorkboardHistory>('bob', `${base(target.id)}/history?limit=100`); assert.equal(history.status, 200);
    assert.equal(history.body.transactions.some(event => hiddenIds.includes(event.id)), false); assert.ok(!JSON.stringify(history.body).includes(`"${source.id}"`)); assert.doesNotMatch(JSON.stringify(history.body), /columnCount|importedFrom/);
    const seen: string[] = []; let beforeSequence: number | null = null;
    do { const page: { status: number; body: WorkboardHistory } = await app.request<WorkboardHistory>('bob', `${base(target.id)}/history?limit=1${beforeSequence === null ? '' : `&before=${beforeSequence}`}`); assert.equal(page.status, 200); seen.push(...page.body.transactions.map(row => row.id)); beforeSequence = page.body.nextBefore; } while (beforeSequence !== null);
    assert.deepEqual(seen, history.body.transactions.map(event => event.id));
    await app.policy(source.id, { view: { kind: 'workspace' } }); await app.policy(target.id, { edit: selected(app.alice.id) });
    assert.equal((await app.request('bob', `${base(target.id)}/import`, 'POST', input, 'saved-import')).status, 403);
    assert.equal((app.store.database.prepare('SELECT body FROM idempotency WHERE key=?').get(key) as { body: string }).body, bytes);
  } finally { await app.close(); }
});

test('source or destination policy revocation while waiting for the writer lock blocks fresh import and saved replay', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phabricator-import-policy-lock-')); const databasePath = join(directory, 'workspace.sqlite');
  const app = await start(databasePath); const transaction = app.store.transaction.bind(app.store);
  try {
    for (const reference of ['source', 'target'] as const) for (const phase of ['write', 'replay'] as const) {
      const source = await app.project(`Source ${reference} ${phase}`); await app.enable(source.id); const target = await app.project(`Target ${reference} ${phase}`);
      const path = `${base(target.id)}/import`; const input = app.input(await app.preview(target.id, source.id)); const key = `lock-${reference}-${phase}`;
      let replay: { key: string; fingerprint: string; status: number; body: string; created_at: string } | undefined;
      if (phase === 'replay') { assert.equal((await app.request('bob', path, 'POST', input, key)).status, 200); replay = app.store.database.prepare('SELECT * FROM idempotency WHERE key LIKE ?').get(`%:${key}`) as typeof replay; assert.ok(replay); app.store.database.prepare('DELETE FROM idempotency WHERE key=?').run(replay.key); }
      const capture = () => ['entities', 'sequences', 'activity', 'project_workboards', 'workboard_columns', 'workboard_positions', 'workboard_transactions'].map(table => app.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      const before = capture(); const id = reference === 'source' ? source.id : target.id; const policy = (await app.request<ObjectAccess>('alice', `/api/policies/${id}`)).body.policy;
      const restricted = { ...policy, version: policy.version + 1, rules: { ...policy.rules, [reference === 'source' ? 'view' : 'edit']: selected(app.alice.id) } };
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
        import { parentPort, workerData } from 'node:worker_threads';
        import { DatabaseSync } from 'node:sqlite';
        const database = new DatabaseSync(workerData.databasePath); database.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
        database.prepare('UPDATE object_policies SET data=? WHERE object_id=?').run(JSON.stringify(workerData.policy), workerData.policy.objectId);
        database.prepare("UPDATE policy_meta SET value=value+1 WHERE name='epoch'").run();
        if (workerData.replay) { const r=workerData.replay; database.prepare('INSERT INTO idempotency (key,fingerprint,status,body,created_at) VALUES (?,?,?,?,?)').run(r.key,r.fingerprint,r.status,r.body,r.created_at); }
        parentPort.once('message', () => { database.exec('COMMIT'); database.close(); parentPort.close(); }); parentPort.postMessage('locked');
      `)}`), { workerData: { databasePath, policy: restricted, replay } });
      try {
        assert.deepEqual(await once(worker, 'message'), ['locked']); let entered = 0;
        app.store.transaction = function<T>(work: () => T): T { entered++; app.store.transaction = transaction; worker.postMessage('commit'); return transaction(work); };
        const denied = await app.request('bob', path, 'POST', input, key);
        assert.equal(entered, 1); assert.equal(denied.status, reference === 'source' ? 404 : 403); assert.equal(denied.body.code, reference === 'source' ? 'PROJECT_REFERENCE_UNAVAILABLE' : 'ACTION_FORBIDDEN'); assert.deepEqual(capture(), before);
      } finally { app.store.transaction = transaction; await worker.terminate(); }
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
