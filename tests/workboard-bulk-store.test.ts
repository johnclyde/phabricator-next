import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../server/store.ts';
import type { WorkboardVisibility } from '../server/workboards.ts';
import type { ActorAttribution, BulkMoveWorkboardCardsInput, ProjectKind, WorkboardBulkMovePreview } from '../shared/types.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'token-a', requestId: 'bulk-request' };
const status = (code: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === code;
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (store: Store) => new Map((store.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, raw(store, name)]));
const version = (store: Store, id: string) => store.workboard(id).board.version;
const enable = (store: Store, id: string) => store.configureWorkboard(id, { enabled: true, expectedBoardVersion: version(store, id) }, actor);
const column = (store: Store, id: string, name = 'Working') => store.createWorkboardColumn(id, { name, expectedBoardVersion: version(store, id) }, actor).columnId!;
const backlog = (store: Store, id: string) => store.workboard(id).columns.find(column => column.isDefault)!.id;
const move = (store: Store, id: string, taskId: string, columnId: string, edge: 'start' | 'end' = 'end') => store.moveWorkboardCard(id, { taskId, columnId, position: { edge }, expectedBoardVersion: version(store, id), expectedTaskVersion: store.taskDetail(taskId).task.version }, actor);
const child = (store: Store, parentId: string, kind: ProjectKind, name: string) => {
  const preview = store.projectChildPreview(parentId, kind);
  return store.createProject({ name, parentId, kind, expectedParentVersion: preview.expectedParentVersion, expectedHierarchyVersion: preview.expectedHierarchyVersion, expectedParentMembersVersion: preview.expectedParentMembersVersion, ...(preview.conversionRequired ? { confirmMembershipConversion: true } : {}) }, actor);
};
const visibility = (hidden: string[] = [], uneditable: string[] = []): WorkboardVisibility => ({ canViewProject: id => !hidden.includes(id), canViewTask: id => !hidden.includes(id), canEditTask: id => !uneditable.includes(id), canEditProject: () => false });
const ids = (store: Store, projectId: string, columnId: string) => store.workboard(projectId, { status: 'all', showHidden: true, limit: 100 }).columns.find(column => column.id === columnId)!.cards.cards.map(card => card.id);
const input = (preview: WorkboardBulkMovePreview): BulkMoveWorkboardCardsInput => ({ sourceColumnId: preview.sourceColumn.id, destinationProjectId: preview.destinationProject.id, destinationColumnId: preview.destinationColumn.id, expectedBoardVersion: preview.expectedBoardVersion, expectedDestinationBoardVersion: preview.expectedDestinationBoardVersion, tasks: preview.tasks.map(task => ({ taskId: task.id, expectedTaskVersion: task.version })) });
const preview = (store: Store, sourceId: string, sourceColumnId: string, destinationProjectId: string, destinationColumnId: string, visible?: WorkboardVisibility) => store.workboardBulkMovePreview(sourceId, { sourceColumnId, destinationProjectId, destinationColumnId, status: 'all' }, visible);
const setup = (store: Store) => {
  const source = store.createProject({ name: 'Source board' }); const destination = store.createProject({ name: 'Destination board' });
  enable(store, source.id); enable(store, destination.id);
  return { source, destination, sourceColumn: backlog(store, source.id), destinationColumn: column(store, destination.id) };
};

test('bulk preview reads the complete eligible filtered source in natural order without writes or hidden counts', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const tasks = Array.from({ length: 5 }, (_, index) => store.createTask({ title: `Task ${index}`, projectIds: [source.id], ownerId: index === 0 ? 'alice' : null, status: index === 4 ? 'resolved' : 'open' }));
    const before = snapshot(store);
    const shown = preview(store, source.id, sourceColumn, destination.id, destinationColumn, visibility([tasks[1]!.id], [tasks[2]!.id]));
    assert.deepEqual(shown.tasks.map(task => task.id), [tasks[4]!.id, tasks[3]!.id, tasks[0]!.id]);
    assert.ok(shown.tasks.every(task => !task.alreadyInDestination));
    assert.deepEqual(shown.filter, { status: 'all', showHidden: false });
    const own = store.workboardBulkMovePreview(source.id, { sourceColumnId: sourceColumn, destinationProjectId: destination.id, destinationColumnId: destinationColumn, ownerId: 'alice' });
    assert.deepEqual(own.tasks.map(task => task.id), [tasks[0]!.id]);
    const open = store.workboardBulkMovePreview(source.id, { sourceColumnId: sourceColumn, destinationProjectId: destination.id, destinationColumnId: destinationColumn, ownerId: null }, visibility([tasks[1]!.id], [tasks[2]!.id]));
    assert.deepEqual(open.tasks.map(task => task.id), [tasks[3]!.id]);
    assert.deepEqual(snapshot(store), before);
    const empty = preview(store, source.id, sourceColumn, destination.id, destinationColumn, visibility(tasks.map(task => task.id)));
    assert.deepEqual(empty.tasks, []);
  } finally { store.close(); }
});

test('same-board bulk moves prepend each reviewed card, preserve unselected neighbors, and advance each task and board once', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Same board' }); enable(store, project.id);
    const sourceColumn = column(store, project.id, 'Source'); const destinationColumn = column(store, project.id, 'Destination');
    store.updateWorkboardColumn(project.id, destinationColumn, { expectedBoardVersion: version(store, project.id), pointLimit: 0 });
    const tasks = Array.from({ length: 3 }, (_, index) => store.createTask({ title: `Selected ${index}`, projectIds: [project.id] }));
    const existing = Array.from({ length: 2 }, (_, index) => store.createTask({ title: `Existing ${index}`, projectIds: [project.id] }));
    for (const task of tasks) move(store, project.id, task.id, sourceColumn);
    for (const task of existing) move(store, project.id, task.id, destinationColumn);
    const selected = preview(store, project.id, sourceColumn, project.id, destinationColumn, visibility([tasks[1]!.id, existing[0]!.id]));
    const oldHistory = raw(store, 'task_transactions'); const oldVersions = tasks.map(task => store.taskDetail(task.id).task.version);
    const receipt = store.bulkMoveWorkboardCards(project.id, input(selected), actor);
    assert.equal(receipt.boardVersion, selected.expectedBoardVersion + 1); assert.equal(receipt.destinationBoardVersion, receipt.boardVersion);
    assert.deepEqual(ids(store, project.id, destinationColumn), [tasks[2]!.id, tasks[0]!.id, ...existing.map(task => task.id)]);
    assert.deepEqual(ids(store, project.id, sourceColumn), [tasks[1]!.id]);
    assert.equal(store.taskDetail(tasks[1]!.id).task.version, oldVersions[1]);
    const events = store.workboardHistory(project.id).transactions.filter(row => row.kind === 'bulk_move');
    assert.equal(events.length, 2); assert.equal(new Set(events.map(row => row.operationId)).size, 1);
    for (const index of [0, 2]) {
      const detail = store.taskDetail(tasks[index]!.id); assert.equal(detail.task.version, oldVersions[index]! + 1); assert.equal(detail.task.status, 'open');
      const tx = detail.history.transactions[0]!; assert.equal(tx.kind, 'column'); assert.equal(tx.column?.bulkSource?.column.id, sourceColumn); assert.equal(tx.column?.projectId, project.id); assert.deepEqual(tx.attribution, actor);
      assert.equal(tx.column?.operationId, events[0]!.operationId);
    }
    assert.deepEqual(raw(store, 'task_transactions').slice(0, oldHistory.length), oldHistory);
    assert.equal(store.workboard(project.id).columns.find(column => column.id === destinationColumn)!.overLimit, true, 'limits are advisory');
  } finally { store.close(); }
});

test('cross-board moves remove only the source tag and record tag-only changes without reordering or invented column history', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const unrelated = store.createProject({ name: 'Unrelated tag' });
    const already = store.createTask({ title: 'Already there', projectIds: [source.id, destination.id, unrelated.id] });
    const first = store.createTask({ title: 'First destination neighbor', projectIds: [destination.id] });
    const last = store.createTask({ title: 'Last destination neighbor', projectIds: [destination.id] });
    for (const task of [first, already, last]) move(store, destination.id, task.id, destinationColumn);
    const before = store.taskDetail(already.id); const positions = raw(store, 'workboard_positions');
    const shown = preview(store, source.id, sourceColumn, destination.id, destinationColumn); assert.equal(shown.tasks[0]!.alreadyInDestination, true);
    const receipt = store.bulkMoveWorkboardCards(source.id, input(shown), actor);
    const after = store.taskDetail(already.id); assert.equal(after.task.version, before.task.version + 1); assert.deepEqual(after.task.projectIds, [destination.id, unrelated.id].sort());
    assert.deepEqual(raw(store, 'workboard_positions'), positions);
    assert.deepEqual(ids(store, destination.id, destinationColumn), [first.id, already.id, last.id]);
    const added = after.history.transactions.filter(row => row.taskVersion === after.task.version);
    assert.equal(added.length, 1); assert.equal(added[0]!.kind, 'project'); assert.equal(added[0]!.project?.action, 'removed');
    for (const project of [source, destination]) {
      const event = store.workboardHistory(project.id).transactions[0]!; assert.equal(event.kind, 'bulk_move'); assert.equal(event.bulkMove?.placementChanged, false); assert.equal(event.move, undefined);
      assert.deepEqual(event.relatedProjectIds, [source.id, destination.id]); assert.equal(event.operationId, added[0]!.project?.operationId); assert.deepEqual(event.attribution, actor);
    }
    assert.equal(receipt.boardVersion, shown.expectedBoardVersion + 1); assert.equal(receipt.destinationBoardVersion, shown.expectedDestinationBoardVersion + 1);
    assert.ok(!store.workboardHistory(destination.id, undefined, 100, id => id !== source.id).transactions.some(row => row.kind === 'bulk_move'));
  } finally { store.close(); }
});

test('milestone sources retain membership on unrelated boards, same-board moves normalize to the parent, and complete no-ops leave bytes unchanged', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, destinationColumn } = setup(store);
    const milestone = child(store, source.id, 'milestone', 'Release');
    const proxy = store.workboard(source.id).columns.find(column => column.proxyProjectId === milestone.id)!;
    const task = store.createTask({ title: 'Milestone card', projectIds: [milestone.id] }); move(store, source.id, task.id, proxy.id);
    const sourcePositions = raw(store, 'workboard_positions').filter(row => row.project_id === source.id);
    const shown = preview(store, source.id, proxy.id, destination.id, destinationColumn);
    store.bulkMoveWorkboardCards(source.id, input(shown), actor);
    assert.deepEqual(store.taskDetail(task.id).task.projectIds, [milestone.id, destination.id].sort());
    assert.deepEqual(raw(store, 'workboard_positions').filter(row => row.project_id === source.id), sourcePositions); assert.deepEqual(ids(store, source.id, proxy.id), [task.id]);
    const exact = snapshot(store); const repeat = preview(store, source.id, proxy.id, destination.id, destinationColumn); assert.equal(repeat.tasks[0]!.alreadyInDestination, true);
    store.bulkMoveWorkboardCards(source.id, input(repeat), actor); assert.deepEqual(snapshot(store), exact);
    assert.ok(!store.taskHistory(task.id, undefined, 100, id => id !== source.id).transactions.some(row => row.column?.bulkSource));
    assert.ok(!store.taskHistory(task.id, undefined, 100, id => id !== milestone.id).transactions.some(row => row.column?.bulkSource));
    const local = preview(store, source.id, proxy.id, source.id, backlog(store, source.id));
    const old = store.taskDetail(task.id).task.version; store.bulkMoveWorkboardCards(source.id, input(local), actor);
    assert.deepEqual(store.taskDetail(task.id).task.projectIds, [source.id, destination.id].sort()); assert.equal(store.taskDetail(task.id).task.version, old + 1);
    assert.deepEqual(ids(store, source.id, proxy.id), []); assert.ok(!raw(store, 'workboard_positions').some(row => row.column_id === proxy.id && row.task_id === task.id));
  } finally { store.close(); }
});

test('mixed batches share one operation and board version while existing destination cards retain their relative position', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const first = store.createTask({ title: 'First new card', projectIds: [source.id] });
    const already = store.createTask({ title: 'Already in destination', projectIds: [source.id, destination.id] });
    const last = store.createTask({ title: 'Last new card', projectIds: [source.id] });
    const neighbor = store.createTask({ title: 'Hidden destination neighbor', projectIds: [destination.id] });
    move(store, destination.id, neighbor.id, destinationColumn); move(store, destination.id, already.id, destinationColumn);
    const shown = preview(store, source.id, sourceColumn, destination.id, destinationColumn, visibility([neighbor.id]));
    assert.deepEqual(shown.tasks.map(task => [task.id, task.alreadyInDestination]), [[last.id, false], [already.id, true], [first.id, false]]);
    const receipt = store.bulkMoveWorkboardCards(source.id, input(shown), actor);
    assert.equal(receipt.boardVersion, shown.expectedBoardVersion + 1); assert.equal(receipt.destinationBoardVersion, shown.expectedDestinationBoardVersion + 1);
    assert.deepEqual(ids(store, destination.id, destinationColumn), [first.id, last.id, neighbor.id, already.id]);
    const sourceEvents = store.workboardHistory(source.id).transactions.filter(row => row.kind === 'bulk_move');
    const destinationEvents = store.workboardHistory(destination.id).transactions.filter(row => row.kind === 'bulk_move');
    assert.equal(sourceEvents.length, 3); assert.equal(destinationEvents.length, 3); assert.equal(new Set([...sourceEvents, ...destinationEvents].map(row => row.operationId)).size, 1);
    assert.ok(sourceEvents.every(row => row.boardVersion === receipt.boardVersion)); assert.ok(destinationEvents.every(row => row.boardVersion === receipt.destinationBoardVersion));
    for (const pin of shown.tasks) assert.equal(store.taskDetail(pin.id).task.version, pin.version + 1);
    assert.equal(sourceEvents.find(row => row.taskId === already.id)!.bulkMove!.placementChanged, false);
    assert.equal(sourceEvents.find(row => row.taskId === already.id)!.move, undefined);
    assert.equal(store.taskDetail(neighbor.id).task.version, 2, 'unselected neighbor remains unchanged');
    assert.deepEqual(ids(store, source.id, sourceColumn), []);
  } finally { store.close(); }
});

test('an archived milestone on a disabled source board remains an explicit authorized source', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, destinationColumn } = setup(store);
    const milestone = child(store, source.id, 'milestone', 'Archived release');
    const proxy = store.workboard(source.id).columns.find(column => column.proxyProjectId === milestone.id)!;
    const task = store.createTask({ title: 'Archived milestone card', projectIds: [milestone.id] });
    store.updateProject(milestone.id, { expectedVersion: milestone.version, status: 'archived' });
    store.configureWorkboard(source.id, { expectedBoardVersion: version(store, source.id), enabled: false });
    const shown = preview(store, source.id, proxy.id, destination.id, destinationColumn);
    assert.equal(shown.sourceColumn.hidden, true); assert.deepEqual(shown.tasks.map(task => task.id), [task.id]);
    store.bulkMoveWorkboardCards(source.id, input(shown), actor);
    assert.deepEqual(store.taskDetail(task.id).task.projectIds, [destination.id, milestone.id].sort());
    assert.equal(store.workboard(source.id).board.enabled, false); assert.equal(store.getProject(milestone.id).status, 'archived');
  } finally { store.close(); }
});

test('explicit hidden and disabled sources are eligible while destinations and unsupported ordinary proxies are checked', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, destinationColumn } = setup(store); const sourceColumn = column(store, source.id, 'Hidden source');
    const task = store.createTask({ title: 'Hidden source card', projectIds: [source.id] }); move(store, source.id, task.id, sourceColumn);
    store.updateWorkboardColumn(source.id, sourceColumn, { expectedBoardVersion: version(store, source.id), hidden: true });
    store.configureWorkboard(source.id, { enabled: false, expectedBoardVersion: version(store, source.id) });
    const shown = preview(store, source.id, sourceColumn, destination.id, destinationColumn); assert.equal(shown.sourceColumn.hidden, true); assert.equal(shown.filter.showHidden, false); assert.equal(shown.tasks.length, 1);
    const unchanged = snapshot(store); assert.throws(() => preview(store, source.id, sourceColumn, source.id, sourceColumn), status(409)); assert.deepEqual(snapshot(store), unchanged);
    store.bulkMoveWorkboardCards(source.id, input(shown), actor); assert.deepEqual(ids(store, destination.id, destinationColumn), [task.id]); assert.equal(store.workboard(source.id).board.enabled, false);
    const ordinary = child(store, destination.id, 'project', 'Ordinary child'); const ordinaryColumn = (raw(store, 'workboard_columns').find(row => row.proxy_project_id === ordinary.id))!.id as string;
    assert.throws(() => preview(store, destination.id, ordinaryColumn, destination.id, destinationColumn), status(400));
    const milestone = child(store, destination.id, 'milestone', 'Milestone'); const milestoneColumn = store.workboard(destination.id).columns.find(column => column.proxyProjectId === milestone.id)!.id;
    assert.throws(() => preview(store, source.id, sourceColumn, destination.id, milestoneColumn), status(400));
    store.updateWorkboardColumn(destination.id, destinationColumn, { expectedBoardVersion: version(store, destination.id), hidden: true });
    assert.throws(() => preview(store, source.id, sourceColumn, destination.id, destinationColumn), status(409));
  } finally { store.close(); }
});

test('the preview cap applies after visibility/edit filtering and never silently truncates a reviewed batch', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const tasks = Array.from({ length: 102 }, (_, index) => store.createTask({ title: `Task ${index}`, projectIds: [source.id] }));
    const before = snapshot(store); assert.throws(() => preview(store, source.id, sourceColumn, destination.id, destinationColumn), { status: 409, message: 'This selection exceeds 100 movable tasks. Narrow the task filter before previewing a bulk move.' }); assert.deepEqual(snapshot(store), before);
    const shown = preview(store, source.id, sourceColumn, destination.id, destinationColumn, visibility([tasks[0]!.id], [tasks[1]!.id])); assert.equal(shown.tasks.length, 100);
    store.bulkMoveWorkboardCards(source.id, input(shown), actor); assert.deepEqual(ids(store, source.id, sourceColumn), [tasks[1]!.id, tasks[0]!.id]);
    assert.equal(store.taskDetail(tasks[0]!.id).task.version, 1); assert.equal(store.taskDetail(tasks[1]!.id).task.version, 1);
  } finally { store.close(); }
});

test('bulk validation checks every pin, source placement, unique selection, and foreign column before effects', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const a = store.createTask({ title: 'First', projectIds: [source.id] }); const b = store.createTask({ title: 'Second', projectIds: [source.id] });
    const outside = store.createTask({ title: 'Not in source', projectIds: [destination.id] });
    const body = input(preview(store, source.id, sourceColumn, destination.id, destinationColumn)); const before = snapshot(store);
    for (const patch of [{ expectedBoardVersion: body.expectedBoardVersion - 1 }, { expectedDestinationBoardVersion: body.expectedDestinationBoardVersion - 1 }, { tasks: [{ taskId: a.id, expectedTaskVersion: 1 }, { taskId: b.id, expectedTaskVersion: 2 }] }, { tasks: [{ taskId: a.id, expectedTaskVersion: 1 }, { taskId: outside.id, expectedTaskVersion: 1 }] }]) {
      assert.throws(() => store.bulkMoveWorkboardCards(source.id, { ...body, ...patch }), status(409)); assert.deepEqual(snapshot(store), before);
    }
    for (const patch of [{ tasks: [] }, { tasks: [body.tasks[0], body.tasks[0]] }, { tasks: Array.from({ length: 101 }, () => body.tasks[0]) }, { tasks: [{ taskId: a.id, expectedTaskVersion: 0 }] }, { tasks: [{ taskId: a.id, expectedTaskVersion: 1, title: 'Not allowed' }] }, { filter: {} }, { expectedBoardVersion: Number.MAX_SAFE_INTEGER + 1 }]) {
      assert.throws(() => store.bulkMoveWorkboardCards(source.id, { ...body, ...patch }), status(400)); assert.deepEqual(snapshot(store), before);
    }
    assert.throws(() => store.bulkMoveWorkboardCards(source.id, { ...body, sourceColumnId: destinationColumn }), status(404));
    assert.throws(() => store.bulkMoveWorkboardCards(source.id, { ...body, destinationProjectId: source.id, destinationColumnId: sourceColumn, expectedDestinationBoardVersion: body.expectedBoardVersion }), status(400));
    assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});

test('a late bulk audit failure rolls back all tasks, positions, history, board versions and saved receipts', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const tasks = Array.from({ length: 3 }, (_, index) => store.createTask({ title: `Atomic ${index}`, projectIds: [source.id] }));
    const body = input(preview(store, source.id, sourceColumn, destination.id, destinationColumn)); const before = snapshot(store);
    store.database.exec(`CREATE TRIGGER fail_bulk BEFORE INSERT ON workboard_transactions WHEN json_extract(NEW.data,'$.kind')='bulk_move' AND NEW.project_id='${destination.id}' AND json_extract(NEW.data,'$.taskId')='${tasks[0]!.id}' BEGIN SELECT RAISE(ABORT,'forced final bulk failure'); END`);
    assert.throws(() => store.mutate('bulk-key', 'fingerprint', () => ({ status: 200, body: store.bulkMoveWorkboardCards(source.id, body, actor) })), /forced final bulk failure/);
    assert.deepEqual(snapshot(store), before);
    store.database.exec('DROP TRIGGER fail_bulk');
    const saved = store.mutate('bulk-key', 'fingerprint', () => ({ status: 200, body: store.bulkMoveWorkboardCards(source.id, body, actor) }));
    const after = snapshot(store); assert.deepEqual(store.mutate('bulk-key', 'fingerprint', () => { throw new Error('A saved bulk request must not run again'); }), saved); assert.deepEqual(snapshot(store), after);
    assert.throws(() => store.database.exec("UPDATE workboard_transactions SET data=data WHERE json_extract(data,'$.kind')='bulk_move'"), /immutable/);
  } finally { store.close(); }
});

test('bulk receipts and source-linked evidence survive restart without replaying later layouts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-bulk-restart-')); const path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const task = store.createTask({ title: 'Persistent move', projectIds: [source.id] });
    const body = input(preview(store, source.id, sourceColumn, destination.id, destinationColumn));
    const saved = store.mutate('bulk-key', 'fingerprint', () => ({ status: 200, body: store.bulkMoveWorkboardCards(source.id, body, actor) }));
    const replayRows = raw(store, 'idempotency'); const evidence = raw(store, 'workboard_transactions');
    store.updateWorkboardColumn(destination.id, destinationColumn, { name: 'New name', expectedBoardVersion: version(store, destination.id) });
    store.configureWorkboard(destination.id, { enabled: false, expectedBoardVersion: version(store, destination.id) });
    store.close(); store = new Store({ path }); const before = snapshot(store);
    assert.deepEqual(store.mutate('bulk-key', 'fingerprint', () => { throw new Error('Do not rerun'); }), saved); assert.deepEqual(snapshot(store), before); assert.deepEqual(raw(store, 'idempotency'), replayRows);
    assert.deepEqual(raw(store, 'workboard_transactions').slice(0, evidence.length), evidence);
    assert.equal(store.taskDetail(task.id).history.transactions.find(row => row.column)?.column?.toColumn.name, 'Working');
    assert.equal(store.taskDetail(task.id).task.version, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const changed of ['source', 'destination', 'task'] as const) test(`a competing ${changed} write invalidates the pinned whole bulk batch after the SQLite writer lock`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-bulk-lock-')); const path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let worker: Worker | undefined;
  try {
    const { source, destination, sourceColumn, destinationColumn } = setup(store);
    const tasks = Array.from({ length: 2 }, (_, index) => store.createTask({ title: `Contended ${index}`, projectIds: [source.id] }));
    const body = input(preview(store, source.id, sourceColumn, destination.id, destinationColumn));
    worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');require('tsx/cjs');const {Store}=require(workerData.module);const s=new Store({path:workerData.path});parentPort.postMessage('ready');parentPort.once('message',()=>{parentPort.postMessage('attempting');try{s.bulkMoveWorkboardCards(workerData.source,workerData.body);parentPort.postMessage({ok:true});}catch(e){parentPort.postMessage({status:e.status,message:e.message});}finally{s.close();}});`, { eval: true, workerData: { module: new URL('../server/store.ts', import.meta.url).pathname, path, source: source.id, body } });
    await once(worker, 'message'); store.database.exec('BEGIN IMMEDIATE'); worker.postMessage('go'); await once(worker, 'message'); const completed = once(worker, 'message');
    if (changed === 'task') store.updateTask(tasks[0]!.id, { expectedVersion: 1, title: 'Changed while waiting' });
    else store.updateWorkboardColumn(changed === 'source' ? source.id : destination.id, changed === 'source' ? sourceColumn : destinationColumn, { name: 'Changed while waiting', expectedBoardVersion: version(store, changed === 'source' ? source.id : destination.id) });
    store.database.exec('COMMIT'); const afterCompetingWrite = snapshot(store); const [result] = await completed;
    assert.equal(result.status, 409); assert.deepEqual(snapshot(store), afterCompetingWrite); assert.equal(store.workboardHistory(source.id).transactions.some(row => row.kind === 'bulk_move'), false);
  } finally { await worker?.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
