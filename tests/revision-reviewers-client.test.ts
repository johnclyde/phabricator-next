import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { revisionReviewerInput, type RevisionReviewerTransaction } from '../shared/revision-reviewers.ts';
import { reviewerReading, reviewerReadingCurrent, reviewerHistory, mergeReviewerHistory, reviewerDraft, reviewerDraftMatches, reviewerIntent, reviewerAuthority, prepareReviewerDraft, verifiedReviewerResult } from '../client/revision-reviewers.ts';

import { base, snapshot, history } from './revision-reviewers-client-fixture.ts';
const input = { ...prepareReviewerDraft(snapshot, 'accept'), message: ' Exact reviewer explanation. ' };
const actor = { principalId: 'U2', displayName: 'Named reviewer', requestId: 'request-1', credentialId: null };
const transaction: RevisionReviewerTransaction = { id: 'event-1', revisionId: 'P1', operationId: 'operation-1', reviewerVersion: 1, action: 'accept', reviewerId: 'U2', before: [], after: [{ principalId: 'U2', displayName: 'Named reviewer', status: 'accepted', decision: { head: base.head, attribution: actor, createdAt: '2026-10-11T12:00:00.000Z', invalidated: null } }], beforeAcceptance: null, acceptance: { kind: 'reviewers', head: base.head, transactionId: 'event-1' }, lifecycleVersion: 1, fromStatus: 'needs_review', toStatus: 'accepted', head: base.head, message: input.message, attribution: actor, createdAt: '2026-10-11T12:00:00.000Z' };

test('reviewer cache binds authorized snapshot to the exact list version and access epoch', () => {
  assert.deepEqual(reviewerReading({ snapshot, history }, 'P1'), { snapshot, history });
  assert.equal(reviewerReading({ snapshot, history: { ...history, accessEpoch: 6 } }, 'P1'), null);
  assert.equal(reviewerReading({ snapshot, history: { ...history, reviewerVersion: 1 } }, 'P1'), null);
  assert.equal(reviewerReading({ snapshot, history, extra: true }, 'P1'), null);
  assert.equal(reviewerReading({ snapshot: { ...snapshot, access: { ...snapshot.access, capabilities: { ...snapshot.access.capabilities, view: false } } }, history }, 'P1'), null);
});

test('reviewer history refuses overlap, duplicate operations and mismatched continuations', () => {
  const first = { ...history, reviewerVersion: 2, transactions: [{ ...transaction, reviewerVersion: 2 }], nextBefore: 2 };
  const second = { ...history, reviewerVersion: 2, transactions: [{ ...transaction, id: 'older', operationId: 'older-op' }], nextBefore: null };
  assert.deepEqual(mergeReviewerHistory(first, second).transactions.map(item => item.reviewerVersion), [2, 1]);
  assert.throws(() => mergeReviewerHistory(first, first), /changed/);
  assert.throws(() => mergeReviewerHistory(first, { ...second, accessEpoch: 6 }), /changed/);
  assert.throws(() => mergeReviewerHistory(first, { ...second, transactions: [{ ...transaction, id: 'other' }] }), /changed/);
  assert.equal(reviewerHistory({ ...first, nextBefore: 1 }, 'P1'), false);
});

test('exact draft pins prevent silent rebases across each proof and permission boundary', () => {
  assert.deepEqual(reviewerDraft(input), input); assert.equal(reviewerDraftMatches(input, snapshot), true);
  for (const changed of [
    { ...snapshot, reviewers: { ...snapshot.reviewers, version: 1 } },
    { ...snapshot, lifecycle: { ...snapshot.lifecycle, version: 1 } },
    { ...snapshot, authorship: { ...snapshot.authorship, version: 1 } },
    { ...snapshot, head: { ...snapshot.head, versionId: 'different' } },
    { ...snapshot, accessEpoch: 6 }, { ...snapshot, configId: 'd'.repeat(64) },
    { ...snapshot, evidence: { ...snapshot.evidence, sha256: 'e'.repeat(64) } },
  ]) assert.equal(reviewerDraftMatches(input, changed), false);
  assert.equal(reviewerDraft({ ...input, reviewerName: 'Stale private label' }), null);
  const intent = { id: '12345678-1234-4123-8123-123456789abc', revisionId: 'P1', body: input, draft: input };
  assert.deepEqual(reviewerIntent(intent, 'P1'), intent);
  assert.equal(reviewerIntent({ ...intent, id: '-'.repeat(36) }, 'P1'), null);
  assert.equal(reviewerIntent({ ...intent, draft: { ...input, message: 'Newer draft' } }, 'P1'), null);
});

test('only own decisions use Interact, including wrapped exact retained requests', () => {
  for (const action of ['accept', 'request_changes', 'resign'] as const) {
    const body = prepareReviewerDraft(snapshot, action); assert.equal(reviewerAuthority(body), 'interact'); assert.equal(reviewerAuthority({ body }), 'interact');
  }
  for (const action of ['add', 'remove', 'block', 'unblock'] as const) assert.equal(reviewerAuthority(prepareReviewerDraft(snapshot, action, 'U2')), 'edit');
  assert.equal(reviewerAuthority({ action: 'accept' }), null);
});

test('receipt binds exact actor, target, source, message and complete canonical request digest', async () => {
  const receipt = { revisionId: 'P1', operationId: 'operation-1', inputSha256: createHash('sha256').update(JSON.stringify(revisionReviewerInput(input))).digest('hex'), transaction, accessEpoch: 5 };
  assert.deepEqual(await verifiedReviewerResult(receipt, 'P1', input, 'U2'), receipt);
  await assert.rejects(verifiedReviewerResult({ ...receipt, transaction: { ...transaction, message: input.message.trim() } }, 'P1', input, 'U2'), /receipt/);
  await assert.rejects(verifiedReviewerResult(receipt, 'P1', input, 'U1'), /receipt/);
  await assert.rejects(verifiedReviewerResult({ ...receipt, inputSha256: 'f'.repeat(64) }, 'P1', input, 'U2'), /different request/);
  await assert.rejects(verifiedReviewerResult({ ...receipt, transaction: { ...transaction, reviewerId: 'U3' } }, 'P1', input, 'U2'), /receipt/);
});

test('offline cache cannot revive a snapshot older than metadata or evidence already read', () => {
  const reading = { snapshot, history }, known = { currentVersion: 1, authorVersion: 0, lifecycleVersion: 0, reviewerVersion: 0, status: 'needs_review' };
  assert.equal(reviewerReadingCurrent(reading, known, snapshot.head.versionId, '[]'), true);
  for (const key of ['currentVersion', 'authorVersion', 'lifecycleVersion', 'reviewerVersion'] as const) assert.equal(reviewerReadingCurrent(reading, { ...known, [key]: 1 + known[key] }, snapshot.head.versionId, '[]'), false);
  assert.equal(reviewerReadingCurrent(reading, known, snapshot.head.versionId, '["new-proof"]'), false);
});
