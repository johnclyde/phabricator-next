import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.ts';
import { Auth } from './auth.ts';
import { initializeRevisionSubscriptions } from './revision-subscriptions.ts';

const alice = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'migration-create' };
const bob = { principalId: 'bob', displayName: 'Bob', credentialId: 'old-token', requestId: 'migration-comment' };
const tables = ['revision_subscription_transactions', 'revision_mute_transactions', 'revision_subscription_operations', 'revision_subscriptions', 'revision_mutes'];
function downgrade(db: DatabaseSync) { for (const table of tables) db.exec(`DROP TABLE ${table}`); db.exec('PRAGMA user_version=28'); }
function snapshot(db: DatabaseSync) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const names = schema.filter(item => item.type === 'table').map(item => item.name); if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) names.push('sqlite_sequence');
  return { schema, rows: Object.fromEntries(names.map(name => [name, db.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(names.map(name => [name, db.prepare(`PRAGMA foreign_key_list("${name}")`).all()])) };
}

test('schema29 preserves all schema28 bytes, constraints, historical receipts and comments without invented followers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-subscriptions-migration-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    new Auth({ database: store.database, mode: 'local', basePath: '/', provisioning: true }); store.database.prepare("INSERT INTO auth_accounts(id,username,display_name,salt,password_hash) VALUES('bob','bob','Bob','fixture','fixture')").run();
    const revision = store.createRevision({ title: 'Preserved paper', testPlan: 'Read the exact source.', kind: 'paper', files: [{ path: 'paper.tex', content: '\ufeffExact source\r\n' }] }, alice), id = revision.revision.id;
    const comment = store.createComment(id, { versionId: revision.versions[0]!.id, body: 'An old comment does not imply a new migration action.' }, bob);
    const metadata = store.revisionMetadata.snapshot(id), receipt = store.revisionMetadata.mutate(id, { title: 'Historically edited title', summary: metadata.metadata.summary, testPlan: metadata.metadata.testPlan!, message: 'Exact old edit', expectedMetadataVersion: 0, expectedVersion: metadata.head.number, expectedVersionId: metadata.head.versionId, expectedContentHash: metadata.head.contentHash, expectedConfigId: metadata.configId, expectedAccessEpoch: store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number }, alice);
    store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('old-comment', 'original-fingerprint', 201, JSON.stringify(comment), comment.createdAt);
    const proof = store.revisionMetadata.operation(receipt.operationId); downgrade(store.database); const before = snapshot(store.database); store.close(); store = new Store({ path }); const after = snapshot(store.database);
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 37);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, table); assert.deepEqual(after.foreignKeys[table], before.foreignKeys[table], table); }
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item, item.name);
    for (const table of tables) assert.deepEqual(after.rows[table], [], table);
    assert.equal(store.revisionSubscriptions.effective(id, alice.principalId), true); assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), false); assert.equal(store.revisionSubscriptions.history(id).subscriptionVersion, 0); assert.equal(store.revisionSubscriptions.muteHistory(id, bob.principalId).muteVersion, 0);
    assert.deepEqual(store.revisionMetadata.operation(receipt.operationId), proof); assert.deepEqual(store.detail(id).comments[0], comment);
    const stable = snapshot(store.database); initializeRevisionSubscriptions(store.database); assert.deepEqual(snapshot(store.database), stable); store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), stable);
    store.createReply(id, comment.threadId!, { viewedVersionId: comment.versionId, body: 'A fresh human reply may now follow.' }, bob); assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), true); assert.equal(store.revisionSubscriptions.history(id).transactions[0]!.reason, 'comment');
    assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []); assert.equal(store.database.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { if (store.database.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema29 table collision rolls back all additive changes and preserves schema28 for repair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-subscriptions-rollback-')), path = join(directory, 'workspace.sqlite'); const original = new Store({ path }); let db: DatabaseSync | undefined, repaired: Store | undefined;
  try {
    original.createRevision({ title: 'Original', testPlan: 'Keep every byte.', kind: 'paper', files: [{ path: 'old.tex', content: 'Unchanged source' }] }, alice); downgrade(original.database);
    original.database.exec("CREATE TABLE revision_mutes(operator_note TEXT); INSERT INTO revision_mutes VALUES('Preserve unexpected operator data')"); const before = snapshot(original.database); original.close();
    assert.throws(() => new Store({ path }), /schema/); db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 28); assert.deepEqual(snapshot(db), before);
    db.exec('DROP TABLE revision_mutes'); db.close(); db = undefined; repaired = new Store({ path }); assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 37); assert.equal(repaired.revisionSubscriptions.snapshot('P1', alice.principalId).subscriptionVersion, 0);
  } finally { if (original.database.isOpen) original.close(); db?.close(); repaired?.close(); rmSync(directory, { recursive: true, force: true }); }
});
