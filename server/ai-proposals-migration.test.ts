import { withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';
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
  const tables = schema.filter(row => row.type === 'table').map(row => ({ name: row.name, rows: db.prepare(`SELECT rowid,* FROM ${quote(row.name)} ORDER BY rowid`).all(), columns: db.prepare(`PRAGMA table_info(${quote(row.name)})`).all(), foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quote(row.name)})`).all() }));
  return { schema, tables };
}
function downgrade(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=OFF');
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'ai_proposal_*'").all() as { name: string }[]) db.exec(`DROP TRIGGER ${quote(row.name)}`);
  withoutRepositoryOperationsSchema(db).exec('DROP TABLE ai_proposal_applications; DROP TABLE ai_proposal_results; DROP TABLE ai_proposal_requests; PRAGMA user_version=42; PRAGMA foreign_keys=ON');
}
function seed(store: Store) {
  const actor = { principalId: 'U1', displayName: 'Writer', credentialId: null, requestId: 'preserved-request' };
  store.notifications.configure({ eligible: () => true, canView: () => true });
  const revision = store.createRevision({ title: 'Existing manuscript', kind: 'paper', testPlan: 'Preserve all evidence.', files: [{ path: 'paper.tex', content: 'Exact original source.\r\n' }] }, actor);
  store.createComment(revision.revision.id, { versionId: revision.versions[0]!.id, body: 'Existing public discussion.' }, { ...actor, principalId: 'U2', displayName: 'Reader', requestId: 'preserved-comment' });
  store.saveReview(revision.revision.id, 1, { provider: 'local', model: 'deterministic', summary: 'Stored evidence.', findings: [] }, actor);
  store.database.exec("CREATE TABLE operator_notes(note TEXT); INSERT INTO operator_notes VALUES('Preserve exact operator data')");
}
test('schema42 to43 adds empty AI evidence tables while preserving every existing row, sequence and definition', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-proposal-migration-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    seed(store); downgrade(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 46); const after = snapshot(store.database);
    for (const table of before.tables) assert.deepEqual(after.tables.find(item => item.name === table.name), table, table.name);
    for (const definition of before.schema) assert.deepEqual(after.schema.find(item => item.name === definition.name), definition, definition.name);
    for (const table of after.tables.filter(item => item.name.startsWith('ai_proposal_'))) assert.deepEqual(table.rows, []);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), after);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('schema42 migration collision rolls back without altering prior data or advancing user_version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-proposal-collision-')), path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let db: DatabaseSync | undefined;
  try {
    seed(store); downgrade(store.database); store.database.exec("CREATE TABLE ai_proposal_results(operator_note TEXT); INSERT INTO ai_proposal_results VALUES('Keep my data')");
    const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /Unexpected ai_proposal_results/);
    db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 42); assert.deepEqual(snapshot(db), before);
    db.exec('DROP TABLE ai_proposal_results'); db.close(); db = undefined;
    const repaired = new Store({ path }); try { assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 46); } finally { repaired.close(); }
  } finally { db?.close(); try { store.close(); } catch { /* Already closed before migration. */ } rmSync(directory, { recursive: true, force: true }); }
});
