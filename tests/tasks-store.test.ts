import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../server/store.ts';
import { initializePolicies } from '../server/policy.ts';
import type { ActorAttribution, Task } from '../shared/types.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice Writer', credentialId: 'alice-session', requestId: 'alice-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob Reviewer', credentialId: 'bob-token', requestId: 'bob-request' };
const create = (store: Store, title = 'Prepare the revised paper') => store.createTask({ title, description: 'Keep the record exact.' }, alice);
const status = (value: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === value;
const tables = ['entities', 'task_transactions', 'task_dependencies', 'task_subscriptions', 'policy_meta', 'activity', 'sequences', 'idempotency'];
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (store: Store) => tables.map(table => raw(store, table));
const depend = (store: Store, id: string, dependencyId: string, action: 'add' | 'remove' = 'add') => store.updateTaskDependencies(id, { taskId: dependencyId, action, expectedVersion: store.taskDetail(id).task.version }, alice);

test('task creation and edits preserve attributed snapshots and exact structured changes; comments have an independent history sequence', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Paper project' }, alice);
    const task = store.createTask({ title: 'Prepare the revised paper', description: 'Keep the record exact.', projectIds: [project.id] }, alice); assert.equal(task.version, 1);
    const created = store.taskHistory(task.id).transactions.find(item => item.kind === 'create')!;
    assert.equal(created.kind, 'create'); assert.equal(created.sequence, 1); assert.equal(created.taskVersion, 1);
    assert.equal(created.actor, alice.displayName); assert.deepEqual(created.attribution, alice); assert.deepEqual(created.snapshot, task);
    const updated = store.updateTask(task.id, { expectedVersion: 1, title: 'Prepare the final draft', description: '  Preserve whitespace.\n', status: 'in_progress', priority: 'urgent' }, bob);
    assert.equal(updated.version, 2); assert.equal(updated.createdAt, task.createdAt);
    const edited = store.taskHistory(task.id).transactions[0]!;
    assert.equal(edited.kind, 'edit'); assert.equal(edited.sequence, 3); assert.equal(edited.taskVersion, 2);
    assert.deepEqual(edited.attribution, bob); assert.equal(edited.actor, bob.displayName);
    assert.deepEqual(edited.changes, [
      { field: 'title', oldValue: task.title, newValue: updated.title },
      { field: 'description', oldValue: task.description, newValue: updated.description },
      { field: 'status', oldValue: 'open', newValue: 'in_progress' },
      { field: 'priority', oldValue: 'normal', newValue: 'urgent' },
    ]);
    const first = store.createTaskComment(task.id, { body: '  First independent comment.\n' }, alice);
    const second = store.createTaskComment(task.id, { body: 'A concurrent response.' }, bob);
    assert.equal(first.sequence, 4); assert.equal(second.sequence, 6); assert.equal(first.taskVersion, 2); assert.equal(second.taskVersion, 2);
    assert.equal(first.comment, '  First independent comment.\n'); assert.deepEqual(second.attribution, bob);
    assert.deepEqual(store.taskDetail(task.id).task, updated, 'comments do not change task fields, version or timestamps');
    assert.deepEqual(store.taskHistory(task.id).transactions.map(item => item.sequence), [6, 5, 4, 3, 2, 1]);
    assert.deepEqual(store.taskHistory(task.id).transactions.at(-1), created);
    assert.throws(() => store.database.exec('UPDATE task_transactions SET data = data'), /immutable/);
    assert.throws(() => store.database.exec('DELETE FROM task_transactions'), /immutable/);
  } finally { store.close(); }
});

test('task edits enforce CAS and strict input without needless versions or history for identical values', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const task = create(store); const before = snapshot(store);
    assert.deepEqual(store.updateTask(task.id, { expectedVersion: 1, title: task.title, status: task.status }, bob), task);
    assert.deepEqual(snapshot(store), before);
    for (const input of [{}, { expectedVersion: 1 }, { title: 'No CAS' }, { expectedVersion: 0, title: 'Bad CAS' },
      { expectedVersion: 1, title: '' }, { expectedVersion: 1, status: 'unknown' }, { expectedVersion: 1, projectId: 'PROJ999' }, { expectedVersion: 1, projectIds: [] },
      { expectedVersion: 1, priority: 'high', version: 99 }]) assert.throws(() => store.updateTask(task.id, input, alice), status(400));
    assert.throws(() => store.updateTask(task.id, { expectedVersion: 2, title: 'Stale' }, alice), status(409));
    for (const input of [{ body: '' }, { body: '  ' }, { body: 'x'.repeat(20_001) }, { body: '\0' }, { body: 'No forged actor.', actor: 'Anyone' }, { body: 'No comment CAS.', expectedVersion: 1 }]) assert.throws(() => store.createTaskComment(task.id, input, bob), status(400));
    assert.throws(() => store.createTask({ title: 'No supplied version', expectedVersion: 1 }, alice), status(400));
    assert.deepEqual(snapshot(store), before);
    const edited = store.updateTask(task.id, { expectedVersion: 1, title: 'A real change.' }, bob);
    assert.throws(() => store.updateTask(task.id, { expectedVersion: 1, title: edited.title }, alice), status(409));
    assert.equal(store.taskHistory(task.id).transactions.length, 3);
  } finally { store.close(); }
});

test('dependency deltas update inverse references and both histories, while status changes notify direct parents without automatically closing them', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const parent = create(store, 'Submit the manuscript'); const other = create(store, 'Publish the data'); const child = create(store, 'Validate the figures');
    const added = depend(store, parent.id, child.id);
    assert.equal(added.task.version, 2); assert.deepEqual(added.dependsOn, [{ id: child.id, title: child.title, status: 'open', priority: 'normal', version: 2 }]);
    assert.deepEqual(store.taskDetail(child.id).blocks, [{ id: parent.id, title: parent.title, status: 'open', priority: 'normal', version: 2 }]);
    assert.deepEqual(added.history.transactions[0]!.dependency, { taskId: child.id, action: 'added', direction: 'depends_on' });
    assert.deepEqual(store.taskHistory(child.id).transactions[0]!.dependency, { taskId: parent.id, action: 'added', direction: 'blocks' });
    depend(store, other.id, child.id);
    const childBefore = store.taskDetail(child.id).task; const parentBefore = store.taskDetail(parent.id).task; const otherBefore = store.taskDetail(other.id).task;
    const renamed = store.updateTask(child.id, { expectedVersion: childBefore.version, title: 'Validate revised figures', priority: 'high' }, bob);
    assert.equal(store.taskDetail(parent.id).task.version, parentBefore.version, 'nonstatus field edits do not bump blocked parents');
    assert.equal(store.taskDetail(parent.id).dependsOn[0]!.title, renamed.title); assert.equal(store.taskDetail(parent.id).dependsOn[0]!.priority, 'high');
    const resolved = store.updateTask(child.id, { expectedVersion: renamed.version, status: 'resolved' }, bob);
    for (const previous of [parentBefore, otherBefore]) {
      const detail = store.taskDetail(previous.id); assert.equal(detail.task.version, previous.version + 1); assert.equal(detail.task.status, 'open');
      const change = detail.history.transactions[0]!;
      assert.equal(change.kind, 'dependency_status'); assert.deepEqual(change.dependencyStatus, { taskId: child.id, oldStatus: 'open', newStatus: 'resolved' });
      assert.deepEqual(change.attribution, bob); assert.equal(change.taskVersion, detail.task.version);
      assert.equal(detail.dependsOn[0]!.status, 'resolved'); assert.equal(detail.dependsOn[0]!.version, resolved.version);
      assert.doesNotMatch(JSON.stringify(detail.activity.filter(item => item.action.startsWith('dependency_'))), new RegExp(`\\b${child.id}\\b|${child.title}`));
      assert.throws(() => store.updateTask(previous.id, { expectedVersion: previous.version, title: 'Missed dependency status.' }, alice), status(409));
    }
    store.updateTask(child.id, { expectedVersion: resolved.version, status: 'open' }, bob);
    const closeBlocked = store.updateTask(parent.id, { expectedVersion: store.taskDetail(parent.id).task.version, status: 'resolved' }, alice);
    assert.equal(closeBlocked.status, 'resolved', 'closing a task with an unresolved dependency remains an explicit supported choice');
    const removed = depend(store, parent.id, child.id, 'remove'); assert.deepEqual(removed.dependsOn, []);
    assert.deepEqual(removed.history.transactions[0]!.dependency, { taskId: child.id, action: 'removed', direction: 'depends_on' });
    assert.deepEqual(store.taskDetail(child.id).blocks.map(item => item.id), [other.id]);
    const afterRemoval = store.taskDetail(parent.id).task;
    store.updateTask(child.id, { expectedVersion: store.taskDetail(child.id).task.version, status: 'resolved' }, bob);
    assert.deepEqual(store.taskDetail(parent.id).task, afterRemoval, 'removed links stop status propagation');
  } finally { store.close(); }
});

test('direct and transitive cycles, self links and duplicate deltas are rejected atomically across connections', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-task-graph-')); const path = join(directory, 'workspace.sqlite');
  const first = new Store({ path }); const second = new Store({ path });
  try {
    const a = create(first, 'A'); const b = create(first, 'B'); const c = create(first, 'C');
    depend(first, a.id, b.id);
    assert.throws(() => second.updateTaskDependencies(b.id, { taskId: a.id, action: 'add', expectedVersion: b.version }, bob), status(409), 'the opposite concurrent edge observes changed task versions');
    assert.throws(() => depend(second, b.id, a.id), status(409));
    depend(second, b.id, c.id);
    const before = snapshot(first);
    assert.throws(() => depend(first, c.id, a.id), status(409), 'cycle detection traverses the complete raw graph');
    assert.throws(() => depend(first, a.id, b.id), status(409));
    assert.throws(() => depend(first, a.id, c.id, 'remove'), status(409));
    assert.throws(() => depend(first, a.id, a.id), status(400));
    assert.throws(() => depend(first, a.id, 'T9999'), { status: 404, code: 'TASK_UNAVAILABLE' });
    for (const input of [{ taskId: b.id, action: 'replace', expectedVersion: first.taskDetail(a.id).task.version }, { taskId: 'PROJ1', action: 'add', expectedVersion: 1 }, { taskId: b.id, action: 'add', expectedVersion: 1, dependsOn: [b.id] }]) assert.throws(() => first.updateTaskDependencies(a.id, input, alice), status(400));
    assert.deepEqual(snapshot(first), before);
    depend(second, b.id, c.id, 'remove'); depend(first, c.id, a.id);
    assert.deepEqual(first.taskDetail(c.id).dependsOn.map(item => item.id), [a.id]);
    const initial = first.taskDetail(a.id).task;
    second.createTaskComment(a.id, { body: 'A second connection can comment without changing edit CAS.' }, bob);
    assert.equal(first.updateTask(a.id, { expectedVersion: initial.version, description: 'Edit alongside a comment.' }, alice).version, initial.version + 1);
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('task history paginates only visible transactions and never reports hidden dependency metadata', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const parent = create(store); const secret = create(store, 'Hidden prerequisite'); const shown = create(store, 'Visible prerequisite');
    depend(store, parent.id, secret.id);
    store.updateTask(secret.id, { expectedVersion: store.taskDetail(secret.id).task.version, status: 'resolved' }, bob);
    depend(store, parent.id, shown.id);
    store.createTaskComment(parent.id, { body: 'Visible discussion.' }, bob);
    depend(store, parent.id, secret.id, 'remove');
    const visible = (id: string) => id !== secret.id;
    const first = store.taskHistory(parent.id, undefined, 2, visible);
    assert.deepEqual(first.transactions.map(item => item.kind), ['comment', 'subscription']);
    assert.equal(first.nextBefore, first.transactions[1]!.sequence); assert.equal(first.firstAvailableSequence, 1);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(`\\b${secret.id}\\b|Hidden prerequisite`));
    const middle = store.taskHistory(parent.id, first.nextBefore!, 2, visible);
    assert.deepEqual(middle.transactions.map(item => item.kind), ['dependency', 'subscription']);
    const last = store.taskHistory(parent.id, middle.nextBefore!, 2, visible);
    assert.deepEqual(last.transactions.map(item => item.kind), ['create']); assert.equal(last.nextBefore, null);
    const empty = store.taskHistory(parent.id, 1, 2, visible); assert.deepEqual(empty.transactions, []); assert.equal(empty.nextBefore, null); assert.equal(empty.firstAvailableSequence, 1);
    assert.equal(store.taskHistory(parent.id).transactions.length, 8, 'filtering leaves the immutable raw audit intact');
    for (let index = 0; index < 55; index++) store.createTaskComment(parent.id, { body: `Comment ${index}` }, alice);
    assert.equal(store.taskHistory(parent.id).transactions.length, 50); assert.equal(store.taskHistory(parent.id, undefined, 100).transactions.length, 63);
    for (const before of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => store.taskHistory(parent.id, before), status(400));
    for (const limit of [0, -1, 1.5, 101]) assert.throws(() => store.taskHistory(parent.id, undefined, limit), status(400));
  } finally { store.close(); }
});

test('task, inverse edge, status propagation, history, activity and replay writes roll back together', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const parent = create(store, 'Parent'); const child = create(store, 'Child');
    let before = snapshot(store);
    store.database.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data, '$.dependency.direction') = 'blocks' BEGIN SELECT RAISE(ABORT, 'Injected inverse history failure'); END;");
    assert.throws(() => store.mutate('atomic-dependency', 'fingerprint', () => ({ status: 200, body: depend(store, parent.id, child.id) })), /Injected/);
    assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER injected_failure');
    depend(store, parent.id, child.id); before = snapshot(store);
    store.database.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'dependency_status_changed' BEGIN SELECT RAISE(ABORT, 'Injected parent activity failure'); END;");
    assert.throws(() => store.updateTask(child.id, { expectedVersion: 2, status: 'resolved' }, bob), /Injected/);
    assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER injected_failure');
    store.database.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'commented' BEGIN SELECT RAISE(ABORT, 'Injected comment activity failure'); END;");
    assert.throws(() => store.createTaskComment(parent.id, { body: 'No partial comment.' }, bob), /Injected/);
    assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER injected_failure');
    store.database.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data, '$.kind') = 'create' BEGIN SELECT RAISE(ABORT, 'Injected baseline failure'); END;");
    assert.throws(() => create(store, 'No partial creation.'), /Injected/);
    assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER injected_failure');
    store.transaction(() => { store.createTaskComment(parent.id, { body: 'Composes with outer transaction.' }, bob); store.updateTask(child.id, { expectedVersion: 2, status: 'resolved' }, alice); });
    assert.equal(store.taskDetail(parent.id).task.version, 3); assert.equal(store.taskDetail(child.id).task.status, 'resolved');
  } finally { store.close(); }
});

test('task histories and graph mutations survive restart and idempotent retries without duplicate inverse updates or comments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-task-retry-')); const path = join(directory, 'workspace.sqlite');
  let store = new Store({ path });
  try {
    const parent = create(store); const child = create(store, 'Dependency');
    const edge = store.mutate('edge-once', 'edge-fingerprint', () => ({ status: 200, body: depend(store, parent.id, child.id) }));
    const edit = store.mutate('edit-once', 'edit-fingerprint', () => ({ status: 200, body: store.updateTask(child.id, { expectedVersion: 2, status: 'resolved' }, bob) }));
    const comment = store.mutate('comment-once', 'comment-fingerprint', () => ({ status: 201, body: store.createTaskComment(parent.id, { body: 'Saved exactly once.' }, alice) }));
    const before = [store.taskDetail(parent.id), store.taskDetail(child.id)];
    store.close(); store = new Store({ path });
    assert.deepEqual([store.taskDetail(parent.id), store.taskDetail(child.id)], before);
    for (const [key, fingerprint, response] of [['edge-once', 'edge-fingerprint', edge], ['edit-once', 'edit-fingerprint', edit], ['comment-once', 'comment-fingerprint', comment]] as const) {
      assert.deepEqual(store.mutate(key, fingerprint, () => { throw new Error('Must not repeat the write'); }), response);
      assert.throws(() => store.mutate(key, 'different-input', () => ({ status: 200, body: {} })), status(409));
    }
    assert.deepEqual([store.taskDetail(parent.id), store.taskDetail(child.id)], before);
    assert.equal(store.taskHistory(parent.id).transactions.length, 5); assert.equal(store.taskHistory(child.id).transactions.length, 4);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('task versions and history sequences reject unsafe increments with no partial mutations', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const parent = create(store); const child = create(store, 'At the limit');
    depend(store, parent.id, child.id);
    const parentAtLimit = { ...store.taskDetail(parent.id).task, version: Number.MAX_SAFE_INTEGER };
    store.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify(parentAtLimit), parent.id);
    let before = snapshot(store);
    assert.throws(() => store.updateTask(parent.id, { expectedVersion: parentAtLimit.version, title: 'Overflow' }, alice), status(409));
    assert.throws(() => store.updateTask(child.id, { expectedVersion: 2, status: 'resolved' }, bob), status(409), 'a blocked parent cannot overflow during status propagation');
    assert.throws(() => depend(store, parent.id, child.id, 'remove'), status(409));
    assert.deepEqual(snapshot(store), before);
    const last = store.taskHistory(child.id).transactions[0]!;
    const sentinel = { ...last, id: 'history-limit', sequence: Number.MAX_SAFE_INTEGER };
    store.database.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(sentinel.id, child.id, sentinel.sequence, sentinel.taskVersion, JSON.stringify(sentinel));
    before = snapshot(store);
    assert.throws(() => store.createTaskComment(child.id, { body: 'History overflow' }, bob), status(409));
    assert.throws(() => store.updateTask(child.id, { expectedVersion: 2, title: 'History overflow' }, bob), status(409));
    assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});

test('a task writer waits for SQLite before reading CAS state, including a dependency inserted by another process', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-task-lock-')); const path = join(directory, 'workspace.sqlite');
  const store = new Store({ path }); let worker: Worker | undefined;
  try {
    const a = create(store, 'A'); const b = create(store, 'B');
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      const now = new Date().toISOString();
      for (const task of [workerData.a, workerData.b]) {
        const next = { ...task, version: 2, updatedAt: now };
        db.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify(next), next.id);
        const sequence = db.prepare('SELECT MAX(sequence) AS sequence FROM task_transactions WHERE task_id = ?').get(task.id).sequence + 1;
        const transaction = { id: 'worker-' + task.id, taskId: task.id, sequence, taskVersion: 2, kind: 'dependency', actor: 'Concurrent writer', createdAt: now,
          dependency: { taskId: task.id === workerData.b.id ? workerData.a.id : workerData.b.id, action: 'added', direction: task.id === workerData.b.id ? 'depends_on' : 'blocks' } };
        db.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(transaction.id, task.id, sequence, 2, JSON.stringify(transaction));
      }
      db.prepare('INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)').run(workerData.b.id, workerData.a.id);
      parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
    `)}`), { workerData: { path, a, b } });
    assert.deepEqual(await once(worker, 'message'), ['locked']);
    const prepare = store.database.prepare.bind(store.database); let reachedLock = 0;
    store.database.prepare = (sql: string) => {
      if (sql === "UPDATE sequences SET value = value WHERE name = 'task'") { reachedLock++; worker!.postMessage('commit'); }
      return prepare(sql);
    };
    try {
      assert.throws(() => store.updateTaskDependencies(a.id, { taskId: b.id, action: 'add', expectedVersion: 1 }, alice), status(409));
      assert.equal(reachedLock, 1);
    } finally { store.database.prepare = prepare; }
    assert.equal(store.taskDetail(a.id).task.version, 2); assert.deepEqual(store.taskDetail(b.id).dependsOn.map(item => item.id), [a.id]);
    assert.throws(() => depend(store, a.id, b.id), status(409));
    assert.equal(store.taskHistory(a.id).transactions.length, 3); assert.equal(raw(store, 'task_dependencies').length, 1);
  } finally { if (worker) await worker.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

function schemaSix(path: string): { task: Omit<Task, 'version' | 'ownerId' | 'authorId' | 'projectIds'> & { projectId: null }; other: string; replay: string; activity: string } {
  const database = new DatabaseSync(path); const now = '2021-06-01T12:00:00.000Z';
  const task = { id: 'T7', title: 'Existing task', description: 'Only the latest stored description.', status: 'in_progress' as const, priority: 'high' as const, projectId: null, createdAt: now, updatedAt: '2025-10-01T12:00:00.000Z' };
  const replay = JSON.stringify(task, null, 2);
  const other = JSON.stringify({ id: 'PROJ1', name: 'Preserved project', description: 'Existing content.', color: '#5b83b5' }, null, 2);
  const activity = JSON.stringify({ id: 'historical-activity', objectId: task.id, actor: 'Unverified old author', action: 'updated', detail: 'Historical task activity.', createdAt: task.updatedAt }, null, 2);
  try {
    // Direct historical schema 6 DDL; no current database is relabelled.
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE versions (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(revision_id, number));
      CREATE TABLE comments (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE reviews (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, object_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), created_at TEXT NOT NULL);
      CREATE TABLE wiki_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES entities(id), number INTEGER NOT NULL CHECK(number > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(document_id, number));
      CREATE TRIGGER wiki_versions_no_update BEFORE UPDATE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
      CREATE TRIGGER wiki_versions_no_delete BEFORE DELETE ON wiki_versions BEGIN SELECT RAISE(ABORT, 'Wiki versions are immutable'); END;
      CREATE TABLE review_threads (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), root_comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE thread_events (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TRIGGER comments_no_update BEFORE UPDATE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
      CREATE TRIGGER comments_no_delete BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
      CREATE TRIGGER thread_events_no_update BEFORE UPDATE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
      CREATE TRIGGER thread_events_no_delete BEFORE DELETE ON thread_events BEGIN SELECT RAISE(ABORT, 'Thread events are immutable'); END;
      CREATE TABLE suggestion_applications (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES entities(id), comment_id TEXT NOT NULL UNIQUE REFERENCES comments(id), thread_id TEXT NOT NULL REFERENCES review_threads(id), from_version_id TEXT NOT NULL REFERENCES versions(id), to_version_id TEXT NOT NULL REFERENCES versions(id), data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TRIGGER suggestion_applications_no_update BEFORE UPDATE ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'Suggestion applications are immutable'); END;
      CREATE TRIGGER suggestion_applications_no_delete BEFORE DELETE ON suggestion_applications BEGIN SELECT RAISE(ABORT, 'Suggestion applications are immutable'); END;
      INSERT INTO sequences (name, value) VALUES ('task', 7);
    `);
    database.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(task.id, 'task', replay);
    database.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run('PROJ1', 'project', other);
    database.prepare('INSERT INTO activity (id, object_id, data) VALUES (?, ?, ?)').run('historical-activity', task.id, activity);
    database.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('old-task-edit', 'old-fingerprint', 200, replay, task.updatedAt);
    initializePolicies(database); database.exec('PRAGMA user_version = 6');
    return { task, other, replay, activity };
  } finally { database.close(); }
}

test('schema 6 migration adds an honest unknown-author baseline at migration time and preserves other records and old replay bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-task-migration-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaSix(path); const started = Date.now(); let store = new Store({ path });
  try {
    assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 26);
    assert.equal(store.fresh, false);
    const detail = store.taskDetail(old.task.id); const { projectId: _legacyProject, ...metadata } = old.task; assert.deepEqual(detail.task, { ...metadata, projectIds: [], ownerId: null, authorId: null, version: 1 });
    assert.deepEqual(detail.dependsOn, []); assert.deepEqual(detail.blocks, []);
    assert.equal(detail.history.transactions.length, 1); const legacy = detail.history.transactions[0]!;
    assert.equal(legacy.kind, 'legacy'); assert.equal(legacy.actor, null); assert.equal(legacy.attribution, undefined);
    assert.equal(legacy.sequence, 1); assert.equal(legacy.taskVersion, 1); assert.deepEqual(legacy.snapshot, { ...old.task, version: 1 }); assert.equal(legacy.changes, undefined);
    assert.ok(Date.parse(legacy.createdAt) >= started); assert.notEqual(legacy.createdAt, old.task.updatedAt);
    assert.equal((store.database.prepare('SELECT data FROM entities WHERE id = ?').get('PROJ1') as { data: string }).data, old.other);
    assert.equal((store.database.prepare('SELECT data FROM activity WHERE id = ?').get('historical-activity') as { data: string }).data, old.activity);
    assert.equal((store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get('old-task-edit') as { body: string }).body, old.replay);
    assert.deepEqual(store.replay('old-task-edit', 'old-fingerprint')!.body, old.task);
    store.close(); store = new Store({ path }); assert.deepEqual(store.taskDetail(old.task.id), detail);
    const edited = store.updateTask(old.task.id, { expectedVersion: 1, title: 'First recorded edit.' }, alice);
    assert.equal(edited.version, 2); assert.deepEqual(store.taskHistory(old.task.id).transactions.at(-1), legacy);
    assert.equal(create(store, 'New task after migration').id, 'T8');
    assert.deepEqual(store.mutate('old-task-edit', 'old-fingerprint', () => { throw new Error('Old write must not repeat'); }).body, old.task);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed schema 7 migration leaves the original schema and task bytes intact for a later retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-task-migration-failure-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaSix(path); let database = new DatabaseSync(path);
  try {
    database.exec("CREATE TRIGGER reject_task_migration BEFORE UPDATE ON entities WHEN NEW.id = 'T7' BEGIN SELECT RAISE(ABORT, 'Injected migration failure'); END;");
    database.close();
    assert.throws(() => new Store({ path }), /Injected migration failure/);
    database = new DatabaseSync(path);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 6);
    assert.equal((database.prepare('SELECT data FROM entities WHERE id = ?').get(old.task.id) as { data: string }).data, old.replay);
    assert.equal((database.prepare('SELECT body FROM idempotency WHERE key = ?').get('old-task-edit') as { body: string }).body, old.replay);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name IN ('task_transactions', 'task_dependencies')").all().length, 0);
    database.exec('DROP TRIGGER reject_task_migration');
    const store = new Store({ path });
    try { assert.equal(store.taskHistory(old.task.id).transactions.length, 1); assert.equal(store.taskDetail(old.task.id).task.version, 1); }
    finally { store.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
