import { withoutRepositoryOperationsSchema } from '../tests/migration-fixture.ts';
import { lifecycleAction, closeRevision } from '../tests/revision-lifecycle-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionAuthor, RevisionAuthorInput } from '../shared/revision-authorship.ts';
import type { GitImportSnapshot } from '../shared/repositories.ts';
import type { DocxProjection } from '../shared/docx.ts';
import { Store } from './store.ts';
import { initializeRevisionAuthorship, revisionAuthorInputHash, RevisionAuthorshipStore } from './revision-authorship.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Original Alice', credentialId: 'alice-key', requestId: 'request-alice' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'request-bob' };
const ref = (actor: ActorAttribution): RevisionAuthor => ({ principalId: actor.principalId, displayName: actor.displayName });
const epoch = (store: Store) => store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
function request(store: Store, id: string, action: 'assign' | 'commandeer' = 'assign', authorId = 'bob', message = 'Handoff\r\nmessage  '): RevisionAuthorInput {
  const snapshot = store.revisionAuthorship.snapshot(id), pins = { expectedReviewerVersion: snapshot.reviewerVersion, expectedLifecycleVersion: snapshot.lifecycleVersion, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: epoch(store), message };
  return action === 'assign' ? { action, authorId, ...pins } : { action, ...pins };
}
function create(store: Store, actor: ActorAttribution | undefined = alice, kind: 'code' | 'paper' | 'document' = 'paper') {
  return store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Exact original manuscript', kind, summary: 'Preserved summary', files: [{ path: 'paper.txt', content: '\ufeffOriginal source\r\n' }] }, actor);
}
function snapshot(db: DatabaseSync, omitAuthorship = false) {
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const filtered = schema.filter(row => !omitAuthorship || !/^revision_author/.test(row.tbl_name));
  const tables = filtered.filter(row => row.type === 'table').map(row => row.name);
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) tables.push('sqlite_sequence');
  return { schema: filtered, rows: Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])), foreignKeys: Object.fromEntries(tables.map(table => [table, db.prepare(`PRAGMA foreign_key_list("${table}")`).all()])) };
}
function oldSchema(store: Store) { withoutRepositoryOperationsSchema(store.database).exec('DROP TABLE revision_author_transactions; DROP TABLE revision_author_operations; DROP TABLE revision_authorship; PRAGMA user_version=24'); }

test('new code, paper and document authorship starts at version zero without fabricated transfer history', () => {
  const store = new Store({ path: ':memory:' }); try {
    for (const kind of ['code', 'paper', 'document'] as const) {
      const detail = create(store, alice, kind), id = detail.revision.id;
      assert.deepEqual(store.revisionAuthorship.state(id), { revisionId: id, version: 0, author: ref(alice), originalAuthor: ref(alice), updatedAt: null });
      assert.equal(detail.revision.authorId, 'alice'); assert.equal(detail.revision.authorDisplayName, alice.displayName); assert.equal(detail.revision.authorVersion, 0);
      assert.deepEqual(store.revisionAuthorship.history(id).transactions, []);
      assert.deepEqual(JSON.parse(store.database.prepare('SELECT data FROM entities WHERE id=?').get(id)!.data as string).authorId, undefined, 'projection never rewrites raw revision metadata');
    }
    const unknown = store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Unknown creator', kind: 'paper', files: [{ path: 'paper.txt', content: 'Legacy' }] });
    assert.equal(store.revisionAuthorship.state(unknown.revision.id).author, null);
    store.createVersion(unknown.revision.id, { expectedVersion: 1, message: 'Later contributor', files: [{ path: 'paper.txt', content: 'Changed' }] }, bob);
    assert.equal(store.revisionAuthorship.state(unknown.revision.id).originalAuthor, null); assert.equal(store.revisionAuthorship.state(unknown.revision.id).author, null);
  } finally { store.close(); }
});

test('assign and commandeer update ownership and reviewer membership while preserving native evidence acceptance and source provenance', () => {
  const store = new Store({ path: ':memory:' }); try {
    const detail = create(store), id = detail.revision.id;
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Preserved evidence', findings: [] }, alice);
    lifecycleAction(store, id, 'accept_reviewed', alice);
    const before = snapshot(store.database, true), previousEpoch = epoch(store), input = request(store, id);
    const receipt = store.revisionAuthorship.mutate(id, input, alice, ref(bob));
    assert.equal(receipt.accessEpoch, previousEpoch + 1); assert.equal(receipt.transaction.message, input.message);
    assert.equal(receipt.transaction.authorVersion, 1); assert.deepEqual(receipt.transaction.previousAuthor, ref(alice)); assert.deepEqual(receipt.transaction.author, ref(bob));
    assert.equal(receipt.inputSha256, revisionAuthorInputHash(input)); assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId).receipt, receipt);
    assert.equal(store.revisionAuthorship.operationRevisionId(receipt.operationId), id);
    const after = snapshot(store.database, true); for (const table of ['policy_meta', 'revision_reviewers', 'revision_reviewer_transactions']) { delete before.rows[table]; delete after.rows[table]; } assert.deepEqual(after, before);
    assert.deepEqual(store.revisionReviewers.state(id).members.map(member => [member.principalId, member.status]), [['alice', 'added']]);
    const projected = store.detail(id).revision; assert.equal(projected.authorId, 'bob'); assert.equal(projected.authorVersion, 1); assert.equal(projected.status, 'accepted');
    assert.equal(store.state({ configured: false, model: null, localConfigured: false, localModel: null }).revisions.find(row => row.id === id)!.authorId, 'bob');
    const reclaim = store.revisionAuthorship.mutate(id, request(store, id, 'commandeer'), alice);
    assert.equal(reclaim.transaction.authorVersion, 2); assert.deepEqual(reclaim.transaction.author, ref(alice)); assert.deepEqual(store.revisionAuthorship.state(id).originalAuthor, ref(alice));
    assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId).receipt, receipt, 'later owners cannot rewrite historical handoff evidence');
    assert.throws(() => store.database.prepare('DELETE FROM revision_author_operations WHERE id=?').run(receipt.operationId), /immutable/);
    assert.throws(() => store.database.prepare('UPDATE revision_author_transactions SET data=data WHERE id=?').run(receipt.transaction.id), /immutable/);
  } finally { store.close(); }
});

test('ownership rejects stale independent author, exact head and access pins without partial writes', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store).revision.id, input = request(store, id);
    for (const change of [{ expectedAuthorVersion: 1 }, { expectedVersion: 2 }, { expectedVersionId: 'foreign-version' }, { expectedContentHash: 'f'.repeat(64) }, { expectedAccessEpoch: epoch(store) + 1 }]) {
      const before = snapshot(store.database); assert.throws(() => store.revisionAuthorship.mutate(id, { ...input, ...change }, alice, ref(bob)), { status: 409 }); assert.deepEqual(snapshot(store.database), before);
    }
    store.revisionAuthorship.mutate(id, input, alice, ref(bob));
    assert.throws(() => store.revisionAuthorship.mutate(id, { ...input, expectedAccessEpoch: epoch(store) }, alice, ref(bob)), { code: 'REVISION_AUTHOR_CHANGED' });
    const staleHead = request(store, id, 'assign', 'alice');
    store.createVersion(id, { expectedVersion: 1, message: 'New source', files: [{ path: 'paper.txt', content: 'Version two' }] }, bob);
    assert.throws(() => store.revisionAuthorship.mutate(id, staleHead, bob, ref(alice)), { code: 'REVISION_AUTHOR_CHANGED' });
  } finally { store.close(); }
});

test('assignment permits closed revisions while commandeer and same-owner actions fail without allocating history', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store).revision.id;
    assert.throws(() => store.revisionAuthorship.mutate(id, request(store, id, 'commandeer'), alice), { code: 'REVISION_AUTHOR_NO_EFFECT' });
    assert.throws(() => store.revisionAuthorship.mutate(id, request(store, id, 'assign', 'alice'), bob, ref(alice)), { code: 'REVISION_AUTHOR_NO_EFFECT' });
    closeRevision(store, id, alice); const before = snapshot(store.database);
    assert.throws(() => store.revisionAuthorship.mutate(id, request(store, id, 'commandeer'), bob), { code: 'REVISION_AUTHOR_CLOSED' }); assert.deepEqual(snapshot(store.database), before);
    store.revisionAuthorship.mutate(id, request(store, id), alice, ref(bob)); assert.equal(store.detail(id).revision.status, 'closed');
    assert.equal(store.revisionAuthorship.history(id).transactions.length, 1);
  } finally { store.close(); }
});

test('close-on-accept prohibits fresh commandeering but preserves assignments, abandoned claims and historical receipts', () => {
  const store = new Store({ path: ':memory:', revisionLifecycle: { closeOnAccept: true } }); try {
    const id = create(store).revision.id;
    const receipt = store.revisionAuthorship.mutate(id, request(store, id, 'commandeer'), bob);
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Exact evidence', findings: [] }, bob);
    lifecycleAction(store, id, 'accept_reviewed', bob);
    assert.equal(store.revisionAuthorship.snapshot(id).closeOnAccept, true);
    const before = snapshot(store.database);
    assert.throws(() => store.revisionAuthorship.mutate(id, request(store, id, 'commandeer'), alice), { code: 'REVISION_AUTHOR_CLOSED' });
    assert.deepEqual(snapshot(store.database), before);
    assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId).receipt, receipt);
    store.revisionAuthorship.mutate(id, request(store, id, 'assign', alice.principalId), bob, ref(alice));
    assert.equal(store.revisionAuthorship.state(id).author?.principalId, alice.principalId);
    const openConfig = new RevisionAuthorshipStore(store.database, false, (id, previous, author, actor, operationId) => store.revisionReviewers.authorChanged(id, previous, author, actor, operationId));
    assert.equal(openConfig.snapshot(id).closeOnAccept, false);
    openConfig.mutate(id, request(store, id, 'commandeer'), bob);
    const abandoned = create(store).revision.id; lifecycleAction(store, abandoned, 'abandon', alice);
    store.revisionAuthorship.mutate(abandoned, request(store, abandoned, 'commandeer'), bob);
    assert.equal(store.revisionAuthorship.state(abandoned).author?.principalId, bob.principalId);
  } finally { store.close(); }
});

test('bounded immutable history pages pin author version and preserve exact Unicode messages', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store).revision.id, body = '\ufeff\r\n\t😀' + 'x'.repeat(9994);
    assert.equal(body.length, 10_000);
    const first = store.revisionAuthorship.mutate(id, request(store, id, 'assign', 'bob', body), alice, ref(bob));
    store.revisionAuthorship.mutate(id, request(store, id, 'assign', 'alice', ''), bob, ref(alice));
    store.revisionAuthorship.mutate(id, request(store, id), alice, ref(bob));
    const page = store.revisionAuthorship.history(id, { limit: 2, expectedAuthorVersion: 3 }); assert.deepEqual(page.transactions.map(row => row.authorVersion), [3, 2]); assert.equal(page.nextBefore, 2);
    const tail = store.revisionAuthorship.history(id, { before: page.nextBefore!, limit: 2, expectedAuthorVersion: 3 }); assert.deepEqual(tail.transactions, [first.transaction]); assert.equal(tail.nextBefore, null);
    for (const query of [{ limit: 0 }, { limit: 101 }, { before: 0 }, { before: 1.2 }, { expectedAuthorVersion: -1 }]) assert.throws(() => store.revisionAuthorship.history(id, query), { status: 400 });
    assert.throws(() => store.revisionAuthorship.history(id, { expectedAuthorVersion: 2 }), { code: 'REVISION_AUTHOR_CHANGED' });
    for (const message of ['a'.repeat(10_001), 'a\0b']) assert.throws(() => store.revisionAuthorship.mutate(id, request(store, id, 'assign', 'alice', message), bob, ref(alice)), { status: 400 });
  } finally { store.close(); }
});

test('actor and target validation, source corruption and injected epoch failure are atomic', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store).revision.id, input = request(store, id), before = snapshot(store.database);
    assert.throws(() => store.revisionAuthorship.mutate(id, input, { ...alice, principalId: '' }, ref(bob)), { status: 400 });
    assert.throws(() => store.revisionAuthorship.mutate(id, input, alice, ref(alice)), { status: 400 });
    assert.throws(() => store.revisionAuthorship.mutate(id, input, alice), { status: 400 }); assert.deepEqual(snapshot(store.database), before);
    store.database.exec("CREATE TRIGGER refuse_author_epoch BEFORE UPDATE ON policy_meta BEGIN SELECT RAISE(ABORT,'injected epoch failure'); END"); const failedBefore = snapshot(store.database);
    assert.throws(() => store.revisionAuthorship.mutate(id, input, alice, ref(bob)), /injected epoch failure/); assert.deepEqual(snapshot(store.database), failedBefore); store.database.exec('DROP TRIGGER refuse_author_epoch');
    store.database.prepare("UPDATE entities SET data=json_set(data,'$.currentVersion',99) WHERE id=?").run(id);
    assert.throws(() => store.revisionAuthorship.snapshot(id), { code: 'REVISION_AUTHOR_INVALID_RECEIPT' });
  } finally { store.close(); }
});

test('canonical operations reject swapped, forged and incomplete historical receipt provenance', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store).revision.id, receipt = store.revisionAuthorship.mutate(id, request(store, id), alice, ref(bob)), original = store.revisionAuthorship.operation(receipt.operationId);
    store.createVersion(id, { expectedVersion: 1, message: 'Source advanced', files: [{ path: 'paper.txt', content: 'Another source' }] }, bob);
    assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId), original, 'historical receipt remains valid after source advances');
    store.database.exec('DROP TRIGGER revision_author_operations_no_update');
    for (const forged of [
      { ...original, input: { ...original.input, message: 'Different request' } },
      { ...original, attribution: { ...original.attribution, principalId: 'bob' } },
      { ...original, receipt: { ...original.receipt, accessEpoch: original.receipt.accessEpoch + 1 } },
      { ...original, receipt: { ...original.receipt, transaction: { ...original.receipt.transaction, previousAuthor: null } } },
    ]) {
      store.database.prepare('UPDATE revision_author_operations SET data=? WHERE id=?').run(JSON.stringify(forged), receipt.operationId);
      assert.throws(() => store.revisionAuthorship.operation(receipt.operationId), { code: 'REVISION_AUTHOR_INVALID_RECEIPT' });
    }
    store.database.prepare('UPDATE revision_author_operations SET data=? WHERE id=?').run(JSON.stringify(original), receipt.operationId);
    store.database.exec('DROP TRIGGER revision_author_transactions_no_delete'); store.database.prepare('DELETE FROM revision_author_transactions WHERE id=?').run(receipt.transaction.id);
    assert.throws(() => store.revisionAuthorship.operation(receipt.operationId), { code: 'REVISION_AUTHOR_INVALID_RECEIPT' });
    assert.throws(() => store.revisionAuthorship.state(id), { code: 'REVISION_AUTHOR_INVALID_RECEIPT' });
  } finally { store.close(); }
});

test('modern authorship receipts bind reviewer and lifecycle pins even when forged request hashes are internally consistent', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store).revision.id, receipt = store.revisionAuthorship.mutate(id, request(store, id), alice, ref(bob));
    const original = store.revisionAuthorship.operation(receipt.operationId);
    const effect = store.database.prepare("SELECT version,before_lifecycle_version FROM revision_reviewer_transactions WHERE cause_id=? AND json_extract(data,'$.action')='author_changed'").get(receipt.operationId)!;
    assert.equal(effect.version, original.input.expectedReviewerVersion! + 1); assert.equal(effect.before_lifecycle_version, original.input.expectedLifecycleVersion);
    store.database.exec('DROP TRIGGER revision_author_operations_no_update');
    for (const pin of ['expectedReviewerVersion', 'expectedLifecycleVersion'] as const) {
      const input = { ...original.input, [pin]: original.input[pin]! + 1 }, inputSha256 = revisionAuthorInputHash(input);
      const forged = { ...original, input, inputSha256, receipt: { ...original.receipt, inputSha256 } };
      store.database.prepare('UPDATE revision_author_operations SET input_sha256=?,data=? WHERE id=?').run(inputSha256, JSON.stringify(forged), receipt.operationId);
      assert.throws(() => store.revisionAuthorship.operation(receipt.operationId), { code: 'REVISION_AUTHOR_INVALID_RECEIPT' }, `${pin} must match immutable side-effect evidence`);
    }
    store.database.prepare('UPDATE revision_author_operations SET input_sha256=?,data=? WHERE id=?').run(original.inputSha256, JSON.stringify(original), receipt.operationId);
    assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId), original);
  } finally { store.close(); }
});

test('schema25 preserves every schema24 row and schema definition, establishes trustworthy baselines, and reopens without changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-author-migration-')), path = join(directory, 'workspace.sqlite'); let store = new Store({ path });
  try {
    const id = create(store).revision.id, unknown = store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Legacy without actor', kind: 'document', files: [{ path: 'old.txt', content: 'Keep exact' }] }).revision.id;
    store.createVersion(id, { expectedVersion: 1, message: 'Later Bob', files: [{ path: 'paper.txt', content: 'Later source' }] }, bob);
    const malformed = create(store).revision.id;
    store.database.prepare("UPDATE versions SET data=json_set(data,'$.attribution.principalId','') WHERE revision_id=? AND number=1").run(malformed);
    const encoded = create(store).revision.id;
    store.database.prepare("UPDATE versions SET data=json_set(data,'$.attribution',?) WHERE revision_id=? AND number=1").run(JSON.stringify(alice), encoded);
    assert.equal(store.database.prepare("SELECT json_type(data,'$.attribution') AS type FROM versions WHERE revision_id=? AND number=1").get(encoded)!.type, 'text');
    store.database.prepare('INSERT INTO idempotency(key,fingerprint,status,body,created_at) VALUES(?,?,?,?,?)').run('historic', 'exact', 201, '{"saved":"bytes"}', '2026-01-01T00:00:00Z');
    oldSchema(store); const before = snapshot(store.database); store.close(); store = new Store({ path });
    assert.equal(store.database.prepare('PRAGMA user_version').get()!.user_version, 46); const after = snapshot(store.database);
    for (const [table, rows] of Object.entries(before.rows)) { assert.deepEqual(after.rows[table], rows, table); assert.deepEqual(after.foreignKeys[table], before.foreignKeys[table], table); }
    for (const item of before.schema) assert.deepEqual(after.schema.find(row => row.name === item.name), item, item.name);
    assert.deepEqual(store.revisionAuthorship.state(id).author, ref(alice)); assert.equal(store.revisionAuthorship.state(id).version, 0);
    assert.equal(store.revisionAuthorship.state(unknown).author, null); assert.equal(store.revisionAuthorship.state(malformed).author, null);
    assert.equal(store.revisionAuthorship.state(encoded).author, null, 'a JSON-encoded actor string is not trustworthy original attribution');
    assert.deepEqual(store.database.prepare('SELECT * FROM revision_author_transactions').all(), []); assert.deepEqual(store.database.prepare('PRAGMA foreign_key_check').all(), []);
    initializeRevisionAuthorship(store.database); const receipt = store.revisionAuthorship.mutate(id, request(store, id), alice, ref(bob));
    const migrated = snapshot(store.database); store.close(); store = new Store({ path }); assert.deepEqual(snapshot(store.database), migrated);
    assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId).receipt, receipt); assert.equal(store.revisionAuthorship.state(id).author?.principalId, 'bob');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('schema25 collision rolls back partial schema and version updates, allowing a corrected migration retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'revision-author-rollback-')), path = join(directory, 'workspace.sqlite'); const store = new Store({ path }); let db: DatabaseSync | undefined, repaired: Store | undefined;
  try {
    create(store); oldSchema(store); store.database.exec("CREATE TABLE revision_author_operations(operator_note TEXT); INSERT INTO revision_author_operations VALUES('Retain operator data')");
    const before = snapshot(store.database); store.close(); assert.throws(() => new Store({ path }), /schema|no such column/);
    db = new DatabaseSync(path); assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 24); assert.deepEqual(snapshot(db), before);
    db.exec('DROP TABLE revision_author_operations'); db.close(); db = undefined; repaired = new Store({ path }); assert.equal(repaired.database.prepare('PRAGMA user_version').get()!.user_version, 46);
  } finally { db?.close(); repaired?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Git and DOCX initial source paths initialize the same authorship baseline while preserving their source provenance', () => {
  const store = new Store({ path: ':memory:' }); try {
    const repo = store.createRepository({ name: 'Fixture', remoteUrl: 'https://example.test/repository.git' });
    const files = [{ path: 'source.txt', content: 'Git source\n' }], snapshot: GitImportSnapshot = { repositoryId: repo.id, objectFormat: 'sha1', files, provenance: { kind: 'git', repositoryId: repo.id, objectFormat: 'sha1', scope: 'complete-text-tree', commitId: 'a'.repeat(40), treeId: 'b'.repeat(40), manifest: [{ path: 'source.txt', mode: '100644', objectId: createHash('sha1').update(`blob ${Buffer.byteLength(files[0]!.content)}\0${files[0]!.content}`).digest('hex') }] } };
    const git = store.createRevisionFromGit(repo.id, { testPlan: 'Fixture verification plan.', commitId: snapshot.provenance.commitId, kind: 'code', title: 'Git authorship' }, snapshot, alice);
    assert.deepEqual(store.revisionAuthorship.state(git.revision.id).author, ref(alice)); assert.ok(git.versions[0]!.gitSource);
    const bytes = Buffer.from('trusted internal package'), hash = createHash('sha256').update(bytes).digest('hex');
    const file = store.files.upload({ name: 'source.docx', bytes: bytes.length, sha256: hash, dataBase64: bytes.toString('base64') }, bob);
    const projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] };
    const docx = store.createDocxRevision({ testPlan: 'Fixture verification plan.', title: 'DOCX authorship', sourceFile: { fileId: file.id, sha256: hash, bytes: bytes.length }, expectedAccessEpoch: epoch(store), shareSource: false }, bytes, projection, bob);
    assert.deepEqual(store.revisionAuthorship.state(docx.revision.id).author, ref(bob)); assert.deepEqual(store.revisionAuthorship.state(docx.revision.id).originalAuthor, ref(bob));
    assert.deepEqual(docx.versions[0]!.attribution, bob); assert.ok(docx.versions[0]!.docx);
  } finally { store.close(); }
});

test('author and epoch counter exhaustion fails explicitly before any partial handoff', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store).revision.id;
    store.database.prepare("UPDATE policy_meta SET value=? WHERE name='epoch'").run(Number.MAX_SAFE_INTEGER);
    let before = snapshot(store.database);
    assert.throws(() => store.revisionAuthorship.mutate(id, request(store, id), alice, ref(bob)), { code: 'REVISION_AUTHOR_INVALID_RECEIPT' }); assert.deepEqual(snapshot(store.database), before);
    store.database.prepare("UPDATE policy_meta SET value=1 WHERE name='epoch'").run();
    const receipt = store.revisionAuthorship.mutate(id, request(store, id), alice, ref(bob)), state = store.revisionAuthorship.state(id);
    store.database.exec('DROP TRIGGER revision_author_transactions_no_update');
    store.database.prepare('UPDATE revision_author_transactions SET author_version=?,data=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, JSON.stringify({ ...receipt.transaction, authorVersion: Number.MAX_SAFE_INTEGER }), receipt.transaction.id);
    store.database.prepare('UPDATE revision_authorship SET version=?,data=? WHERE revision_id=?').run(Number.MAX_SAFE_INTEGER, JSON.stringify({ ...state, version: Number.MAX_SAFE_INTEGER }), id);
    before = snapshot(store.database);
    assert.throws(() => store.revisionAuthorship.mutate(id, request(store, id, 'assign', 'alice'), bob, ref(alice)), { code: 'REVISION_AUTHOR_LIMIT' }); assert.deepEqual(snapshot(store.database), before);
  } finally { store.close(); }
});
