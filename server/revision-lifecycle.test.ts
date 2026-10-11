import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionLifecycleAction } from '../shared/revision-lifecycle.ts';
import type { DocxProjection } from '../shared/docx.ts';
import type { GitImportSnapshot } from '../shared/repositories.ts';
import { Store } from './store.ts';
import { RevisionLifecycleStore, revisionLifecycleInputHash } from './revision-lifecycle.ts';
import { RevisionReviewerStore } from './revision-reviewers.ts';
import { lifecycleAction, lifecycleInput, closeRevision } from '../tests/revision-lifecycle-fixture.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Original Alice', credentialId: 'alice-key', requestId: 'request-alice' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'request-bob' };
const files = [{ path: 'source.txt', content: '\ufeffExact original\r\n' }];
const create = (store: Store, draft = false, actor: ActorAttribution | undefined = alice) => store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Lifecycle manuscript', kind: 'paper', files, draft }, actor).revision.id;
const state = (store: Store, id: string) => store.revisionLifecycle.state(id);
const review = (store: Store, id: string, error = false) => store.saveReview(id, store.detail(id).revision.currentVersion, { provider: 'local', model: 'fixture', summary: 'Exact source evidence', findings: error ? [{ id: 'error', source: 'local', severity: 'error', filePath: 'source.txt', line: 1, title: 'Error', body: 'Blocking finding' }] : [] }, bob);
const update = (store: Store, id: string) => store.createVersion(id, { expectedVersion: store.detail(id).revision.currentVersion, files: [{ path: 'source.txt', content: 'Next immutable source' }], message: 'New content' }, bob);
const rows = (store: Store) => Object.fromEntries((store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]));

test('draft and ordinary creation initialize truthful version-zero baselines without fabricated events', () => {
  const store = new Store({ path: ':memory:' }); try {
    for (const draft of [false, true]) {
      const id = create(store, draft), lifecycle = state(store, id);
      assert.deepEqual(lifecycle, { revisionId: id, version: 0, status: draft ? 'draft' : 'needs_review', reviewStarted: !draft, closedFromAccepted: null, resumeAcceptanceHead: null, updatedAt: null });
      assert.equal(store.detail(id).revision.lifecycleVersion, 0); assert.deepEqual(store.revisionLifecycle.history(id).transactions, []);
      assert.equal(JSON.parse(store.database.prepare('SELECT data FROM entities WHERE id=?').get(id)!.data as string).lifecycleVersion, undefined);
    }
    for (const draft of [null, 1, 'true']) assert.throws(() => store.createRevision({ title: 'Invalid draft', files, draft }), { status: 400 });
    const unknown = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Legacy-style unowned', files }).revision.id;
    assert.equal(store.revisionLifecycle.snapshot(unknown).authorship.author, null);
    assert.throws(() => lifecycleAction(store, unknown, 'plan_changes', alice), { code: 'REVISION_LIFECYCLE_ACTION_UNAVAILABLE' });
  } finally { store.close(); }
});

test('actions preserve source/evidence and distinguish author duties from editor evidence acceptance', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store, true), original = store.detail(id).versions;
    lifecycleAction(store, id, 'request_review', bob, 'Editor publishes a shared draft');
    assert.equal(state(store, id).reviewStarted, true);
    for (const action of ['plan_changes', 'abandon', 'request_review'] as RevisionLifecycleAction[]) assert.throws(() => lifecycleAction(store, id, action, bob), { status: 409 });
    review(store, id); const receipt = lifecycleAction(store, id, 'accept_reviewed', bob, '\ufeffExact\r\nmessage  ');
    assert.equal(state(store, id).status, 'accepted'); assert.equal(receipt.inputSha256, revisionLifecycleInputHash(store.revisionLifecycle.operation(receipt.operationId).input));
    assert.throws(() => lifecycleAction(store, id, 'close', bob), { status: 409 });
    lifecycleAction(store, id, 'close', alice); assert.equal(state(store, id).closedFromAccepted, true);
    assert.throws(() => lifecycleAction(store, id, 'reopen', alice), { status: 409 });
    assert.deepEqual(store.detail(id).versions, original); assert.equal(store.detail(id).reviews.length, 1);
    assert.deepEqual(store.revisionLifecycle.operation(receipt.operationId).receipt, receipt);
    assert.throws(() => store.updateRevision(id, { status: 'draft', expectedVersion: 1 }, alice), { code: 'REVISION_LIFECYCLE_ACTION_REQUIRED' });
    assert.throws(() => store.database.prepare('DELETE FROM revision_lifecycle_operations WHERE id=?').run(receipt.operationId), /immutable/);
    assert.throws(() => store.database.prepare('UPDATE revision_lifecycle_transactions SET data=data WHERE id=?').run(receipt.transaction.id), /immutable/);
  } finally { store.close(); }
});

test('same-head planned changes retain acceptance until a new source or current error invalidates it', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); review(store, id); lifecycleAction(store, id, 'accept_reviewed', bob);
    lifecycleAction(store, id, 'plan_changes', alice); const marker = state(store, id).resumeAcceptanceHead;
    assert.deepEqual(marker, store.revisionLifecycle.snapshot(id).head);
    lifecycleAction(store, id, 'request_review', alice); assert.equal(state(store, id).status, 'accepted');
    lifecycleAction(store, id, 'plan_changes', alice); review(store, id, true);
    assert.equal(state(store, id).status, 'changes_planned'); assert.equal(state(store, id).resumeAcceptanceHead, null);
    assert.equal(store.revisionLifecycle.history(id).transactions[0]!.action, 'review_invalidated');
    lifecycleAction(store, id, 'request_review', alice); assert.equal(state(store, id).status, 'needs_review');
    assert.throws(() => lifecycleAction(store, id, 'accept_reviewed', bob), { status: 409 });
    update(store, id); review(store, id); lifecycleAction(store, id, 'accept_reviewed', bob); lifecycleAction(store, id, 'plan_changes', alice);
    update(store, id); assert.equal(state(store, id).status, 'needs_review'); assert.equal(state(store, id).resumeAcceptanceHead, null);
    assert.equal(store.revisionLifecycle.history(id).transactions[0]!.action, 'source_updated');
  } finally { store.close(); }
});

test('abandon and reclaim remember whether review started, including after source updates', () => {
  const store = new Store({ path: ':memory:' }); try {
    for (const draft of [true, false]) {
      const id = create(store, draft); lifecycleAction(store, id, 'abandon', alice);
      lifecycleAction(store, id, 'reclaim', alice); assert.equal(state(store, id).status, draft ? 'draft' : 'needs_review');
      lifecycleAction(store, id, 'abandon', alice); update(store, id);
      assert.equal(state(store, id).status, draft ? 'draft' : 'needs_review'); assert.equal(state(store, id).version, 4);
    }
  } finally { store.close(); }
});

test('source updates preserve closed and draft states and always append distinct lifecycle evidence', () => {
  const store = new Store({ path: ':memory:', revisionLifecycle: { allowReopen: true } }); try {
    const draft = create(store, true); update(store, draft); update(store, draft);
    assert.equal(state(store, draft).status, 'draft'); assert.equal(state(store, draft).version, 2);
    const id = create(store); closeRevision(store, id, alice); const old = store.revisionLifecycle.snapshot(id).head;
    update(store, id); assert.equal(state(store, id).status, 'closed'); assert.equal(state(store, id).resumeAcceptanceHead, null);
    const event = store.revisionLifecycle.history(id).transactions[0]!; assert.deepEqual(event.beforeHead, old); assert.equal(event.head.number, 2);
    lifecycleAction(store, id, 'reopen', bob); assert.equal(state(store, id).status, 'needs_review');
    assert.throws(() => lifecycleAction(store, id, 'accept_reviewed', alice), { status: 409 });
    review(store, id); lifecycleAction(store, id, 'accept_reviewed', alice); review(store, id, true);
    assert.equal(state(store, id).status, 'changes_requested'); assert.equal(store.revisionLifecycle.history(id).transactions[0]!.action, 'review_invalidated');
  } finally { store.close(); }
});

test('operator configuration controls editor close/abandon and accepted terminal behavior', () => {
  const store = new Store({ path: ':memory:', revisionLifecycle: { alwaysAllowClose: true, alwaysAllowAbandon: true, allowReopen: true } }); try {
    const id = create(store); lifecycleAction(store, id, 'abandon', bob); lifecycleAction(store, id, 'reclaim', alice);
    review(store, id); lifecycleAction(store, id, 'accept_reviewed', bob); lifecycleAction(store, id, 'close', bob); lifecycleAction(store, id, 'reopen', bob);
    const closed = new RevisionLifecycleStore(store.database, { closeOnAccept: true }); closed.connectReviewers(new RevisionReviewerStore(store.database, closed));
    review(store, id); assert.equal(state(store, id).status, 'accepted', 'reopening unchanged accepted evidence reassesses its existing basis');
    for (const action of ['request_review', 'plan_changes', 'abandon', 'close'] as const) assert.equal(closed.snapshot(id, alice.principalId).actions.find(row => row.action === action)!.available, false);
    assert.throws(() => new RevisionLifecycleStore(store.database, { allowReopen: 'true' as unknown as boolean }), /configuration/);
    assert.throws(() => new RevisionLifecycleStore(store.database, { surprise: false } as never), /configuration/);
  } finally { store.close(); }
});

test('all independent action pins, evidence changes, ABA source identity and author handoff are checked atomically', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), input = lifecycleInput(store, id, 'plan_changes');
    for (const changed of [{ expectedLifecycleVersion: 1 }, { expectedReviewerVersion: 1 }, { expectedAuthorVersion: 1 }, { expectedVersion: 2 }, { expectedVersionId: 'other' }, { expectedContentHash: 'f'.repeat(64) }, { expectedAccessEpoch: input.expectedAccessEpoch + 1 }, { expectedConfigId: 'a'.repeat(64) }, { expectedEvidenceSha256: 'a'.repeat(64) }]) {
      const before = rows(store); assert.throws(() => store.revisionLifecycle.mutate(id, { ...input, ...changed }, alice), { status: 409 }); assert.deepEqual(rows(store), before);
    }
    review(store, id); assert.throws(() => store.revisionLifecycle.mutate(id, input, alice), { code: 'REVISION_LIFECYCLE_CHANGED' });
    const authorInput = lifecycleInput(store, id, 'plan_changes');
    store.revisionAuthorship.mutate(id, { action: 'assign', authorId: bob.principalId, message: '', expectedAuthorVersion: 0, expectedReviewerVersion: authorInput.expectedReviewerVersion, expectedLifecycleVersion: authorInput.expectedLifecycleVersion, expectedVersion: authorInput.expectedVersion, expectedVersionId: authorInput.expectedVersionId, expectedContentHash: authorInput.expectedContentHash, expectedAccessEpoch: authorInput.expectedAccessEpoch }, alice, { principalId: bob.principalId, displayName: bob.displayName });
    assert.throws(() => store.revisionLifecycle.mutate(id, { ...authorInput, expectedAccessEpoch: lifecycleInput(store, id, 'plan_changes').expectedAccessEpoch }, alice), { code: 'REVISION_LIFECYCLE_CHANGED' });
    const stale = lifecycleInput(store, id, 'plan_changes'); store.createVersion(id, { expectedVersion: 1, files, message: 'Identical content, new immutable version' }, bob);
    assert.equal(store.revisionLifecycle.snapshot(id).head.contentHash, stale.expectedContentHash);
    assert.throws(() => store.revisionLifecycle.mutate(id, stale, bob), { code: 'REVISION_LIFECYCLE_CHANGED' });
  } finally { store.close(); }
});

test('source and review hook failures roll back new source, evidence, sequence and activity together', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); review(store, id); lifecycleAction(store, id, 'accept_reviewed', bob);
    store.database.exec("CREATE TRIGGER refuse_lifecycle BEFORE INSERT ON revision_lifecycle_transactions BEGIN SELECT RAISE(ABORT,'injected lifecycle failure'); END");
    const before = rows(store);
    for (const work of [() => update(store, id), () => review(store, id, true), () => lifecycleAction(store, id, 'plan_changes', alice)]) { assert.throws(work, /injected lifecycle failure/); assert.deepEqual(rows(store), before); }
  } finally { store.close(); }
});

test('historical receipt proof survives later evidence, source, configuration and author changes', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); review(store, id); const receipt = lifecycleAction(store, id, 'accept_reviewed', bob);
    const planned = lifecycleAction(store, id, 'plan_changes', alice);
    review(store, id, true); update(store, id);
    const pin = lifecycleInput(store, id, 'plan_changes'); store.revisionAuthorship.mutate(id, { action: 'assign', authorId: bob.principalId, message: '', expectedAuthorVersion: 0, expectedReviewerVersion: pin.expectedReviewerVersion, expectedLifecycleVersion: pin.expectedLifecycleVersion, expectedVersion: pin.expectedVersion, expectedVersionId: pin.expectedVersionId, expectedContentHash: pin.expectedContentHash, expectedAccessEpoch: pin.expectedAccessEpoch }, alice, { principalId: bob.principalId, displayName: bob.displayName });
    const configured = new RevisionLifecycleStore(store.database, { closeOnAccept: true }); configured.connectReviewers(new RevisionReviewerStore(store.database, configured));
    assert.deepEqual(configured.operation(receipt.operationId).receipt, receipt); assert.deepEqual(configured.operation(planned.operationId).receipt, planned);
    assert.equal(configured.operationRevisionId(receipt.operationId), id);
    store.database.exec('DROP TRIGGER revision_lifecycle_operations_no_update');
    const original = store.database.prepare('SELECT data FROM revision_lifecycle_operations WHERE id=?').get(planned.operationId)!.data as string;
    for (const patch of [{ authorship: { version: 0, author: { principalId: bob.principalId, displayName: bob.displayName } } }, { config: { ...store.revisionLifecycle.config, ignored: true } }, { before: { ...JSON.parse(original).before, surprise: true } }, { reviewProofs: [] }, { attribution: { ...alice, credentialId: 'forged' } }]) {
      store.database.prepare('UPDATE revision_lifecycle_operations SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(original), ...patch }), planned.operationId);
      assert.throws(() => store.revisionLifecycle.operation(planned.operationId), { code: 'REVISION_LIFECYCLE_INVALID_RECEIPT' });
    }
    store.database.prepare('UPDATE revision_lifecycle_operations SET data=? WHERE id=?').run(original, planned.operationId);
    assert.deepEqual(store.revisionLifecycle.operation(planned.operationId).receipt, planned);
  } finally { store.close(); }
});

test('history pagination and metadata integrity fail closed without reading manuscript bodies', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), message = '\ufeff\r\n😀' + 'x'.repeat(9995);
    const first = lifecycleAction(store, id, 'plan_changes', alice, message); lifecycleAction(store, id, 'request_review', alice); lifecycleAction(store, id, 'plan_changes', alice);
    const page = store.revisionLifecycle.history(id, { limit: 2, expectedLifecycleVersion: 3 }); assert.deepEqual(page.transactions.map(t => t.lifecycleVersion), [3, 2]); assert.equal(page.nextBefore, 2);
    assert.deepEqual(store.revisionLifecycle.history(id, { before: 2 }).transactions, [first.transaction]);
    for (const query of [{ before: 0 }, { limit: 0 }, { limit: 101 }, { expectedLifecycleVersion: -1 }]) assert.throws(() => store.revisionLifecycle.history(id, query), { status: 400 });
    assert.throws(() => store.revisionLifecycle.history(id, { expectedLifecycleVersion: 2 }), { status: 409 });
    assert.throws(() => lifecycleAction(store, id, 'request_review', alice, 'x'.repeat(10001)), { status: 400 });
    store.database.prepare("UPDATE versions SET data=json_remove(data,'$.files') WHERE revision_id=?").run(id);
    assert.equal(store.revisionLifecycle.snapshot(id).head.number, 1, 'metadata identity is not source-body verification');
    store.database.prepare("UPDATE entities SET data=json_set(data,'$.currentVersion',json('true')) WHERE id=?").run(id);
    assert.throws(() => store.revisionLifecycle.snapshot(id), { code: 'REVISION_LIFECYCLE_INVALID_RECEIPT' });
  } finally { store.close(); }
});

test('review evidence has an explicit count bound and any exact review mutation invalidates receipt proof', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), saved = review(store, id), receipt = lifecycleAction(store, id, 'accept_reviewed', bob);
    store.database.prepare("UPDATE reviews SET data=json_set(data,'$.summary','Changed historical evidence') WHERE id=?").run(saved.id);
    assert.throws(() => store.revisionLifecycle.operation(receipt.operationId), { code: 'REVISION_LIFECYCLE_INVALID_RECEIPT' });
    const insert = store.database.prepare('INSERT INTO reviews(id,revision_id,version_id,data) VALUES(?,?,?,?)');
    for (let n = 0; n < 1000; n++) { const next = { ...saved, id: `bounded-${String(n).padStart(4, '0')}` }; insert.run(next.id, id, next.versionId, JSON.stringify(next)); }
    assert.throws(() => store.revisionLifecycle.snapshot(id), { code: 'REVISION_LIFECYCLE_LIMIT' });
  } finally { store.close(); }
});

test('Git and DOCX draft creation and subsequent package/source hooks share exact lifecycle semantics', () => {
  const store = new Store({ path: ':memory:' }); try {
    const repo = store.createRepository({ name: 'Fixture', remoteUrl: 'https://example.test/repository.git' });
    const git: GitImportSnapshot = { repositoryId: repo.id, objectFormat: 'sha1', files, provenance: { kind: 'git', repositoryId: repo.id, objectFormat: 'sha1', scope: 'complete-text-tree', commitId: 'a'.repeat(40), treeId: 'b'.repeat(40), manifest: [{ path: files[0]!.path, mode: '100644', objectId: createHash('sha1').update(`blob ${Buffer.byteLength(files[0]!.content)}\0${files[0]!.content}`).digest('hex') }] } };
    const imported = store.createRevisionFromGit(repo.id, { testPlan: 'Fixture verification plan.', commitId: git.provenance.commitId, kind: 'paper', title: 'Git draft', draft: true }, git, alice);
    assert.equal(state(store, imported.revision.id).status, 'draft');
    const bytes = Buffer.from('trusted package fixture'), hash = createHash('sha256').update(bytes).digest('hex');
    const file = store.files.upload({ name: 'source.docx', bytes: bytes.length, sha256: hash, dataBase64: bytes.toString('base64') }, alice);
    const projection: DocxProjection = { format: 'phabricator.docx.projection.v1', mainPart: 'word/document.xml', blocks: [], notes: [], comments: [], changes: [], editableRanges: [], warnings: [] };
    const epoch = lifecycleInput(store, imported.revision.id, 'request_review').expectedAccessEpoch;
    const docx = store.createDocxRevision({ testPlan: 'Fixture verification plan.', title: 'DOCX draft', sourceFile: { fileId: file.id, sha256: hash, bytes: bytes.length }, expectedAccessEpoch: epoch, shareSource: false, draft: true }, bytes, projection, alice);
    const id = docx.revision.id, head = docx.versions[0]!; assert.equal(state(store, id).reviewStarted, false);
    store.createDocxVersion(id, { sourceFile: head.docx!.sourceFile, expectedVersion: 1, expectedVersionId: head.id, expectedContentHash: head.contentHash, expectedAccessEpoch: epoch, shareSource: false, message: 'Imported again' }, bytes, projection, alice);
    assert.equal(state(store, id).status, 'draft'); assert.equal(state(store, id).version, 1); assert.equal(store.revisionLifecycle.history(id).transactions[0]!.head.number, 2);
  } finally { store.close(); }
});
