import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { initializeNotifications, initializeNotificationSuiteTargets, NotificationStore } from './notifications.ts';
import { initializeSuite } from './suite.ts';
const actor = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'migration' };
const recipient = { ...actor, principalId: 'bob', displayName: 'Bob' };
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE entities(id TEXT PRIMARY KEY); INSERT INTO entities VALUES('T1'); CREATE TABLE policy_meta(name TEXT PRIMARY KEY,value INTEGER); INSERT INTO policy_meta VALUES('epoch',1)");
  initializeSuite(db); initializeNotifications(db);
  const store = new NotificationStore(db, { revision: () => { throw new Error('Unused'); }, task: () => ({ title: 'Original', version: 1 }), recipients: () => ({ recipients: ['bob'], muted: [] }) });
  store.configure({ eligible: () => true, canView: () => true }); store.emit({ objectId: 'T1', kind: 'task_updated', attribution: actor, cause: { type: 'original', id: 'original' } });
  const item = store.list('bob', {}, 1).items[0]!; const receipt = store.mutate('bob', { action: 'read', notificationId: item.id, expectedVersion: 0, expectedAccessEpoch: 1 }, recipient, 'a'.repeat(64));
  db.exec("UPDATE sqlite_sequence SET rowid=17,seq=91 WHERE name='notification_deliveries'");
  return { db, store, receipt, item };
}
function snapshot(db: DatabaseSync) { const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(); const tables = schema.filter(row => row.type === 'table').map(row => String(row.name)); return { schema, data: Object.fromEntries([...tables, 'sqlite_sequence'].map(name => [name, db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])) }; }
test('suite notification migration preserves historical bytes, rowids, reads, sequences and exact receipts under foreign keys', () => {
  const f = fixture(); try {
    const before = snapshot(f.db); f.db.exec('BEGIN'); initializeNotificationSuiteTargets(f.db); f.db.exec('COMMIT'); const after = snapshot(f.db);
    assert.deepEqual(after.data, before.data); assert.deepEqual(f.store.operation(f.receipt.operationId).receipt, f.receipt);
    for (const object of before.schema) if (object.name !== 'notification_events') assert.deepEqual(after.schema.find(row => row.name === object.name), object);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_list(notification_events)').all(), []);
    assert.equal(f.db.prepare('PRAGMA foreign_key_list(notification_deliveries)').all()[0]!.table, 'notification_events');
    assert.equal(f.db.prepare('PRAGMA foreign_key_list(notification_read_changes)').all().length, 2);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    const stable = snapshot(f.db); initializeNotificationSuiteTargets(f.db); initializeNotifications(f.db); assert.deepEqual(snapshot(f.db), stable);
    const id = `Z-${randomUUID()}`; f.db.prepare("INSERT INTO suite_records(id,app,kind,data) VALUES(?,'conpherence','room','{}')").run(id);
    f.db.prepare('INSERT INTO notification_events(id,revision_id,cause_type,cause_id,data) VALUES(?,?,?,?,?)').run(randomUUID(), id, 'suite_transaction', '1', '{}');
    assert.throws(() => f.db.prepare('INSERT INTO notification_events(id,revision_id,cause_type,cause_id,data) VALUES(?,?,?,?,?)').run(randomUUID(), 'missing', 'suite_transaction', '2', '{}'), /does not exist/);
    f.store.emit({ objectId: 'T1', kind: 'task_updated', attribution: actor, cause: { type: 'later', id: 'later' } });
    assert.equal(f.db.prepare('SELECT max(sequence) AS n FROM notification_deliveries').get()!.n, 92);
  } finally { f.db.close(); }
});
test('suite notification migration rejects altered legacy schema and rolls back without repairing evidence', () => {
  for (const damage of ['DROP TRIGGER notification_events_no_update; CREATE TRIGGER notification_events_no_update BEFORE UPDATE ON notification_events BEGIN SELECT 1; END', 'CREATE INDEX notification_unknown_index ON notification_events(cause_id)']) {
    const f = fixture(); try { f.db.exec(damage); const before = snapshot(f.db); assert.throws(() => initializeNotificationSuiteTargets(f.db), /Unexpected/); assert.deepEqual(snapshot(f.db), before); } finally { f.db.close(); }
  }
});
test('failed copy restores the original schema and every row, including cursor secret and sqlite sequence', () => {
  const f = fixture(); try {
    f.db.exec("PRAGMA foreign_keys=OFF; DELETE FROM entities WHERE id='T1'; PRAGMA foreign_keys=ON");
    const before = snapshot(f.db); assert.throws(() => initializeNotificationSuiteTargets(f.db), /target does not exist/); assert.deepEqual(snapshot(f.db), before);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_temp_schema WHERE name LIKE 'suite_backup_%'").get()!.n, 0);
    assert.equal(f.db.prepare('PRAGMA foreign_key_list(notification_events)').all()[0]!.table, 'entities');
  } finally { f.db.close(); }
});
test('unexpected foreign key dependents reject migration without dropping their data', () => {
  const f = fixture(); try { f.db.exec('CREATE TABLE private_extension(id TEXT PRIMARY KEY,event_id TEXT REFERENCES notification_events(id))'); const before = snapshot(f.db); assert.throws(() => initializeNotificationSuiteTargets(f.db), /dependency/); assert.deepEqual(snapshot(f.db), before); } finally { f.db.close(); }
});

test('empty original deliveries preserve absent sequence rows without manufacturing seq zero', () => {
  const db = new DatabaseSync(':memory:'); try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE entities(id TEXT PRIMARY KEY)'); initializeSuite(db); initializeNotifications(db);
    const before = snapshot(db); initializeNotificationSuiteTargets(db); assert.deepEqual(snapshot(db).data, before.data); assert.equal(db.prepare("SELECT 1 FROM sqlite_sequence WHERE name='notification_deliveries'").get(), undefined);
  } finally { db.close(); }
});

test('operator-named triggers and indexes attached to rebuilt tables are never silently dropped', () => {
  for (const extension of ['CREATE INDEX operator_event_lookup ON notification_events(cause_id)', 'CREATE TRIGGER operator_delivery_audit AFTER INSERT ON notification_deliveries BEGIN SELECT 1; END']) {
    const f = fixture(); try { f.db.exec(extension); const before = snapshot(f.db); assert.throws(() => initializeNotificationSuiteTargets(f.db), /dependency/); assert.deepEqual(snapshot(f.db), before); } finally { f.db.close(); }
  }
});
