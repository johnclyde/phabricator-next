import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_REVISION_LIFECYCLE_CONFIG, revisionLifecycleActions, revisionLifecycleInput, type RevisionLifecycleSnapshot, type RevisionLifecycleHistory, type RevisionLifecycleTransaction } from '../shared/revision-lifecycle.ts';
import { lifecycleReading, lifecycleSnapshot, lifecycleHistory, mergeLifecycleHistory, lifecycleDraft, lifecycleDraftMatches, lifecycleIntent, prepareLifecycleDraft, verifiedLifecycleResult, revisionRefreshDirection } from '../client/revision-lifecycle.ts';

const base: Omit<RevisionLifecycleSnapshot, 'actions'> = {
  reviewers: { version: 0, accepting: 0, rejecting: 0, olderRejecting: 0, blocking: 0, acceptance: null }, lifecycle: { revisionId: 'P1', version: 0, status: 'needs_review', reviewStarted: true, closedFromAccepted: null, resumeAcceptanceHead: null, updatedAt: null },
  head: { versionId: 'source-1', number: 1, contentHash: 'a'.repeat(64) }, authorship: { version: 0, author: { principalId: 'U1', displayName: 'Current Author' } },
  evidence: { sha256: 'b'.repeat(64), reviewIds: ['review-1'], errorCount: 0 }, config: { ...DEFAULT_REVISION_LIFECYCLE_CONFIG }, configId: 'c'.repeat(64), accessEpoch: 5,
  access: { policy: { objectId: 'P1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: true, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'Workspace' },
};
const snapshot: RevisionLifecycleSnapshot = { ...base, actions: revisionLifecycleActions(base, 'U1') };
const history: RevisionLifecycleHistory = { revisionId: 'P1', lifecycleVersion: 0, transactions: [], nextBefore: null, accessEpoch: 5 };
const input = { ...prepareLifecycleDraft(snapshot, 'plan_changes'), message: ' Exact lifecycle explanation. ' };
const transaction: RevisionLifecycleTransaction = { id: 'event-1', revisionId: 'P1', operationId: 'operation-1', lifecycleVersion: 1, action: 'plan_changes', fromStatus: 'needs_review', toStatus: 'changes_planned', beforeHead: base.head, head: base.head, message: input.message, attribution: { principalId: 'U1', displayName: 'Current Author', requestId: 'request-1', credentialId: null }, createdAt: '2026-10-11T12:00:00.000Z', evidenceSha256: base.evidence.sha256, reviewIds: base.evidence.reviewIds };

test('monotonic metadata refresh updates the older side and only uses status fallback for legacy snapshots', () => {
  const known = { currentVersion: 2, authorVersion: 1, lifecycleVersion: 3, reviewerVersion: 0, status: 'needs_review' };
  for (const field of ['currentVersion', 'authorVersion', 'lifecycleVersion', 'reviewerVersion'] as const) {
    const newer = { ...known, [field]: known[field] + 1 };
    assert.equal(revisionRefreshDirection(known, newer), 'workspace');
    assert.equal(revisionRefreshDirection(newer, known), 'revision');
  }
  assert.equal(revisionRefreshDirection(known, { ...known, status: 'abandoned' }), null);
  assert.equal(revisionRefreshDirection({ ...known, lifecycleVersion: undefined }, known), 'workspace');
  assert.equal(revisionRefreshDirection(known, { ...known, lifecycleVersion: undefined }), 'revision');
  assert.equal(revisionRefreshDirection({ currentVersion: 1, status: 'draft' }, { currentVersion: 1, status: 'needs_review' }), 'revision');
  assert.equal(revisionRefreshDirection(undefined, known), 'workspace');
});

test('lifecycle cache binds source-authorized snapshot and history versions and epochs', () => {
  assert.deepEqual(lifecycleReading({ snapshot, history }, 'P1'), { snapshot, history });
  assert.equal(lifecycleReading({ snapshot, history: { ...history, accessEpoch: 6 } }, 'P1'), null);
  assert.equal(lifecycleReading({ snapshot, history: { ...history, lifecycleVersion: 1 } }, 'P1'), null);
  assert.equal(lifecycleReading({ snapshot, history, extra: true }, 'P1'), null);
  assert.equal(lifecycleSnapshot({ ...snapshot, access: { ...base.access, capabilities: { ...base.access.capabilities, view: false } } }, 'P1'), false);
  assert.equal(lifecycleSnapshot(snapshot, 'D1'), false);
});

test('history rejects overlap, backwards continuations, mixed versions and altered cursor', () => {
  const first = { ...history, lifecycleVersion: 2, transactions: [{ ...transaction, lifecycleVersion: 2 }], nextBefore: 2 };
  const second = { ...history, lifecycleVersion: 2, transactions: [{ ...transaction, id: 'older', operationId: 'older-op' }], nextBefore: null };
  assert.deepEqual(mergeLifecycleHistory(first, second).transactions.map(item => item.lifecycleVersion), [2, 1]);
  assert.throws(() => mergeLifecycleHistory(first, first), /changed/);
  assert.throws(() => mergeLifecycleHistory(first, { ...second, lifecycleVersion: 3 }), /changed/);
  assert.throws(() => mergeLifecycleHistory(first, { ...second, accessEpoch: 6 }), /changed/);
  assert.throws(() => mergeLifecycleHistory(first, { ...second, transactions: [{ ...transaction, id: 'other' }] }), /changed/);
  assert.equal(lifecycleHistory({ ...first, nextBefore: 1 }, 'P1'), false);
  assert.equal(lifecycleHistory({ ...first, transactions: [...second.transactions, ...first.transactions] }, 'P1'), false);
});

test('action drafts pin every authority and evidence input without retaining rendered labels', () => {
  assert.deepEqual(lifecycleDraft(input), input); assert.equal(lifecycleDraftMatches(input, snapshot), true);
  for (const changed of [
    { ...snapshot, lifecycle: { ...snapshot.lifecycle, version: 1 } },
    { ...snapshot, authorship: { ...snapshot.authorship, version: 1 } },
    { ...snapshot, head: { ...snapshot.head, versionId: 'different' } },
    { ...snapshot, accessEpoch: 6 }, { ...snapshot, configId: 'd'.repeat(64) },
    { ...snapshot, evidence: { ...snapshot.evidence, sha256: 'e'.repeat(64) } },
  ]) assert.equal(lifecycleDraftMatches(input, changed), false);
  assert.equal(lifecycleDraft({ ...input, authorName: 'Private label' }), null);
  const intent = { id: '12345678-1234-4123-8123-123456789abc', revisionId: 'P1', body: input, draft: input };
  assert.deepEqual(lifecycleIntent(intent, 'P1'), intent);
  assert.equal(lifecycleIntent({ ...intent, id: '-'.repeat(36) }, 'P1'), null);
  assert.equal(lifecycleIntent({ ...intent, draft: { ...input, message: 'Newer draft' } }, 'P1'), null);
  assert.equal(lifecycleIntent(intent, 'L1'), null);
});

test('receipt requires exact whitespace, source, action, actor and normalized input digest', async () => {
  const receipt = { revisionId: 'P1', operationId: 'operation-1', inputSha256: createHash('sha256').update(JSON.stringify(revisionLifecycleInput(input))).digest('hex'), transaction, accessEpoch: 5 };
  assert.deepEqual(await verifiedLifecycleResult(receipt, 'P1', input, 'U1'), receipt);
  await assert.rejects(verifiedLifecycleResult({ ...receipt, transaction: { ...transaction, message: input.message.trim() } }, 'P1', input, 'U1'), /receipt/);
  await assert.rejects(verifiedLifecycleResult(receipt, 'P1', input, 'U2'), /receipt/);
  await assert.rejects(verifiedLifecycleResult({ ...receipt, inputSha256: 'f'.repeat(64) }, 'P1', input, 'U1'), /different request/);
  await assert.rejects(verifiedLifecycleResult({ ...receipt, transaction: { ...transaction, head: { ...transaction.head, versionId: 'other-source' } } }, 'P1', input, 'U1'), /receipt/);
});

test('legacy retained lifecycle requests remain recoverable while unsent legacy drafts require fresh review', () => {
  const { expectedReviewerVersion: _reviewers, ...old } = input;
  const retained = lifecycleDraft(old)!; assert.deepEqual(retained, old); assert.equal(lifecycleDraftMatches(retained, snapshot), false);
  const intent = { id: '12345678-1234-4123-8123-123456789abc', revisionId: 'P1', body: old, draft: old };
  assert.deepEqual(lifecycleIntent(intent, 'P1'), intent);
  assert.equal(lifecycleDraftMatches(input, { ...snapshot, reviewers: { ...snapshot.reviewers, version: 1 } }), false);
});
