import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store, contentHash } from '../server/store.ts';
import { initializePolicies } from '../server/policy.ts';
import type { ActorAttribution, Task, TaskDetail, TaskTransaction } from '../shared/types.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice Writer', credentialId: 'alice-session', requestId: 'alice-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob Reviewer', credentialId: 'bob-token', requestId: 'bob-request' };
const status = (value: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === value;
const tables = ['entities', 'task_transactions', 'task_projects', 'task_dependencies', 'task_duplicates', 'task_subscriptions', 'policy_meta', 'object_policies', 'activity', 'sequences', 'idempotency'];
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const snapshot = (store: Store) => tables.map(table => raw(store, table));
const current = (store: Store, id: string) => store.taskDetail(id).task;
const tags = (store: Store, id: string, action: 'add' | 'remove' | 'set', projectIds: string[], attribution = bob) => store.updateTaskProjects(id, { action, projectIds, expectedVersion: current(store, id).version }, attribution);
const projects = (store: Store, count = 3) => Array.from({ length: count }, (_, index) => store.createProject({ name: `Project ${index + 1}` }, alice));

test('task creation saves canonical multiple tags and exact snapshots while supporting only an unambiguous scalar creation alias', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const [a, b] = projects(store, 2);
    const task = store.createTask({ title: 'Multiple tags', projectIds: [b!.id, a!.id] }, alice);
    assert.deepEqual(task.projectIds, [a!.id, b!.id]); assert.equal('projectId' in task, false);
    assert.deepEqual(store.taskHistory(task.id).transactions.find(item => item.kind === 'create')!.snapshot, task);
    assert.deepEqual(current(store, task.id), task);
    assert.deepEqual(store.state({ configured: false, model: null }).tasks.find(item => item.id === task.id), task);
    const metadata = JSON.parse((store.database.prepare('SELECT data FROM entities WHERE id = ?').get(task.id) as { data: string }).data) as object;
    assert.equal('projectId' in metadata, false); assert.equal('projectIds' in metadata, false);
    assert.deepEqual(store.createTask({ title: 'Legacy creation alias', projectId: a!.id }).projectIds, [a!.id]);
    assert.deepEqual(store.createTask({ title: 'Legacy no tag', projectId: null }).projectIds, []);
    assert.deepEqual(store.createTask({ title: 'No tags by default' }).projectIds, []);
    const before = snapshot(store);
    for (const fields of [
      { projectId: null, projectIds: [] }, { projectId: a!.id, projectIds: [a!.id] }, { projectIds: null },
      { projectIds: a!.id }, { projectIds: [a!.id, a!.id] }, { projectIds: ['PROJ999'] }, { projectIds: [task.id] },
      { projectIds: ['PROJ0'] }, { projectIds: [1] }, { projectIds: Array.from({ length: 101 }, (_, index) => `PROJ${index + 1}`) },
    ]) assert.throws(() => store.createTask({ title: 'Invalid tags', ...fields }, alice), status(400));
    for (const fields of [{ projectId: null }, { projectId: a!.id }, { projectId: 'PROJ999' }, { projectIds: [] }, { projectIds: [a!.id] }]) {
      assert.throws(() => store.updateTask(task.id, { expectedVersion: 1, title: 'Must remain unchanged', ...fields }, alice), { status: 400, message: 'Change project tags with the separate task projects action.' });
    }
    assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});

test('add/remove/set are CAS set operations with one version, attributed immutable per-tag deltas and no-op preservation', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const [a, b, c] = projects(store); const task = store.createTask({ title: 'Tag operations', projectIds: [a!.id] }, alice);
    const epoch = raw(store, 'policy_meta'); const sourceHistory = raw(store, 'task_transactions');
    const added = tags(store, task.id, 'add', [a!.id, b!.id]);
    assert.deepEqual(added.task.projectIds, [a!.id, b!.id]); assert.equal(added.task.version, 2);
    const addition = added.history.transactions[0]!;
    assert.equal(addition.kind, 'project'); assert.equal(addition.project?.action, 'added'); assert.equal(addition.project?.projectId, b!.id);
    assert.equal(addition.taskVersion, 2); assert.equal(addition.actor, bob.displayName); assert.deepEqual(addition.attribution, bob);
    assert.deepEqual(raw(store, 'task_transactions').slice(0, sourceHistory.length), sourceHistory);
    assert.deepEqual(raw(store, 'policy_meta'), epoch, 'tag changes do not change policy capabilities');
    for (const [action, ids] of [['add', [a!.id]], ['remove', [c!.id]], ['set', [b!.id, a!.id]], ['add', []], ['remove', []]] as const) {
      const before = snapshot(store); assert.deepEqual(tags(store, task.id, action, [...ids]), added); assert.deepEqual(snapshot(store), before);
    }
    const replaced = tags(store, task.id, 'set', [c!.id]);
    assert.equal(replaced.task.version, 3); assert.deepEqual(replaced.task.projectIds, [c!.id]);
    const changes = replaced.history.transactions.filter(item => item.taskVersion === 3);
    assert.deepEqual(changes.map(item => [item.project?.projectId, item.project?.action]), [[c!.id, 'added'], [b!.id, 'removed'], [a!.id, 'removed']]);
    assert.equal(new Set(changes.map(item => item.project?.operationId)).size, 1); assert.notEqual(changes[0]!.project!.operationId, addition.project!.operationId);
    assert.ok(changes.every(item => item.kind === 'project' && item.actor === bob.displayName));
    assert.equal(replaced.activity.filter(item => item.action === 'projects_changed').length, 2);
    assert.doesNotMatch(JSON.stringify(replaced.activity.filter(item => item.action === 'projects_changed')), /PROJ|Project [123]/);
    const before = snapshot(store);
    assert.throws(() => store.updateTaskProjects(task.id, { action: 'add', projectIds: [c!.id], expectedVersion: 2 }, alice), status(409), 'even a no-op must use current CAS');
    assert.deepEqual(snapshot(store), before);
    assert.deepEqual(tags(store, task.id, 'set', []).task.projectIds, []);
    assert.throws(() => store.database.exec("UPDATE task_transactions SET data = data WHERE json_extract(data, '$.kind') = 'project'"), /immutable/);
    assert.throws(() => store.database.exec("DELETE FROM task_transactions WHERE json_extract(data, '$.kind') = 'project'"), /immutable/);
  } finally { store.close(); }
});

test('project inputs accept the full 100-ID request boundary without truncation or an implicit total-association cap', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const ids = projects(store, 101).map(project => project.id);
    const task = store.createTask({ title: 'Many tags', projectIds: ids.slice(0, 100) });
    assert.deepEqual(task.projectIds, ids.slice(0, 100).sort());
    assert.deepEqual(tags(store, task.id, 'add', [ids[100]!]).task.projectIds, [...ids].sort());
    const before = snapshot(store);
    assert.throws(() => tags(store, task.id, 'set', ids), status(400)); assert.deepEqual(snapshot(store), before);
    const removed = tags(store, task.id, 'remove', ids.slice(0, 100));
    assert.deepEqual(removed.task.projectIds, [ids[100]!]); assert.equal(removed.task.version, 3);
    const page = store.taskHistory(task.id, undefined, 100);
    assert.equal(page.transactions.length, 100); assert.ok(page.transactions.every(item => item.project?.action === 'removed'));
    assert.equal(new Set(page.transactions.map(item => item.project?.operationId)).size, 1);
  } finally { store.close(); }
});

test('tag validation and failures atomically preserve edges, task, history, activity, sequences and saved replays', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const [a, b, c] = projects(store); const task = store.createTask({ title: 'Atomic tag changes', projectIds: [a!.id] }, alice);
    const before = snapshot(store);
    for (const input of [{ action: 'replace' }, { projectIds: null }, { projectIds: [b!.id, b!.id] }, { projectIds: ['PROJ999'] }, { projectIds: [task.id] }, { projectIds: Array(101).fill(b!.id) }, { expectedVersion: 0 }, { expectedVersion: 1.5 }, { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { actor: 'Forged' }]) assert.throws(() => store.updateTaskProjects(task.id, { action: 'set', projectIds: [b!.id], expectedVersion: 1, ...input }, bob), status(400));
    assert.deepEqual(snapshot(store), before);
    for (const trigger of [
      `CREATE TRIGGER fail_tags BEFORE INSERT ON task_projects WHEN NEW.project_id = '${c!.id}' BEGIN SELECT RAISE(ABORT, 'Injected edge failure'); END;`,
      `CREATE TRIGGER fail_tags BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data, '$.project.action') = 'added' BEGIN SELECT RAISE(ABORT, 'Injected history failure'); END;`,
      `CREATE TRIGGER fail_tags BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'projects_changed' BEGIN SELECT RAISE(ABORT, 'Injected activity failure'); END;`,
    ]) {
      store.database.exec(trigger);
      assert.throws(() => store.mutate('failed-tags', 'same-input', () => ({ status: 200, body: tags(store, task.id, 'set', [b!.id, c!.id]) })), /Injected/);
      assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_tags');
    }
    store.database.exec("CREATE TRIGGER fail_tags BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data, '$.kind') = 'create' BEGIN SELECT RAISE(ABORT, 'Injected create failure'); END;");
    assert.throws(() => store.createTask({ title: 'No partial creation', projectIds: [a!.id, b!.id] }, alice), /Injected/); assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_tags');
    const { projectIds: _projectIds, ...metadata } = current(store, task.id);
    store.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify({ ...metadata, version: Number.MAX_SAFE_INTEGER }), task.id);
    const atLimit = snapshot(store); assert.throws(() => tags(store, task.id, 'add', [b!.id]), status(409)); assert.deepEqual(snapshot(store), atLimit);
  } finally { store.close(); }
});

test('visible tag history is filtered before pagination without hidden project metadata or mutation of raw history', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const [visibleProject, hiddenProject] = projects(store, 2); const task = store.createTask({ title: 'History filter' });
    tags(store, task.id, 'add', [visibleProject!.id, hiddenProject!.id]);
    tags(store, task.id, 'remove', [visibleProject!.id, hiddenProject!.id]);
    const historyBytes = raw(store, 'task_transactions'); const visible = (id: string) => id !== hiddenProject!.id;
    const first = store.taskHistory(task.id, undefined, 1, visible);
    assert.equal(first.transactions[0]!.project?.projectId, visibleProject!.id); assert.equal(first.transactions[0]!.project?.action, 'removed'); assert.equal(first.firstAvailableSequence, 1);
    assert.equal(first.nextBefore, first.transactions[0]!.sequence);
    const second = store.taskHistory(task.id, first.nextBefore!, 1, visible); assert.equal(second.transactions[0]!.project?.action, 'added');
    const third = store.taskHistory(task.id, second.nextBefore!, 1, visible); assert.equal(third.transactions[0]!.kind, 'create'); assert.equal(third.nextBefore, null);
    assert.doesNotMatch(JSON.stringify([first, second, third]), new RegExp(hiddenProject!.id)); assert.deepEqual(raw(store, 'task_transactions'), historyBytes);
    const allHidden = store.taskHistory(task.id, undefined, 1, id => !id.startsWith('PROJ'));
    assert.equal(allHidden.transactions[0]!.kind, 'create'); assert.equal(allHidden.nextBefore, null);
  } finally { store.close(); }
});

test('current canonical tags survive unrelated edits, owner transfer, dependency propagation and direct-read duplicate merges', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const [a, b] = projects(store, 2); const first = store.createTask({ title: 'First', ownerId: alice.principalId, projectIds: [a!.id] }, alice); const second = store.createTask({ title: 'Second', projectIds: [b!.id] }, bob);
    tags(store, first.id, 'set', [b!.id]);
    // Simulate preserved obsolete scalar metadata and a stale external cache.
    store.database.prepare("UPDATE entities SET data = json_set(data, '$.projectId', ?, '$.projectIds', json(?)) WHERE id = ?").run(a!.id, JSON.stringify([a!.id]), first.id);
    assert.deepEqual(current(store, first.id).projectIds, [b!.id]);
    const title = store.updateTask(first.id, { expectedVersion: current(store, first.id).version, title: 'Renamed' }, alice); assert.deepEqual(title.projectIds, [b!.id]);
    assert.equal(store.transferTaskOwners(alice.principalId, bob.principalId, alice), 1);
    store.updateTaskDependencies(first.id, { taskId: second.id, action: 'add', expectedVersion: current(store, first.id).version }, alice);
    store.updateTask(second.id, { expectedVersion: current(store, second.id).version, status: 'resolved' }, bob);
    store.mergeTask(first.id, { taskId: second.id, expectedVersion: current(store, first.id).version, expectedTargetVersion: current(store, second.id).version }, alice);
    for (const id of [first.id, second.id]) {
      assert.deepEqual(current(store, id).projectIds, [b!.id]);
      const metadata = JSON.parse((store.database.prepare('SELECT data FROM entities WHERE id = ?').get(id) as { data: string }).data) as object;
      assert.equal('projectId' in metadata, false); assert.equal('projectIds' in metadata, false);
    }
  } finally { store.close(); }
});

test('concurrent tag updates enforce task CAS and saved responses remain historical across later tags and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-tags-replay-')); const path = join(directory, 'workspace.sqlite');
  let first = new Store({ path }); let second = new Store({ path });
  try {
    const [a, b] = projects(first, 2); const task = first.createTask({ title: 'Concurrent tags' }, alice);
    const input = { action: 'add', projectIds: [a!.id], expectedVersion: 1 };
    const response = first.mutate('tag-once', 'same-input', () => ({ status: 200, body: first.updateTaskProjects(task.id, input, alice) }));
    assert.throws(() => second.updateTaskProjects(task.id, { action: 'add', projectIds: [b!.id], expectedVersion: 1 }, bob), status(409));
    tags(second, task.id, 'set', [b!.id]); const before = snapshot(first);
    assert.deepEqual(first.mutate('tag-once', 'same-input', () => { throw new Error('Must not repeat a saved operation'); }), response);
    assert.deepEqual((response.body as TaskDetail).task.projectIds, [a!.id]); assert.deepEqual(current(first, task.id).projectIds, [b!.id]); assert.deepEqual(snapshot(first), before);
    second.close(); first.close(); first = new Store({ path }); second = new Store({ path });
    assert.deepEqual(snapshot(first), before); assert.deepEqual(first.replay('tag-once', 'same-input'), response);
    assert.throws(() => first.mutate('tag-once', 'different', () => ({ status: 200, body: {} })), status(409));
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('tag writers wait for the SQLite write lock before loading the expected task version and association set', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-tags-lock-')); const path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let worker: Worker | undefined;
  try {
    const [a, b] = projects(store, 2); const task = store.createTask({ title: 'Writer lock' });
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      db.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)').run(workerData.id, workerData.project);
      db.prepare("UPDATE entities SET data = json_set(data, '$.version', 2) WHERE id = ?").run(workerData.id);
      parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
    `)}`), { workerData: { path, id: task.id, project: a!.id } });
    assert.deepEqual(await once(worker, 'message'), ['locked']);
    const prepare = store.database.prepare.bind(store.database); let waited = 0;
    store.database.prepare = (sql: string) => { if (sql === "UPDATE sequences SET value = value WHERE name = 'task'") { waited++; worker!.postMessage('commit'); } return prepare(sql); };
    try { assert.throws(() => store.updateTaskProjects(task.id, { action: 'set', projectIds: [b!.id], expectedVersion: 1 }, alice), status(409)); assert.equal(waited, 1); }
    finally { store.database.prepare = prepare; }
    assert.deepEqual(current(store, task.id).projectIds, [a!.id]); assert.equal(current(store, task.id).version, 2);
    assert.equal(store.taskHistory(task.id).transactions.filter(item => item.kind === 'project').length, 0);
  } finally { if (worker) await worker.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});


type LegacyTask = Omit<Task, 'projectIds'> & { projectId: string | null };
function schemaNine(path: string): { task: LegacyTask; preserved: Map<string, unknown[]>; replay: string } {
  const db = new DatabaseSync(path); const now = '2026-10-02T12:00:00.000Z';
  try {
    // Build real historical schema 9 directly; never relabel a current Store.
    db.exec(`
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
      CREATE TABLE task_transactions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES entities(id), sequence INTEGER NOT NULL CHECK(sequence > 0), task_version INTEGER NOT NULL CHECK(task_version > 0), data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(task_id, sequence));
      CREATE TRIGGER task_transactions_no_update BEFORE UPDATE ON task_transactions BEGIN SELECT RAISE(ABORT, 'Task transactions are immutable'); END;
      CREATE TRIGGER task_transactions_no_delete BEFORE DELETE ON task_transactions BEGIN SELECT RAISE(ABORT, 'Task transactions are immutable'); END;
      CREATE TABLE task_dependencies (task_id TEXT NOT NULL REFERENCES entities(id), dependency_id TEXT NOT NULL REFERENCES entities(id), PRIMARY KEY(task_id, dependency_id), CHECK(task_id <> dependency_id));
      CREATE INDEX task_dependencies_inverse ON task_dependencies(dependency_id, task_id);
      CREATE TABLE task_subscriptions (task_id TEXT NOT NULL REFERENCES entities(id), principal_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('subscribed', 'unsubscribed')), version INTEGER NOT NULL CHECK(version > 0), updated_at TEXT NOT NULL, PRIMARY KEY(task_id, principal_id));
      CREATE INDEX task_subscriptions_principal ON task_subscriptions(principal_id, state, task_id);
      CREATE TABLE task_duplicates (source_id TEXT NOT NULL REFERENCES entities(id), target_id TEXT NOT NULL REFERENCES entities(id), operation_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(source_id, target_id), CHECK(source_id <> target_id));
      CREATE INDEX task_duplicates_target ON task_duplicates(target_id, source_id);
      CREATE TRIGGER task_duplicates_no_update BEFORE UPDATE ON task_duplicates BEGIN SELECT RAISE(ABORT, 'Task duplicate links are immutable'); END;
      CREATE TRIGGER task_duplicates_no_delete BEFORE DELETE ON task_duplicates BEGIN SELECT RAISE(ABORT, 'Task duplicate links are immutable'); END;
      INSERT INTO sequences (name, value) VALUES ('task', 2);
    `);
    const project = { id: 'PROJ1', name: 'Original project', description: 'Historical project', color: '#5b83b5' };
    db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(project.id, 'project', JSON.stringify(project, null, 2));
    const task: LegacyTask = { id: 'T1', title: 'Historical source', description: 'Keep exact content.', status: 'duplicate', priority: 'high', ownerId: bob.principalId, authorId: alice.principalId, projectId: project.id, version: 4, createdAt: now, updatedAt: now };
    const target: LegacyTask = { ...task, id: 'T2', projectId: null, title: 'Historical destination', status: 'resolved', version: 2, authorId: null, ownerId: null };
    for (const item of [task, target]) {
      db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(item.id, 'task', JSON.stringify(item, null, 2));
      const transaction: TaskTransaction = { id: `old-${item.id}`, taskId: item.id, sequence: 1, taskVersion: item.version, kind: 'legacy', actor: null, createdAt: now, snapshot: item };
      db.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(transaction.id, item.id, 1, item.version, JSON.stringify(transaction, null, 2));
    }
    db.prepare('INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)').run(target.id, task.id);
    db.prepare('INSERT INTO task_duplicates (source_id, target_id, operation_id, created_at) VALUES (?, ?, ?, ?)').run(task.id, target.id, 'historical-merge-operation', now);
    db.prepare('INSERT INTO task_subscriptions (task_id, principal_id, state, version, updated_at) VALUES (?, ?, ?, ?, ?)').run(task.id, alice.principalId, 'unsubscribed', 3, now);
    const source = [{ path: 'paper.tex', content: 'Exact evidence' }];
    db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run('D1', 'revision', JSON.stringify({ id: 'D1', kind: 'code', title: 'Old source', summary: '', status: 'needs_review', currentVersion: 1, projectId: null, repositoryId: null, createdAt: now, updatedAt: now }, null, 2));
    db.prepare('INSERT INTO versions (id, revision_id, number, data) VALUES (?, ?, ?, ?)').run('v1', 'D1', 1, JSON.stringify({ id: 'v1', revisionId: 'D1', number: 1, files: source, contentHash: contentHash(source), message: 'Historical source', createdAt: now }, null, 2));
    db.prepare('INSERT INTO activity (id, object_id, data) VALUES (?, ?, ?)').run('old-activity', task.id, JSON.stringify({ id: 'old-activity', objectId: task.id, actor: 'Historical actor', action: 'updated', detail: 'Old event', createdAt: now }, null, 2));
    const replay = JSON.stringify({ task, history: { transactions: [], nextBefore: null, firstAvailableSequence: null }, dependsOn: [], blocks: [], duplicateOf: [], duplicates: [], activity: [] }, null, 2);
    db.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('historical', 'historical-input', 200, replay, now);
    initializePolicies(db); db.exec('PRAGMA user_version = 9');
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return { task, preserved: new Map(names.map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])), replay };
  } finally { db.close(); }
}

test('schema 10 migrates scalar relationships without altering any prior task, source, history, preference, policy or replay bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-tags-migration-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaNine(path); let store = new Store({ path });
  try {
    assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 32);
    for (const [table, rows] of old.preserved) assert.deepEqual(raw(store, table), rows, table);
    const { projectId, ...metadata } = old.task;
    assert.deepEqual(current(store, old.task.id), { ...metadata, projectIds: [projectId] });
    assert.deepEqual(current(store, 'T2').projectIds, []);
    assert.deepEqual(raw(store, 'task_projects').map(row => ({ ...row })), [{ task_id: 'T1', project_id: 'PROJ1' }]);
    assert.deepEqual(store.taskHistory('T1').transactions[0]!.snapshot, old.task);
    assert.equal(store.taskHistory('T1').transactions.some(item => item.kind === 'project'), false);
    assert.deepEqual(store.replay('historical', 'historical-input')!.body, JSON.parse(old.replay));
    store.close(); store = new Store({ path });
    for (const [table, rows] of old.preserved) assert.deepEqual(raw(store, table), rows, table);
    tags(store, 'T1', 'remove', ['PROJ1']);
    const edited = store.updateTask('T1', { expectedVersion: 5, title: 'First current edit' }, alice);
    assert.deepEqual(edited.projectIds, []); assert.equal('projectId' in edited, false);
    assert.deepEqual(store.taskHistory('T1').transactions.at(-1)!.snapshot, old.task);
    assert.equal((store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get('historical') as { body: string }).body, old.replay);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema 10 migration fails atomically for invalid legacy references and retries without partial edges or rewritten evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-tags-migration-failure-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaNine(path); const database = new DatabaseSync(path);
  try {
    const original = (database.prepare('SELECT data FROM entities WHERE id = ?').get('T2') as { data: string }).data;
    database.prepare("UPDATE entities SET data = json_set(data, '$.projectId', ?) WHERE id = ?").run('PROJ404', 'T2');
    const invalid = (database.prepare('SELECT data FROM entities WHERE id = ?').get('T2') as { data: string }).data;
    assert.throws(() => new Store({ path }), /invalid legacy project reference/);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_projects'").get(), undefined);
    assert.equal((database.prepare('SELECT data FROM entities WHERE id = ?').get('T2') as { data: string }).data, invalid);
    database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(original, 'T2');
    for (const [table, rows] of old.preserved) assert.deepEqual(database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows, table);
    database.exec('CREATE TABLE task_projects_project (conflicting_name TEXT)');
    assert.throws(() => new Store({ path }), /already/);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_projects'").get(), undefined);
    database.exec('DROP TABLE task_projects_project'); const store = new Store({ path });
    try { assert.deepEqual(current(store, 'T1').projectIds, ['PROJ1']); for (const [table, rows] of old.preserved) assert.deepEqual(raw(store, table), rows, table); }
    finally { store.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
