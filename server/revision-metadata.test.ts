import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store, docxOperationHash, gitImportInput, parseDocxImportInput } from './store.ts';
import { revisionMetadataInputHash, RevisionMetadataStore } from './revision-metadata.ts';
import { revisionMetadataFields, validRevisionMetadataResult, isRevisionMetadataHistory, type RevisionMetadataInput } from '../shared/revision-metadata.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { GitImportSnapshot } from '../shared/repositories.ts';
import type { DocxProjection } from '../shared/docx.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'first-key', requestId: 'metadata-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'bob-request' };
const epoch = (store: Store) => store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
const creation = () => ({ title: ' Original title ', summary: '\ufeffOriginal\r\nsummary  ', testPlan: ' Read exact source\r\n', kind: 'paper' as const, files: [{ path: 'paper.tex', content: '\ufeffSource\r\n' }] });
function input(store: Store, id: string, fields: Partial<Pick<RevisionMetadataInput, 'title' | 'summary' | 'testPlan' | 'message'>> = {}): RevisionMetadataInput {
  const snapshot = store.revisionMetadata.snapshot(id);
  return { title: snapshot.metadata.title, summary: snapshot.metadata.summary, testPlan: snapshot.metadata.testPlan ?? '', message: ' Exact reason\r\n', expectedMetadataVersion: snapshot.metadata.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedConfigId: snapshot.configId, expectedAccessEpoch: epoch(store), ...fields };
}
function data(store: Store, tables: string[]) { return Object.fromEntries(tables.map(table => [table, store.database.prepare(`SELECT rowid,* FROM "${table}" ORDER BY rowid`).all()])); }
function all(store: Store) { return data(store, (store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).map(row => row.name)); }

test('metadata edits preserve exact source, review acceptance, authorship and every unrelated storage row', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = store.createRevision(creation(), alice).revision.id;
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Verified source', findings: [] }, bob); lifecycleAction(store, id, 'accept_reviewed', alice);
    const tables = (store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'revision_metadata%' ORDER BY name").all() as { name: string }[]).map(row => row.name), before = data(store, tables);
    const request = input(store, id, { title: 'Updated title', summary: 'New summary\r\n\t', testPlan: 'Verified references and figures.\n' });
    const receipt = store.revisionMetadata.mutate(id, request, alice);
    assert.equal(receipt.changed, true); assert.equal(receipt.metadata.version, 1); assert.equal(receipt.inputSha256, revisionMetadataInputHash(request)); assert.ok(validRevisionMetadataResult(receipt, id, request, alice.principalId));
    assert.deepEqual(data(store, tables), before); assert.equal(store.detail(id).revision.status, 'accepted'); assert.equal(store.detail(id).revision.currentVersion, 1);
    assert.equal(store.detail(id).revision.title, request.title); assert.equal(store.detail(id).revision.summary, request.summary); assert.equal(store.detail(id).revision.testPlan, request.testPlan); assert.equal(store.detail(id).revision.metadataVersion, 1);
    assert.deepEqual(store.revisionMetadata.operation(receipt.operationId).receipt, receipt);
  } finally { store.close(); }
});

test('no-effect saves have immutable receipts but do not append history or advance metadata and survive later edits/source', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = store.createRevision(creation(), alice).revision.id, request = input(store, id), before = all(store), receipt = store.revisionMetadata.mutate(id, request, bob);
    assert.equal(receipt.changed, false); assert.equal(receipt.transaction, null); assert.equal(receipt.metadata.version, 0);
    const after = all(store); for (const table of Object.keys(before)) if (table !== 'revision_metadata_operations') assert.deepEqual(after[table], before[table], table);
    assert.equal(store.revisionMetadata.history(id).transactions.length, 0); assert.ok(validRevisionMetadataResult(receipt, id, request, bob.principalId));
    store.revisionMetadata.mutate(id, input(store, id, { title: 'Later title' }), alice);
    store.createVersion(id, { expectedVersion: 1, files: [{ path: 'paper.tex', content: 'New source' }], message: 'Next version' }, alice);
    assert.deepEqual(store.revisionMetadata.operation(receipt.operationId).receipt, receipt); assert.equal(store.detail(id).revision.title, 'Later title');
    assert.equal(JSON.parse(store.database.prepare('SELECT data FROM entities WHERE id=?').get(id)!.data as string).title, creation().title, 'source writers retain original raw metadata');
  } finally { store.close(); }
});

test('required plan, UTF-8 title, exact corpus boundaries and reserved headers apply consistently to fresh fields', () => {
  assert.equal(revisionMetadataFields({ title: 'é'.repeat(127) + 'a', testPlan: ' ' }, true).testPlan, ' ');
  assert.equal(revisionMetadataFields({ title: ' ', summary: '\ufeffexact\r\n', testPlan: '\t' }, true).title, ' ');
  assert.equal(revisionMetadataFields({ title: 'x' }, false).testPlan, '');
  for (const fields of [{ title: '' }, { title: 'é'.repeat(128) }, { title: '\ud800' }, { title: 'x', testPlan: '' }, { title: 'x', testPlan: null }, { title: 'x', testPlan: 'valid', summary: 'x'.repeat(100_001) }, { title: 'x', testPlan: 'Tests: ambiguous' }, { title: 'x', testPlan: 'valid', summary: 'Before\r\nSummary: ambiguous' }]) assert.throws(() => revisionMetadataFields(fields, true));
  const store = new Store({ path: ':memory:' }); try {
    for (const draft of [false, true]) { const { testPlan: _plan, ...without } = creation(); assert.throws(() => store.createRevision({ ...without, draft }, alice), { code: 'REVISION_METADATA_INVALID_INPUT' }); }
    assert.equal(store.state({ configured: false, model: null }).revisions.length, 0);
    const id = store.createRevision(creation(), alice).revision.id, before = all(store);
    assert.throws(() => store.revisionMetadata.mutate(id, input(store, id, { testPlan: '' }), alice), { code: 'REVISION_METADATA_INVALID_INPUT' }); assert.deepEqual(all(store), before);
  } finally { store.close(); }
});

test('all optimistic source/metadata/config/access pins are enforced and failed writes roll back', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = store.createRevision(creation(), alice).revision.id, request = input(store, id, { title: 'Change' }), before = all(store);
    const changes: Partial<RevisionMetadataInput>[] = [{ expectedMetadataVersion: 1 }, { expectedVersion: 2 }, { expectedVersionId: 'another-source' }, { expectedContentHash: 'a'.repeat(64) }, { expectedConfigId: 'b'.repeat(64) }, { expectedAccessEpoch: epoch(store) + 1 }];
    for (const change of changes) { assert.throws(() => store.revisionMetadata.mutate(id, { ...request, ...change }, alice), { status: 409 }); assert.deepEqual(all(store), before); }
    assert.throws(() => store.revisionMetadata.mutate(id, request, { ...alice, principalId: '' }), { status: 400 });
    store.database.exec("CREATE TRIGGER fail_metadata BEFORE UPDATE ON revision_metadata BEGIN SELECT RAISE(ABORT,'metadata rollback'); END");
    assert.throws(() => store.revisionMetadata.mutate(id, request, alice), /metadata rollback/); assert.deepEqual(all(store), before);
  } finally { store.close(); }
});

test('canonical changed and no-op operations reject forged input, state, source, configuration and receipts', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = store.createRevision(creation(), alice).revision.id;
    for (const changed of [false, true]) {
      const receipt = store.revisionMetadata.mutate(id, input(store, id, changed ? { title: 'Changed' } : {}), alice), original = store.revisionMetadata.operation(receipt.operationId);
      store.database.exec('DROP TRIGGER IF EXISTS revision_metadata_operations_no_update');
      for (const forge of [(value: typeof original) => { value.receipt.metadata.summary = 'Forged'; }, (value: typeof original) => { value.head.versionId = 'wrong'; }, (value: typeof original) => { value.config = { requireTestPlan: false }; }, (value: typeof original) => { value.before.version++; }, (value: typeof original) => { value.input.title = 'Other'; value.inputSha256 = revisionMetadataInputHash(value.input); value.receipt.inputSha256 = value.inputSha256; }]) {
        const forged = structuredClone(original); forge(forged);
        store.database.prepare('UPDATE revision_metadata_operations SET input_sha256=?,data=? WHERE id=?').run(forged.inputSha256, JSON.stringify(forged), original.id);
        assert.throws(() => store.revisionMetadata.operation(original.id), { code: 'REVISION_METADATA_INVALID_RECEIPT' });
      }
      store.database.prepare('UPDATE revision_metadata_operations SET input_sha256=?,data=? WHERE id=?').run(original.inputSha256, JSON.stringify(original), original.id); assert.deepEqual(store.revisionMetadata.operation(original.id), original);
    }
  } finally { store.close(); }
});

test('bounded immutable history pins retain exact old/new text and filter no-op saves', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = store.createRevision(creation(), alice).revision.id;
    for (let index = 1; index <= 4; index++) store.revisionMetadata.mutate(id, input(store, id, { summary: `Edit ${index}\r\n` }), alice);
    store.revisionMetadata.mutate(id, input(store, id), alice);
    const first = store.revisionMetadata.history(id, { limit: 2, expectedMetadataVersion: 4 }), second = store.revisionMetadata.history(id, { limit: 2, before: first.nextBefore!, expectedMetadataVersion: 4 });
    assert.deepEqual(first.transactions.map(t => t.metadataVersion), [4, 3]); assert.deepEqual(second.transactions.map(t => t.metadataVersion), [2, 1]); assert.equal(second.nextBefore, null);
    assert.ok(isRevisionMetadataHistory({ ...first, accessEpoch: epoch(store) }, id)); assert.equal(second.transactions[1]!.before.summary, creation().summary);
    assert.throws(() => store.revisionMetadata.history(id, { expectedMetadataVersion: 3 }), { code: 'REVISION_METADATA_CHANGED' }); assert.throws(() => store.revisionMetadata.history(id, { limit: 101 }), { status: 400 });
    for (const table of ['revision_metadata_baselines', 'revision_metadata_transactions', 'revision_metadata_operations']) assert.throws(() => store.database.exec(`DELETE FROM ${table}`), /immutable/);
  } finally { store.close(); }
});

test('fresh Git and Word creation enforce required plans without changing old wire normalization or package identity', () => {
  const store = new Store({ path: ':memory:' }); try {
    const repository = store.createRepository({ name: 'Fixture', remoteUrl: 'https://example.com/fixture.git' });
    const content = 'Exact Git source\n', commitId = 'a'.repeat(40), snapshot: GitImportSnapshot = { repositoryId: repository.id, objectFormat: 'sha1', files: [{ path: 'file.txt', content }], provenance: { kind: 'git', repositoryId: repository.id, objectFormat: 'sha1', commitId, treeId: 'b'.repeat(40), scope: 'complete-text-tree', manifest: [{ path: 'file.txt', mode: '100644', objectId: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex') }] } };
    const gitInput = { commitId, title: 'Git draft', kind: 'code' as const, draft: true }; assert.equal(Object.hasOwn(gitImportInput(gitInput), 'testPlan'), false);
    assert.throws(() => store.createRevisionFromGit(repository.id, gitInput, snapshot, alice), { code: 'REVISION_METADATA_INVALID_INPUT' });
    const git = store.createRevisionFromGit(repository.id, { ...gitInput, testPlan: 'Compared exact tree.' }, snapshot, alice); assert.equal(git.revision.testPlan, 'Compared exact tree.');
    const bytes = Buffer.from('Trusted parser fixture'), digest = createHash('sha256').update(bytes).digest('hex'), file = store.files.upload({ name: 'paper.docx', dataBase64: bytes.toString('base64'), bytes: bytes.length, sha256: digest }, alice);
    const sourceFile = { fileId: file.id, sha256: digest, bytes: bytes.length }, projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] };
    const docx = { title: 'Word draft', draft: true, sourceFile, expectedAccessEpoch: epoch(store), shareSource: false }; assert.equal(Object.hasOwn(parseDocxImportInput(docx), 'testPlan'), false); assert.equal(docxOperationHash(docx), docxOperationHash(parseDocxImportInput(docx)));
    assert.throws(() => store.createDocxRevision(docx, bytes, projection, alice), { code: 'REVISION_METADATA_INVALID_INPUT' });
    const word = store.createDocxRevision({ ...docx, testPlan: 'Read every paragraph.' }, bytes, projection, alice); assert.equal(word.revision.testPlan, 'Read every paragraph.'); assert.deepEqual(store.docxBytes(word.revision.id, word.versions[0]!.id), Uint8Array.from(bytes));
  } finally { store.close(); }
});

test('optional-plan configuration is strict, pins changes, and preserves historical empty-plan operation receipts', () => {
  const store = new Store({ path: ':memory:', revisionMetadata: { requireTestPlan: false } }); try {
    const { testPlan: _plan, ...fields } = creation(), id = store.createRevision(fields, alice).revision.id; assert.equal(store.detail(id).revision.testPlan, '');
    const receipt = store.revisionMetadata.mutate(id, input(store, id, { title: 'Optional plan edited' }), alice), required = new RevisionMetadataStore(store.database);
    assert.deepEqual(required.operation(receipt.operationId).receipt, receipt); assert.notEqual(required.configId, store.revisionMetadata.configId);
    assert.throws(() => required.mutate(id, input(store, id, { testPlan: 'Now verified' }), alice), { code: 'REVISION_METADATA_CHANGED' });
    assert.throws(() => new RevisionMetadataStore(store.database, { requireTestPlan: undefined }), /configuration/);
  } finally { store.close(); }
});
