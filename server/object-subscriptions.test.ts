import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initializeObjectSubscriptions, ObjectSubscriptionStore, objectSubscriptionInputHash, type ObjectSubscriptionOperation } from './object-subscriptions.ts';
import { OBJECT_SUBSCRIPTION_LIMITS, objectSubscriptionInput, isObjectSubscriptionSnapshot, isObjectSubscriptionPerson, isObjectSubscriptionHistory, isObjectMuteHistory, isObjectSubscriptionStatus, isObjectSubscriptionTransaction, validObjectSubscriptionResult, type ObjectSubscriptionAction, type ObjectSubscriptionInput } from '../shared/object-subscriptions.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { PasteTransaction } from '../shared/pastes.ts';
import type { ObjectAccess } from '../shared/policy.ts';
import type { NotificationCause } from './notifications.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'alice-key', requestId: 'alice-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: 'bob-key', requestId: 'bob-request' };
const carol: ActorAttribution = { principalId: 'carol', displayName: 'Carol', credentialId: null, requestId: 'carol-request' };
const at = '2026-10-01T12:00:00.000Z';
const ref = (actor: ActorAttribution) => ({ principalId: actor.principalId, displayName: actor.displayName });
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE policy_meta(name TEXT PRIMARY KEY,value INTEGER); INSERT INTO policy_meta VALUES('epoch',1);
    CREATE TABLE paste_transactions(id TEXT PRIMARY KEY,paste_id TEXT,sequence INTEGER,paste_version INTEGER,content_version INTEGER,data TEXT);
    CREATE TABLE auth_accounts(id TEXT PRIMARY KEY,disabled INTEGER NOT NULL DEFAULT 0); INSERT INTO auth_accounts(id) VALUES('alice'),('bob'),('carol');
    CREATE TABLE auth_meta(name TEXT PRIMARY KEY,value TEXT); INSERT INTO auth_meta VALUES('workspace_id','fixture');
  `);
  for (const id of ['W1', 'W2']) db.prepare("INSERT INTO entities VALUES(?,'document',?)").run(id, JSON.stringify({ id, title: 'Wiki', content: 'Exact legacy source', version: 1 }));
  const record = { id: 'PA1', title: '', authorId: alice.principalId, version: 1, contentVersion: 1, contentHash: 'a'.repeat(64), createdAt: at, updatedAt: at };
  db.prepare("INSERT INTO entities VALUES('PA1','paste',?)").run(JSON.stringify(record));
  const create = { id: randomUUID(), pasteId: 'PA1', sequence: 1, pasteVersion: 1, contentVersion: 1, contentHash: record.contentHash, kind: 'create', createdAt: at, attribution: alice, snapshot: record };
  db.prepare('INSERT INTO paste_transactions VALUES(?,?,?,?,?,?)').run(create.id, 'PA1', 1, 1, 1, JSON.stringify(create));
  initializeObjectSubscriptions(db);
  const store = new ObjectSubscriptionStore(db);
  return { db, store, close: () => db.close() };
}
type Fixture = ReturnType<typeof fixture>;
const epoch = (f: Fixture) => f.db.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
function input(f: Fixture, id: string, action: ObjectSubscriptionAction, target = bob): ObjectSubscriptionInput {
  const s = f.store.snapshot(id, target.principalId), common = { principalId: target.principalId, expectedAccessEpoch: epoch(f) };
  return action === 'subscribe' || action === 'unsubscribe' ? { action, ...common, expectedSubscriptionVersion: s.viewer.version } : { action, ...common, expectedMuteVersion: s.mute.version };
}
function act(f: Fixture, id: string, action: ObjectSubscriptionAction, actor = bob, target = actor, key: string | null = null) { return f.store.mutate(id, input(f, id, action, target), actor, ref(target), key); }
function tables(db: DatabaseSync) { return Object.fromEntries((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])); }
function comment(f: Fixture, actor = bob): PasteTransaction {
  const next = Number(f.db.prepare("SELECT max(sequence) AS n FROM paste_transactions WHERE paste_id='PA1'").get()!.n) + 1;
  const value: PasteTransaction = { id: randomUUID(), pasteId: 'PA1', sequence: next, pasteVersion: 1, contentVersion: 1, contentHash: 'a'.repeat(64), kind: 'comment', createdAt: at, attribution: actor, comment: 'A source-bound comment.' };
  f.db.prepare('INSERT INTO paste_transactions VALUES(?,?,?,?,?,?)').run(value.id, value.pasteId, next, 1, 1, JSON.stringify(value)); return value;
}
const access = (id: string): ObjectAccess => ({ policy: { objectId: id, version: 1, spaceId: 'S1', rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' });

test('Wiki has no automatic author; Paste immutable author remains following independently of explicit edges and mute', () => {
  const f = fixture(); try {
    const source = f.db.prepare('SELECT * FROM entities ORDER BY id').all();
    assert.deepEqual(f.store.snapshot('W1', alice.principalId).subscribers, []);
    const initial = f.store.snapshot('PA1', alice.principalId); assert.deepEqual(initial.viewer.automatic, ['author']); assert.equal(initial.viewer.following, true); assert.equal(initial.subscriptionVersion, 0);
    for (const action of ['subscribe', 'unsubscribe'] as const) assert.throws(() => act(f, 'PA1', action, alice), { code: 'OBJECT_SUBSCRIPTION_AUTOMATIC' });
    act(f, 'PA1', 'unsubscribe', bob, alice); assert.equal(f.store.status('PA1', alice.principalId).state, 'unsubscribed'); assert.equal(f.store.effective('PA1', alice.principalId), true);
    const before = f.store.history('PA1'); act(f, 'PA1', 'mute', alice); assert.deepEqual(f.store.deliveryPreferences('PA1'), { recipients: ['alice'], muted: ['alice'] }); assert.deepEqual(f.store.history('PA1'), before);
    act(f, 'W1', 'subscribe'); act(f, 'PA1', 'subscribe'); assert.deepEqual(f.store.deliveryPreferences('PA1'), { recipients: ['alice', 'bob'], muted: ['alice'] });
    assert.deepEqual(f.db.prepare('SELECT * FROM entities ORDER BY id').all(), source);
  } finally { f.close(); }
});

test('per-person pins ignore source edits; independent subscriptions and personal mute do not advance each other', () => {
  const f = fixture(); try {
    const pending = input(f, 'W1', 'subscribe'); act(f, 'W1', 'subscribe', carol);
    f.db.prepare("UPDATE entities SET data=json_set(data,'$.title','Changed published title','$.version',2) WHERE id='W1'").run();
    const receipt = f.store.mutate('W1', pending, bob, ref(bob)); assert.equal(receipt.changed, true);
    const before = f.store.history('W1'); act(f, 'W1', 'mute'); assert.deepEqual(f.store.history('W1'), before);
    assert.throws(() => f.store.mutate('W1', pending, bob), { code: 'OBJECT_SUBSCRIPTION_CHANGED' });
    const valid = input(f, 'W1', 'unsubscribe'), rows = tables(f.db);
    for (const value of [{ ...valid, expectedAccessEpoch: 2 }, { ...valid, expectedSubscriptionVersion: 999 }]) { assert.throws(() => f.store.mutate('W1', value, bob), { status: 409 }); assert.deepEqual(tables(f.db), rows); }
    assert.throws(() => act(f, 'W1', 'mute', alice, bob), { status: 403 });
    assert.throws(() => f.store.mutate('W1', valid, { ...bob, principalId: '' }), { status: 400 });
    assert.throws(() => f.store.snapshot('T1', bob.principalId), { status: 404 });
  } finally { f.close(); }
});

test('changed and no-effect operations retain exact proof and scoped-key identity after later source, name and preference changes', () => {
  const f = fixture(); try {
    const firstInput = input(f, 'W1', 'unmute'), baseline = f.store.mutate('W1', firstInput, bob, ref(bob), '1'.repeat(64)); assert.equal(baseline.changed, false);
    act(f, 'W1', 'subscribe'); const request = input(f, 'W1', 'subscribe');
    const rows = tables(f.db), first = f.store.mutate('W1', request, bob, ref(bob), '2'.repeat(64)); assert.equal(first.changed, false);
    for (const [name, value] of Object.entries(rows)) if (name !== 'object_subscription_operations') assert.deepEqual(tables(f.db)[name], value, name);
    act(f, 'W1', 'subscribe', carol); const later = f.store.mutate('W1', request, bob, ref(bob), '3'.repeat(64));
    assert.equal(first.kind, 'subscription'); assert.equal(later.kind, 'subscription'); if (first.kind === 'subscription' && later.kind === 'subscription') assert.equal(later.subscriptionVersion, first.subscriptionVersion + 1);
    act(f, 'W1', 'unsubscribe'); act(f, 'W1', 'mute');
    f.db.prepare("UPDATE entities SET data=json_set(data,'$.title','Later title','$.content','Later body') WHERE id='W1'").run();
    f.db.prepare("UPDATE auth_accounts SET disabled=1 WHERE id='bob'").run();
    for (const receipt of [baseline, first, later]) assert.deepEqual(f.store.operation(receipt.operationId).receipt, receipt);
    assert.equal(f.store.operation(first.operationId).retryKeySha256, '2'.repeat(64)); assert.equal(f.store.operationPrincipalId(first.operationId), bob.principalId); assert.equal(f.store.operationObjectId(first.operationId), 'W1');
    assert.ok(validObjectSubscriptionResult(first, 'W1', request, bob.principalId)); assert.equal(first.inputSha256, objectSubscriptionInputHash(request));
  } finally { f.close(); }
});

test('only new eligible Paste commenters with untouched preferences implicitly follow; no duplicates or optout override', () => {
  const f = fixture(); try {
    const first = comment(f); f.store.implicitComment(first); const history = f.store.history('PA1'); assert.equal(history.transactions.length, 1); assert.equal(history.transactions[0]!.commentId, first.id); assert.equal(history.transactions[0]!.reason, 'comment');
    f.store.implicitComment(first); assert.deepEqual(f.store.history('PA1'), history);
    act(f, 'PA1', 'unsubscribe'); f.store.implicitComment(comment(f)); assert.equal(f.store.effective('PA1', bob.principalId), false);
    act(f, 'PA1', 'unsubscribe', carol); f.store.implicitComment(comment(f, carol)); assert.equal(f.store.effective('PA1', carol.principalId), false);
    const count = f.store.history('PA1').subscriptionVersion;
    for (const actor of [alice, { ...bob, principalId: 'system:bot' }, { ...bob, principalId: 'missing' }]) f.store.implicitComment(comment(f, actor));
    assert.equal(f.store.history('PA1').subscriptionVersion, count);
    f.db.prepare("UPDATE auth_accounts SET disabled=1 WHERE id='bob'").run(); assert.deepEqual(f.store.history('PA1').transactions.at(-1), history.transactions[0], 'old human comment evidence remains valid after account retirement');
    const local = { ...bob, principalId: 'local:fixture' }; f.store.implicitComment(comment(f, local)); assert.equal(f.store.effective('PA1', local.principalId), true);
    f.db.prepare("UPDATE auth_accounts SET disabled=0 WHERE id='bob'").run();
    const tampered = { ...first, comment: 'Changed submitted body' }; assert.throws(() => f.store.implicitComment(tampered), { code: 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT' });
  } finally { f.close(); }
});

test('public history and pages are bounded, pinned and ordered without private mute counters', () => {
  const f = fixture(); try {
    for (const target of [carol, bob]) act(f, 'PA1', 'subscribe', alice, target);
    const first = f.store.snapshot('PA1', bob.principalId, { limit: 2 }), second = f.store.snapshot('PA1', bob.principalId, { after: first.nextAfter!, expectedSubscriptionVersion: first.subscriptionVersion, limit: 2 });
    assert.deepEqual(first.subscribers.map(p => p.principalId), ['alice', 'bob']); assert.deepEqual(second.subscribers.map(p => p.principalId), ['carol']); assert.equal(second.nextAfter, null);
    assert.ok(isObjectSubscriptionSnapshot({ ...first, access: access('PA1'), accessEpoch: 1 }, 'PA1', bob.principalId));
    const person = f.store.person('PA1', bob.principalId); assert.ok(isObjectSubscriptionPerson({ ...person, accessEpoch: 1 }, 'PA1', bob.principalId));
    act(f, 'PA1', 'unsubscribe'); assert.throws(() => f.store.snapshot('PA1', bob.principalId, { expectedSubscriptionVersion: first.subscriptionVersion }), { status: 409 });
    const h = f.store.history('PA1', { limit: 2 }); assert.deepEqual(h.transactions.map(t => t.subscriptionVersion), [3, 2]); assert.deepEqual(f.store.history('PA1', { before: h.nextBefore! }).transactions.map(t => t.subscriptionVersion), [1]); assert.ok(isObjectSubscriptionHistory({ ...h, accessEpoch: 1 }, 'PA1'));
    for (const action of ['mute', 'unmute', 'mute'] as const) act(f, 'PA1', action);
    const m = f.store.muteHistory('PA1', bob.principalId, { limit: 2 }); assert.deepEqual(m.transactions.map(t => t.version), [3, 2]); assert.deepEqual(f.store.muteHistory('PA1', bob.principalId, { before: m.nextBefore! }).transactions.map(t => t.version), [1]); assert.ok(isObjectMuteHistory({ ...m, accessEpoch: 1 }, 'PA1', bob.principalId));
    assert.equal(f.store.history('PA1').subscriptionVersion, 3); assert.equal(f.store.muteHistory('PA1', alice.principalId).muteVersion, 0);
    for (const q of [{ limit: 0 }, { limit: 101 }, { before: 0 }]) assert.throws(() => f.store.history('PA1', q), { status: 400 });
    assert.throws(() => f.store.muteHistory('PA1', bob.principalId, { expectedMuteVersion: 1 }), { status: 409 });
  } finally { f.close(); }
});

test('only changed subscription edits to another person emit, and publisher failure rolls back all preference evidence', () => {
  const f = fixture(); try {
    const events: NotificationCause[] = []; let fail = false;
    f.store.connectNotifications(cause => { if (fail) throw new Error('Delivery rollback'); events.push(cause); });
    act(f, 'W1', 'subscribe'); act(f, 'W1', 'mute'); act(f, 'W1', 'subscribe', alice, bob); assert.equal(events.length, 0);
    act(f, 'W1', 'unsubscribe', alice, bob); assert.equal(events[0]!.kind, 'wiki_subscribers_changed');
    act(f, 'PA1', 'subscribe', alice, bob); assert.equal(events[1]!.kind, 'paste_subscribers_changed');
    const before = tables(f.db); fail = true; assert.throws(() => act(f, 'W2', 'subscribe', alice, carol), /Delivery rollback/); assert.deepEqual(tables(f.db), before);
    f.db.exec('BEGIN'); act(f, 'W1', 'unmute'); f.db.exec('ROLLBACK'); assert.deepEqual(tables(f.db), before);
    f.db.exec("CREATE TRIGGER reject_preference BEFORE INSERT ON object_subscriptions BEGIN SELECT RAISE(ABORT,'atomic comment'); END");
    const withTrigger = tables(f.db); f.db.exec('BEGIN'); try { const value = comment(f, carol); assert.throws(() => f.store.implicitComment(value), /atomic comment/); } finally { f.db.exec('ROLLBACK'); } assert.deepEqual(tables(f.db), withTrigger);
    for (const table of ['object_subscription_transactions', 'object_subscription_operations', 'object_mute_transactions']) assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  } finally { f.close(); }
});

test('operation verification rejects altered owner, headless role identity, state, counters, digest and receipt', () => {
  const f = fixture(); try {
    const receipts = [act(f, 'W1', 'subscribe'), act(f, 'W1', 'subscribe'), act(f, 'W1', 'mute'), act(f, 'W1', 'mute')];
    f.db.exec('DROP TRIGGER object_subscription_operations_no_update');
    for (const receipt of receipts) {
      const original = f.store.operation(receipt.operationId);
      const forgeries: ((v: ObjectSubscriptionOperation) => void)[] = [v => { v.objectId = 'W2'; }, v => { v.attribution.principalId = 'carol'; }, v => { v.author = ref(alice); }, v => { v.before.version++; }, v => { v.receipt.changed = !v.receipt.changed; }, v => { v.inputSha256 = 'f'.repeat(64); }, v => { v.retryKeySha256 = 'invalid'; }, v => { v.createdAt = 'invalid'; }, v => { v.subscriptionVersion = (v.subscriptionVersion ?? 0) + 1; }];
      for (const forge of forgeries) { const value = structuredClone(original); forge(value); f.db.prepare('UPDATE object_subscription_operations SET data=? WHERE id=?').run(JSON.stringify(value), original.id); assert.throws(() => f.store.operation(original.id), { code: 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT' }); }
      f.db.prepare('UPDATE object_subscription_operations SET data=? WHERE id=?').run(JSON.stringify(original), original.id); assert.deepEqual(f.store.operation(original.id), original);
    }
    assert.throws(() => f.store.operation(randomUUID()), { status: 409 });
  } finally { f.close(); }
});

test('current caches and malformed string-encoded author evidence fail closed, including delivery routing', () => {
  const f = fixture(); try {
    act(f, 'PA1', 'mute', alice); const original = f.db.prepare("SELECT data FROM object_mutes WHERE object_id='PA1'").get()!.data as string;
    f.db.prepare("UPDATE object_mutes SET data=json_set(data,'$.muted',json('false')) WHERE object_id='PA1'").run();
    for (const call of [() => f.store.snapshot('PA1', alice.principalId), () => f.store.deliveryPreferences('PA1')]) assert.throws(call, { code: 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT' });
    f.db.prepare("UPDATE object_mutes SET data=? WHERE object_id='PA1'").run(original);
    const created = f.db.prepare("SELECT id,data FROM paste_transactions WHERE json_extract(data,'$.kind')='create'").get() as { id: string; data: string };
    const value = JSON.parse(created.data); value.attribution = JSON.stringify(value.attribution); f.db.prepare('UPDATE paste_transactions SET data=? WHERE id=?').run(JSON.stringify(value), created.id);
    assert.throws(() => f.store.status('PA1', alice.principalId), { code: 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT' });
    f.db.prepare('UPDATE paste_transactions SET data=? WHERE id=?').run(created.data, created.id);
    act(f, 'W1', 'subscribe'); f.db.prepare("UPDATE object_subscriptions SET state='unsubscribed' WHERE object_id='W1'").run(); assert.throws(() => f.store.deliveryPreferences('W1'), { code: 'OBJECT_SUBSCRIPTION_INVALID_RECEIPT' });
  } finally { f.close(); }
});

test('1000 explicit identities include optouts; capacity preserves removals, private mute and otherwise valid comments', () => {
  const f = fixture(); try {
    for (let index = 0; index < OBJECT_SUBSCRIPTION_LIMITS.people; index++) {
      const target = { ...bob, principalId: `person-${String(index).padStart(4, '0')}`, displayName: `Person ${index}` };
      act(f, 'PA1', index % 2 ? 'subscribe' : 'unsubscribe', alice, target);
    }
    const before = tables(f.db); assert.throws(() => act(f, 'PA1', 'subscribe'), { code: 'OBJECT_SUBSCRIPTION_LIMIT' }); assert.deepEqual(tables(f.db), before);
    act(f, 'PA1', 'unsubscribe', alice, { ...bob, principalId: 'person-0001', displayName: 'Person 1' }); act(f, 'PA1', 'mute');
    f.store.implicitComment(comment(f)); assert.equal(f.store.status('PA1', bob.principalId).state, null);
    assert.equal(f.store.history('PA1').subscriptionVersion, OBJECT_SUBSCRIPTION_LIMITS.people + 1);
  } finally { f.close(); }
});

test('shared guards reject mixed counters, source pins, Wiki automatic followers, private ownership and inconsistent receipts', () => {
  const f = fixture(); try {
    const request = input(f, 'W1', 'subscribe');
    for (const v of [{ ...request, expectedMuteVersion: 0 }, { ...request, expectedVersion: 1 }, { ...request, action: 'watch' }, { ...request, principalId: '' }]) assert.throws(() => objectSubscriptionInput(v));
    const receipt = f.store.mutate('W1', request, bob); assert.ok(validObjectSubscriptionResult(receipt, 'W1', request, bob.principalId));
    if (receipt.kind !== 'subscription' || !receipt.transaction) throw new Error('Expected changed subscription');
    assert.equal(isObjectSubscriptionStatus({ ...receipt.status, automatic: ['author'] }, 'W1'), false);
    assert.equal(isObjectSubscriptionTransaction({ ...receipt.transaction, reason: 'comment', operationId: null, commentId: randomUUID() }), false);
    assert.equal(validObjectSubscriptionResult({ ...receipt, subscriptionVersion: 0 }, 'W1', request, bob.principalId), false);
    assert.equal(validObjectSubscriptionResult({ ...receipt, status: { ...receipt.status, displayName: 'Someone else' } }, 'W1', request, bob.principalId), false);
    const m = act(f, 'W1', 'mute'); assert.equal(validObjectSubscriptionResult(m, 'W1', input(f, 'W1', 'unmute'), alice.principalId), false);
  } finally { f.close(); }
});
