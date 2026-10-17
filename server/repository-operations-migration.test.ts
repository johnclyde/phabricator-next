import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { REPOSITORY_OPERATIONS_TABLES, withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_autoindex_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  return { schema, tables: schema.filter(row => row.type === 'table').map(row => ({ name: row.name, rows: db.prepare(`SELECT rowid,* FROM ${quote(row.name)} ORDER BY rowid`).all(), foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quote(row.name)})`).all() })) };
}
function legacy(path: string) {
  const store = new Store({ path });
  const actor = { principalId: 'U1', displayName: 'Preserved writer', credentialId: null, requestId: 'historical-source' };
  const repository = store.createRepository({ name: 'Existing source', description: 'Exact repository metadata.', remoteUrl: 'https://example.invalid/source.git' });
  store.createTask({ title: 'Keep task', description: 'Task history survives migration.' }, actor);
  const revision = store.createRevision({ title: 'Preserve source', repositoryId: repository.id, kind: 'code', testPlan: 'Keep immutable evidence.', files: [{ path: 'source.ts', content: '\ufeffOriginal source\r\n😀' }] }, actor);
  store.createComment(revision.revision.id, { versionId: revision.versions[0]!.id, body: 'Prior discussion.' }, actor);
  store.saveReview(revision.revision.id, 1, { provider: 'local', model: 'deterministic', summary: 'Prior analysis.', findings: [] }, actor);
  store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('saved-request', 'exact-request', 201, '{ "retain": "formatting" }', '2026-10-14T00:00:00Z');
  store.database.exec("CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Preserve exact independent data'); CREATE INDEX operator_notes_index ON operator_notes(note); CREATE VIEW operator_note_view AS SELECT note FROM operator_notes; CREATE TRIGGER operator_notes_guard BEFORE DELETE ON operator_notes BEGIN SELECT RAISE(ABORT,'Keep independent data'); END");
  withoutRepositoryOperationsSchema(store.database).exec('PRAGMA user_version=45');
  return store;
}

test('schema46 adds empty replication and receive storage while preserving every prior row and schema definition', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repository-operations-migration-')), path = join(directory, 'workspace.sqlite'); let store = legacy(path);
  try {
    const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 47);
    const after = snapshot(store.database);
    for (const entry of before.schema) assert.deepEqual(after.schema.find(item => item.name === entry.name), entry, entry.name);
    for (const entry of before.tables) assert.deepEqual(after.tables.find(item => item.name === entry.name), entry, entry.name);
    const added = after.tables.filter(item => !before.tables.some(entry => entry.name === item.name));
    assert.deepEqual(added.map(item => item.name), [...REPOSITORY_OPERATIONS_TABLES]);
    for (const table of added) assert.deepEqual(table.rows, []);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), after);
  } finally { if (store.database.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const name of [...REPOSITORY_OPERATIONS_TABLES, 'repository_sync_attempt_repository', 'hosted_git_receives_pending']) test(`schema46 refuses an incompatible ${name} without changing prior data`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'repository-operations-collision-')), path = join(directory, 'workspace.sqlite'); const store = legacy(path);
  try {
    store.database.exec(`CREATE TABLE ${quote(name)}(operator_note TEXT); INSERT INTO ${quote(name)} VALUES('Keep collision data')`);
    const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /schema|exist|column|unexpected|already/i);
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 45); assert.deepEqual(snapshot(db), before); }
    finally { db.close(); }
  } finally { if (store.database.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema46 version-write failure rolls back all new objects and preserves a retryable schema45 database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repository-operations-rollback-')), path = join(directory, 'workspace.sqlite'), store = legacy(path), exec = DatabaseSync.prototype.exec;
  const before = snapshot(store.database); store.close();
  try {
    DatabaseSync.prototype.exec = function(sql: string) { if (sql === 'PRAGMA user_version = 46') throw new Error('Injected schema46 failure'); return exec.call(this, sql); };
    assert.throws(() => new Store({ path }), /Injected schema46 failure/);
  } finally { DatabaseSync.prototype.exec = exec; }
  try {
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 45); assert.deepEqual(snapshot(db), before); }
    finally { db.close(); }
    const repaired = new Store({ path });
    try { assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 47); for (const table of before.tables) assert.deepEqual(snapshot(repaired.database).tables.find(item => item.name === table.name), table); }
    finally { repaired.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('schema46 runtime refuses a future database without rewriting any record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'repository-operations-future-')), path = join(directory, 'workspace.sqlite'), db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA user_version=48; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('Preserve future format')");
    const before = snapshot(db); assert.throws(() => new Store({ path }), /newer|unsupported/i);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 48); assert.deepEqual(snapshot(db), before);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
