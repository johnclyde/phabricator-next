import { withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { maniphestAdministratorsFromEnvironment } from './maniphest-config.ts';

const owned = /^(?:search_|dashboard_|maniphest_)/;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  return { schema, tables: schema.filter(row => row.type === 'table').map(row => ({ name: row.name, rows: db.prepare(`SELECT rowid,* FROM ${quote(row.name)} ORDER BY rowid`).all() })) };
}
function downgrade(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const { type, name } of snapshot(db).schema.filter(row => owned.test(row.name) && (row.type === 'trigger' || row.type === 'index'))) db.exec(`DROP ${type.toUpperCase()} ${quote(name)}`);
  for (const { name } of snapshot(db).schema.filter(row => owned.test(row.name) && row.type === 'table')) db.exec(`DROP TABLE ${quote(name)}`);
  withoutRepositoryOperationsSchema(db).exec('PRAGMA user_version=43; PRAGMA foreign_keys=ON');
}
test('schema43 to44 preserves every prior row and definition, seeds default task settings, and reopens unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-migration-')), path = join(dir, 'workspace.sqlite'); let store = new Store({ path });
  try {
    store.createTask({ title: 'Preserved task', description: 'Exact historical source.' });
    store.createProject({ name: 'Preserved project' });
    store.database.exec("CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Preserve exact data')");
    downgrade(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 46);
    const after = snapshot(store.database);
    for (const row of before.schema) assert.deepEqual(after.schema.find(item => item.name === row.name), row, row.name);
    for (const table of before.tables) assert.deepEqual(after.tables.find(item => item.name === table.name), table, table.name);
    assert.equal(store.database.prepare('SELECT count(*) AS n FROM maniphest_config_history').get()!.n, 1);
    for (const table of after.tables.filter(item => /^(?:search_|dashboard_)/.test(item.name))) assert.deepEqual(table.rows, []);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), after);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
for (const collision of ['maniphest_config', 'search_queries', 'dashboard_history']) test(`schema44 collision at ${collision} rolls back the whole upgrade`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-collision-')), path = join(dir, 'workspace.sqlite'); const store = new Store({ path });
  try {
    store.createTask({ title: 'Keep this task' }); downgrade(store.database);
    store.database.exec(`CREATE TABLE ${quote(collision)}(note TEXT); INSERT INTO ${quote(collision)} VALUES('Operator data')`);
    const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /Unexpected/);
    const db = new DatabaseSync(path); try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 43); assert.deepEqual(snapshot(db), before); } finally { db.close(); }
  } finally { try { store.close(); } catch { /* Closed before upgrade. */ } rmSync(dir, { recursive: true, force: true }); }
});
test('hosted task configuration administrators require explicit account IDs', () => {
  assert.deepEqual(maniphestAdministratorsFromEnvironment({}), []);
  assert.deepEqual(maniphestAdministratorsFromEnvironment({ APP_MANIPHEST_ADMIN_PRINCIPAL_IDS: '["U1","U2","U1"]' }), ['U1', 'U2']);
  for (const raw of ['*', '"U1"', '[null]', '[""]', '["all users"]']) assert.throws(() => maniphestAdministratorsFromEnvironment({ APP_MANIPHEST_ADMIN_PRINCIPAL_IDS: raw }));
});
