import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionReviewerInput, RevisionReviewerAction } from '../shared/revision-reviewers.ts';
import { Store } from './store.ts';
import { lifecycleAction, lifecycleInput } from '../tests/revision-lifecycle-fixture.ts';
import { revisionReviewerInputHash } from './revision-reviewers.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'alice-review' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: 'bob-token', requestId: 'bob-review' };
const carol: ActorAttribution = { principalId: 'carol', displayName: 'Carol', credentialId: null, requestId: 'carol-review' };
const ref = (actor: ActorAttribution) => ({ principalId: actor.principalId, displayName: actor.displayName });
const epoch = (store: Store) => store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
function create(store: Store, draft = false) { return store.createRevision({ testPlan: 'Fixture verification plan.', title: 'Exact paper', kind: 'paper', draft, files: [{ path: 'paper.tex', content: '\ufeffExact source\r\n' }] }, alice).revision.id; }
function input(store: Store, id: string, action: RevisionReviewerAction, target?: ActorAttribution): RevisionReviewerInput {
  const snapshot = store.revisionReviewers.snapshot(id);
  const pins = { message: ' Exact reviewer attestation\r\n', expectedReviewerVersion: snapshot.reviewers.version, expectedLifecycleVersion: snapshot.lifecycle.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: epoch(store), expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 };
  return ['add', 'remove', 'block', 'unblock'].includes(action) ? { action: action as 'add', reviewerId: target!.principalId, ...pins } : { action: action as 'accept', ...pins };
}
function act(store: Store, id: string, action: RevisionReviewerAction, actor = bob, target?: ActorAttribution) { return store.revisionReviewers.mutate(id, input(store, id, action, target), actor, target && ref(target)); }
function source(store: Store, id: string) { const number = store.detail(id).revision.currentVersion; store.createVersion(id, { expectedVersion: number, message: 'Next immutable version', files: [{ path: 'paper.tex', content: `Version ${number + 1}` }] }, alice); }
function transfer(store: Store, id: string, target: ActorAttribution) {
  const snapshot = store.revisionAuthorship.snapshot(id);
  return store.revisionAuthorship.mutate(id, { action: 'assign', authorId: target.principalId, message: 'Transfer', expectedAuthorVersion: snapshot.authorship.version, expectedReviewerVersion: snapshot.reviewerVersion, expectedLifecycleVersion: snapshot.lifecycleVersion, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: epoch(store) }, alice, ref(target));
}
function rows(store: Store) { return Object.fromEntries((store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(({ name }) => [name, store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])); }

test('independent people accept exact source without fabricating ReviewRuns; immutable history survives later decisions and source', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), original = store.database.prepare('SELECT data FROM versions WHERE revision_id=?').get(id)!.data, beforeEpoch = epoch(store);
    const request = input(store, id, 'accept'), receipt = store.revisionReviewers.mutate(id, request, bob);
    assert.equal(store.detail(id).revision.status, 'accepted'); assert.equal(store.detail(id).reviews.length, 0); assert.equal(epoch(store), beforeEpoch);
    assert.equal(receipt.transaction.reviewerVersion, 1); assert.equal(receipt.transaction.lifecycleVersion, 1); assert.equal(receipt.inputSha256, revisionReviewerInputHash(request));
    assert.equal(store.revisionReviewers.state(id).acceptance?.kind, 'reviewers'); assert.equal(store.detail(id).revision.reviewerVersion, 1);
    assert.equal(store.database.prepare('SELECT data FROM versions WHERE revision_id=?').get(id)!.data, original);
    assert.deepEqual(store.revisionReviewers.operation(receipt.operationId).receipt, receipt);
    act(store, id, 'request_changes', bob); source(store, id);
    assert.deepEqual(store.revisionReviewers.operation(receipt.operationId).receipt, receipt);
    assert.throws(() => store.database.prepare('UPDATE revision_reviewer_transactions SET data=data WHERE id=?').run(receipt.transaction.id), /immutable/);
    assert.throws(() => store.database.prepare('DELETE FROM revision_reviewer_operations WHERE id=?').run(receipt.operationId), /immutable/);
  } finally { store.close(); }
});

test('required reviewers and old rejections block both human and native evidence acceptance until explicitly cleared', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); act(store, id, 'add', alice, carol); act(store, id, 'block', alice, carol); act(store, id, 'accept', bob);
    assert.equal(store.detail(id).revision.status, 'needs_review');
    store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'No errors', findings: [] }, alice);
    assert.throws(() => lifecycleAction(store, id, 'accept_reviewed', alice), /required reviews/);
    act(store, id, 'unblock', alice, carol); assert.equal(store.detail(id).revision.status, 'accepted');
    act(store, id, 'request_changes', carol); assert.equal(store.detail(id).revision.status, 'changes_requested'); source(store, id);
    assert.equal(store.detail(id).revision.status, 'needs_review'); act(store, id, 'accept', bob); assert.equal(store.detail(id).revision.status, 'needs_review');
    assert.equal(store.revisionLifecycle.snapshot(id).reviewers.olderRejecting, 1);
    lifecycleAction(store, id, 'plan_changes', alice); const planned = store.revisionLifecycle.snapshot(id, alice.principalId);
    assert.equal(planned.actions.find(option => option.action === 'request_review')!.targetStatus, 'accepted');
    lifecycleAction(store, id, 'request_review', alice); assert.equal(store.detail(id).revision.status, 'accepted');
    assert.equal(store.revisionReviewers.state(id).members.find(member => member.principalId === carol.principalId)!.decision!.invalidated!.reason, 'request_review');
  } finally { store.close(); }
});

test('membership blocking toggles reset decisions and resignation/removal reassess without losing historical decisions', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); act(store, id, 'accept'); act(store, id, 'block', alice, bob);
    assert.equal(store.detail(id).revision.status, 'needs_review'); assert.equal(store.revisionReviewers.state(id).members[0]!.decision, null);
    act(store, id, 'unblock', alice, bob); act(store, id, 'accept'); act(store, id, 'resign');
    assert.equal(store.detail(id).revision.status, 'needs_review'); assert.equal(store.revisionReviewers.state(id).members[0]!.status, 'resigned');
    assert.throws(() => act(store, id, 'add', alice, bob), /no effect/); act(store, id, 'remove', alice, bob); act(store, id, 'add', alice, bob);
    act(store, id, 'request_changes', bob); act(store, id, 'remove', alice, bob); assert.equal(store.detail(id).revision.status, 'needs_review');
    const history = store.revisionReviewers.history(id, { limit: 3 }); assert.equal(history.transactions.length, 3); assert.equal(history.nextBefore, history.transactions.at(-1)!.reviewerVersion);
    assert.ok(store.revisionReviewers.history(id, { before: history.nextBefore! }).transactions.some(transaction => transaction.action === 'accept'));
  } finally { store.close(); }
});

test('reviewable, planned, draft and terminal action rules respect self acceptance and explicit reviewer role', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store, true);
    assert.throws(() => act(store, id, 'accept'), /Request review/); act(store, id, 'add', alice, bob); act(store, id, 'resign');
    assert.throws(() => act(store, id, 'resign'), /current reviewer/); lifecycleAction(store, id, 'request_review', alice);
    assert.throws(() => act(store, id, 'accept', alice), /current author/); assert.throws(() => act(store, id, 'request_changes', alice), /current author/);
    assert.throws(() => act(store, id, 'add', bob, alice), /current author/);
    lifecycleAction(store, id, 'plan_changes', alice); act(store, id, 'accept'); assert.equal(store.detail(id).revision.status, 'changes_planned');
    assert.equal(store.revisionLifecycle.snapshot(id, alice.principalId).actions.find(action => action.action === 'request_review')!.targetStatus, 'accepted');
    lifecycleAction(store, id, 'request_review', alice); lifecycleAction(store, id, 'close', alice);
    for (const action of ['accept', 'request_changes', 'resign'] as const) assert.throws(() => act(store, id, action), /Closed or abandoned/);
    const abandoned = create(store); act(store, abandoned, 'add', alice, bob); lifecycleAction(store, abandoned, 'abandon', alice); assert.throws(() => act(store, abandoned, 'resign'), /Closed or abandoned/);
  } finally { store.close(); }
  const self = new Store({ path: ':memory:', revisionReviewers: { allowSelfAccept: true }, revisionLifecycle: { closeOnAccept: true } }); try {
    const id = create(self); act(self, id, 'accept', alice); assert.equal(self.detail(id).revision.status, 'accepted');
    assert.throws(() => act(self, id, 'accept', bob), /Closed or abandoned/); assert.throws(() => act(self, id, 'request_changes', alice), /Closed or abandoned/);
    const other = create(self); assert.throws(() => act(self, other, 'request_changes', alice), /current author/);
  } finally { self.close(); }
});

test('reopen and reclaim reassess retained exact reviewer decisions and native evidence provenance', () => {
  const store = new Store({ path: ':memory:', revisionLifecycle: { allowReopen: true } }); try {
    const id = create(store); act(store, id, 'accept'); lifecycleAction(store, id, 'close', alice);
    let snapshot = store.revisionLifecycle.snapshot(id, alice.principalId); assert.equal(snapshot.actions.find(action => action.action === 'reopen')!.targetStatus, 'accepted');
    const opened = lifecycleAction(store, id, 'reopen', alice); assert.equal(opened.transaction.toStatus, 'accepted'); assert.deepEqual(store.revisionLifecycle.operation(opened.operationId).receipt, opened);
    lifecycleAction(store, id, 'abandon', alice); act(store, id, 'block', alice, bob);
    snapshot = store.revisionLifecycle.snapshot(id, alice.principalId); assert.equal(snapshot.actions.find(action => action.action === 'reclaim')!.targetStatus, 'needs_review'); lifecycleAction(store, id, 'reclaim', alice);
    act(store, id, 'request_changes', bob); lifecycleAction(store, id, 'abandon', alice); const reclaimed = lifecycleAction(store, id, 'reclaim', alice); assert.equal(reclaimed.transaction.toStatus, 'changes_requested');
    assert.deepEqual(store.revisionLifecycle.operation(reclaimed.operationId).receipt, reclaimed);
  } finally { store.close(); }
});

test('author transfers remove the new author, add the former author and invalidate sole-vote acceptance atomically', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); act(store, id, 'accept'); const beforeSource = store.database.prepare('SELECT data FROM versions WHERE revision_id=?').get(id)!.data;
    const receipt = transfer(store, id, bob); assert.equal(store.detail(id).revision.status, 'needs_review'); assert.deepEqual(store.revisionReviewers.state(id).members.map(member => member.principalId), ['alice']);
    assert.equal(store.revisionReviewers.state(id).acceptance, null); assert.equal(store.database.prepare('SELECT data FROM versions WHERE revision_id=?').get(id)!.data, beforeSource);
    assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId).receipt, receipt);
    act(store, id, 'accept', alice); assert.equal(store.detail(id).revision.status, 'accepted');
    store.database.exec("CREATE TRIGGER refuse_reviewer_swap BEFORE INSERT ON revision_reviewer_transactions WHEN json_extract(NEW.data,'$.action')='author_changed' BEGIN SELECT RAISE(ABORT,'injected reviewer failure'); END");
    const before = rows(store); assert.throws(() => transfer(store, id, carol), /injected reviewer failure/); assert.deepEqual(rows(store), before);
  } finally { store.close(); }
});

test('handoff which removes the final required reviewer binds acceptance to its actual immutable reviewer transaction', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); act(store, id, 'add', alice, carol); act(store, id, 'block', alice, carol); act(store, id, 'accept', bob);
    assert.equal(store.detail(id).revision.status, 'needs_review');
    const receipt = transfer(store, id, carol), state = store.revisionReviewers.state(id);
    assert.equal(store.detail(id).revision.status, 'accepted'); assert.equal(state.acceptance?.kind, 'reviewers');
    const transaction = store.revisionReviewers.history(id, {}).transactions[0]!;
    assert.equal(transaction.action, 'author_changed'); assert.equal(state.acceptance!.transactionId, transaction.id);
    assert.notEqual(state.acceptance!.transactionId, receipt.operationId); assert.deepEqual(transaction.acceptance, state.acceptance);
    assert.equal(store.database.prepare('SELECT cause_id FROM revision_reviewer_transactions WHERE id=?').get(transaction.id)!.cause_id, receipt.operationId);
    assert.deepEqual(store.revisionAuthorship.operation(receipt.operationId).receipt, receipt);
  } finally { store.close(); }
});

test('source and error evidence void acceptance with explicit provenance and never resurrect it through unrelated membership edits', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); act(store, id, 'accept'); const first = store.revisionReviewers.state(id).members[0]!.decision!; source(store, id);
    let state = store.revisionReviewers.state(id); assert.deepEqual(state.members[0]!.decision!.head, first.head); assert.equal(state.members[0]!.decision!.invalidated!.reason, 'source_updated'); assert.equal(state.acceptance, null);
    act(store, id, 'add', alice, carol); assert.equal(store.detail(id).revision.status, 'needs_review'); act(store, id, 'accept');
    lifecycleAction(store, id, 'plan_changes', alice);
    store.saveReview(id, 2, { provider: 'local', model: 'fixture', summary: 'Error', findings: [{ id: 'fixture-error', source: 'local', filePath: 'paper.tex', line: 1, severity: 'error', title: 'Error', body: 'Current source problem' }] }, alice);
    state = store.revisionReviewers.state(id); assert.equal(state.acceptance, null); assert.equal(state.members.find(member => member.principalId === bob.principalId)!.decision!.invalidated!.reason, 'review_error');
    assert.equal(store.revisionLifecycle.state(id).resumeAcceptanceHead, null); act(store, id, 'remove', alice, carol); lifecycleAction(store, id, 'request_review', alice);
    assert.equal(store.detail(id).revision.status, 'needs_review'); act(store, id, 'accept'); assert.notEqual(store.detail(id).revision.status, 'accepted');
  } finally { store.close(); }
});

test('native evidence acceptance remains distinct and reviewerless accepted state is not silently discarded', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Clean', findings: [] }, alice);
    const receipt = lifecycleAction(store, id, 'accept_reviewed', alice); assert.equal(store.revisionReviewers.state(id).acceptance?.kind, 'evidence');
    act(store, id, 'add', alice, bob); assert.equal(store.detail(id).revision.status, 'accepted'); act(store, id, 'remove', alice, bob); assert.equal(store.detail(id).revision.status, 'accepted');
    lifecycleAction(store, id, 'plan_changes', alice); lifecycleAction(store, id, 'request_review', alice); assert.equal(store.detail(id).revision.status, 'accepted');
    act(store, id, 'add', alice, bob); act(store, id, 'block', alice, bob); assert.equal(store.detail(id).revision.status, 'needs_review'); assert.equal(store.revisionReviewers.state(id).acceptance, null);
    act(store, id, 'unblock', alice, bob); assert.equal(store.detail(id).revision.status, 'needs_review'); assert.deepEqual(store.revisionLifecycle.operation(receipt.operationId).receipt, receipt);
  } finally { store.close(); }
});

test('all independent reviewer pins reject stale writes and a lifecycle action cannot silently omit new reviewer pins', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), current = input(store, id, 'accept');
    for (const change of [{ expectedReviewerVersion: 1 }, { expectedLifecycleVersion: 1 }, { expectedAuthorVersion: 1 }, { expectedVersion: 2 }, { expectedVersionId: 'foreign' }, { expectedContentHash: 'f'.repeat(64) }, { expectedAccessEpoch: epoch(store) + 1 }, { expectedConfigId: 'f'.repeat(64) }, { expectedEvidenceSha256: 'f'.repeat(64) }]) {
      const before = rows(store); assert.throws(() => store.revisionReviewers.mutate(id, { ...current, ...change }, bob), { status: 409 }); assert.deepEqual(rows(store), before);
    }
    const life = lifecycleInput(store, id, 'plan_changes'); delete life.expectedReviewerVersion; assert.throws(() => store.revisionLifecycle.mutate(id, life, alice), { status: 400 });
    const before = rows(store); assert.throws(() => store.revisionReviewers.mutate(id, { ...current, message: 'x'.repeat(10001) }, bob), { status: 400 }); assert.deepEqual(rows(store), before);
    store.database.exec("CREATE TRIGGER refuse_reviewer BEFORE INSERT ON revision_reviewer_transactions BEGIN SELECT RAISE(ABORT,'injected reviewer failure'); END");
    const blocked = rows(store); assert.throws(() => store.revisionReviewers.mutate(id, current, bob), /injected reviewer failure/); assert.deepEqual(rows(store), blocked);
  } finally { store.close(); }
});

test('reviewer operation receipts detect canonical source, actor, config, membership and status substitutions', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), receipt = act(store, id, 'accept'), row = store.database.prepare('SELECT data FROM revision_reviewer_operations WHERE id=?').get(receipt.operationId)!;
    store.database.exec('DROP TRIGGER revision_reviewer_operations_no_update');
    for (const mutate of [(value: any) => { value.before.authorship.author = ref(bob); }, (value: any) => { value.before.config.allowSelfAccept = true; }, (value: any) => { value.before.head.versionId = 'foreign'; }, (value: any) => { value.after.members[0].displayName = 'Forged'; }, (value: any) => { value.receipt.transaction.toStatus = 'closed'; }, (value: any) => { value.attribution.principalId = 'carol'; }]) {
      const value = JSON.parse(row.data as string); mutate(value); store.database.prepare('UPDATE revision_reviewer_operations SET data=? WHERE id=?').run(JSON.stringify(value), receipt.operationId); assert.throws(() => store.revisionReviewers.operation(receipt.operationId), { code: 'REVISION_REVIEWER_INVALID_RECEIPT' });
    }
    store.database.prepare('UPDATE revision_reviewer_operations SET data=? WHERE id=?').run(row.data, receipt.operationId); assert.deepEqual(store.revisionReviewers.operation(receipt.operationId).receipt, receipt);
  } finally { store.close(); }
});

test('bounded membership rejects overflow without partial reviewer, lifecycle or authorship changes', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store);
    for (let number = 0; number < 100; number++) act(store, id, 'add', alice, { ...bob, principalId: `reviewer-${number}`, displayName: `Reviewer ${number}` });
    const before = rows(store); assert.throws(() => act(store, id, 'accept', bob), { code: 'REVISION_REVIEWER_LIMIT' }); assert.deepEqual(rows(store), before);
    assert.throws(() => transfer(store, id, carol), { code: 'REVISION_REVIEWER_LIMIT' }); assert.deepEqual(rows(store), before);
    act(store, id, 'remove', alice, { ...bob, principalId: 'reviewer-0' }); transfer(store, id, carol); assert.equal(store.revisionReviewers.state(id).members.length, 100);
  } finally { store.close(); }
});
