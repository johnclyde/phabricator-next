import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { seedDemo } from './seed.ts';
import { registerFilePolicy } from './policy.ts';
import { analyzeCitations } from '../shared/citations.ts';
import { migratePastes } from './pastes-migration.ts';

function schema17(path: string) {
  const store = new Store({ path }); seedDemo(store); const db = store.database;
  const actor = { principalId: 'local:workspace', displayName: 'Workspace', credentialId: null, requestId: 'before-pastes' };
  const bytes = Buffer.from('%PDF-1.4\nHistorical supporting source.\n');
  const file = store.files.upload({ name: 'support.pdf', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, actor); registerFilePolicy(db, file.id, actor.principalId);
  const paper = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Historical paper', files: [{ path: 'main.tex', content: '\\cite{old}' }, { path: 'ref.bib', content: '@article{old,title={Historical source}}' }] }, actor);
  const version = paper.versions[0]; const target = analyzeCitations(version.files).entries[0];
  const evidence = store.citationEvidence.create(paper.revision.id, { versionId: version.id, contentHash: version.contentHash, targetId: target.id, source: { fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType }, verdict: 'supports', quote: 'Historical supporting source.', locator: 'p. 1', note: 'Read manually', attested: true, expectedAccessEpoch: 1 }, actor);
  store.citationEvidence.retract(paper.revision.id, evidence.id, { expectedRecordVersion: 1, reason: 'Superseded source' }, actor);
  const definitions = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='entities' AND type IN ('index','trigger') AND name!='paste_identity_no_update' AND sql IS NOT NULL ORDER BY type,name").all() as { sql: string }[];
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    -- Notifications and their mail dependents did not exist at this historical boundary.
    DROP TABLE mail_outbox; DROP TABLE notification_read_changes; DROP TABLE notification_operations; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE notification_read_state; DROP TABLE notification_cursor_secret;
    DROP TABLE revision_lifecycle_transactions; DROP TABLE revision_lifecycle_operations; DROP TABLE revision_lifecycle;
    DROP TABLE revision_author_transactions; DROP TABLE revision_author_operations; DROP TABLE revision_authorship;
    DROP TABLE revision_dependency_edges; DROP TABLE revision_dependency_transactions; DROP TABLE revision_dependency_operations; DROP TABLE revision_dependency_versions;
    DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; DROP TABLE wiki_cursor_secret; DROP TABLE wiki_locations; DROP TABLE revision_docx_packages; DROP TRIGGER docx_versions_no_update; DROP TRIGGER docx_versions_no_delete;
    DROP TRIGGER paste_identity_no_update; DROP TABLE paste_transactions; DROP TABLE paste_versions;
    CREATE TABLE entities_v17(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document','file')),data TEXT NOT NULL CHECK(json_valid(data)));
    INSERT INTO entities_v17(rowid,id,kind,data) SELECT rowid,id,kind,data FROM entities;
    DROP TABLE entities; ALTER TABLE entities_v17 RENAME TO entities;`);
  for (const definition of definitions) db.exec(definition.sql);
  db.exec('PRAGMA user_version=17; COMMIT; PRAGMA foreign_keys=ON;');
  return store;
}
function snapshot(db: DatabaseSync) {
  const schemas = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schemas.filter(row => row.type === 'table').map(row => row.name);
  return { schemas, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), references: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}

test('schema17 migration preserves all evidence and dependent schema, rowids, custom columns and foreign keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pastes-migration-')); const path = join(directory, 'workspace.sqlite'); let store = schema17(path);
  try {
    const db = store.database;
    db.exec(`ALTER TABLE entities ADD COLUMN operator_note TEXT NOT NULL DEFAULT 'preserve';
      CREATE INDEX operator_note_index ON entities(operator_note);
      CREATE TABLE operator_log(id TEXT NOT NULL REFERENCES entities(id));
      CREATE VIEW entity_names AS SELECT id,operator_note FROM entities;
      CREATE VIEW dependent_names AS SELECT * FROM entity_names;
      CREATE TRIGGER operator_log_insert AFTER INSERT ON operator_log BEGIN UPDATE entities SET operator_note='logged' WHERE id=NEW.id; END;
      CREATE TRIGGER entities_note_update AFTER UPDATE OF operator_note ON entities BEGIN SELECT id FROM dependent_names WHERE id=NEW.id; END;`);
    const max = (db.prepare('SELECT MAX(rowid) AS n FROM entities').get() as { n: number }).n; db.prepare('UPDATE entities SET rowid=? WHERE rowid=?').run(max + 99, max);
    const before = snapshot(db); store.close(); store = new Store({ path }); const after = snapshot(store.database);
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 44); assert.equal(store.database.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, `${table} exact historical bytes and rowids`); assert.deepEqual(after.references[table], before.references[table], `${table} foreign keys`); }
    for (const definition of before.schemas.filter(item => item.name !== 'entities')) assert.deepEqual(after.schemas.find(item => item.name === definition.name), definition, definition.name);
    assert.match(after.schemas.find(item => item.name === 'entities')!.sql, /'paste'/); assert.match(after.schemas.find(item => item.name === 'entities')!.sql, /operator_note/);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(store.database.prepare('SELECT * FROM entity_names ORDER BY id').all(), store.database.prepare('SELECT * FROM dependent_names ORDER BY id').all());
    store.database.prepare("INSERT INTO operator_log VALUES('PROJ1')").run(); assert.equal(store.database.prepare("SELECT operator_note FROM entities WHERE id='PROJ1'").get()!.operator_note, 'logged');
    assert.throws(() => store.database.exec("UPDATE citation_evidence SET data='{}'"), /immutable/); assert.throws(() => store.database.exec('DELETE FROM citation_evidence_retractions'), /immutable/);
    assert.throws(() => store.database.exec("INSERT INTO entities(id,kind,data) VALUES('BAD','invalid','{}')"), /CHECK/);
    assert.throws(() => store.database.exec("INSERT INTO operator_log VALUES('MISSING')"), /FOREIGN KEY/);
    assert.equal(store.pastes.create({ content: 'first paste' }, { principalId: 'local:workspace', displayName: 'Workspace', credentialId: null, requestId: 'after' }).id, 'PA1');
    const final = snapshot(store.database); store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), final, 'reopen never repeats migration');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migration failure restores schema17 bytes and all views/triggers with foreign keys enabled', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pastes-migration-failed-')); const path = join(directory, 'workspace.sqlite'); const store = schema17(path);
  try {
    const db = store.database; db.exec("CREATE VIEW original_ids AS SELECT id FROM entities; CREATE TABLE paste_versions(operator_note TEXT); INSERT INTO paste_versions VALUES('do not overwrite');");
    const before = snapshot(db); assert.throws(() => migratePastes(db), /already exists/); assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 17); assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1); assert.ok(db.prepare('SELECT * FROM original_ids').all().length);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migration refuses pre-existing broken relationships and rolls back to schema17', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pastes-migration-orphan-')); const path = join(directory, 'workspace.sqlite'); const store = schema17(path);
  try {
    const db = store.database; db.exec("PRAGMA foreign_keys=OFF; INSERT INTO versions(id,revision_id,number,data) VALUES('orphan','P9999',1,'{}'); PRAGMA foreign_keys=ON;");
    const before = snapshot(db); assert.throws(() => migratePastes(db), /existing relationship/); assert.deepEqual(snapshot(db), before); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 17); assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
