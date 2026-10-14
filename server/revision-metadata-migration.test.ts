import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { initializeRevisionMetadata } from './revision-metadata.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const actor = { principalId: 'alice', displayName: 'Original Alice', credentialId: null, requestId: 'metadata-migration' };
function drop(db: DatabaseSync) { db.exec('DROP TABLE revision_metadata_transactions; DROP TABLE revision_metadata_operations; DROP TABLE revision_metadata_baselines; DROP TABLE revision_metadata; PRAGMA user_version=27'); }
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schema.filter(row => row.type === 'table').map(row => row.name); if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}

test('schema28 preserves every schema27 row and constraint, unknown plans, wide legacy titles, and historical operation receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-metadata-migrate-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    const id = store.createRevision({ title: 'Historical accepted source', summary: '\ufeffOriginal\r\nsummary  ', testPlan: 'Fixture verification.', kind: 'paper', files: [{ path: 'paper.txt', content: '\ufeffExact historical source\r\n' }] }, actor).revision.id;
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Original proof', findings: [] }, actor);
    const accepted = lifecycleAction(store, id, 'accept_reviewed', actor), proof = store.revisionLifecycle.operation(accepted.operationId);
    store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('old-lifecycle', 'original-fingerprint', 200, JSON.stringify(accepted), '2026-01-01T00:00:00Z');
    const wide = store.createRevision({ title: 'Legacy wide title', testPlan: 'Fixture verification.', kind: 'paper', files: [{ path: 'legacy.txt', content: 'Unchanged legacy body' }] }).revision.id;
    store.revisionDependencies.mutate(id, { direction: 'parents', add: [wide], remove: [], expectedRelationshipVersion: 0, expectedAccessEpoch: store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number }, actor);
    const legacyTitle = '漢'.repeat(238) + '\ud800X', legacySummary = 'Legacy\udfffsummary\r\n';
    // JSON encoding preserves code units which SQLite's UTF-8 binding would
    // replace if handed an isolated surrogate as an extracted SQL string.
    const legacyEntity = JSON.parse(store.database.prepare('SELECT data FROM entities WHERE id=?').get(wide)!.data as string);
    store.database.prepare('UPDATE entities SET data=? WHERE id=?').run(JSON.stringify({ ...legacyEntity, title: legacyTitle, summary: legacySummary }), wide);
    drop(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 42); const after = snapshot(store.database);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, table); assert.deepEqual(after.foreignKeys[table], before.foreignKeys[table], table); }
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item, item.name);
    assert.equal(store.revisionMetadata.config.requireTestPlan, true); assert.equal(store.detail(id).revision.testPlan, null); assert.equal(store.detail(id).revision.metadataVersion, 0); assert.equal(store.detail(id).revision.status, 'accepted');
    assert.equal(store.detail(wide).revision.title, legacyTitle); assert.equal(store.detail(wide).revision.summary, legacySummary); assert.equal(store.detail(wide).revision.testPlan, null); assert.deepEqual(store.revisionMetadata.history(id).transactions, []); assert.deepEqual(store.revisionLifecycle.operation(accepted.operationId), proof);
    const stack = store.revisionStack.read(id, () => true, store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number);
    assert.equal(stack.nodes.find(node => node.id === wide)!.title, legacyTitle, 'Stack preserves the exact legacy title');
    assert.equal(store.revisionDependencies.page(id, { direction: 'parents' }, () => true).revisions[0]!.title, legacyTitle, 'dependency projection preserves the exact legacy title');
    const stable = snapshot(store.database); initializeRevisionMetadata(store.database); assert.deepEqual(snapshot(store.database), stable);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), stable);
    const metadata = store.revisionMetadata.snapshot(wide), raw = store.database.prepare('SELECT data FROM entities WHERE id=?').get(wide)!.data;
    const request = { title: 'Corrected title', summary: metadata.metadata.summary, testPlan: 'Verified the existing source.', message: 'Record the missing plan explicitly.', expectedMetadataVersion: 0, expectedVersion: metadata.head.number, expectedVersionId: metadata.head.versionId, expectedContentHash: metadata.head.contentHash, expectedAccessEpoch: store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number, expectedConfigId: metadata.configId };
    assert.throws(() => store.revisionMetadata.mutate(wide, request, actor), { code: 'REVISION_METADATA_INVALID_INPUT' });
    const receipt = store.revisionMetadata.mutate(wide, { ...request, summary: 'Corrected Unicode summary.' }, actor);
    assert.equal(receipt.metadata.version, 1); assert.equal(receipt.transaction!.before.title, legacyTitle); assert.equal(receipt.transaction!.before.testPlan, null); assert.deepEqual(store.database.prepare('SELECT data FROM entities WHERE id=?').get(wide)!.data, raw);
    assert.deepEqual(store.revisionMetadata.operation(receipt.operationId).receipt, receipt); assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { if (store.database.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema28 metadata corruption or table collisions roll back every migration write and preserve schema27 for repair', () => {
  for (const corruption of ['collision', 'object-title', 'bad-head'] as const) {
    const directory = mkdtempSync(join(tmpdir(), 'revision-metadata-rollback-')), path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let db: DatabaseSync | undefined, repaired: Store | undefined;
    try {
      const id = store.createRevision({ title: 'Old revision', testPlan: 'Fixture verification.', kind: 'paper', files: [{ path: 'old.txt', content: 'Untouched' }] }, actor).revision.id;
      const originalVersion = store.database.prepare('SELECT data FROM versions WHERE revision_id=?').get(id)!.data as string;
      drop(store.database);
      if (corruption === 'collision') store.database.exec("CREATE TABLE revision_metadata_operations(operator_note TEXT); INSERT INTO revision_metadata_operations VALUES('Keep operator data')");
      else if (corruption === 'object-title') store.database.prepare("UPDATE entities SET data=json_set(data,'$.title',json(?)) WHERE id=?").run('{"nested":"not a string"}', id);
      else store.database.prepare("UPDATE versions SET data=json_set(data,'$.contentHash','invalid') WHERE revision_id=?").run(id);
      const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /schema|column|verified/);
      db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 27); assert.deepEqual(snapshot(db), before);
      if (corruption === 'collision') db.exec('DROP TABLE revision_metadata_operations');
      else if (corruption === 'object-title') db.prepare("UPDATE entities SET data=json_set(data,'$.title','Old revision') WHERE id=?").run(id);
      else db.prepare('UPDATE versions SET data=? WHERE revision_id=?').run(originalVersion, id);
      db.close(); db = undefined; repaired = new Store({ path }); assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 42); assert.equal(repaired.detail(id).revision.testPlan, null);
    } finally { db?.close(); repaired?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
