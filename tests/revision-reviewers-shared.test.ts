import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionReviewerInput, revisionReviewerActions, revisionReviewerSummary, isRevisionReviewerSnapshot, isRevisionReviewerHistory, isRevisionReviewerTransaction, validRevisionReviewerResult, type RevisionReviewerMember, type RevisionReviewerTransaction } from '../shared/revision-reviewers.ts';
import { base, snapshot } from './revision-reviewers-client-fixture.ts';

const time = '2026-10-11T12:00:00.000Z';
const actor = { principalId: 'U2', displayName: 'Reviewer', credentialId: null, requestId: 'review-request' };
const input = revisionReviewerInput({ action: 'accept', message: 'Exact version reviewed.', expectedReviewerVersion: 0, expectedLifecycleVersion: 0, expectedAuthorVersion: 0, expectedVersion: base.head.number, expectedVersionId: base.head.versionId, expectedContentHash: base.head.contentHash, expectedAccessEpoch: base.accessEpoch, expectedConfigId: base.configId, expectedEvidenceSha256: base.evidence.sha256 });
const accepted: RevisionReviewerMember = { principalId: actor.principalId, displayName: actor.displayName, status: 'accepted', decision: { head: base.head, attribution: actor, createdAt: time, invalidated: null } };
const transaction: RevisionReviewerTransaction = { id: 'event', revisionId: 'P1', operationId: 'operation', reviewerVersion: 1, action: 'accept', reviewerId: actor.principalId, before: [], after: [accepted], beforeAcceptance: null, acceptance: { kind: 'reviewers', head: base.head, transactionId: 'event' }, head: base.head, fromStatus: 'needs_review', toStatus: 'accepted', lifecycleVersion: 1, message: input.message, attribution: actor, createdAt: time };

test('reviewer intent canonicalization keeps every exact pin and forbids acting as another person', () => {
  assert.deepEqual(revisionReviewerInput(Object.fromEntries(Object.entries(input).reverse())), input);
  for (const field of Object.keys(input)) { const missing = { ...input } as Record<string, unknown>; delete missing[field]; assert.throws(() => revisionReviewerInput(missing), field); }
  assert.throws(() => revisionReviewerInput({ ...input, reviewerId: 'U3' }));
  assert.throws(() => revisionReviewerInput({ ...input, expectedReviewerVersion: '0' }));
  assert.throws(() => revisionReviewerInput({ ...input, action: 'add' }));
  assert.equal(revisionReviewerInput({ ...input, action: 'add', reviewerId: 'U3' }).action, 'add');
  for (const reviewerId of ['../U3', 'U 3', '', '\0']) assert.throws(() => revisionReviewerInput({ ...input, action: 'add', reviewerId }));
});

test('personal decisions respect interact authority and author, draft, planned and terminal rules', () => {
  const actions = (value = base, principal = 'U2') => Object.fromEntries(revisionReviewerActions(value, principal).map(action => [action.action, action.available]));
  assert.equal(actions().accept, true); assert.equal(actions().add, false); assert.equal(actions().request_changes, true); assert.equal(actions().resign, false);
  assert.equal(actions(base, 'U1').accept, false); assert.equal(actions(base, 'U1').request_changes, false);
  const selfEnabled = { ...base, config: { ...base.config, allowSelfAccept: true } };
  assert.equal(actions(selfEnabled, 'U1').accept, true); assert.equal(actions(selfEnabled, 'U1').request_changes, false);
  assert.equal(actions({ ...base, lifecycle: { ...base.lifecycle, status: 'draft', reviewStarted: false } }).accept, false);
  assert.equal(actions({ ...base, lifecycle: { ...base.lifecycle, status: 'changes_planned' } }).accept, true);
  for (const status of ['closed', 'abandoned'] as const) {
    const available = actions({ ...base, lifecycle: { ...base.lifecycle, status } });
    assert.equal(available.accept, false); assert.equal(available.request_changes, false); assert.equal(available.resign, false);
  }
  assert.equal(actions({ ...base, lifecycle: { ...base.lifecycle, status: 'accepted' }, config: { ...base.config, closeOnAccept: true } }).accept, false);
  assert.equal(actions({ ...base, access: { ...base.access, capabilities: { ...base.access.capabilities, interact: false } } }).accept, false);
});

test('old rejection remains a veto but old or error-invalidated acceptance never counts as current approval', () => {
  const rejected: RevisionReviewerMember = { ...accepted, status: 'rejected' };
  const summarize = (member: RevisionReviewerMember, head = base.head) => revisionReviewerSummary({ ...base.reviewers, members: [member] }, head);
  assert.equal(summarize(accepted).accepting, 1); assert.equal(summarize(rejected).rejecting, 1);
  const next = { versionId: 'source-2', number: 2, contentHash: 'd'.repeat(64) };
  assert.equal(summarize(accepted, next).accepting, 0); assert.equal(summarize(rejected, next).olderRejecting, 1);
  for (const reason of ['source_updated', 'review_error'] as const) {
    const invalidated = { reason, head: next, attribution: actor, createdAt: time };
    assert.equal(summarize({ ...accepted, decision: { ...accepted.decision!, invalidated } }).accepting, 0);
    assert.equal(summarize({ ...rejected, decision: { ...rejected.decision!, invalidated } }).olderRejecting, 1);
  }
  assert.equal(summarize({ ...rejected, decision: { ...rejected.decision!, invalidated: { reason: 'request_review', head: base.head, attribution: actor, createdAt: time } } }).olderRejecting, 0);
  assert.equal(summarize({ ...accepted, status: 'blocking', decision: null }).blocking, 1);
});

test('snapshot validation checks complete nested lifecycle and evidence rather than only their visible status', () => {
  assert.equal(isRevisionReviewerSnapshot(snapshot, 'P1'), true);
  for (const lifecycle of [{ ...base.lifecycle, resumeAcceptanceHead: {} }, { ...base.lifecycle, updatedAt: 'invented' }, { ...base.lifecycle, closedFromAccepted: 'yes' }, { ...base.lifecycle, extra: true }]) assert.equal(isRevisionReviewerSnapshot({ ...snapshot, lifecycle }, 'P1'), false);
  for (const evidence of [{ ...base.evidence, reviewIds: [null] }, { ...base.evidence, reviewIds: ['same', 'same'] }, { ...base.evidence, errorCount: 1 }, { ...base.evidence, extra: true }]) assert.equal(isRevisionReviewerSnapshot({ ...snapshot, evidence }, 'P1'), false);
});

test('receipt and history reject wrong personal actors, repeated operations and impossible lifecycle jumps', () => {
  const receipt = { revisionId: 'P1', operationId: transaction.operationId, inputSha256: 'e'.repeat(64), transaction, accessEpoch: 5 };
  assert.equal(validRevisionReviewerResult(receipt, 'P1', input, 'U2'), true);
  for (const lifecycleVersion of [-1, 2, 50]) assert.equal(validRevisionReviewerResult({ ...receipt, transaction: { ...transaction, lifecycleVersion } }, 'P1', input, 'U2'), false);
  assert.equal(isRevisionReviewerTransaction({ ...transaction, reviewerId: 'U3' }, 'P1'), false);
  const history = { revisionId: 'P1', reviewerVersion: 2, transactions: [{ ...transaction, id: 'second', reviewerVersion: 2 }, transaction], nextBefore: null, accessEpoch: 5 };
  assert.equal(isRevisionReviewerHistory(history, 'P1'), false);
  assert.equal(isRevisionReviewerHistory({ ...history, transactions: [{ ...transaction, id: 'second', operationId: 'different', reviewerVersion: 2 }, transaction] }, 'P1'), true);
});
