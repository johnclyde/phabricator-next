import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { Store } from '../server/store.ts';
import { initializePolicies } from '../server/policy.ts';
import type { ActorAttribution, TaskSnapshot, TaskTransaction } from '../shared/types.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice Writer', credentialId: 'alice-session', requestId: 'alice-operation' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob Reviewer', credentialId: 'bob-token', requestId: 'bob-operation' };
const create = (store: Store, ownerId: string | null = null) => store.createTask({ title: 'Prepare a paper', ownerId }, alice);
const status = (value: number) => (error: unknown) => typeof error === 'object' && error !== null && 'status' in error && error.status === value;
const membership = (store: Store, id: string, principalId: string, action: 'subscribe' | 'unsubscribe', actor = alice) => store.updateTaskSubscription(id, { principalId, action, expectedMembershipVersion: store.subscriptionStatus(id, principalId).version }, actor);
const epoch = (store: Store) => (store.database.prepare("SELECT value FROM policy_meta WHERE name = 'epoch'").get() as { value: number }).value;
const tables = ['entities', 'task_transactions', 'task_subscriptions', 'policy_meta', 'activity', 'sequences', 'idempotency'];
const snapshot = (store: Store) => tables.map(table => store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('creation records stable author identity and explicit creator subscription while current ownership remains derived', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const before = epoch(store); const task = create(store, bob.principalId);
    assert.equal(task.authorId, alice.principalId); assert.equal(task.ownerId, bob.principalId); assert.equal(task.version, 1);
    assert.equal(epoch(store), before + 1);
    assert.deepEqual(store.subscriptionStatus(task.id, bob.principalId), { taskId: task.id, principalId: bob.principalId, state: null, version: 0, automatic: true, subscribed: true, updatedAt: null });
    const creator = store.subscriptionStatus(task.id, alice.principalId);
    assert.equal(creator.state, 'subscribed'); assert.equal(creator.version, 1); assert.equal(creator.automatic, false);
    const history = store.taskHistory(task.id).transactions;
    assert.deepEqual(history.map(item => item.kind), ['subscription', 'create']);
    assert.deepEqual(history[1]!.snapshot, task); assert.deepEqual(history[0]!.attribution, alice);
    assert.deepEqual(history[0]!.subscription, { principalId: alice.principalId, oldState: null, newState: 'subscribed', membershipVersion: 1, reason: 'created' });
    assert.equal(history[0]!.taskVersion, 1); assert.equal(history[0]!.actor, alice.displayName);
    assert.deepEqual(store.taskSubscriptions(task.id, bob.principalId).subscribers.map(item => item.principalId), ['alice', 'bob']);
    const anonymous = store.createTask({ title: 'An unattributed operator fixture' });
    assert.equal(anonymous.authorId, null); assert.equal(anonymous.ownerId, null);
    assert.deepEqual(store.taskSubscriptions(anonymous.id, alice.principalId).subscribers, []);
    assert.equal(store.taskHistory(anonymous.id).transactions.length, 1, 'an unknown author is never guessed from display text');
    assert.throws(() => store.updateTask(task.id, { expectedVersion: 1, authorId: bob.principalId }, bob), status(400));
    assert.throws(() => store.createTask({ title: 'Forged author', authorId: bob.principalId }, alice), status(400));
  } finally { store.close(); }
});

test('comments subscribe once, respect persisted opt-out, and explicit subscription overrides it without changing task version', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const task = create(store); const before = store.taskDetail(task.id).task; const initialEpoch = epoch(store);
    const comment = store.createTaskComment(task.id, { body: 'I can help review.' }, bob);
    let history = store.taskHistory(task.id).transactions;
    assert.equal(history[0]!.id, comment.id); assert.equal(history[1]!.subscription?.reason, 'commented');
    assert.deepEqual(history[1]!.attribution, bob); assert.equal(store.subscriptionStatus(task.id, bob.principalId).version, 1);
    store.createTaskComment(task.id, { body: 'Another thought.' }, bob);
    assert.equal(store.taskHistory(task.id).transactions.filter(item => item.subscription?.principalId === bob.principalId).length, 1);
    const optedOut = membership(store, task.id, bob.principalId, 'unsubscribe', bob);
    assert.equal(optedOut.version, 2); assert.equal(optedOut.subscribed, false);
    store.createTaskComment(task.id, { body: 'Commenting does not erase my opt-out.' }, bob);
    assert.deepEqual(store.subscriptionStatus(task.id, bob.principalId), optedOut);
    const explicit = membership(store, task.id, bob.principalId, 'subscribe', alice);
    assert.equal(explicit.version, 3); assert.equal(explicit.subscribed, true);
    history = store.taskHistory(task.id).transactions;
    assert.deepEqual(history[0]!.subscription, { principalId: bob.principalId, oldState: 'unsubscribed', newState: 'subscribed', membershipVersion: 3, reason: 'explicit' });
    assert.deepEqual(history[0]!.attribution, alice, 'the member was added by Alice; this is not recorded as Bob consenting');
    assert.deepEqual(store.taskDetail(task.id).task, before); assert.equal(epoch(store), initialEpoch);
    const unchanged = snapshot(store); assert.deepEqual(membership(store, task.id, bob.principalId, 'subscribe'), explicit); assert.deepEqual(snapshot(store), unchanged);
    const neverSubscribed = membership(store, task.id, 'charlie', 'unsubscribe', bob);
    assert.equal(neverSubscribed.version, 1); assert.equal(neverSubscribed.state, 'unsubscribed', 'unsubscribing an absent member records durable intent');
  } finally { store.close(); }
});

test('owner changes share field history and epoch updates; former owner is explicitly subscribed and automatic owners cannot unsubscribe', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const task = create(store); const initialEpoch = epoch(store);
    const tombstone = membership(store, task.id, bob.principalId, 'unsubscribe', bob);
    const assigned = store.updateTask(task.id, { expectedVersion: 1, ownerId: bob.principalId, priority: 'high' }, alice);
    assert.equal(assigned.version, 2); assert.equal(assigned.authorId, alice.principalId); assert.equal(epoch(store), initialEpoch + 1);
    const assignment = store.taskHistory(task.id).transactions[0]!;
    assert.deepEqual(assignment.changes, [{ field: 'priority', oldValue: 'normal', newValue: 'high' }, { field: 'ownerId', oldValue: null, newValue: bob.principalId }]);
    assert.deepEqual(store.subscriptionStatus(task.id, bob.principalId), { ...tombstone, automatic: true, subscribed: true });
    assert.throws(() => membership(store, task.id, bob.principalId, 'unsubscribe', bob), status(409));
    store.createTaskComment(task.id, { body: 'Owner comments do not change explicit preferences.' }, bob);
    assert.equal(store.subscriptionStatus(task.id, bob.principalId).version, tombstone.version);
    const same = snapshot(store); store.updateTask(task.id, { expectedVersion: 2, ownerId: bob.principalId }, alice); assert.deepEqual(snapshot(store), same);
    const unassigned = store.updateTask(task.id, { expectedVersion: 2, ownerId: null }, alice);
    assert.equal(unassigned.version, 3); assert.equal(unassigned.ownerId, null); assert.equal(unassigned.authorId, alice.principalId);
    assert.equal(epoch(store), initialEpoch + 2);
    const former = store.subscriptionStatus(task.id, bob.principalId);
    assert.equal(former.state, 'subscribed'); assert.equal(former.version, tombstone.version + 1); assert.equal(former.automatic, false);
    const effect = store.taskHistory(task.id).transactions[0]!;
    assert.equal(effect.subscription?.reason, 'former_owner'); assert.equal(effect.subscription?.oldState, 'unsubscribed'); assert.deepEqual(effect.attribution, alice);
    assert.equal(effect.taskVersion, unassigned.version);
    assert.deepEqual(store.taskHistory(task.id).transactions[1]!.changes, [{ field: 'ownerId', oldValue: bob.principalId, newValue: null }]);
    assert.throws(() => store.updateTask(task.id, { expectedVersion: 2, ownerId: 'charlie' }, bob), status(409));
  } finally { store.close(); }
});

test('effective subscriber pages are bounded, ordered and deduplicated, with independent viewer state and durable tombstones', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const task = create(store, 'member025');
    for (let index = 0; index < 105; index++) membership(store, task.id, `member${String(index).padStart(3, '0')}`, 'subscribe');
    membership(store, task.id, 'member005', 'unsubscribe');
    const all = ['alice', ...Array.from({ length: 105 }, (_, index) => `member${String(index).padStart(3, '0')}`).filter(id => id !== 'member005')];
    const first = store.taskSubscriptions(task.id, 'outsider'); assert.equal(first.subscribers.length, 50);
    assert.equal(first.viewer.state, null); assert.equal(first.viewer.version, 0); assert.equal(first.viewer.subscribed, false);
    const collected: string[] = []; let cursor: string | undefined;
    do {
      const page = store.taskSubscriptions(task.id, 'member025', cursor, 17);
      assert.equal(page.viewer.automatic, true); assert.equal(page.viewer.subscribed, true);
      collected.push(...page.subscribers.map(item => item.principalId)); cursor = page.nextAfter ?? undefined;
    } while (cursor !== undefined);
    assert.deepEqual(collected, all); assert.equal(new Set(collected).size, collected.length);
    const outsidePage = store.taskSubscriptions(task.id, 'member005', 'member099', 2);
    assert.equal(outsidePage.viewer.state, 'unsubscribed'); assert.equal(outsidePage.viewer.version, 2);
    assert.deepEqual(outsidePage.subscribers.map(item => item.principalId), ['member100', 'member101']);
    assert.deepEqual(store.taskSubscriptions(task.id, 'alice', 'zzz').subscribers, []);
    for (const limit of [0, -1, 1.5, 101]) assert.throws(() => store.taskSubscriptions(task.id, 'alice', undefined, limit), status(400));
    for (const after of ['', 'bad cursor', 'x'.repeat(129)]) assert.throws(() => store.taskSubscriptions(task.id, 'alice', after), status(400));
  } finally { store.close(); }
});

test('membership CAS is independent per principal and survives restart/idempotency without duplicate automatic effects', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-membership-retry-')); const path = join(directory, 'workspace.sqlite');
  let first = new Store({ path }); let second = new Store({ path });
  try {
    const task = create(first); const input = { principalId: bob.principalId, action: 'subscribe', expectedMembershipVersion: 0 };
    const response = first.mutate('member-once', 'member-fingerprint', () => ({ status: 200, body: first.updateTaskSubscription(task.id, input, alice) }));
    second.updateTaskSubscription(task.id, { principalId: 'charlie', action: 'subscribe', expectedMembershipVersion: 0 }, bob);
    assert.throws(() => second.updateTaskSubscription(task.id, input, bob), status(409));
    membership(second, task.id, bob.principalId, 'unsubscribe', bob);
    const comment = first.mutate('comment-once', 'comment-fingerprint', () => ({ status: 201, body: first.createTaskComment(task.id, { body: 'Remain opted out.' }, bob) }));
    const before = snapshot(first); second.close(); first.close(); first = new Store({ path }); second = new Store({ path });
    assert.deepEqual(snapshot(first), before);
    assert.deepEqual(first.mutate('member-once', 'member-fingerprint', () => { throw new Error('Must not resubscribe'); }), response);
    assert.deepEqual(first.mutate('comment-once', 'comment-fingerprint', () => { throw new Error('Must not duplicate comment'); }), comment);
    assert.equal(first.subscriptionStatus(task.id, bob.principalId).state, 'unsubscribed');
    assert.deepEqual(snapshot(first), before);
    assert.throws(() => first.mutate('member-once', 'different', () => ({ status: 200, body: {} })), status(409));
    for (const changed of [{ expectedMembershipVersion: -1 }, { expectedMembershipVersion: 0.5 }, { expectedMembershipVersion: Number.MAX_SAFE_INTEGER + 1 }, { principalId: '' }, { principalId: 'space in ID' }, { action: 'toggle' }, { state: 'subscribed' }]) assert.throws(() => first.updateTaskSubscription(task.id, { ...input, ...changed }, alice), status(400));
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('membership, owner, policy epoch, history, activity and replay failures roll back as one operation', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const task = create(store, bob.principalId); let before = snapshot(store);
    store.database.exec("CREATE TRIGGER fail_membership BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data, '$.subscription.reason') = 'former_owner' BEGIN SELECT RAISE(ABORT, 'Injected former-owner failure'); END;");
    assert.throws(() => store.mutate('failed-handoff', 'fingerprint', () => ({ status: 200, body: store.updateTask(task.id, { expectedVersion: 1, ownerId: null }, alice) })), /Injected/);
    assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_membership');
    store.database.exec("CREATE TRIGGER fail_membership BEFORE INSERT ON activity WHEN json_extract(NEW.data, '$.action') = 'subscription_changed' BEGIN SELECT RAISE(ABORT, 'Injected membership activity failure'); END;");
    assert.throws(() => create(store), /Injected/); assert.deepEqual(snapshot(store), before);
    assert.throws(() => membership(store, task.id, 'charlie', 'subscribe'), /Injected/); assert.deepEqual(snapshot(store), before);
    store.database.exec('DROP TRIGGER fail_membership');
    store.database.exec("CREATE TRIGGER fail_membership BEFORE INSERT ON task_transactions WHEN json_extract(NEW.data, '$.kind') = 'comment' BEGIN SELECT RAISE(ABORT, 'Injected comment failure'); END;");
    assert.throws(() => store.createTaskComment(task.id, { body: 'No partial implicit subscription.' }, { ...bob, principalId: 'charlie' }), /Injected/);
    assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_membership');
    store.database.prepare('UPDATE task_subscriptions SET version = ? WHERE task_id = ? AND principal_id = ?').run(Number.MAX_SAFE_INTEGER, task.id, alice.principalId);
    before = snapshot(store); assert.throws(() => membership(store, task.id, alice.principalId, 'unsubscribe'), status(409)); assert.deepEqual(snapshot(store), before);
    store.database.prepare("UPDATE policy_meta SET value = ? WHERE name = 'epoch'").run(Number.MAX_SAFE_INTEGER);
    before = snapshot(store); assert.throws(() => store.updateTask(task.id, { expectedVersion: 1, ownerId: 'charlie' }, alice), status(409)); assert.deepEqual(snapshot(store), before);
  } finally { store.close(); }
});

test('membership writes acquire the writer lock before reading opt-out and CAS state', { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-membership-lock-')); const path = join(directory, 'workspace.sqlite');
  const store = new Store({ path }); let worker: Worker | undefined;
  try {
    const task = create(store);
    worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(`
      import { parentPort, workerData } from 'node:worker_threads';
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE');
      db.prepare('INSERT INTO task_subscriptions (task_id, principal_id, state, version, updated_at) VALUES (?, ?, ?, ?, ?)').run(workerData.id, 'bob', 'unsubscribed', 1, new Date().toISOString());
      parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.close(); }); parentPort.postMessage('locked');
    `)}`), { workerData: { path, id: task.id } });
    assert.deepEqual(await once(worker, 'message'), ['locked']);
    const prepare = store.database.prepare.bind(store.database); let waited = 0;
    store.database.prepare = (sql: string) => { if (sql === "UPDATE sequences SET value = value WHERE name = 'task'") { waited++; worker!.postMessage('commit'); } return prepare(sql); };
    try { assert.throws(() => store.updateTaskSubscription(task.id, { principalId: 'bob', action: 'subscribe', expectedMembershipVersion: 0 }, alice), status(409)); assert.equal(waited, 1); }
    finally { store.database.prepare = prepare; }
    const optedOut = store.subscriptionStatus(task.id, bob.principalId);
    store.createTaskComment(task.id, { body: 'I remain opted out after a concurrent update.' }, bob);
    assert.deepEqual(store.subscriptionStatus(task.id, bob.principalId), optedOut);
    assert.equal(store.taskHistory(task.id).transactions.filter(item => item.subscription?.principalId === bob.principalId).length, 0);
  } finally { if (worker) await worker.terminate(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('explicit owner transfer preserves authors and prior preferences, records normal effects, and composes atomically with an operator transaction', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const local = { ...alice, principalId: 'local:workspace', displayName: 'You' };
    const operator = { principalId: 'operator:transfer', displayName: 'Workspace operator', credentialId: null, requestId: 'handoff' };
    const first = store.createTask({ title: 'First local owner', ownerId: local.principalId }, bob);
    const second = store.createTask({ title: 'Second local owner', ownerId: local.principalId }, alice);
    const other = store.createTask({ title: 'Other owner', ownerId: bob.principalId }, local);
    membership(store, first.id, 'unrelated', 'unsubscribe', local);
    const before = snapshot(store);
    store.database.exec(`CREATE TRIGGER fail_handoff BEFORE INSERT ON task_transactions WHEN NEW.task_id = '${second.id}' AND json_extract(NEW.data, '$.kind') = 'edit' BEGIN SELECT RAISE(ABORT, 'Injected handoff failure'); END;`);
    assert.throws(() => store.transaction(() => store.transferTaskOwners(local.principalId, alice.principalId, operator)), /Injected/);
    assert.deepEqual(snapshot(store), before); store.database.exec('DROP TRIGGER fail_handoff');
    const initialEpoch = epoch(store);
    assert.equal(store.transaction(() => store.transferTaskOwners(local.principalId, alice.principalId, operator)), 2);
    assert.equal(epoch(store), initialEpoch + 2);
    assert.equal(store.taskDetail(first.id).task.authorId, bob.principalId); assert.equal(store.taskDetail(second.id).task.authorId, alice.principalId);
    assert.deepEqual(store.taskDetail(other.id).task, other);
    assert.equal(store.subscriptionStatus(first.id, 'unrelated').state, 'unsubscribed');
    const former = store.taskHistory(first.id).transactions[0]!;
    assert.equal(former.subscription?.principalId, local.principalId); assert.equal(former.subscription?.reason, 'former_owner'); assert.deepEqual(former.attribution, operator);
    assert.equal(store.subscriptionStatus(first.id, alice.principalId).automatic, true); assert.equal(store.subscriptionStatus(first.id, alice.principalId).state, null);
    assert.equal(store.transferTaskOwners(local.principalId, alice.principalId, operator), 0);
    assert.equal(store.transferTaskOwners(alice.principalId, alice.principalId, operator), 0);
  } finally { store.close(); }
});

test('mutation presentation distinguishes a fresh owner handoff from disclosure of its preserved historical replay', () => {
  const store = new Store({ path: ':memory:' });
  try {
    const task = create(store, alice.principalId); const flags: boolean[] = [];
    const present = (response: { status: number; body: unknown }, replayed: boolean) => {
      flags.push(replayed);
      if (replayed) throw new Error('Current access denied before replay disclosure');
      return { status: response.status, body: { id: task.id, saved: true, accessLost: true, accessEpoch: epoch(store) } };
    };
    const response = store.mutate('handoff', 'same-input', () => ({ status: 200, body: store.updateTask(task.id, { expectedVersion: 1, ownerId: bob.principalId }, alice) }), undefined, present);
    assert.equal((response.body as { accessLost: boolean }).accessLost, true); assert.equal(store.taskDetail(task.id).task.ownerId, bob.principalId);
    const before = snapshot(store);
    assert.throws(() => store.mutate('handoff', 'same-input', () => { throw new Error('Must not repeat handoff'); }, undefined, present), /Current access denied/);
    assert.deepEqual(flags, [false, true]); assert.deepEqual(snapshot(store), before);
    assert.equal((store.replay('handoff', 'same-input')!.body as { ownerId: string }).ownerId, bob.principalId, 'presentation never rewrites preserved response bytes');
  } finally { store.close(); }
});

function schemaSeven(path: string): { tasks: TaskSnapshot[]; histories: string[]; replay: string } {
  const db = new DatabaseSync(path); const now = '2026-10-01T12:00:00.000Z';
  const tasks: TaskSnapshot[] = Array.from({ length: 4 }, (_, index) => ({ id: `T${index + 1}`, title: `Known task ${index + 1}`, description: 'Historical content.', status: 'open', priority: 'normal', projectId: null, version: index === 0 ? 2 : 1, createdAt: now, updatedAt: now }));
  const histories: string[] = [];
  try {
    // Historical schema 7 is built directly, including earlier immutable tables.
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
      INSERT INTO sequences (name, value) VALUES ('task', 4);
    `);
    tasks.forEach((task, index) => {
      db.prepare('INSERT INTO entities (id, kind, data) VALUES (?, ?, ?)').run(task.id, 'task', JSON.stringify(task, null, 2));
      const transaction: TaskTransaction = { id: `create-${task.id}`, taskId: task.id, sequence: 1, taskVersion: 1, kind: index === 1 ? 'legacy' : 'create', actor: index === 1 ? null : alice.displayName, createdAt: now,
        snapshot: { ...task, version: 1, ...(index === 3 ? { id: 'T999' } : {}) }, ...(index === 2 ? {} : { attribution: alice }) };
      const data = JSON.stringify(transaction, null, 2); histories.push(data);
      db.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(transaction.id, task.id, 1, 1, data);
      if (index === 0) {
        const edit: TaskTransaction = { id: 'edit-T1', taskId: task.id, sequence: 2, taskVersion: 2, kind: 'edit', actor: bob.displayName, attribution: bob, createdAt: now, changes: [{ field: 'title', oldValue: 'Earlier title', newValue: task.title }] };
        const edited = JSON.stringify(edit, null, 2); histories.push(edited);
        db.prepare('INSERT INTO task_transactions (id, task_id, sequence, task_version, data) VALUES (?, ?, ?, ?, ?)').run(edit.id, task.id, 2, 2, edited);
      }
    });
    const replay = JSON.stringify(tasks[0], null, 2);
    db.prepare('INSERT INTO idempotency (key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?)').run('old-task', 'old-fingerprint', 200, replay, now);
    initializePolicies(db); db.exec('PRAGMA user_version = 7');
    return { tasks, histories, replay };
  } finally { db.close(); }
}

test('schema 8 migration recovers only proven original authors, preserves task versions and byte-exact history/replays, and creates no inferred subscribers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-membership-migration-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaSeven(path); let store = new Store({ path });
  try {
    assert.equal((store.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    old.tasks.forEach((task, index) => assert.deepEqual(store.taskDetail(task.id).task, { ...task, ownerId: null, authorId: index === 0 ? alice.principalId : null }));
    const historyBytes = () => (store.database.prepare('SELECT data FROM task_transactions ORDER BY rowid').all() as { data: string }[]).map(row => row.data);
    assert.deepEqual(historyBytes(), old.histories);
    assert.equal(store.database.prepare('SELECT * FROM task_subscriptions').all().length, 0);
    assert.deepEqual(store.taskSubscriptions('T1', alice.principalId).subscribers, []);
    assert.equal((store.database.prepare('SELECT body FROM idempotency WHERE key = ?').get('old-task') as { body: string }).body, old.replay);
    assert.deepEqual(store.replay('old-task', 'old-fingerprint')!.body, old.tasks[0]);
    store.close(); store = new Store({ path }); assert.deepEqual(historyBytes(), old.histories);
    const edited = store.updateTask('T1', { expectedVersion: 2, ownerId: bob.principalId }, alice);
    assert.equal(edited.version, 3); assert.equal(edited.authorId, alice.principalId); assert.equal(edited.ownerId, bob.principalId);
    assert.deepEqual(historyBytes().slice(0, old.histories.length), old.histories);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema 8 migration failure rolls back metadata and tables without damaging schema 7 history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'phab-membership-migration-failure-')); const path = join(directory, 'workspace.sqlite');
  const old = schemaSeven(path); let database = new DatabaseSync(path);
  try {
    database.exec("CREATE TRIGGER fail_metadata BEFORE UPDATE ON entities WHEN NEW.id = 'T1' BEGIN SELECT RAISE(ABORT, 'Injected metadata failure'); END;"); database.close();
    assert.throws(() => new Store({ path }), /Injected metadata failure/);
    database = new DatabaseSync(path);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
    old.tasks.forEach(task => assert.deepEqual(JSON.parse((database.prepare('SELECT data FROM entities WHERE id = ?').get(task.id) as { data: string }).data), task));
    assert.deepEqual((database.prepare('SELECT data FROM task_transactions ORDER BY rowid').all() as { data: string }[]).map(row => row.data), old.histories);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_subscriptions'").get(), undefined);
    database.exec('DROP TRIGGER fail_metadata'); const store = new Store({ path });
    try { assert.equal(store.taskDetail('T1').task.authorId, alice.principalId); } finally { store.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
