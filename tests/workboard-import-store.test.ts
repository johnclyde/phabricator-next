import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../server/store.ts';
import type { ActorAttribution, ProjectKind } from '../shared/types.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'session-a', requestId: 'request-a' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: 'token-b', requestId: 'request-b' };
const status = (code: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === code;
const rows = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (store: Store) => new Map((store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, rows(store, name)]));
const version = (store: Store, id: string) => store.workboard(id).board.version;
const enable = (store: Store, id: string) => store.configureWorkboard(id, { enabled: true, expectedBoardVersion: version(store, id) }, alice);
const column = (store: Store, id: string, name: string, pointLimit: number | null = null) => store.createWorkboardColumn(id, { name, pointLimit, expectedBoardVersion: version(store, id) }, alice).columnId!;
const edit = (store: Store, id: string, columnId: string, input: Record<string, unknown>) => store.updateWorkboardColumn(id, columnId, { expectedBoardVersion: version(store, id), ...input }, alice);
const child = (store: Store, id: string, kind: ProjectKind, name: string) => { const preview = store.projectChildPreview(id, kind); return store.createProject({ parentId: id, kind, name, expectedParentVersion: preview.expectedParentVersion, expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion, ...(preview.conversionRequired ? { confirmMembershipConversion: true } : {}) }, alice); };
const input = (store: Store, targetId: string, sourceId: string) => { const preview = store.workboardImportPreview(targetId, sourceId); return { sourceProjectId: sourceId, expectedBoardVersion: preview.expectedBoardVersion, expectedSourceBoardVersion: preview.expectedSourceBoardVersion }; };
const rawColumns = (store: Store, projectId: string) => store.database.prepare('SELECT * FROM workboard_columns WHERE project_id=? ORDER BY sequence,id').all(projectId);

test('import copies active normal definitions from disabled archived sources with new identities, current target proxies, and no copied cards', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = store.createProject({ name: 'Source board' }); const target = store.createProject({ name: 'Target board' });
    child(store, source.id, 'milestone', 'Source milestone'); enable(store, source.id);
    const backlog = store.workboard(source.id).columns.find(row => row.isDefault)!;
    const zero = column(store, source.id, 'Zero', 0); const omitted = column(store, source.id, 'Hidden'); const limited = column(store, source.id, 'Limited', 4);
    edit(store, source.id, omitted, { hidden: true });
    store.reorderWorkboardColumn(source.id, limited, { expectedBoardVersion: version(store, source.id), position: { beforeColumnId: backlog.id } }, alice);
    const sourceTask = store.createTask({ title: 'Source card stays', projectIds: [source.id] }, alice);
    store.moveWorkboardCard(source.id, { taskId: sourceTask.id, columnId: zero, expectedBoardVersion: version(store, source.id), expectedTaskVersion: 1, position: { edge: 'start' } }, alice);
    const targetTask = store.createTask({ title: 'Target card already exists', projectIds: [target.id] }, bob);
    store.configureWorkboard(source.id, { enabled: false, expectedBoardVersion: version(store, source.id) }, alice);
    store.updateProject(source.id, { expectedVersion: source.version, status: 'archived' }, alice);
    const previewBefore = snapshot(store); const preview = store.workboardImportPreview(target.id, source.id); assert.deepEqual(snapshot(store), previewBefore);
    assert.deepEqual(preview.columns.map(row => [row.id, row.name, row.isDefault, row.pointLimit]), [[limited, 'Limited', false, 4], [backlog.id, 'Backlog', true, null], [zero, 'Zero', false, 0]]);
    const targetMilestone = child(store, target.id, 'milestone', 'Current milestone'); const ordinary = child(store, target.id, 'project', 'Current child');
    const prior = snapshot(store); const sourceRows = rawColumns(store, source.id); const sourceBoard = store.workboard(source.id).board;
    const receipt = store.importWorkboardColumns(target.id, { sourceProjectId: source.id, expectedBoardVersion: preview.expectedBoardVersion, expectedSourceBoardVersion: preview.expectedSourceBoardVersion }, bob);
    assert.deepEqual(receipt, { projectId: target.id, saved: true, refreshRequired: true, boardVersion: 1 });
    const destination = store.workboard(target.id); assert.equal(destination.board.enabled, true);
    assert.deepEqual(destination.columns.filter(row => row.kind === 'normal').map(row => [row.name, row.isDefault, row.pointLimit]), [['Limited', false, 4], ['Backlog', true, null], ['Zero', false, 0]]);
    const copied = rawColumns(store, target.id); assert.equal(copied.find(row => row.is_default)?.name, '', 'raw empty default names stay empty');
    assert.ok(copied.every(row => !sourceRows.some(original => original.id === row.id)));
    assert.deepEqual(copied.filter(row => row.kind === 'proxy').map(row => row.proxy_project_id).sort(), [targetMilestone.id, ordinary.id].sort());
    assert.deepEqual(destination.columns.flatMap(row => row.cards.cards.map(card => card.id)), [targetTask.id]);
    assert.deepEqual(rawColumns(store, source.id), sourceRows); assert.deepEqual(store.workboard(source.id).board, sourceBoard);
    for (const table of ['entities', 'task_projects', 'task_transactions', 'workboard_positions', 'project_profiles', 'project_hierarchy', 'object_policies', 'policy_meta', 'activity']) assert.deepEqual(rows(store, table), prior.get(table), table);
    assert.deepEqual(rows(store, 'workboard_transactions').filter(row => row.project_id === source.id), prior.get('workboard_transactions')!.filter(row => (row as { project_id: string }).project_id === source.id));
  } finally { store.close(); }
});

test('renamed defaults and initial zero/null limits remain exact immutable creation and import evidence', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = store.createProject({ name: 'Evidence source' }); const target = store.createProject({ name: 'Evidence target' }); enable(store, source.id);
    const backlog = store.workboard(source.id).columns[0]!; const unlimited = column(store, source.id, 'Unlimited'); const zero = column(store, source.id, 'Zero', 0);
    const initial = store.workboardHistory(source.id).transactions.filter(row => row.kind === 'column_create');
    assert.deepEqual(initial.map(row => row.columnConfiguration), [{ isDefault: false, pointLimit: 0 }, { isDefault: false, pointLimit: null }, { isDefault: true, pointLimit: null }]);
    edit(store, source.id, backlog.id, { name: 'Inbox', pointLimit: 7 });
    const old = rows(store, 'workboard_transactions'); store.importWorkboardColumns(target.id, input(store, target.id, source.id), bob);
    const history = store.workboardHistory(target.id).transactions; assert.equal(history.length, 5);
    assert.equal(new Set(history.map(row => row.operationId)).size, 1); assert.ok(history.every(row => row.boardVersion === 1 && row.actor === 'Bob' && JSON.stringify(row.attribution) === JSON.stringify(bob)));
    assert.ok(history.every(row => JSON.stringify(row.relatedProjectIds) === JSON.stringify([target.id, source.id])));
    const imported = history.filter(row => row.kind === 'column_create');
    assert.deepEqual(imported.map(row => [row.column?.name, row.columnConfiguration, row.importedFrom?.columnId]), [['Zero', { isDefault: false, pointLimit: 0 }, zero], ['Unlimited', { isDefault: false, pointLimit: null }, unlimited], ['Inbox', { isDefault: true, pointLimit: 7 }, backlog.id]]);
    assert.ok(history.every(row => row.importedFrom?.columnCount === 3 && row.importedFrom.projectId === source.id && row.importedFrom.boardVersion === version(store, source.id)));
    assert.equal(history.find(row => row.kind === 'column_import')?.importedFrom?.columnId, undefined);
    assert.deepEqual(rows(store, 'workboard_transactions').slice(0, old.length), old);
    assert.deepEqual(store.workboardHistory(target.id, undefined, 1, id => id !== source.id), { transactions: [], nextBefore: null, firstAvailableSequence: null });
    assert.equal(store.workboard(target.id).columns.find(row => row.isDefault)!.name, 'Inbox', 'copied definitions remain destination-owned');
    const milestone = child(store, target.id, 'milestone', 'Later proxy'); const event = store.workboardHistory(target.id).transactions[0]!;
    assert.equal(event.column?.proxyProjectId, milestone.id); assert.deepEqual(event.columnConfiguration, { isDefault: false, pointLimit: null });
  } finally { store.close(); }
});

test('import only accepts never-initialized targets and pins the complete source board without enabling it', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = store.createProject({ name: 'CAS source' }); const target = store.createProject({ name: 'CAS target' }); const empty = store.createProject({ name: 'Empty source' }); enable(store, source.id);
    const before = snapshot(store); assert.throws(() => store.workboardImportPreview(target.id, empty.id), status(409)); assert.throws(() => store.workboardImportPreview(target.id, target.id), status(400)); assert.deepEqual(snapshot(store), before);
    const stale = input(store, target.id, source.id); column(store, source.id, 'Added after preview'); const changed = snapshot(store);
    assert.throws(() => store.importWorkboardColumns(target.id, stale, bob), status(409)); assert.deepEqual(snapshot(store), changed);
    const valid = input(store, target.id, source.id);
    for (const patch of [{ expectedBoardVersion: 1 }, { expectedSourceBoardVersion: 999 }]) assert.throws(() => store.importWorkboardColumns(target.id, { ...valid, ...patch }, bob), status(409));
    for (const patch of [{ expectedBoardVersion: -1 }, { expectedSourceBoardVersion: 0 }, { expectedSourceBoardVersion: Number.MAX_SAFE_INTEGER + 1 }, { sourceProjectId: 'invalid' }, { extra: true }]) assert.throws(() => store.importWorkboardColumns(target.id, { ...valid, ...patch }, bob), status(400));
    assert.deepEqual(snapshot(store), changed); enable(store, target.id); const initialized = snapshot(store);
    assert.throws(() => store.importWorkboardColumns(target.id, { ...valid, expectedBoardVersion: version(store, target.id) }, bob), status(409)); assert.throws(() => store.workboardImportPreview(target.id, source.id), status(409)); assert.deepEqual(snapshot(store), initialized);
    store.configureWorkboard(target.id, { enabled: false, expectedBoardVersion: version(store, target.id) }, bob); const disabled = snapshot(store);
    assert.throws(() => store.importWorkboardColumns(target.id, { ...valid, expectedBoardVersion: version(store, target.id) }, bob), status(409)); assert.deepEqual(snapshot(store), disabled);
  } finally { store.close(); }
});

test('historical creation events without configuration stay byte-exact instead of borrowing current limits', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = store.createProject({ name: 'Historical source' }); const target = store.createProject({ name: 'Historical target' }); enable(store, source.id);
    const backlog = store.workboard(source.id).columns[0]!;
    // An exact old-format row is inserted as a fixture, not reconstructed from
    // the new creation writer. Its omitted fields represent unknown evidence.
    const old = { id: 'historical-create', projectId: source.id, sequence: 3, boardVersion: 1, kind: 'column_create', actor: 'Prior operator', createdAt: '2025-01-01T00:00:00Z', operationId: 'historical-op', column: { id: backlog.id, name: 'Backlog', proxyProjectId: null }, relatedProjectIds: [source.id], relatedTaskIds: [] };
    const json = JSON.stringify(old, null, 2);
    store.database.prepare('INSERT INTO workboard_transactions(id,project_id,sequence,board_version,data) VALUES(?,?,?,?,?)').run(old.id, source.id, 3, 1, json);
    edit(store, source.id, backlog.id, { pointLimit: 8 }); store.importWorkboardColumns(target.id, input(store, target.id, source.id), bob);
    assert.equal((store.database.prepare('SELECT data FROM workboard_transactions WHERE id=?').get(old.id) as { data: string }).data, json);
    assert.equal(store.workboardHistory(source.id).transactions.find(row => row.id === old.id)!.columnConfiguration, undefined);
    assert.equal(store.workboardHistory(target.id).transactions.find(row => row.kind === 'column_create')!.columnConfiguration?.pointLimit, 8);
  } finally { store.close(); }
});

test('missing, hidden or duplicate default definitions fail closed without fabricating a new default', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = store.createProject({ name: 'Invalid definitions' }); const target = store.createProject({ name: 'Never touched' }); enable(store, source.id); const extra = column(store, source.id, 'Other'); const valid = input(store, target.id, source.id); const backlog = store.workboard(source.id).columns.find(row => row.isDefault)!;
    for (const command of ["UPDATE workboard_columns SET hidden=1 WHERE is_default=1", "UPDATE workboard_columns SET hidden=0,is_default=0 WHERE is_default=1"]) {
      store.database.exec(command); const before = snapshot(store); assert.throws(() => store.importWorkboardColumns(target.id, valid), status(409)); assert.deepEqual(snapshot(store), before);
    }
    store.database.prepare('UPDATE workboard_columns SET is_default=1 WHERE id=?').run(backlog.id); store.database.exec('DROP INDEX workboard_default_column'); store.database.prepare('UPDATE workboard_columns SET is_default=1 WHERE id=?').run(extra);
    const malformed = snapshot(store); assert.throws(() => store.importWorkboardColumns(target.id, valid), status(409)); assert.deepEqual(snapshot(store), malformed);
  } finally { store.close(); }
});

test('a failure after copying columns rolls back every new identity, proxy, history entry and saved response', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = store.createProject({ name: 'Atomic template' }); const target = store.createProject({ name: 'Atomic target' }); enable(store, source.id); column(store, source.id, 'Second'); child(store, target.id, 'milestone', 'Target proxy'); const selected = input(store, target.id, source.id); const before = snapshot(store);
    store.database.exec("CREATE TRIGGER fail_import BEFORE INSERT ON workboard_transactions WHEN json_extract(NEW.data,'$.kind')='column_import' BEGIN SELECT RAISE(ABORT,'forced import failure'); END");
    assert.throws(() => store.mutate('import-key', 'input', () => ({ status: 200, body: store.importWorkboardColumns(target.id, selected, bob) })), /forced import failure/); assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_import');
    const receipt = store.importWorkboardColumns(target.id, selected, bob); assert.equal(receipt.boardVersion, 1); assert.equal(rawColumns(store, target.id).length, 3);
  } finally { store.close(); }
});

test('exact import retries preserve historical receipt and evidence across later source/target changes and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-import-restart-')); const path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    const source = store.createProject({ name: 'Saved source' }); const target = store.createProject({ name: 'Saved target' }); enable(store, source.id); const selected = input(store, target.id, source.id);
    const response = store.mutate('saved-import', 'fingerprint', () => ({ status: 200, body: store.importWorkboardColumns(target.id, selected, bob) })); const replayBytes = rows(store, 'idempotency'); const firstEvents = rows(store, 'workboard_transactions').filter(row => row.project_id === target.id);
    column(store, source.id, 'Source later'); column(store, target.id, 'Target later'); store.configureWorkboard(target.id, { enabled: false, expectedBoardVersion: version(store, target.id) }); const before = snapshot(store);
    assert.deepEqual(store.mutate('saved-import', 'fingerprint', () => { throw new Error('must not rerun'); }), response); assert.deepEqual(snapshot(store), before); assert.deepEqual(rows(store, 'idempotency'), replayBytes);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store), before); assert.deepEqual(store.mutate('saved-import', 'fingerprint', () => { throw new Error('must not rerun'); }), response);
    assert.deepEqual(rows(store, 'workboard_transactions').filter(row => row.project_id === target.id).slice(0, firstEvents.length), firstEvents);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const competing of ['source-edit', 'target-enable'] as const) test(`import rechecks ${competing} after acquiring the SQLite writer lock`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-import-lock-')); const path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let worker: Worker | undefined;
  try {
    const source = store.createProject({ name: 'Locked source' }); const target = store.createProject({ name: 'Locked target' }); enable(store, source.id); const selected = input(store, target.id, source.id);
    worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');require('tsx/cjs');const {Store}=require(workerData.module);const s=new Store({path:workerData.path});parentPort.postMessage('ready');parentPort.once('message',()=>{parentPort.postMessage('attempting');try{s.importWorkboardColumns(workerData.target,workerData.input);parentPort.postMessage({ok:true});}catch(e){parentPort.postMessage({status:e.status});}finally{s.close();}});`, { eval: true, workerData: { module: new URL('../server/store.ts', import.meta.url).pathname, path, target: target.id, input: selected } });
    await once(worker, 'message'); store.database.exec('BEGIN IMMEDIATE'); worker.postMessage('go'); await once(worker, 'message'); const completed = once(worker, 'message');
    if (competing === 'source-edit') column(store, source.id, 'Concurrent source column'); else enable(store, target.id);
    const committed = snapshot(store); store.database.exec('COMMIT'); const [result] = await completed; assert.equal(result.status, 409); assert.deepEqual(snapshot(store), committed);
    assert.equal(rows(store, 'workboard_transactions').filter(row => row.project_id === target.id && JSON.parse(row.data as string).kind === 'column_import').length, 0);
  } finally { if (worker) await worker.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
