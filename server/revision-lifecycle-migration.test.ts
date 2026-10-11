import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { initializeRevisionLifecycle } from './revision-lifecycle.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const actor = { principalId: 'alice', displayName: 'Original Alice', credentialId: null, requestId: 'lifecycle-migration' };
const drop = (db: DatabaseSync) => db.exec('DROP TABLE revision_lifecycle_transactions; DROP TABLE revision_lifecycle_operations; DROP TABLE revision_lifecycle; PRAGMA user_version=25');
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}

test('schema26 preserves every schema25 row, definition and sequence with truthful observed lifecycle baselines', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-lifecycle-migrate-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    const ids: string[] = [];
    for (const status of ['draft', 'needs_review', 'changes_requested', 'accepted', 'closed'] as const) {
      const id = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: `Observed ${status}`, files: [{ path: 'source.txt', content: '\ufeffExact historical bytes\r\n' }] }, actor).revision.id; ids.push(id);
      store.database.prepare("UPDATE entities SET data=json_set(data,'$.status',?) WHERE id=?").run(status, id);
    }
    store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('historical-lifecycle', 'exact', 200, '{"status":"accepted","literal":"  old receipt  "}', '2026-01-01T00:00:00Z');
    drop(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 29); const after = snapshot(store.database);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, table); assert.deepEqual(after.foreignKeys[table], before.foreignKeys[table], table); }
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item, item.name);
    for (const id of ids) {
      const state = store.revisionLifecycle.state(id); assert.equal(state.version, 0); assert.equal(state.reviewStarted, true); assert.equal(state.closedFromAccepted, null); assert.equal(state.resumeAcceptanceHead, null); assert.equal(state.updatedAt, null);
      assert.equal(state.status, store.detail(id).revision.status); assert.deepEqual(store.revisionLifecycle.history(id).transactions, []);
    }
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    const stable = snapshot(store.database); initializeRevisionLifecycle(store.database); assert.deepEqual(snapshot(store.database), stable);
    const receipt = lifecycleAction(store, ids[1]!, 'plan_changes', actor); const saved = snapshot(store.database);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), saved); assert.deepEqual(store.revisionLifecycle.operation(receipt.operationId).receipt, receipt);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema26 collisions and malformed legacy status roll back all new schema and preserve retryable schema25', () => {
  for (const collision of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'revision-lifecycle-rollback-')), path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let db: DatabaseSync | undefined, repaired: Store | undefined;
    try {
      const id = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Old paper', files: [{ path: 'old.txt', content: 'Untouched' }] }, actor).revision.id;
      drop(store.database);
      if (collision) store.database.exec("CREATE TABLE revision_lifecycle_operations(operator_note TEXT); INSERT INTO revision_lifecycle_operations VALUES('Retain operator data')");
      else store.database.prepare("UPDATE entities SET data=json_set(data,'$.status','invented') WHERE id=?").run(id);
      const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /schema|column|verified/);
      db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 25); assert.deepEqual(snapshot(db), before);
      if (collision) db.exec('DROP TABLE revision_lifecycle_operations'); else db.prepare("UPDATE entities SET data=json_set(data,'$.status','needs_review') WHERE id=?").run(id);
      db.close(); db = undefined; repaired = new Store({ path }); assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 29);
    } finally { db?.close(); repaired?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
