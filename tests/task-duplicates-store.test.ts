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
import type { ActorAttribution, Task, TaskTransaction } from '../shared/types.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'alice-session', requestId: 'alice-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: 'bob-token', requestId: 'bob-request' };
const merger: ActorAttribution = { principalId: 'merger', displayName: 'Merge operator', credentialId: 'merge-token', requestId: 'merge-request' };
const create = (store: Store, title = 'Review the paper') => store.createTask({ title, description: 'Keep this exact source.' }, alice);
const current = (store: Store, id: string) => store.taskDetail(id).task;
const status = (value: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === value;
const raw = (store: Store, table: string) => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const tables = ['entities', 'task_transactions', 'task_dependencies', 'task_duplicates', 'task_subscriptions', 'policy_meta', 'object_policies', 'activity', 'sequences', 'idempotency'];
const snapshot = (store: Store) => tables.map(table => raw(store, table));
const merge = (store: Store, source: string, target: string) => store.mergeTask(source, { taskId: target, expectedVersion: current(store, source).version, expectedTargetVersion: current(store, target).version }, merger);
const mergeIn = (store: Store, target: string, sources: string[]) => store.mergeTasksInto(target, { expectedVersion: current(store, target).version, sources: sources.map(taskId => ({ taskId, expectedVersion: current(store, taskId).version })) }, merger);
const depend = (store: Store, parent: string, child: string) => store.updateTaskDependencies(parent, { taskId: child, action: 'add', expectedVersion: current(store, parent).version }, alice);
const subscribe = (store: Store, taskId: string, principalId: string, action: 'subscribe' | 'unsubscribe') => store.updateTaskSubscription(taskId, { principalId, action, expectedMembershipVersion: store.subscriptionStatus(taskId, principalId).version }, bob);

test('single merge preserves both original tasks and evidence while recording immutable paired links and exact status provenance', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const project = store.createProject({ name: 'Source project' }, alice);
    const source = store.createTask({ title: 'Original source', description: '  Source text\n', status: 'in_progress', priority: 'urgent', projectId: project.id, ownerId: bob.principalId }, alice);
    const target = store.createTask({ title: 'Destination', description: 'Target text', status: 'resolved', priority: 'low', ownerId: alice.principalId }, bob);
    const comment = store.createTaskComment(source.id, { body: 'Original discussion remains here.' }, bob);
    const historical = raw(store, 'task_transactions'); const policies = raw(store, 'object_policies'); const epoch = raw(store, 'policy_meta');
    const result = merge(store, source.id, target.id); const destination = current(store, target.id);
    assert.equal(result.task.id, source.id); assert.deepEqual(result.task, { ...source, status: 'duplicate', version: 2, updatedAt: result.task.updatedAt });
    assert.deepEqual(destination, { ...target, version: 2, updatedAt: destination.updatedAt });
    assert.deepEqual(result.duplicateOf.map(item => item.id), [target.id]); assert.deepEqual(result.duplicates, []);
    assert.deepEqual(store.taskDetail(target.id).duplicates.map(item => item.id), [source.id]);
    assert.deepEqual(raw(store, 'task_transactions').slice(0, historical.length), historical);
    assert.equal(store.taskHistory(source.id).transactions.find(item => item.id === comment.id)?.comment, comment.comment);
    assert.equal(store.taskHistory(target.id).transactions.some(item => item.comment === comment.comment), false);
    const from = store.taskHistory(source.id).transactions.find(item => item.kind === 'merge')!;
    const into = store.taskHistory(target.id).transactions.find(item => item.kind === 'merge')!;
    assert.deepEqual(from.merge, { taskId: target.id, direction: 'merged_into', operationId: into.merge!.operationId });
    assert.deepEqual(into.merge, { taskId: source.id, direction: 'merged_from', operationId: from.merge!.operationId });
    assert.deepEqual(from.changes, [{ field: 'status', oldValue: 'in_progress', newValue: 'duplicate' }]); assert.equal(into.changes, undefined);
    assert.deepEqual(from.attribution, merger); assert.deepEqual(into.attribution, merger); assert.equal(from.actor, merger.displayName);
    assert.equal(from.taskVersion, 2); assert.equal(into.taskVersion, 2);
    assert.deepEqual(raw(store, 'object_policies'), policies); assert.deepEqual(raw(store, 'policy_meta'), epoch);
    assert.throws(() => store.database.exec('UPDATE task_duplicates SET target_id = target_id'), /immutable/);
    assert.throws(() => store.database.exec('DELETE FROM task_duplicates'), /immutable/);
  } finally { store.close(); }
});

test('batch merge validates initial versions and advances overlapping endpoints and dependent parents once per atomic operation', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const first = create(store, 'First source'); const second = create(store, 'Second source'); const target = create(store, 'Destination'); const parent = create(store, 'Shared parent');
    depend(store, second.id, first.id); depend(store, target.id, first.id); depend(store, target.id, second.id); depend(store, parent.id, first.id); depend(store, parent.id, second.id);
    const originals = [first, second, target, parent].map(task => current(store, task.id)); const edges = raw(store, 'task_dependencies');
    const result = mergeIn(store, target.id, [first.id, second.id]);
    assert.equal(result.task.id, target.id); assert.equal(result.task.status, 'open'); assert.deepEqual(raw(store, 'task_dependencies'), edges);
    for (const original of originals) assert.equal(current(store, original.id).version, original.version + 1);
    assert.equal(current(store, first.id).status, 'duplicate'); assert.equal(current(store, second.id).status, 'duplicate'); assert.equal(current(store, parent.id).status, 'open');
    const records = [first, second, target].flatMap(task => store.taskHistory(task.id).transactions.filter(item => item.kind === 'merge'));
    assert.equal(records.length, 4); assert.equal(new Set(records.map(item => item.merge!.operationId)).size, 1);
    for (const original of originals) {
      const events = store.taskHistory(original.id).transactions.filter(item => item.kind === 'merge' || item.kind === 'dependency_status');
      for (const event of events) { assert.equal(event.taskVersion, original.version + 1); assert.deepEqual(event.attribution, merger); }
    }
    assert.equal(store.taskHistory(parent.id).transactions.filter(item => item.kind === 'dependency_status').length, 2);
    assert.equal(store.taskHistory(target.id).transactions.filter(item => item.kind === 'dependency_status').length, 2);
    assert.equal(store.taskHistory(second.id).transactions.filter(item => item.kind === 'dependency_status').length, 1);
    for (const activity of store.activities().filter(item => ['merged', 'duplicates_merged', 'dependency_status_changed'].includes(item.action))) {
      assert.equal(/T\d/.test(activity.detail), false); assert.equal(activity.detail.includes('First source'), false);
    }
  } finally { store.close(); }
});

test('merge carries source authors, owners and current subscribers explicitly with actual initiator attribution, preserving source opt-outs', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = store.createTask({ title: 'Source', ownerId: bob.principalId }, alice);
    const second = store.createTask({ title: 'Unknown author', ownerId: 'other-owner' });
    const target = store.createTask({ title: 'Destination', ownerId: bob.principalId });
    subscribe(store, source.id, alice.principalId, 'unsubscribe'); subscribe(store, source.id, 'reader', 'subscribe'); subscribe(store, source.id, 'opted-out', 'unsubscribe');
    subscribe(store, second.id, 'reader', 'subscribe'); subscribe(store, target.id, alice.principalId, 'unsubscribe'); subscribe(store, target.id, 'reader', 'unsubscribe');
    const preferences = () => store.database.prepare('SELECT * FROM task_subscriptions WHERE task_id IN (?, ?) ORDER BY task_id, principal_id').all(source.id, second.id);
    const before = preferences(); mergeIn(store, target.id, [source.id, second.id]);
    assert.deepEqual(preferences(), before);
    assert.deepEqual(store.taskSubscriptions(target.id, merger.principalId).subscribers.map(item => item.principalId), ['alice', 'bob', 'other-owner', 'reader']);
    assert.equal(store.subscriptionStatus(target.id, 'opted-out').state, null); assert.equal(store.subscriptionStatus(target.id, merger.principalId).state, null);
    assert.equal(store.subscriptionStatus(target.id, bob.principalId).state, 'subscribed', 'automatic destination following does not suppress an explicit merge addition');
    assert.equal(store.subscriptionStatus(target.id, alice.principalId).version, 2); assert.equal(store.subscriptionStatus(target.id, 'reader').version, 2);
    const additions = store.taskHistory(target.id).transactions.filter(item => item.subscription?.reason === 'merged'); assert.equal(additions.length, 4);
    for (const addition of additions) { assert.deepEqual(addition.attribution, merger); assert.equal(addition.actor, merger.displayName); assert.equal(addition.taskVersion, 2); }
    assert.equal(current(store, source.id).ownerId, bob.principalId); assert.equal(current(store, target.id).ownerId, bob.principalId);
  } finally { store.close(); }
});

test('merge inputs are strict and versioned while multiple destinations, directed cycles and later reopening remain valid', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const first = create(store); const second = create(store); const third = create(store);
    const input = { taskId: second.id, expectedVersion: 1, expectedTargetVersion: 1 }; let before = snapshot(store);
    for (const bad of [{}, { ...input, taskId: 'bad' }, { ...input, expectedVersion: 0 }, { ...input, expectedTargetVersion: 1.1 }, { ...input, actor: 'fake' }, { ...input, taskId: first.id }]) assert.throws(() => store.mergeTask(first.id, bad, merger), status(400));
    for (const bad of [{ sources: [], expectedVersion: 1 }, { sources: Array.from({ length: 101 }, () => ({ taskId: first.id, expectedVersion: 1 })), expectedVersion: 1 }, { sources: [{ taskId: first.id, expectedVersion: 1 }, { taskId: first.id, expectedVersion: 1 }], expectedVersion: 1 }, { sources: [{ taskId: first.id, expectedVersion: 1, title: 'forged' }], expectedVersion: 1 }, { sources: [{ taskId: second.id, expectedVersion: 1 }], expectedVersion: 1 }]) assert.throws(() => store.mergeTasksInto(second.id, bad, merger), status(400));
    assert.throws(() => store.mergeTask(first.id, { ...input, taskId: 'T999' }, merger), status(404));
    assert.throws(() => store.mergeTask(first.id, { ...input, expectedVersion: 2 }, merger), status(409));
    assert.throws(() => store.mergeTask(first.id, { ...input, expectedTargetVersion: 2 }, merger), status(409));
    assert.throws(() => store.mergeTasksInto(third.id, { expectedVersion: 1, sources: [{ taskId: first.id, expectedVersion: 1 }, { taskId: second.id, expectedVersion: 2 }] }, merger), status(409));
    assert.throws(() => store.createTask({ title: 'No direct duplicate', status: 'duplicate' }, alice), status(400));
    assert.throws(() => store.updateTask(first.id, { expectedVersion: 1, status: 'duplicate' }, alice), status(400)); assert.deepEqual(snapshot(store), before);
    merge(store, first.id, second.id);
    const existing = current(store, first.id); store.updateTask(first.id, { expectedVersion: existing.version, status: 'duplicate', title: 'Still a duplicate' }, alice);
    merge(store, first.id, third.id); assert.equal(store.taskHistory(first.id).transactions[0]!.changes, undefined, 'an already duplicate source has no invented status change');
    merge(store, second.id, first.id);
    assert.deepEqual(store.taskDetail(first.id).duplicateOf.map(item => item.id), [second.id, third.id]); assert.deepEqual(store.taskDetail(first.id).duplicates.map(item => item.id), [second.id]);
    const linkBytes = raw(store, 'task_duplicates'); const reopened = store.updateTask(first.id, { expectedVersion: current(store, first.id).version, status: 'open' }, bob);
    assert.equal(reopened.status, 'open'); assert.deepEqual(raw(store, 'task_duplicates'), linkBytes); assert.equal(store.taskDetail(first.id).duplicateOf.length, 2);
  } finally { store.close(); }
});

test('fresh repeated merges preserve first-link bytes but record new operations, reclose reopened tasks and carry new followers', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const source = create(store, 'Original source'); const extra = create(store, 'Additional source'); const target = create(store, 'Destination');
    merge(store, source.id, target.id);
    const originalLinks = raw(store, 'task_duplicates'); const firstOperation = store.taskHistory(source.id).transactions.find(item => item.merge)!.merge!.operationId;
    const beforeSource = current(store, source.id); const beforeTarget = current(store, target.id);
    subscribe(store, source.id, 'new-reader', 'subscribe'); subscribe(store, target.id, alice.principalId, 'unsubscribe');
    const input = { taskId: target.id, expectedVersion: beforeSource.version, expectedTargetVersion: beforeTarget.version };
    const response = store.mutate('repeat-merge', 'repeat-input', () => ({ status: 201, body: store.mergeTask(source.id, input, merger) }));
    assert.deepEqual(raw(store, 'task_duplicates'), originalLinks);
    assert.equal(current(store, source.id).version, beforeSource.version + 1); assert.equal(current(store, target.id).version, beforeTarget.version + 1);
    const repeated = store.taskHistory(source.id).transactions.find(item => item.merge)!;
    assert.notEqual(repeated.merge!.operationId, firstOperation); assert.equal(repeated.changes, undefined, 'already duplicate status has no invented transition');
    assert.equal(store.subscriptionStatus(target.id, 'new-reader').state, 'subscribed'); assert.equal(store.subscriptionStatus(target.id, alice.principalId).state, 'subscribed');
    const after = snapshot(store); assert.deepEqual(store.mutate('repeat-merge', 'repeat-input', () => { throw new Error('Do not repeat saved request'); }), response); assert.deepEqual(snapshot(store), after);
    store.updateTask(source.id, { expectedVersion: current(store, source.id).version, status: 'open' }, alice);
    const reopened = current(store, source.id); const existingTarget = current(store, target.id); const newSource = current(store, extra.id);
    subscribe(store, source.id, 'later-reader', 'subscribe');
    mergeIn(store, target.id, [source.id, extra.id]);
    assert.deepEqual(raw(store, 'task_duplicates').slice(0, originalLinks.length), originalLinks); assert.equal(raw(store, 'task_duplicates').length, 2);
    assert.equal(current(store, source.id).status, 'duplicate'); assert.equal(current(store, source.id).version, reopened.version + 1);
    assert.equal(current(store, target.id).version, existingTarget.version + 1); assert.equal(current(store, extra.id).version, newSource.version + 1);
    assert.equal(store.subscriptionStatus(target.id, 'later-reader').state, 'subscribed');
    const reclosed = store.taskHistory(source.id).transactions.find(item => item.merge)!;
    assert.deepEqual(reclosed.changes, [{ field: 'status', oldValue: 'open', newValue: 'duplicate' }]);
    assert.equal(reclosed.merge!.operationId, store.taskHistory(extra.id).transactions.find(item => item.merge)!.merge!.operationId);
    assert.notEqual(reclosed.merge!.operationId, repeated.merge!.operationId);
  } finally { store.close(); }
});

test('merge history filters hidden counterpart references before pagination without dropping other visible batch records', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const target = store.createTask({ title: 'Target' }); const sources = Array.from({ length: 55 }, (_, index) => store.createTask({ title: `Source ${index}` }));
    mergeIn(store, target.id, sources.map(item => item.id));
    const hidden = new Set(sources.filter((_, index) => index % 2 === 0).map(item => item.id));
    const expected = store.taskHistory(target.id, undefined, 100).transactions.filter(item => !item.merge || !hidden.has(item.merge.taskId));
    const actual: TaskTransaction[] = []; let before: number | undefined;
    do {
      const page = store.taskHistory(target.id, before, 7, id => !hidden.has(id));
      assert.equal(page.firstAvailableSequence, 1); assert.ok(page.transactions.length <= 7);
      actual.push(...page.transactions); before = page.nextBefore ?? undefined;
    } while (before !== undefined);
    assert.deepEqual(actual, expected); assert.equal(actual.filter(item => item.merge).length, 27);
    assert.deepEqual(store.taskHistory(sources[0]!.id, undefined, 50, id => id !== target.id).transactions.map(item => item.kind), ['create']);
  } finally { store.close(); }
});

test('merge links, endpoint and parent versions, subscriptions, history, activity and replay writes roll back together', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const first = create(store); const second = create(store); const target = store.createTask({ title: 'Target' }); const parent = create(store); depend(store, parent.id, first.id);
    const before = snapshot(store);
    const attempt = () => store.mutate('batch-once', 'fingerprint', () => ({ status: 201, body: mergeIn(store, target.id, [first.id, second.id]) }));
    const triggers = [
      `CREATE TRIGGER fail_merge BEFORE INSERT ON task_duplicates WHEN NEW.source_id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'Injected link failure'); END;`,
      `CREATE TRIGGER fail_merge BEFORE INSERT ON task_transactions WHEN NEW.task_id = '${parent.id}' AND json_extract(NEW.data, '$.kind') = 'dependency_status' BEGIN SELECT RAISE(ABORT, 'Injected parent failure'); END;`,
      "CREATE TRIGGER fail_merge BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'subscription_changed' BEGIN SELECT RAISE(ABORT, 'Injected subscription failure'); END;",
      "CREATE TRIGGER fail_merge BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT, 'Injected replay failure'); END;",
    ];
    for (const trigger of triggers) { store.database.exec(trigger); assert.throws(attempt, /Injected/); assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_merge'); }
    const task = current(store, parent.id); const originalJson = (store.database.prepare('SELECT data FROM entities WHERE id = ?').get(task.id) as { data: string }).data; store.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(JSON.stringify({ ...task, version: Number.MAX_SAFE_INTEGER }), task.id);
    const exhausted = snapshot(store); assert.throws(attempt, status(409)); assert.deepEqual(snapshot(store), exhausted);
    store.database.prepare('UPDATE entities SET data = ? WHERE id = ?').run(originalJson, task.id); assert.deepEqual(snapshot(store), before);
    const result = attempt(); assert.equal(result.status, 201); const after = snapshot(store);
    assert.deepEqual(store.mutate('batch-once', 'fingerprint', () => { throw new Error('No second merge'); }), result); assert.deepEqual(snapshot(store), after);
  } finally { store.close(); }
});

test('opposite merges cannot both commit stale endpoint versions and historical replay persists after reopening and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-merge-cas-')); const path = join(directory, 'workspace.sqlite');
  let first = new Store({ path }); let second = new Store({ path });
  try {
    const source = create(first); const target = create(first);
    const response = first.mutate('merge-once', 'merge-body', () => ({ status: 201, body: first.mergeTask(source.id, { taskId: target.id, expectedVersion: 1, expectedTargetVersion: 1 }, merger) }));
    assert.throws(() => second.mergeTask(target.id, { taskId: source.id, expectedVersion: 1, expectedTargetVersion: 1 }, bob), status(409));
    second.updateTask(source.id, { expectedVersion: 2, status: 'open' }, alice);
    const before = snapshot(first); first.close(); second.close(); first = new Store({ path }); second = new Store({ path });
    assert.deepEqual(snapshot(first), before); assert.equal(current(first, source.id).status, 'open');
    assert.deepEqual(first.mutate('merge-once', 'merge-body', () => { throw new Error('Do not close again'); }), response);
    assert.deepEqual(snapshot(first), before); assert.equal((response.body as { task: Task }).task.status, 'duplicate');
    merge(first, target.id, source.id); assert.equal(raw(first, 'task_duplicates').length, 2, 'a fresh-version opposite relationship is allowed');
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('merges acquire the writer lock before checking endpoint versions', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-merge-lock-')); const path = join(directory, 'workspace.sqlite');
  const store = new Store({ path }); let worker: Worker | undefined;
  try {
    const source = create(store); const target = create(store);
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      db.prepare("UPDATE entities SET data = json_set(data, '$.version', 2, '$.title', 'Concurrent edit') WHERE id = ?").run(workerData.id);
      parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
    `)}`), { workerData: { path, id: target.id } });
    assert.deepEqual(await once(worker, 'message'), ['locked']);
    const prepare = store.database.prepare.bind(store.database); let waited = 0;
    store.database.prepare = (sql: string) => { if (sql === "UPDATE sequences SET value = value WHERE name = 'task'") { waited++; worker!.postMessage('commit'); } return prepare(sql); };
    try { assert.throws(() => store.mergeTask(source.id, { taskId: target.id, expectedVersion: 1, expectedTargetVersion: 1 }, merger), status(409)); assert.equal(waited, 1); }
    finally { store.database.prepare = prepare; }
    assert.equal(current(store, source.id).status, 'open'); assert.equal(current(store, target.id).title, 'Concurrent edit'); assert.deepEqual(raw(store, 'task_duplicates'), []);
  } finally { if (worker) await worker.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

type LegacyTask = Omit<Task, 'projectIds'> & { projectId: string | null };
function schemaEight(path: string): { task: LegacyTask; rows: unknown[]; replay: string } {
  const db = new DatabaseSync(path); const now = '2026-10-02T12:00:00.000Z';
  try {
    // Build the historical schema directly. No current Store is opened and
    // relabelled, and no merge evidence is inferred from existing statuses.
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
      INSERT INTO sequences (name, value) VALUES ('task', 2);
    `);
    const task: LegacyTask = { id: 'T1', title: 'Historical source', description: 'Keep exact content.', status: 'open', priority: 'high', ownerId: bob.principalId, authorId: alice.principalId, projectId: null, version: 4, createdAt: now, updatedAt: now };
    const target: LegacyTask = { ...task, id: 'T2', title: 'Historical destination', status: 'resolved', version: 2, authorId: null, ownerId: null };
    for (const item of [task, target]) {
      db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(item.id, 'task', JSON.stringify(item, null, 2));
      const history: TaskTransaction = { id: `old-${item.id}`, taskId: item.id, sequence: 1, taskVersion: item.version, kind: 'legacy', actor: null, createdAt: now, snapshot: item };
      db.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(history.id, item.id, 1, item.version, JSON.stringify(history, null, 2));
    }
    db.prepare('INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)').run(target.id, task.id);
    db.prepare('INSERT INTO task_subscriptions (task_id, principal_id, state, version, updated_at) VALUES (?, ?, ?, ?, ?)').run(task.id, alice.principalId, 'unsubscribed', 3, now);
    const source = [{ path: 'paper.tex', content: 'Exact evidence' }];
    db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run('D1', 'revision', JSON.stringify({ id: 'D1', kind: 'code', title: 'Old source', summary: '', status: 'needs_review', currentVersion: 1, projectId: null, repositoryId: null, createdAt: now, updatedAt: now }, null, 2));
    db.prepare('INSERT INTO versions (id, revision_id, number, data) VALUES (?, ?, ?, ?)').run('v1', 'D1', 1, JSON.stringify({ id: 'v1', revisionId: 'D1', number: 1, files: source, contentHash: contentHash(source), message: 'Historical source', createdAt: now }, null, 2));
    const replay = JSON.stringify({ task, history: { transactions: [], nextBefore: null, firstAvailableSequence: null }, dependsOn: [], blocks: [], activity: [] }, null, 2);
    db.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('historical', 'historical-input', 200, replay, now);
    initializePolicies(db); db.exec('PRAGMA user_version = 8');
    return { task, rows: [...tables.filter(table => table !== 'task_duplicates'), 'versions'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), replay };
  } finally { db.close(); }
}

test('schema 9 adds empty duplicate storage while preserving actual schema 8 task, membership, source, history and replay bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-merge-migration-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaEight(path); let store = new Store({ path });
  try {
    assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 38);
    assert.deepEqual([...tables.filter(table => table !== 'task_duplicates'), 'versions'].map(table => raw(store, table)), old.rows);
    const { projectId: _legacyProject, ...metadata } = old.task; assert.deepEqual(current(store, old.task.id), { ...metadata, projectIds: [] }); assert.deepEqual(store.taskDetail(old.task.id).duplicateOf, []); assert.deepEqual(store.taskDetail('T2').duplicates, []);
    assert.deepEqual(raw(store, 'task_duplicates'), []);
    assert.equal((store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get('historical') as { body: string }).body, old.replay);
    store.close(); store = new Store({ path });
    assert.deepEqual([...tables.filter(table => table !== 'task_duplicates'), 'versions'].map(table => raw(store, table)), old.rows);
    merge(store, old.task.id, 'T2'); assert.equal(current(store, old.task.id).version, 5); assert.equal(current(store, 'T2').version, 3, 'destination and dependent-parent consequence advance once');
    assert.equal((store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get('historical') as { body: string }).body, old.replay);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema 9 migration failure rolls back its table and version without modifying the previous database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-merge-migration-failure-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaEight(path); const database = new DatabaseSync(path);
  try {
    database.exec('CREATE TABLE task_duplicates_target (conflicting_name TEXT)');
    assert.throws(() => new Store({ path }), /already/);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_duplicates'").get(), undefined);
    assert.deepEqual([...tables.filter(table => table !== 'task_duplicates'), 'versions'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), old.rows);
    database.exec('DROP TABLE task_duplicates_target'); const store = new Store({ path });
    try { const { projectId: _legacyProject, ...metadata } = old.task; assert.deepEqual(current(store, old.task.id), { ...metadata, projectIds: [] }); assert.deepEqual(raw(store, 'task_duplicates'), []); } finally { store.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
