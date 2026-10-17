import { withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.ts';
import { seedDemo } from './seed.ts';

function schema23(path: string) {
  const store = new Store({ path }); seedDemo(store);
  const actor = { principalId: 'local:workspace', displayName: 'Original author', credentialId: null, requestId: 'before-dependencies' };
  const paper = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Immutable source evidence', files: [{ path: 'main.tex', content: 'Original paper\n' }] }, actor);
  store.saveReview(paper.revision.id, 1, { provider: 'local', model: 'historical-checks', summary: 'Original evidence', findings: [] }, actor);
  store.createComment(paper.revision.id, { versionId: paper.versions[0]!.id, body: 'Original comment' }, actor);
  store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('pre24-receipt', 'historical-fingerprint', 201, JSON.stringify(paper), '2026-10-11T00:00:00Z');
  withoutRepositoryOperationsSchema(store.database).exec('DROP TABLE revision_dependency_edges; DROP TABLE revision_dependency_transactions; DROP TABLE revision_dependency_operations; DROP TABLE revision_dependency_versions; PRAGMA user_version=23');
  return store;
}
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schema.filter(item => item.type === 'table').map(item => item.name);
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}

test('schema24 adds empty dependency tables without rewriting schema23 source, policies, receipts, rowids or counters', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-dependencies-migration-')), path = join(directory, 'workspace.sqlite'); let store = schema23(path);
  try {
    const paper = store.database.prepare("SELECT id FROM entities WHERE kind='revision' AND json_extract(data,'$.title')='Immutable source evidence'").get()!.id as string;
    const before = snapshot(store.database), detail = JSON.stringify(store.detail(paper));
    store.close(); store = new Store({ path }); const after = snapshot(store.database);
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 47);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, `${table} rows and rowids`); assert.deepEqual(after.foreignKeys[table], before.foreignKeys[table], `${table} foreign keys`); }
    for (const definition of before.schema) assert.deepEqual(after.schema.find(item => item.name === definition.name), definition, definition.name);
    for (const table of ['revision_dependency_versions', 'revision_dependency_edges', 'revision_dependency_transactions', 'revision_dependency_operations']) assert.deepEqual(after.rows[table], []);
    assert.equal(JSON.stringify(store.detail(paper)), detail); assert.equal(store.revisionDependencies.version(paper), 0);
    const upgraded = snapshot(store.database); store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), upgraded);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed dependency migration rolls back all partial schema changes and can be retried safely', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-dependencies-rollback-')), path = join(directory, 'workspace.sqlite'); const store = schema23(path); let db: DatabaseSync | undefined, repaired: Store | undefined;
  try {
    store.database.exec("CREATE TABLE revision_dependency_transactions(operator_note TEXT); INSERT INTO revision_dependency_transactions VALUES('Preserve collision data');");
    const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /already exists|no such column/);
    db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 23); assert.deepEqual(snapshot(db), before); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec('DROP TABLE revision_dependency_transactions'); db.close(); db = undefined;
    repaired = new Store({ path }); assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 47);
    assert.deepEqual(repaired.database.prepare('SELECT * FROM revision_dependency_operations').all(), []);
  } finally { db?.close(); repaired?.close(); rmSync(directory, { recursive: true, force: true }); }
});
