import { REPOSITORY_OPERATIONS_TABLES, withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  return { schema, tables: schema.filter(row => row.type === 'table').map(row => ({ name: row.name, rows: db.prepare(`SELECT rowid,* FROM ${quote(row.name)} ORDER BY rowid`).all() })) };
}
function schema44(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const row of snapshot(db).schema.filter(row => row.name.startsWith('owners_') && ['trigger', 'index'].includes(row.type))) db.exec(`DROP ${row.type.toUpperCase()} ${quote(row.name)}`);
  for (const row of snapshot(db).schema.filter(row => row.name.startsWith('owners_') && row.type === 'table')) db.exec(`DROP TABLE ${quote(row.name)}`);
  withoutRepositoryOperationsSchema(db).exec('PRAGMA user_version=44; PRAGMA foreign_keys=ON');
}
test('schema45 adds empty Owners storage while preserving every prior row and definition', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owners-migration-')), path = join(dir, 'workspace.sqlite'); let store = new Store({ path });
  try {
    store.createTask({ title: 'Preserve task', description: 'Exact source before Owners.' });
    store.createProject({ name: 'Preserve project' });
    store.createRepository({ name: 'Preserve repository', remoteUrl: 'https://example.invalid/source.git' });
    store.database.exec("CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Exact independent data')");
    schema44(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 46);
    const after = snapshot(store.database);
    for (const row of before.schema) assert.deepEqual(after.schema.find(item => item.name === row.name), row, row.name);
    for (const row of before.tables) assert.deepEqual(after.tables.find(item => item.name === row.name), row, row.name);
    const added = after.tables.filter(row => !before.tables.some(old => old.name === row.name));
    assert.deepEqual(added.map(row => row.name), [...REPOSITORY_OPERATIONS_TABLES, 'owners_history', 'owners_operations', 'owners_packages', 'owners_routing_records'].sort());
    for (const row of added) assert.deepEqual(row.rows, []);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), after);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
for (const collision of ['owners_packages', 'owners_operations', 'owners_routing_records', 'owners_routing_no_delete']) test(`schema45 collision at ${collision} rolls back all Owners schema changes`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'owners-collision-')), path = join(dir, 'workspace.sqlite'); const store = new Store({ path });
  try {
    store.createTask({ title: 'Keep existing work' }); schema44(store.database);
    store.database.exec(`CREATE TABLE ${quote(collision)}(note TEXT); INSERT INTO ${quote(collision)} VALUES('Preserve operator data')`);
    const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /Unexpected/);
    const db = new DatabaseSync(path); try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 44); assert.deepEqual(snapshot(db), before); } finally { db.close(); }
  } finally { try { store.close(); } catch { /* Closed before upgrade. */ } rmSync(dir, { recursive: true, force: true }); }
});
test('current runtime refuses future databases without mutating them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owners-future-')), path = join(dir, 'workspace.sqlite'), db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA user_version=47; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('Keep me')");
    const before = snapshot(db); assert.throws(() => new Store({ path }), /newer|unsupported/i);
    assert.deepEqual(snapshot(db), before); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 47);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
