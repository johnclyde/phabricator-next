import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { initializeRevisionProjects } from './revision-projects.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const actor = { principalId: 'alice', displayName: 'Alice', credentialId: 'original-token', requestId: 'migration' };
const names = ['revision_project_response_bindings', 'revision_project_transactions', 'revision_project_operations', 'revision_project_baselines', 'revision_projects'];
function downgrade(db: DatabaseSync) { for (const name of names) db.exec(`DROP TABLE ${name}`); db.exec('PRAGMA user_version=29'); }
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schema.filter(row => row.type === 'table').map(row => row.name); if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}

test('schema30 maps legacy scalar tags without changing any schema29 rows, constraints, source or saved receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-projects-migration-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    const project = store.createProject({ name: 'Legacy project' }, actor), original = store.createRevision({ title: 'Historical tagged paper', testPlan: 'Verify source.', summary: '\ufeffExact summary\r\n', kind: 'paper', projectId: project.id, files: [{ path: 'old.tex', content: '\ufeffUnchanged source\r\n' }] }, actor), id = original.revision.id;
    const untagged = store.createRevision({ title: 'Untagged legacy revision', testPlan: 'Verify source.', kind: 'code', files: [{ path: 'old.ts', content: 'old();' }] }, actor).revision.id;
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Exact historical evidence', findings: [] }, actor); const acceptance = lifecycleAction(store, id, 'accept_reviewed', actor), proof = store.revisionLifecycle.operation(acceptance.operationId);
    store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('old-creation', 'original-fingerprint', 201, JSON.stringify(original), original.revision.createdAt);
    downgrade(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path }); const after = snapshot(store.database);
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 37);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, table); assert.deepEqual(after.foreignKeys[table], before.foreignKeys[table], table); }
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item, item.name);
    assert.deepEqual(store.revisionProjects.state(id), { revisionId: id, version: 0, projectIds: [project.id], updatedAt: null }); assert.deepEqual(store.revisionProjects.state(untagged).projectIds, []);
    assert.deepEqual(store.revisionProjects.history(id).transactions, []); assert.deepEqual(after.rows.revision_project_transactions, []); assert.deepEqual(after.rows.revision_project_operations, []); assert.deepEqual(after.rows.revision_project_response_bindings, []); assert.deepEqual(store.revisionLifecycle.operation(acceptance.operationId), proof);
    assert.deepEqual(store.replay('old-creation', 'original-fingerprint'), { status: 201, body: original }, 'unbound legacy idempotency bytes retain their historical shape');
    assert.equal(store.detail(id).revision.status, 'accepted'); assert.equal(store.detail(id).revision.projectId, project.id); assert.equal(store.detail(id).revision.projectVersion, 0);
    const stable = snapshot(store.database); initializeRevisionProjects(store.database); assert.deepEqual(snapshot(store.database), stable); store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), stable);
    const receipt = store.revisionProjects.mutate(id, { action: 'remove', projectIds: [project.id], expectedProjectVersion: 0, expectedAccessEpoch: store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number }, actor);
    assert.equal(receipt.transaction!.before.version, 0); assert.deepEqual(receipt.tags.projectIds, []); assert.deepEqual(store.revisionProjects.operation(receipt.operationId).receipt, receipt);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { if (store.database.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema30 rejects unknown legacy tags and table collisions atomically, leaving schema29 available for repair', () => {
  for (const fault of ['reference', 'collision'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'revision-projects-rollback-')), path = join(directory, 'workspace.sqlite'); const original = new Store({ path }); let db: DatabaseSync | undefined, repaired: Store | undefined;
    try {
      const id = original.createRevision({ title: 'Preserved', testPlan: 'Keep source.', kind: 'paper', files: [{ path: 'old.tex', content: 'Exact source' }] }, actor).revision.id; downgrade(original.database);
      if (fault === 'reference') original.database.prepare("UPDATE entities SET data=json_set(data,'$.projectId','PROJ999') WHERE id=?").run(id);
      else original.database.exec("CREATE TABLE revision_project_operations(operator_note TEXT); INSERT INTO revision_project_operations VALUES('Preserve custom data')");
      const before = snapshot(original.database); original.close(); assert.throws(() => new Store({ path })); db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 29); assert.deepEqual(snapshot(db), before);
      if (fault === 'reference') db.prepare("UPDATE entities SET data=json_set(data,'$.projectId',NULL) WHERE id=?").run(id); else db.exec('DROP TABLE revision_project_operations');
      db.close(); db = undefined; repaired = new Store({ path }); assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 37); assert.deepEqual(repaired.revisionProjects.state(id).projectIds, []);
    } finally { if (original.database.isOpen) original.close(); db?.close(); repaired?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
