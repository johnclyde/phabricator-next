import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { seedDemo } from './seed.ts';
import { migrateFiles } from './files-migration.ts';

/** Remove only the new empty Files schema to reconstruct the populated schema-15 boundary. */
function schema15(path: string) {
  const store = new Store({ path }); seedDemo(store);
  const db = store.database;
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    -- Notifications and their mail dependents did not exist at this historical boundary.
    DROP TABLE mail_outbox; DROP TABLE notification_read_changes; DROP TABLE notification_operations; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE notification_read_state; DROP TABLE notification_cursor_secret;
    DROP TABLE revision_lifecycle_transactions; DROP TABLE revision_lifecycle_operations; DROP TABLE revision_lifecycle;
    DROP TABLE revision_author_transactions; DROP TABLE revision_author_operations; DROP TABLE revision_authorship;
    DROP TABLE revision_dependency_edges; DROP TABLE revision_dependency_transactions; DROP TABLE revision_dependency_operations; DROP TABLE revision_dependency_versions;
    DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; DROP TABLE wiki_cursor_secret; DROP TABLE wiki_locations; DROP TABLE revision_docx_packages; DROP TRIGGER docx_versions_no_update; DROP TRIGGER docx_versions_no_delete;
    DROP TRIGGER paste_identity_no_update; DROP TABLE paste_transactions; DROP TABLE paste_versions;
    DROP TABLE citation_evidence_retractions; DROP TABLE citation_evidence;
    DROP TRIGGER file_identity_no_update;
    DROP TABLE file_upload_receipts; DROP TABLE file_attachments; DROP TABLE file_transactions; DROP TABLE file_contents; DROP TABLE file_blobs;
    DELETE FROM sequences WHERE name='file';
    CREATE TABLE entities_v15(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document')),data TEXT NOT NULL CHECK(json_valid(data)));
    INSERT INTO entities_v15(rowid,id,kind,data) SELECT rowid,id,kind,data FROM entities;
    DROP TABLE entities; ALTER TABLE entities_v15 RENAME TO entities;
    CREATE INDEX entities_kind ON entities(kind);
    CREATE UNIQUE INDEX documents_slug ON entities(json_extract(data,'$.slug')) WHERE kind='document';
    CREATE INDEX legacy_entity_name ON entities(json_extract(data,'$.name')) WHERE kind='project';
    CREATE TABLE legacy_entity_updates(id TEXT NOT NULL);
    CREATE TRIGGER legacy_entity_updated AFTER UPDATE ON entities BEGIN INSERT INTO legacy_entity_updates(id) VALUES(NEW.id); END;
    PRAGMA user_version=15; COMMIT; PRAGMA foreign_keys=ON;`);
  // Make rowid preservation observable instead of merely preserving a dense ordering.
  const row = db.prepare('SELECT MAX(rowid) AS id FROM entities').get() as { id: number };
  db.prepare('UPDATE entities SET rowid=? WHERE rowid=?').run(row.id + 100, row.id);
  return store;
}
function snapshot(db: DatabaseSync) {
  const schemas = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schemas.filter(row => row.type === 'table').map(row => row.name);
  const records = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]));
  const references = Object.fromEntries(tables.map(name => [name, db.prepare(`PRAGMA foreign_key_list("${name}")`).all()]));
  return { schemas, records, references };
}

test('schema 15 upgrade preserves old evidence bytes, entity rowids, schema objects and child foreign keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'files-migration-')); const path = join(directory, 'workspace.sqlite'); let store = schema15(path);
  try {
    const before = snapshot(store.database); store.close(); store = new Store({ path }); const db = store.database;
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 44); assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const after = snapshot(db);
    for (const [table, records] of Object.entries(before.records)) {
      assert.deepEqual(after.records[table], records, `${table} historical rows and rowids must be unchanged`);
      assert.deepEqual(after.references[table], before.references[table], `${table} foreign key definitions`);
    }
    for (const schema of before.schemas.filter(row => row.name !== 'entities')) assert.deepEqual(after.schemas.find(row => row.name === schema.name), schema, `preserve ${schema.name}`);
    assert.match(after.schemas.find(row => row.name === 'entities')!.sql, /'file'/);
    assert.throws(() => db.prepare("INSERT INTO entities(id,kind,data) VALUES('BAD','unrecognized','{}')").run(), /CHECK/);
    assert.throws(() => db.prepare("INSERT INTO versions(id,revision_id,number,data) VALUES('bad','P999',1,'{}')").run(), /FOREIGN KEY/);
    const wiki = db.prepare('SELECT id FROM wiki_versions LIMIT 1').get() as { id: string };
    assert.throws(() => db.prepare("UPDATE wiki_versions SET data='{}' WHERE id=?").run(wiki.id), /immutable/);
    db.prepare("UPDATE entities SET data=data WHERE id='PROJ1'").run();
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM legacy_entity_updates WHERE id='PROJ1'").get() as { n: number }).n, 1);
    store.close(); store = new Store({ path }); assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 44, 'migration is not repeated on reopen');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migration failure restores the complete old schema and leaves foreign keys enabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'files-migration-failure-')); const path = join(directory, 'workspace.sqlite'); const store = schema15(path);
  try {
    const db = store.database;
    db.exec("CREATE TABLE file_blobs(unexpected TEXT); INSERT INTO file_blobs VALUES('operator data must survive');");
    const before = snapshot(db);
    assert.throws(() => migrateFiles(db), /already exists/);
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 15);
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.throws(() => db.prepare("INSERT INTO versions(id,revision_id,number,data) VALUES('bad','P999',1,'{}')").run(), /FOREIGN KEY/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migration refuses pre-existing broken relationships instead of blessing them as schema 16', () => {
  const directory = mkdtempSync(join(tmpdir(), 'files-migration-invalid-')); const path = join(directory, 'workspace.sqlite'); const store = schema15(path);
  try {
    const db = store.database;
    db.exec("PRAGMA foreign_keys=OFF; INSERT INTO versions(id,revision_id,number,data) VALUES('orphan','P999',1,'{}'); PRAGMA foreign_keys=ON;");
    const before = snapshot(db);
    assert.throws(() => migrateFiles(db), /existing relationship/); assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 15); assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
