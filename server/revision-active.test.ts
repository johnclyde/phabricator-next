import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Store } from './store.ts';
import { createAuth } from './auth.ts';
import { PolicyStore } from './policy.ts';
import { AccessLayer } from './access.ts';
import { REVISION_ACTIVE_BUCKETS, classifyRevisionActive, evaluateRevisionActive, validateRevisionActiveSnapshot, type RevisionActiveItem, type RevisionActiveSnapshot } from '../shared/revision-active.ts';
import type { ActorAttribution, AppState, Revision, RevisionKind } from '../shared/types.ts';
import { REVISION_STATUSES } from '../shared/revision-status.ts';
import type { RevisionReviewerAction, RevisionReviewerInput, RevisionReviewerStatus } from '../shared/revision-reviewers.ts';
import { lifecycleAction } from '../tests/revision-lifecycle-fixture.ts';

const alice: ActorAttribution = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'alice-active' };
const bob: ActorAttribution = { principalId: 'bob', displayName: 'Bob', credentialId: null, requestId: 'bob-active' };
const carol: ActorAttribution = { principalId: 'carol', displayName: 'Carol', credentialId: null, requestId: 'carol-active' };
const item = (patch: Partial<RevisionActiveItem> = {}): RevisionActiveItem => ({ revisionId: 'P1', head: { versionId: 'source-v1', number: 1, contentHash: 'a'.repeat(64) }, status: 'needs_review', authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, isAuthor: false, reviewerStatus: 'added', decisionCurrent: null, ...patch });
const revision = (patch: Partial<Revision> = {}): Revision => ({ id: 'P1', kind: 'paper', title: 'Literal [draft]', summary: 'An exact summary.', status: 'needs_review', currentVersion: 1, authorId: alice.principalId, authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, repositoryId: null, projectId: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch });
function state(revisions = [revision()], items = [item()]): Pick<AppState, 'revisions' | 'currentPrincipalId' | 'accessEpoch' | 'revisionActive'> {
  return { revisions, currentPrincipalId: bob.principalId, accessEpoch: 1, revisionActive: { format: 'revision-active.v1', principalId: bob.principalId, accessEpoch: 1, closeOnAccept: false, items } };
}
function fixture(closeOnAccept = false) {
  const store = new Store({ path: ':memory:', revisionLifecycle: { closeOnAccept, allowReopen: true }, revisionReviewers: { allowSelfAccept: true } });
  const auth = createAuth({ database: store.database, mode: 'local', basePath: '/' }), local = auth.authenticate({ method: 'GET', headers: {} } as IncomingMessage);
  const policies = new PolicyStore(store.database, { principalExists: id => [alice.principalId, bob.principalId, carol.principalId, local.principalId].includes(id) });
  const read = (actor = bob) => store.read(() => new AccessLayer(store, auth, policies, { ...local, principalId: actor.principalId, displayName: actor.displayName }).state({ configured: false, model: null }));
  const create = (draft = false, kind: RevisionKind = 'paper', author = alice) => store.createRevision({ title: 'Active projection fixture', kind, draft, testPlan: 'Inspect exact required-action semantics.', files: [{ path: 'source.txt', content: 'PRIVATE SOURCE BODY\n' }] }, author).revision.id;
  const act = (id: string, action: RevisionReviewerAction, actor = bob, target?: ActorAttribution) => {
    const snapshot = store.revisionReviewers.snapshot(id), pins = { message: 'PRIVATE REVIEWER MESSAGE', expectedReviewerVersion: snapshot.reviewers.version, expectedLifecycleVersion: snapshot.lifecycle.version, expectedAuthorVersion: snapshot.authorship.version, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: policies.epoch(), expectedConfigId: snapshot.configId, expectedEvidenceSha256: snapshot.evidence.sha256 };
    const input: RevisionReviewerInput = action === 'add' || action === 'remove' || action === 'block' || action === 'unblock' ? { ...pins, action, reviewerId: target!.principalId } : { ...pins, action };
    return store.revisionReviewers.mutate(id, input, actor, target && { principalId: target.principalId, displayName: target.displayName });
  };
  const next = (id: string) => store.createVersion(id, { expectedVersion: store.detail(id).revision.currentVersion, message: 'New immutable source', files: [{ path: 'source.txt', content: 'PRIVATE NEXT SOURCE BODY' }] }, alice);
  const bucket = (id: string, actor = bob) => { const snapshot = read(actor).revisionActive!; return classifyRevisionActive(snapshot.items.find(value => value.revisionId === id)!, snapshot.closeOnAccept); };
  return { store, auth, policies, read, create, act, next, bucket, close: () => store.close() };
}

test('required-action buckets preserve exact upstream order, author precedence, open states and raw rejection obligations', () => {
  assert.deepEqual(REVISION_ACTIVE_BUCKETS.map(v => v.label), ['Must Review', 'Ready to Review', 'Ready to Land', 'Ready to Update', 'Drafts', 'Waiting on Review', 'Waiting on Authors', 'Waiting on Other Reviewers']);
  const statuses: (RevisionReviewerStatus | null)[] = [null, 'added', 'blocking', 'accepted', 'rejected', 'resigned'];
  const authors = { draft: 'drafts', needs_review: 'waiting-on-review', changes_requested: 'ready-to-update', changes_planned: 'ready-to-update', accepted: 'ready-to-land', closed: null, abandoned: null };
  for (const status of REVISION_STATUSES) for (const reviewerStatus of statuses) for (const decisionCurrent of [false, true]) {
    const value = item({ status, reviewerStatus, decisionCurrent, isAuthor: true });
    assert.equal(classifyRevisionActive(value, false), authors[status], `author ${status}/${reviewerStatus}/${decisionCurrent}`);
    assert.equal(classifyRevisionActive(value, true), status === 'accepted' ? null : authors[status]);
    if (status === 'closed' || status === 'abandoned' || status === 'draft' || reviewerStatus === null || reviewerStatus === 'resigned') assert.equal(classifyRevisionActive({ ...value, isAuthor: false }, false), null);
    else if (status !== 'needs_review') assert.equal(classifyRevisionActive({ ...value, isAuthor: false }, false), 'waiting-on-authors');
    else assert.equal(classifyRevisionActive({ ...value, isAuthor: false }, false), reviewerStatus === 'blocking' || reviewerStatus === 'rejected' ? 'must-review' : reviewerStatus === 'added' || !decisionCurrent ? 'ready-to-review' : 'waiting-on-other-reviewers');
    if (status === 'accepted') assert.equal(classifyRevisionActive({ ...value, isAuthor: false }, true), null);
  }
});

test('complete viewer-bound snapshots reject missing, foreign, duplicate, malformed and stale projection data', () => {
  const valid = state(); assert.ok(validateRevisionActiveSnapshot(valid.revisionActive, valid));
  const mutations: ((snapshot: RevisionActiveSnapshot) => void)[] = [
    snapshot => { snapshot.format = 'revision-active.v2' as 'revision-active.v1'; }, snapshot => { snapshot.principalId = alice.principalId; }, snapshot => { snapshot.accessEpoch++; },
    snapshot => { snapshot.items = []; }, snapshot => { snapshot.items.push(snapshot.items[0]!); }, snapshot => { snapshot.items[0]!.revisionId = 'P9999'; },
    snapshot => { snapshot.items[0]!.head.number++; }, snapshot => { snapshot.items[0]!.head.contentHash = 'invalid'; }, snapshot => { snapshot.items[0]!.head.versionId = ''; },
    snapshot => { snapshot.items[0]!.status = 'accepted'; }, snapshot => { snapshot.items[0]!.authorVersion++; }, snapshot => { snapshot.items[0]!.lifecycleVersion++; }, snapshot => { snapshot.items[0]!.reviewerVersion++; },
    snapshot => { snapshot.items[0]!.isAuthor = true; }, snapshot => { snapshot.items[0]!.decisionCurrent = true; }, snapshot => { snapshot.items[0]!.reviewerStatus = 'accepted'; },
    snapshot => { Object.assign(snapshot.items[0]!, { otherReviewer: carol.principalId }); }, snapshot => { Object.assign(snapshot, { secret: 'unexpected' }); },
  ];
  for (const mutate of mutations) { const snapshot: RevisionActiveSnapshot = structuredClone(valid.revisionActive!); mutate(snapshot); assert.equal(validateRevisionActiveSnapshot(snapshot, valid), false, JSON.stringify(snapshot)); }
  for (const key of ['authorId', 'authorVersion', 'lifecycleVersion', 'reviewerVersion'] as const) { const missing = structuredClone(valid); delete missing.revisions[0]![key]; assert.equal(validateRevisionActiveSnapshot(missing.revisionActive, missing), false, key); }
  for (const malformed of [null, 'P1', {}, { ...revision(), title: null }, { ...revision(), summary: 5 }, { ...revision(), updatedAt: null }, { ...revision(), updatedAt: 'invalid' }, { ...revision(), kind: 'document' }]) {
    const broken = { ...valid, revisions: [malformed] } as typeof valid;
    assert.equal(validateRevisionActiveSnapshot(broken.revisionActive, broken), false); assert.equal(evaluateRevisionActive(broken, 'paper').available, false);
  }
  assert.equal(validateRevisionActiveSnapshot(undefined, valid), false);
  assert.equal(evaluateRevisionActive({ ...valid, revisionActive: undefined }, 'paper').available, false);
  assert.equal(evaluateRevisionActive({ ...valid, revisions: [...valid.revisions, valid.revisions[0]!] }, 'paper').available, false);
  const duplicate = state([revision(), revision({ id: 'P2' })], [item(), item()]); assert.equal(validateRevisionActiveSnapshot(duplicate.revisionActive, duplicate), false);
  const empty = state([], []); assert.ok(validateRevisionActiveSnapshot(empty.revisionActive, empty)); assert.ok(evaluateRevisionActive(empty, 'paper').available);
});

test('Active evaluation uses literal kind filtering, stable latest-first buckets and no Following fallback', () => {
  const current = state([revision(), revision({ id: 'P2' }), revision({ id: 'L1', kind: 'document' }), revision({ id: 'P3', updatedAt: '2026-01-02T00:00:00.000Z' })], [item(), item({ revisionId: 'P2' }), item({ revisionId: 'L1' }), item({ revisionId: 'P3', reviewerStatus: null })]);
  const result = evaluateRevisionActive(current, 'paper', '[DRAFT]'); assert.ok(result.available);
  assert.deepEqual(result.groups.find(group => group.key === 'ready-to-review')!.revisions.map(row => row.id), ['P2', 'P1']);
  assert.deepEqual(result.groups.flatMap(group => group.revisions.map(row => row.id)), ['P2', 'P1']);
  const literal = evaluateRevisionActive(current, 'paper', '.*'); assert.ok(literal.available); assert.equal(literal.groups.flatMap(group => group.revisions).length, 0);
  assert.equal(evaluateRevisionActive(current, 'paper', 'x'.repeat(513)).available, false);
  const followed = { ...current, followingRevisionIds: ['P3'] };
  assert.deepEqual(evaluateRevisionActive(followed, 'paper'), evaluateRevisionActive(current, 'paper'));
});

test('authorized server projection is complete, scalar-only and read-only; private revisions never contribute items', () => {
  const f = fixture(); try {
    const visible = f.create(), hidden = f.create(), noReviewer = f.create(false, 'document');
    f.act(visible, 'add', alice, bob); f.act(visible, 'add', alice, carol); f.act(hidden, 'add', alice, bob);
    const policy = f.policies.policy(hidden, alice.principalId); f.policies.setPolicy(hidden, { expectedVersion: policy.version, spaceId: policy.spaceId, ...policy.rules, view: { kind: 'principals', principalIds: [alice.principalId] } }, alice.principalId);
    const tables = f.store.database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const rows = () => tables.map(({ name }) => [name, f.store.database.prepare(`SELECT rowid,* FROM "${name}" ORDER BY rowid`).all()]);
    const before = rows(), savedDetail = f.store.detail; f.store.detail = () => { throw new Error('State projection must not load revision source or review bodies.'); };
    let observed: AppState; try { observed = f.read(); } finally { f.store.detail = savedDetail; }
    assert.deepEqual(observed.revisions.map(row => row.id).sort(), [visible, noReviewer].sort());
    assert.ok(validateRevisionActiveSnapshot(observed.revisionActive, observed)); assert.deepEqual(observed.revisionActive!.items.map(value => value.revisionId).sort(), [visible, noReviewer].sort());
    assert.equal(observed.revisionActive!.items.find(value => value.revisionId === visible)!.reviewerStatus, 'added');
    assert.equal(observed.revisionActive!.items.find(value => value.revisionId === noReviewer)!.reviewerStatus, null);
    assert.doesNotMatch(JSON.stringify(observed.revisionActive), /PRIVATE|Carol|carol|displayName|attribution|message/);
    assert.ok(!observed.revisionActive!.items.some(value => value.revisionId === hidden)); assert.deepEqual(rows(), before);
    const other = f.read(carol); assert.equal(other.revisionActive!.principalId, carol.principalId); assert.equal(validateRevisionActiveSnapshot(observed.revisionActive, other), false);
  } finally { f.close(); }
});

test('real reviewer transitions preserve old rejection obligations, voided accepts, resignation, removal and source pins', () => {
  const f = fixture(); try {
    const id = f.create(); f.act(id, 'add', alice, bob); assert.equal(f.bucket(id), 'ready-to-review');
    f.act(id, 'block', alice, bob); assert.equal(f.bucket(id), 'must-review');
    f.act(id, 'request_changes'); assert.equal(f.bucket(id), 'waiting-on-authors');
    lifecycleAction(f.store, id, 'request_review', alice); let current = f.read();
    assert.equal(f.store.revisionReviewers.state(id).members[0]!.decision!.invalidated!.reason, 'request_review');
    assert.equal(f.bucket(id), 'must-review'); assert.equal(current.revisionActive!.items[0]!.decisionCurrent, false);
    f.act(id, 'accept'); assert.equal(f.bucket(id), 'waiting-on-authors'); assert.equal(f.bucket(id, alice), 'ready-to-land');
    const accepted = f.read(); f.next(id); current = f.read(); assert.equal(f.bucket(id), 'ready-to-review');
    assert.equal(current.revisionActive!.items[0]!.head.number, 2); assert.equal(current.revisionActive!.items[0]!.decisionCurrent, false); assert.equal(validateRevisionActiveSnapshot(accepted.revisionActive, current), false);
    f.act(id, 'resign'); assert.equal(f.bucket(id), null); assert.equal(f.read().revisionActive!.items[0]!.decisionCurrent, true);
    f.next(id); assert.equal(f.read().revisionActive!.items[0]!.decisionCurrent, false); assert.equal(f.bucket(id), null);
    f.act(id, 'remove', alice, bob); assert.equal(f.read().revisionActive!.items[0]!.reviewerStatus, null); assert.equal(f.bucket(id), null);
  } finally { f.close(); }
});

test('drafts, author transfer, planned changes and close-on-accept preserve role precedence and lifecycle meaning', () => {
  const f = fixture(); try {
    const draft = f.create(true); f.act(draft, 'add', alice, bob); assert.equal(f.bucket(draft), null); assert.equal(f.bucket(draft, alice), 'drafts');
    const id = f.create(); f.act(id, 'add', alice, bob); f.act(id, 'block', alice, bob); f.act(id, 'accept', alice);
    assert.equal(f.bucket(id, alice), 'waiting-on-review', 'an author who is also an accepting reviewer remains in the author bucket');
    const snapshot = f.store.revisionAuthorship.snapshot(id), before = f.read();
    f.store.revisionAuthorship.mutate(id, { action: 'assign', authorId: bob.principalId, message: 'Transfer', expectedAuthorVersion: snapshot.authorship.version, expectedReviewerVersion: snapshot.reviewerVersion, expectedLifecycleVersion: snapshot.lifecycleVersion, expectedVersion: snapshot.head.number, expectedVersionId: snapshot.head.versionId, expectedContentHash: snapshot.head.contentHash, expectedAccessEpoch: f.policies.epoch() }, alice, { principalId: bob.principalId, displayName: bob.displayName });
    assert.equal(f.read().revisionActive!.items.find(value => value.revisionId === id)!.isAuthor, true); assert.equal(validateRevisionActiveSnapshot(before.revisionActive, f.read()), false);
    lifecycleAction(f.store, id, 'plan_changes', bob); assert.equal(f.bucket(id), 'ready-to-update'); assert.equal(f.bucket(id, alice), 'waiting-on-authors');
    lifecycleAction(f.store, id, 'abandon', bob); assert.equal(f.bucket(id), null); assert.equal(f.bucket(id, alice), null);
  } finally { f.close(); }
  const closed = fixture(true); try { const id = closed.create(); closed.act(id, 'accept'); assert.equal(closed.read().revisionActive!.closeOnAccept, true); assert.equal(closed.bucket(id), null); assert.equal(closed.bucket(id, alice), null); } finally { closed.close(); }
});

test('server projection fails closed if a hydrated summary no longer matches authoritative lifecycle pins', () => {
  const f = fixture(); try {
    const id = f.create(), saved = f.store.state.bind(f.store);
    f.store.state = (...args) => { const snapshot = saved(...args); snapshot.revisions.find(row => row.id === id)!.reviewerVersion!++; return snapshot; };
    assert.throws(() => f.read(), /Active revision state changed/);
  } finally { f.close(); }
});
