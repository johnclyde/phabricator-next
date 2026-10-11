import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.ts';
import { Auth } from './auth.ts';
import { revisionSubscriptionInputHash } from './revision-subscriptions.ts';
import { isRevisionMuteHistory, isRevisionSubscriptionHistory, revisionSubscriptionInput, validRevisionSubscriptionResult, REVISION_SUBSCRIPTION_LIMITS, type RevisionSubscriptionAction, type RevisionSubscriptionInput } from '../shared/revision-subscriptions.ts';
import type { ActorAttribution } from '../shared/types.ts';
import type { RevisionReviewerAction, RevisionReviewerInput } from '../shared/revision-reviewers.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: 'alice-key', requestId: 'alice-follow-request' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: 'bob-key', requestId: 'bob-follow-request' };
const carol: ActorAttribution = { principalId: 'carol', displayName: 'Carol', credentialId: null, requestId: 'carol-follow-request' };
const ref = ({ principalId, displayName }: ActorAttribution) => ({ principalId, displayName });
const epoch = (store: Store) => store.database.prepare("SELECT value FROM policy_meta WHERE name='epoch'").get()!.value as number;
const create = (store: Store, draft = false) => store.createRevision({ title: 'Paper to follow', testPlan: 'Read the exact manuscript.', kind: 'paper', draft, files: [{ path: 'paper.tex', content: '\ufeffExact source\r\n' }] }, alice).revision.id;
function input(store: Store, id: string, action: RevisionSubscriptionAction, target = bob): RevisionSubscriptionInput {
  const value = store.revisionSubscriptions.snapshot(id, target.principalId), common = { principalId: target.principalId, expectedAuthorVersion: value.authorVersion, expectedReviewerVersion: value.reviewerVersion, expectedAccessEpoch: epoch(store) };
  return action === 'subscribe' || action === 'unsubscribe' ? { action, ...common, expectedSubscriptionVersion: value.viewer.version } : { action, ...common, expectedMuteVersion: value.mute.version };
}
function act(store: Store, id: string, action: RevisionSubscriptionAction, actor = bob, target = actor) { return store.revisionSubscriptions.mutate(id, input(store, id, action, target), actor, ref(target)); }
function review(store: Store, id: string, action: RevisionReviewerAction, actor = bob, target?: ActorAttribution) {
  const s = store.revisionReviewers.snapshot(id), pins = { message: '', expectedReviewerVersion: s.reviewers.version, expectedLifecycleVersion: s.lifecycle.version, expectedAuthorVersion: s.authorship.version, expectedVersion: s.head.number, expectedVersionId: s.head.versionId, expectedContentHash: s.head.contentHash, expectedAccessEpoch: epoch(store), expectedConfigId: s.configId, expectedEvidenceSha256: s.evidence.sha256 };
  const request: RevisionReviewerInput = ['add', 'remove', 'block', 'unblock'].includes(action) ? { action: action as 'add', reviewerId: target!.principalId, ...pins } : { action: action as 'accept', ...pins };
  return store.revisionReviewers.mutate(id, request, actor, target && ref(target));
}
function transfer(store: Store, id: string, target = carol) {
  const s = store.revisionAuthorship.snapshot(id);
  return store.revisionAuthorship.mutate(id, { action: 'assign', authorId: target.principalId, message: '', expectedAuthorVersion: s.authorship.version, expectedReviewerVersion: s.reviewerVersion, expectedLifecycleVersion: s.lifecycleVersion, expectedVersion: s.head.number, expectedVersionId: s.head.versionId, expectedContentHash: s.head.contentHash, expectedAccessEpoch: epoch(store) }, alice, ref(target));
}
function rows(store: Store, include = (_name: string) => true) { return Object.fromEntries((store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]).filter(row => include(row.name)).map(({ name }) => [name, store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()])); }
function accountFixtures(store: Store) {
  new Auth({ database: store.database, mode: 'local', basePath: '/', provisioning: true });
  for (const actor of [alice, bob, carol]) store.database.prepare("INSERT INTO auth_accounts(id,username,display_name,salt,password_hash) VALUES(?,?,?,'fixture','fixture')").run(actor.principalId, actor.principalId, actor.displayName);
}

test('following and mute have independent exact histories without touching source, evidence, lifecycle or policy', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); store.saveReview(id, 1, { provider: 'local', model: 'fixture', summary: 'Verified exact source', findings: [] }, alice); lifecycleAction(store, id, 'accept_reviewed', alice);
    const old = rows(store, name => !name.startsWith('revision_subscription') && !name.startsWith('revision_mute'));
    const request = input(store, id, 'subscribe'), receipt = store.revisionSubscriptions.mutate(id, request, bob);
    assert.ok(validRevisionSubscriptionResult(receipt, id, request, bob.principalId)); assert.equal(receipt.inputSha256, revisionSubscriptionInputHash(request)); assert.equal(receipt.changed, true); assert.equal(receipt.kind, 'subscription');
    assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), true);
    const publicBefore = store.revisionSubscriptions.snapshot(id, alice.principalId), historyBefore = store.revisionSubscriptions.history(id);
    const muted = act(store, id, 'mute'); assert.equal(muted.kind, 'mute'); assert.equal(muted.changed, true);
    assert.deepEqual(store.revisionSubscriptions.snapshot(id, alice.principalId), publicBefore); assert.deepEqual(store.revisionSubscriptions.history(id), historyBefore);
    assert.equal(store.revisionSubscriptions.snapshot(id, bob.principalId).mute.muted, true); assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), true);
    assert.deepEqual(rows(store, name => !name.startsWith('revision_subscription') && !name.startsWith('revision_mute')), old);
    act(store, id, 'unsubscribe'); assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), false); assert.equal(store.revisionSubscriptions.snapshot(id, bob.principalId).mute.muted, true);
    assert.deepEqual(store.revisionSubscriptions.operation(receipt.operationId).receipt, receipt); assert.deepEqual(store.revisionSubscriptions.operation(muted.operationId).receipt, muted);
    assert.ok(isRevisionSubscriptionHistory({ ...store.revisionSubscriptions.history(id), accessEpoch: epoch(store) }, id)); assert.ok(isRevisionMuteHistory({ ...store.revisionSubscriptions.muteHistory(id, bob.principalId), accessEpoch: epoch(store) }, id, bob.principalId));
  } finally { store.close(); }
});

test('automatic authors and nonresigned reviewers follow independently of explicit optout, status and author handoff', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store, true); assert.deepEqual(store.revisionSubscriptions.status(id, alice.principalId).automatic, ['author']);
    for (const action of ['subscribe', 'unsubscribe'] as const) assert.throws(() => act(store, id, action, alice), { code: 'REVISION_SUBSCRIPTION_AUTOMATIC' });
    act(store, id, 'unsubscribe', bob, alice); assert.equal(store.revisionSubscriptions.status(id, alice.principalId).state, 'unsubscribed'); assert.equal(store.revisionSubscriptions.effective(id, alice.principalId), true);
    review(store, id, 'add', alice, bob); assert.deepEqual(store.revisionSubscriptions.status(id, bob.principalId).automatic, ['reviewer']);
    act(store, id, 'unsubscribe', alice, bob); assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), true);
    const publicHistory = store.revisionSubscriptions.history(id); review(store, id, 'resign'); assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), false);
    transfer(store, id); assert.deepEqual(store.revisionSubscriptions.status(id, alice.principalId).automatic, ['reviewer']); assert.deepEqual(store.revisionSubscriptions.status(id, carol.principalId).automatic, ['author']);
    assert.deepEqual(store.revisionSubscriptions.history(id), publicHistory, 'roles do not fabricate explicit follow history');
    lifecycleAction(store, id, 'abandon', carol); assert.equal(store.revisionSubscriptions.effective(id, carol.principalId), true); assert.equal(store.revisionSubscriptions.effective(id, alice.principalId), true);
  } finally { store.close(); }
});

test('no-op preference receipts are immutable and recoverable after later source, role and personal state changes', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); act(store, id, 'subscribe');
    const request = input(store, id, 'subscribe'), before = rows(store), receipt = store.revisionSubscriptions.mutate(id, request, bob);
    assert.equal(receipt.changed, false); assert.equal(receipt.transaction, null);
    for (const [table, value] of Object.entries(before)) if (table !== 'revision_subscription_operations') assert.deepEqual(rows(store)[table], value, table);
    const unmuteRequest = input(store, id, 'unmute'), unmuted = store.revisionSubscriptions.mutate(id, unmuteRequest, bob); assert.equal(unmuted.changed, false);
    act(store, id, 'unsubscribe'); act(store, id, 'mute'); review(store, id, 'add', alice, bob); transfer(store, id);
    store.createVersion(id, { expectedVersion: 1, message: 'New exact source', files: [{ path: 'paper.tex', content: 'New source' }] }, carol);
    assert.deepEqual(store.revisionSubscriptions.operation(receipt.operationId).receipt, receipt); assert.deepEqual(store.revisionSubscriptions.operation(unmuted.operationId).receipt, unmuted);
    assert.ok(validRevisionSubscriptionResult(receipt, id, request, bob.principalId)); assert.ok(validRevisionSubscriptionResult(unmuted, id, unmuteRequest, bob.principalId));
    for (const table of ['revision_subscription_operations', 'revision_subscription_transactions', 'revision_mute_transactions']) assert.throws(() => store.database.exec(`DELETE FROM ${table}`), /immutable/);
  } finally { store.close(); }
});

test('per-person CAS, epochs and actual role changes conflict; source-only changes and independent mute roles do not', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), pending = input(store, id, 'subscribe'), initialRoles = store.revisionSubscriptions.snapshot(id, bob.principalId).roleDigest;
    store.createVersion(id, { expectedVersion: 1, message: 'New exact source', files: [{ path: 'paper.tex', content: 'Changed source' }] }, alice);
    assert.equal(store.revisionSubscriptions.snapshot(id, bob.principalId).roleDigest, initialRoles); const receipt = store.revisionSubscriptions.mutate(id, pending, bob); assert.equal(receipt.changed, true); assert.deepEqual(store.revisionSubscriptions.operation(receipt.operationId).receipt, receipt);
    assert.throws(() => store.revisionSubscriptions.mutate(id, pending, bob), { code: 'REVISION_SUBSCRIPTION_CHANGED' });
    const other = input(store, id, 'subscribe', carol), mute = input(store, id, 'mute'); review(store, id, 'add', alice, carol);
    assert.throws(() => store.revisionSubscriptions.mutate(id, other, carol), { code: 'REVISION_SUBSCRIPTION_CHANGED' });
    assert.equal(store.revisionSubscriptions.mutate(id, mute, bob).kind, 'mute', 'mute is independent of membership');
    const before = rows(store), valid = input(store, id, 'unsubscribe');
    for (const changes of [{ expectedAccessEpoch: epoch(store) + 1 }, { expectedSubscriptionVersion: 100 }, { expectedAuthorVersion: 100 }, { expectedReviewerVersion: 100 }]) { assert.throws(() => store.revisionSubscriptions.mutate(id, { ...valid, ...changes } as RevisionSubscriptionInput, bob), { status: 409 }); assert.deepEqual(rows(store), before); }
    assert.throws(() => act(store, id, 'mute', alice, bob), { status: 403 }); assert.deepEqual(rows(store), before);
  } finally { store.close(); }
});

test('human comments and replies follow atomically, respecting optout/roles and excluding unattributed or system actors', () => {
  const store = new Store({ path: ':memory:' }); try {
    accountFixtures(store); const id = create(store), versionId = store.detail(id).versions[0]!.id;
    const root = store.createComment(id, { versionId, body: 'Read the proof.' }, bob);
    assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), true); const history = store.revisionSubscriptions.history(id); assert.equal(history.transactions.length, 1); assert.equal(history.transactions[0]!.commentId, root.id); assert.equal(history.transactions[0]!.reason, 'comment');
    store.revisionSubscriptions.commented(id, root.id, bob); assert.deepEqual(store.revisionSubscriptions.history(id), history, 'saved comment cannot duplicate an implicit follow');
    store.createReply(id, root.threadId!, { viewedVersionId: versionId, body: 'A second independent reader.' }, carol); assert.equal(store.revisionSubscriptions.effective(id, carol.principalId), true);
    act(store, id, 'unsubscribe'); store.createReply(id, root.threadId!, { viewedVersionId: versionId, body: 'Still not following.' }, bob); assert.equal(store.revisionSubscriptions.effective(id, bob.principalId), false);
    const count = store.revisionSubscriptions.history(id).subscriptionVersion;
    for (const actor of [undefined, alice, { ...bob, principalId: 'unknown' }, { ...bob, principalId: 'system:reviewer' }]) store.createComment(id, { versionId, body: 'No implicit subscription.' }, actor);
    assert.equal(store.revisionSubscriptions.history(id).subscriptionVersion, count);
    const other = create(store), otherVersion = store.detail(other).versions[0]!.id; act(store, other, 'unsubscribe'); store.createComment(other, { versionId: otherVersion, body: 'First comment after prior optout.' }, bob); assert.equal(store.revisionSubscriptions.status(other, bob.principalId).state, 'unsubscribed');
    const third = create(store), thirdVersion = store.detail(third).versions[0]!.id, before = rows(store);
    store.database.exec("CREATE TRIGGER reject_follow BEFORE INSERT ON revision_subscriptions BEGIN SELECT RAISE(ABORT,'rollback implicit preference'); END");
    assert.throws(() => store.createComment(third, { versionId: thirdVersion, body: 'Must roll back comment and follow.' }, bob), /rollback implicit/); assert.deepEqual(rows(store), before);
    store.database.exec('DROP TRIGGER reject_follow'); store.database.prepare('UPDATE auth_accounts SET disabled=1 WHERE id=?').run(bob.principalId); store.createComment(third, { versionId: thirdVersion, body: 'Unknown direct store attribution is not a fresh human action.' }, bob); assert.equal(store.revisionSubscriptions.effective(third, bob.principalId), false);
  } finally { store.close(); }
});

test('active local identity can follow by replying but an inactive local or terminal operator never does', () => {
  const store = new Store({ path: ':memory:' }); try {
    const auth = new Auth({ database: store.database, mode: 'local', basePath: '/' }), local = { principalId: `local:${auth.workspaceId}`, displayName: 'You', credentialId: null, requestId: 'local-comment' }, id = create(store), versionId = store.detail(id).versions[0]!.id;
    store.createComment(id, { versionId, body: 'From the active local person.' }, local); assert.equal(store.revisionSubscriptions.effective(id, local.principalId), true);
    const other = create(store), v = store.detail(other).versions[0]!.id; store.database.exec("INSERT INTO auth_meta(name,value) VALUES('require_auth','true')");
    store.createComment(other, { versionId: v, body: 'Legacy local attribution.' }, local); store.createComment(other, { versionId: v, body: 'Operator attribution.' }, { ...local, principalId: `operator:${auth.workspaceId}` }); assert.equal(store.revisionSubscriptions.history(other).transactions.length, 0);
  } finally { store.close(); }
});

test('bounded subscriber and separate history pages have inspected CAS, exact ordering and no private counters', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); for (const target of [carol, bob]) act(store, id, 'subscribe', alice, target);
    const first = store.revisionSubscriptions.snapshot(id, bob.principalId, { limit: 2 }), second = store.revisionSubscriptions.snapshot(id, bob.principalId, { after: first.nextAfter!, limit: 2, expectedSubscriptionVersion: first.subscriptionVersion, expectedAuthorVersion: first.authorVersion, expectedReviewerVersion: first.reviewerVersion });
    assert.deepEqual(first.subscribers.map(person => person.principalId), ['alice', 'bob']); assert.deepEqual(second.subscribers.map(person => person.principalId), ['carol']); assert.equal(second.nextAfter, null);
    act(store, id, 'unsubscribe'); const person = store.revisionSubscriptions.person(id, bob.principalId); assert.equal(person.status.version, 2); assert.equal(person.status.state, 'unsubscribed');
    assert.throws(() => store.revisionSubscriptions.snapshot(id, bob.principalId, { expectedSubscriptionVersion: first.subscriptionVersion }), { status: 409 });
    const history = store.revisionSubscriptions.history(id, { limit: 2 }), next = store.revisionSubscriptions.history(id, { before: history.nextBefore!, limit: 2 }); assert.deepEqual(history.transactions.map(t => t.subscriptionVersion), [3, 2]); assert.deepEqual(next.transactions.map(t => t.subscriptionVersion), [1]);
    for (const action of ['mute', 'unmute', 'mute'] as const) act(store, id, action);
    const mute = store.revisionSubscriptions.muteHistory(id, bob.principalId, { limit: 2 }), nextMute = store.revisionSubscriptions.muteHistory(id, bob.principalId, { before: mute.nextBefore! }); assert.deepEqual(mute.transactions.map(t => t.version), [3, 2]); assert.deepEqual(nextMute.transactions.map(t => t.version), [1]); assert.equal(store.revisionSubscriptions.muteHistory(id, alice.principalId).muteVersion, 0); assert.equal(store.revisionSubscriptions.history(id).subscriptionVersion, 3);
    for (const query of [{ limit: 101 }, { limit: 0 }, { before: 0 }]) assert.throws(() => store.revisionSubscriptions.history(id, query), { status: 400 });
  } finally { store.close(); }
});

test('immutable operation reconstruction rejects altered identities, roles, actor, no-op state and changed receipts', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), receipts = [act(store, id, 'subscribe'), act(store, id, 'subscribe'), act(store, id, 'mute'), act(store, id, 'mute')];
    store.database.exec('DROP TRIGGER revision_subscription_operations_no_update');
    for (const receipt of receipts) {
      const original = store.revisionSubscriptions.operation(receipt.operationId);
      for (const forge of [(v: typeof original) => { v.roles.author = ref(bob); }, (v: typeof original) => { v.roles.reviewerVersion++; }, (v: typeof original) => { v.before.version++; }, (v: typeof original) => { v.attribution.principalId = 'other'; }, (v: typeof original) => { v.receipt.changed = !v.receipt.changed; }, (v: typeof original) => { v.input.expectedReviewerVersion++; v.inputSha256 = revisionSubscriptionInputHash(v.input); v.receipt.inputSha256 = v.inputSha256; }]) {
        const value = structuredClone(original); forge(value); store.database.prepare('UPDATE revision_subscription_operations SET input_sha256=?,data=? WHERE id=?').run(value.inputSha256, JSON.stringify(value), original.id); assert.throws(() => store.revisionSubscriptions.operation(original.id), { code: 'REVISION_SUBSCRIPTION_INVALID_RECEIPT' });
      }
      store.database.prepare('UPDATE revision_subscription_operations SET input_sha256=?,data=? WHERE id=?').run(original.inputSha256, JSON.stringify(original), original.id); assert.deepEqual(store.revisionSubscriptions.operation(original.id), original);
    }
    store.database.prepare('DELETE FROM revision_subscriptions WHERE revision_id=? AND principal_id=?').run(id, bob.principalId); assert.throws(() => store.revisionSubscriptions.status(id, bob.principalId), { code: 'REVISION_SUBSCRIPTION_INVALID_RECEIPT' });
  } finally { store.close(); }
});

test('1000 explicit identities include optout tombstones; full capacity preserves existing removal, mute and commenting', () => {
  const store = new Store({ path: ':memory:' }); try {
    accountFixtures(store); const id = create(store);
    for (let index = 0; index < REVISION_SUBSCRIPTION_LIMITS.people; index++) {
      const target = { ...bob, principalId: `person-${String(index).padStart(4, '0')}`, displayName: `Person ${index}` };
      const roles = store.revisionSubscriptions.person(id, target.principalId);
      store.revisionSubscriptions.mutate(id, { action: index % 2 ? 'subscribe' : 'unsubscribe', principalId: target.principalId, expectedSubscriptionVersion: 0, expectedAuthorVersion: roles.authorVersion, expectedReviewerVersion: roles.reviewerVersion, expectedAccessEpoch: epoch(store) }, alice, ref(target));
    }
    const before = rows(store); assert.throws(() => act(store, id, 'subscribe'), { code: 'REVISION_SUBSCRIPTION_LIMIT' }); assert.deepEqual(rows(store), before);
    const target = { ...bob, principalId: 'person-0001', displayName: 'Person 1' }; act(store, id, 'unsubscribe', alice, target); assert.equal(store.revisionSubscriptions.effective(id, target.principalId), false);
    act(store, id, 'mute'); const versionId = store.detail(id).versions[0]!.id; store.createComment(id, { versionId, body: 'Commenting remains possible at capacity.' }, bob); assert.equal(store.revisionSubscriptions.status(id, bob.principalId).state, null); assert.equal(store.detail(id).comments.length, 1);
  } finally { store.close(); }
});

test('strict inputs exclude source pins, mixed preference counters, unsupported actions and foreign preference reads', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store), request = input(store, id, 'subscribe');
    for (const value of [{ ...request, expectedVersion: 1 }, { ...request, expectedMuteVersion: 0 }, { ...request, principalId: '' }, { ...request, action: 'watch' }, { ...request, expectedSubscriptionVersion: -1 }]) assert.throws(() => revisionSubscriptionInput(value));
    const before = rows(store); assert.throws(() => store.revisionSubscriptions.mutate(id, request, { ...bob, principalId: '' }), { status: 400 }); assert.throws(() => store.revisionSubscriptions.snapshot('T1', bob.principalId), { status: 404 }); assert.deepEqual(rows(store), before);
  } finally { store.close(); }
});

test('same-input no-op receipts retain their distinct scoped retry-key proofs and original public sequence', () => {
  const store = new Store({ path: ':memory:' }); try {
    const id = create(store); act(store, id, 'subscribe'); const request = input(store, id, 'subscribe');
    const first = store.revisionSubscriptions.mutate(id, request, bob, undefined, 'a'.repeat(64));
    act(store, id, 'subscribe', alice, carol);
    const second = store.revisionSubscriptions.mutate(id, request, bob, undefined, 'b'.repeat(64));
    assert.equal(first.changed, false); assert.equal(second.changed, false); assert.equal(first.inputSha256, second.inputSha256);
    assert.equal(first.kind === 'subscription' && first.subscriptionVersion, 1); assert.equal(second.kind === 'subscription' && second.subscriptionVersion, 2);
    assert.equal(store.revisionSubscriptions.operation(first.operationId).retryKeySha256, 'a'.repeat(64)); assert.equal(store.revisionSubscriptions.operation(second.operationId).retryKeySha256, 'b'.repeat(64));
    assert.deepEqual(store.revisionSubscriptions.operation(first.operationId).receipt, first);
    assert.throws(() => store.revisionSubscriptions.mutate(id, request, bob, undefined, 'not-a-hash'), { status: 400 });
  } finally { store.close(); }
});
