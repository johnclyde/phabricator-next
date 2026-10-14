import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { initializeRevisionReviewers } from './revision-reviewers.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const actor = { principalId: 'alice', displayName: 'Original Alice', credentialId: null, requestId: 'reviewer-migration' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function drop(db: DatabaseSync) { db.exec('DROP TABLE revision_reviewer_transactions; DROP TABLE revision_reviewer_operations; DROP TABLE revision_reviewer_baselines; DROP TABLE revision_reviewers; PRAGMA user_version=26'); }
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const tables = schema.filter(row => row.type === 'table').map(row => row.name); if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}

test('schema27 preserves all schema26 rows, schema, sequences, original receipts and unknown versus proven native acceptance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-reviewers-migrate-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    const id = store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Recorded evidence acceptance', kind: 'paper', files: [{ path: 'paper.txt', content: '\ufeffExact historical source\r\n' }] }, actor).revision.id;
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Original proof', findings: [] }, actor);
    const lifeReceipt = lifecycleAction(store, id, 'accept_reviewed', actor), authorSnapshot = store.revisionAuthorship.snapshot(id);
    const authorReceipt = store.revisionAuthorship.mutate(id, { action: 'assign', authorId: 'bob', message: 'Historical handoff', expectedAuthorVersion: 0, expectedVersion: 1, expectedVersionId: authorSnapshot.head.versionId, expectedContentHash: authorSnapshot.head.contentHash, expectedAccessEpoch: store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number, expectedReviewerVersion: authorSnapshot.reviewerVersion, expectedLifecycleVersion: authorSnapshot.lifecycleVersion }, actor, { principalId: 'bob', displayName: 'Bob' });
    // Reconstruct the exact old wire/storage formats in an isolated fixture;
    // the migration itself is then required to preserve every captured byte.
    const life = store.revisionLifecycle.operation(lifeReceipt.operationId), authored = store.revisionAuthorship.operation(authorReceipt.operationId);
    delete life.input.expectedReviewerVersion; delete life.reviewers; life.inputSha256 = hash(life.input); life.receipt.inputSha256 = life.inputSha256;
    delete authored.input.expectedReviewerVersion; delete authored.input.expectedLifecycleVersion; authored.inputSha256 = hash(authored.input); authored.receipt.inputSha256 = authored.inputSha256;
    store.database.exec('DROP TRIGGER revision_lifecycle_operations_no_update; DROP TRIGGER revision_author_operations_no_update');
    store.database.prepare('UPDATE revision_lifecycle_operations SET input_sha256=?,data=? WHERE id=?').run(life.inputSha256, JSON.stringify(life), life.id);
    store.database.prepare('UPDATE revision_author_operations SET input_sha256=?,data=? WHERE id=?').run(authored.inputSha256, JSON.stringify(authored), authored.id);
    store.database.exec("CREATE TRIGGER revision_lifecycle_operations_no_update BEFORE UPDATE ON revision_lifecycle_operations BEGIN SELECT RAISE(ABORT,'Revision lifecycle operations are immutable'); END; CREATE TRIGGER revision_author_operations_no_update BEFORE UPDATE ON revision_author_operations BEGIN SELECT RAISE(ABORT,'Revision author operations are immutable'); END;");
    for (const [key, receipt] of [['old-lifecycle', life.receipt], ['old-author', authored.receipt]] as const) store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run(key, 'original-fingerprint', 200, JSON.stringify(receipt), '2026-01-01T00:00:00Z');
    const unknown = store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Unknown historical acceptance', kind: 'paper', files: [{ path: 'legacy.txt', content: 'Legacy bytes' }] }).revision.id;
    store.database.prepare("UPDATE entities SET data=json_set(data,'$.status','accepted') WHERE id=?").run(unknown);
    store.database.prepare("UPDATE revision_lifecycle SET data=json_set(data,'$.status','accepted') WHERE revision_id=?").run(unknown);
    drop(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 41); const after = snapshot(store.database);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, table); assert.deepEqual(after.foreignKeys[table], before.foreignKeys[table], table); }
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item, item.name);
    assert.deepEqual(store.revisionReviewers.state(unknown).acceptance, { kind: 'legacy', head: null, transactionId: null });
    const state = store.revisionReviewers.state(id); assert.equal(state.version, 0); assert.deepEqual(state.members, []); assert.equal(state.acceptance?.kind, 'evidence'); assert.deepEqual(store.revisionReviewers.history(id).transactions, []);
    assert.deepEqual(store.revisionLifecycle.operation(life.id), life); assert.deepEqual(store.revisionAuthorship.operation(authored.id), authored);
    const stable = snapshot(store.database); initializeRevisionReviewers(store.database); assert.deepEqual(snapshot(store.database), stable);
    assert.throws(() => store.revisionLifecycle.mutate(id, life.input, actor), { status: 400 }); assert.throws(() => store.revisionAuthorship.mutate(id, authored.input, actor, { principalId: 'bob', displayName: 'Bob' }), { status: 400 }); assert.deepEqual(snapshot(store.database), stable);
    store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), stable);
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema27 malformed history or sidecar name collisions roll back and preserve retryable schema26', () => {
  for (const collision of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), 'revision-reviewers-rollback-')), path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let db: DatabaseSync | undefined, repaired: Store | undefined;
    try {
      const id = store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Old revision', kind: 'paper', files: [{ path: 'old.txt', content: 'Untouched' }] }, actor).revision.id;
      drop(store.database);
      if (collision) store.database.exec("CREATE TABLE revision_reviewer_operations(operator_note TEXT); INSERT INTO revision_reviewer_operations VALUES('Retain this row')");
      else store.database.prepare("UPDATE versions SET data=json_set(data,'$.contentHash','invalid') WHERE revision_id=?").run(id);
      const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /schema|column|verified/);
      db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 26); assert.deepEqual(snapshot(db), before);
      if (collision) db.exec('DROP TABLE revision_reviewer_operations'); else db.prepare("UPDATE versions SET data=json_set(data,'$.contentHash',?) WHERE revision_id=?").run('a'.repeat(64), id);
      db.close(); db = undefined; repaired = new Store({ path }); assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 41);
    } finally { db?.close(); repaired?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
