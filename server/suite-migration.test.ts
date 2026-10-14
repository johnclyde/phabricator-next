import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.ts';
const snapshot = (db: DatabaseSync) => (db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[]).map(row => ({ ...row, rows: db.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
function downgrade(db: DatabaseSync) { db.exec('DROP TABLE suite_history; DROP TABLE suite_records; PRAGMA user_version=40;'); }
test('six-app migration preserves every existing table and row and survives reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-migrate-')), path = join(dir, 'db.sqlite'); let store = new Store({ path });
  try {
    store.createTask({ title: 'Keep existing work', description: 'Exact retained text.' }); downgrade(store.database);
    const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 42);
    const after = snapshot(store.database); for (const old of before) assert.deepEqual(after.find(row => row.name === old.name), old);
    assert.equal(after.length, before.length + 2); assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), after);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
for (const collision of ['table', 'index', 'trigger']) test(`six-app migration rejects an incompatible ${collision} without altering prior records`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-collision-')), path = join(dir, 'db.sqlite'), store = new Store({ path });
  downgrade(store.database);
  store.database.exec({ table: "CREATE TABLE suite_records(operator_note TEXT); INSERT INTO suite_records VALUES('Keep me')", index: 'CREATE INDEX suite_records_app ON entities(kind)', trigger: 'CREATE TRIGGER suite_history_no_update BEFORE DELETE ON entities BEGIN SELECT 1; END' }[collision]!);
  const before = snapshot(store.database); store.close();
  try { assert.throws(() => new Store({ path }), /Unexpected suite_/); const db = new DatabaseSync(path); try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 40); assert.deepEqual(snapshot(db), before); } finally { db.close(); } }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
