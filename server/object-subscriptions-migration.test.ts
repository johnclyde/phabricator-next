import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeObjectSubscriptions, ObjectSubscriptionStore } from './object-subscriptions.ts';
import type { ActorAttribution } from '../shared/types.ts';

const actor: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'fixture' };
function baseline(db: DatabaseSync) {
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA user_version=32;
    CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE policy_meta(name TEXT PRIMARY KEY,value INTEGER); INSERT INTO policy_meta VALUES('epoch',1);
    CREATE TABLE paste_transactions(id TEXT PRIMARY KEY,paste_id TEXT,sequence INTEGER,paste_version INTEGER,content_version INTEGER,data TEXT);
    CREATE TABLE legacy_receipts(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE VIEW operator_view AS SELECT id FROM entities;
    CREATE INDEX operator_index ON entities(kind);
    CREATE TRIGGER operator_identity BEFORE UPDATE OF id ON entities BEGIN SELECT RAISE(ABORT,'identity'); END;
  `);
  db.prepare("INSERT INTO entities VALUES('W1','document',?)").run('{"id":"W1","version":1,"content":"\\ufeffold\\r\\nsource","operator_data":{"exact":"preserved"}}');
  db.prepare('INSERT INTO legacy_receipts VALUES(?,?)').run('old-key', '{"revisionId":"P1","projectId":"PROJ1","accessEpoch":13}');
}
function contents(db: DatabaseSync) { return Object.fromEntries((db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])); }
const schema = (db: DatabaseSync) => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
function migrate(db: DatabaseSync) { db.exec('BEGIN IMMEDIATE'); try { initializeObjectSubscriptions(db); db.exec('PRAGMA user_version=33; COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }

test('schema33 object following is additive, restartable and leaves every existing row, schema object and old receipt byte intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'object-subscriptions-migration-')), path = join(directory, 'db.sqlite'); let db = new DatabaseSync(path);
  try {
    baseline(db); const rows = contents(db), oldSchema = schema(db); migrate(db);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 33);
    for (const [table, original] of Object.entries(rows)) assert.deepEqual(contents(db)[table], original, table);
    for (const value of oldSchema) assert.ok(schema(db).some(current => JSON.stringify(current) === JSON.stringify(value)));
    const newTables = Object.keys(contents(db)).filter(name => !(name in rows)); assert.deepEqual(newTables, ['object_mute_transactions', 'object_mutes', 'object_subscription_operations', 'object_subscription_transactions', 'object_subscriptions']);
    for (const name of newTables) assert.deepEqual(contents(db)[name], [], 'no historical subscriptions or notification backfill');
    const store = new ObjectSubscriptionStore(db), receipt = store.mutate('W1', { action: 'subscribe', principalId: actor.principalId, expectedSubscriptionVersion: 0, expectedAccessEpoch: 1 }, actor, actor, '1'.repeat(64));
    const after = contents(db), afterSchema = schema(db); initializeObjectSubscriptions(db); assert.deepEqual(contents(db), after); assert.deepEqual(schema(db), afterSchema);
    db.close(); db = new DatabaseSync(path); initializeObjectSubscriptions(db); assert.deepEqual(contents(db), after); assert.deepEqual(new ObjectSubscriptionStore(db).operation(receipt.operationId).receipt, receipt);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unknown, same-column and named index/trigger collisions fail the whole migration without adopting operator schema', () => {
  const collisions = [
    'CREATE TABLE object_subscriptions(operator_note TEXT); INSERT INTO object_subscriptions VALUES(\'preserve\')',
    'CREATE TABLE object_mutes(object_id TEXT,principal_id TEXT,version INTEGER,data TEXT)',
    'CREATE INDEX object_subscription_operations_no_update ON entities(kind)',
    "CREATE TRIGGER object_mutes_no_delete BEFORE DELETE ON entities BEGIN SELECT RAISE(ABORT,'operator'); END",
    'CREATE TABLE object_subscriptions_extra(operator_note TEXT)'
  ];
  for (const collision of collisions) {
    const db = new DatabaseSync(':memory:'); try {
      baseline(db); db.exec(collision); const before = contents(db), beforeSchema = schema(db);
      assert.throws(() => migrate(db), /Conflicting object subscription schema/);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 32); assert.deepEqual(contents(db), before); assert.deepEqual(schema(db), beforeSchema);
    } finally { db.close(); }
  }
});

test('an outer migration failure rolls back every new table and leaves the previous schema fence', () => {
  const db = new DatabaseSync(':memory:'); try {
    baseline(db); const rows = contents(db), oldSchema = schema(db); db.exec('BEGIN IMMEDIATE'); initializeObjectSubscriptions(db);
    assert.throws(() => db.exec('INSERT INTO deliberately_missing_table VALUES(1)'), /no such table/); db.exec('ROLLBACK');
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 32); assert.deepEqual(contents(db), rows); assert.deepEqual(schema(db), oldSchema);
  } finally { db.close(); }
});
