import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { seedDemo } from './seed.ts';
import { registerFilePolicy } from './policy.ts';

function schema16(path: string) {
  const store = new Store({ path }); seedDemo(store);
  const actor = { principalId: 'local:workspace', displayName: 'Workspace', credentialId: null, requestId: 'pre-migration' };
  const bytes = Buffer.from('%PDF-1.4\nOriginal figure.\n');
  const file = store.files.upload({ name: 'figure.pdf', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }, actor);
  registerFilePolicy(store.database, file.id, actor.principalId);
  const paper = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Existing immutable figure history', files: [{ path: 'main.tex', content: 'A claim \\cite{proof}.' }, { path: 'refs.bib', content: '@article{proof,title={Old evidence}}' }], assets: [{ path: 'figure.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' }], shareAssets: true }, actor);
  store.saveReview(paper.revision.id, 1, { provider: 'local', model: 'deterministic-checks', summary: 'Historical analysis', findings: [] }, actor);
  store.createComment(paper.revision.id, { versionId: paper.versions[0]!.id, body: 'Historical review comment' }, actor);
  const definitions = store.database.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='entities' AND type IN ('index','trigger') AND name!='paste_identity_no_update' AND sql IS NOT NULL ORDER BY type,name").all() as { sql: string }[];
  store.database.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    -- Notifications and their mail dependents did not exist at this historical boundary.
    DROP TABLE mail_outbox; DROP TABLE notification_read_changes; DROP TABLE notification_operations; DROP TABLE notification_deliveries; DROP TABLE notification_events; DROP TABLE notification_read_state; DROP TABLE notification_cursor_secret;
    DROP TABLE revision_lifecycle_transactions; DROP TABLE revision_lifecycle_operations; DROP TABLE revision_lifecycle;
    DROP TABLE revision_author_transactions; DROP TABLE revision_author_operations; DROP TABLE revision_authorship;
    DROP TABLE revision_dependency_edges; DROP TABLE revision_dependency_transactions; DROP TABLE revision_dependency_operations; DROP TABLE revision_dependency_versions;
    DROP TABLE wiki_conduit_receipts; DROP TABLE wiki_content_identifiers; DROP TABLE wiki_document_identifiers; DROP TABLE wiki_transactions; DROP TABLE wiki_publication; DROP TABLE wiki_cursor_secret; DROP TABLE wiki_locations; DROP TABLE revision_docx_packages; DROP TRIGGER docx_versions_no_update; DROP TRIGGER docx_versions_no_delete;
    DROP TRIGGER paste_identity_no_update; DROP TABLE paste_transactions; DROP TABLE paste_versions;
    DROP TABLE citation_evidence_retractions; DROP TABLE citation_evidence;
    CREATE TABLE entities_v16(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('project','repository','revision','task','document','file')),data TEXT NOT NULL CHECK(json_valid(data)));
    INSERT INTO entities_v16(rowid,id,kind,data) SELECT rowid,id,kind,data FROM entities;
    DROP TABLE entities; ALTER TABLE entities_v16 RENAME TO entities;`);
  for (const definition of definitions) store.database.exec(definition.sql);
  store.database.exec('PRAGMA user_version=16; COMMIT; PRAGMA foreign_keys=ON;');
  return store;
}

function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  return { schema, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), references: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}

test('schema 16 upgrade adds empty evidence tables and preserves all existing source, Files, policies and audit bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-migration-')); const path = join(directory, 'workspace.sqlite'); let store = schema16(path);
  try {
    const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 45);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    const after = snapshot(store.database);
    for (const [table, rows] of Object.entries(before.rows)) {
      assert.deepEqual(after.rows[table], rows, `${table} rows and rowids stay byte-for-byte unchanged`);
      assert.deepEqual(after.references[table], before.references[table], `${table} relationships stay unchanged`);
    }
    for (const schema of before.schema.filter(row => row.name !== 'entities')) assert.deepEqual(after.schema.find(row => row.name === schema.name), schema);
    assert.match(after.schema.find(row => row.name === 'entities')!.sql, /'paste'/);
    assert.deepEqual(after.rows.citation_evidence, []); assert.deepEqual(after.rows.citation_evidence_retractions, []);
    const migrated = snapshot(store.database); store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), migrated, 'reopening does not rerun migration');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a failed schema 17 migration rolls back its schema and preserves the schema 16 boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'citation-migration-failure-')); const path = join(directory, 'workspace.sqlite'); const store = schema16(path); let db: DatabaseSync | undefined;
  try {
    store.database.exec("CREATE TABLE citation_evidence_retractions(operator_note TEXT); INSERT INTO citation_evidence_retractions VALUES('preserve operator data');");
    const before = snapshot(store.database); store.close();
    assert.throws(() => new Store({ path }), /already exists/);
    db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON');
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 16); assert.deepEqual(snapshot(db), before);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});
