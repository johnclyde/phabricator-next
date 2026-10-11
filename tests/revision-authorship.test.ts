import test from 'node:test';
import assert from 'node:assert/strict';
import { revisionAuthorInput, isRevisionAuthorship, isRevisionAuthorHistory, validRevisionAuthorResult, type RevisionAuthorInput, type RevisionAuthorTransaction } from '../shared/revision-authorship.ts';

const author = { principalId: 'alice', displayName: 'Original writer' }, next = { principalId: 'bob', displayName: 'Current writer' };
const input: RevisionAuthorInput = { action: 'assign', authorId: next.principalId, expectedAuthorVersion: 0, expectedVersion: 2, expectedVersionId: 'exact-head', expectedContentHash: 'a'.repeat(64), expectedAccessEpoch: 7, message: 'Please take this draft.' };
const transaction: RevisionAuthorTransaction = { id: 'transaction', operationId: 'operation', revisionId: 'P1', authorVersion: 1, action: 'assign', previousAuthor: author, author: next, head: { versionId: input.expectedVersionId, number: 2, contentHash: input.expectedContentHash }, message: input.message, attribution: { principalId: author.principalId, displayName: author.displayName, credentialId: null, requestId: 'request' }, createdAt: '2026-10-11T00:00:00Z' };

test('author intents require exact concurrency and source pins without implicit assignment or field coercion', () => {
  assert.deepEqual(revisionAuthorInput(input), input);
  const { authorId: _, ...commandeer } = { ...input, action: 'commandeer' as const }; assert.deepEqual(revisionAuthorInput(commandeer), commandeer);
  for (const patch of [{ action: ['assign'] }, { authorId: null }, { authorId: '' }, { expectedAuthorVersion: -1 }, { expectedVersion: 0 }, { expectedVersionId: '' }, { expectedContentHash: 'A'.repeat(64) }, { expectedAccessEpoch: '7' }, { message: '\0' }, { message: 'a'.repeat(10_001) }, { extra: true }]) assert.throws(() => revisionAuthorInput({ ...input, ...patch }));
  assert.throws(() => revisionAuthorInput({ ...commandeer, authorId: author.principalId }));
  assert.throws(() => revisionAuthorInput({ ...input, message: undefined }));
});

test('modern authorship intents preserve reviewer and lifecycle pins without rewriting historical receipt input', () => {
  const modern = { ...input, expectedReviewerVersion: 3, expectedLifecycleVersion: 4 };
  assert.deepEqual(revisionAuthorInput(modern), modern);
  assert.deepEqual(revisionAuthorInput(input), input);
  for (const patch of [{ expectedReviewerVersion: -1 }, { expectedReviewerVersion: '3' }, { expectedLifecycleVersion: 1.5 }, { expectedLifecycleVersion: null }]) {
    assert.throws(() => revisionAuthorInput({ ...modern, ...patch }));
  }
  const { expectedReviewerVersion: _reviewers, ...missingReviewers } = modern;
  const { expectedLifecycleVersion: _lifecycle, ...missingLifecycle } = modern;
  assert.throws(() => revisionAuthorInput(missingReviewers));
  assert.throws(() => revisionAuthorInput(missingLifecycle));
});

test('ownership baseline is honest and known original attribution cannot masquerade as a prior transfer', () => {
  const baseline = { revisionId: 'P1', version: 0, author, originalAuthor: author, updatedAt: null };
  assert.ok(isRevisionAuthorship(baseline, 'P1')); assert.ok(isRevisionAuthorship({ ...baseline, author: null, originalAuthor: null }, 'P1'));
  assert.equal(isRevisionAuthorship({ ...baseline, author: next }, 'P1'), false);
  assert.equal(isRevisionAuthorship({ ...baseline, version: 1 }, 'P1'), false);
  assert.ok(isRevisionAuthorship({ ...baseline, version: 1, author: next, updatedAt: transaction.createdAt }, 'P1'));
  assert.equal(isRevisionAuthorship(baseline, 'D1'), false);
});

test('receipt verification binds actor, target, action and exact source while minimal acknowledgments contain no content', () => {
  const receipt = { revisionId: 'P1', operationId: 'operation', inputSha256: 'b'.repeat(64), transaction, accessEpoch: 8 };
  assert.ok(validRevisionAuthorResult(receipt, 'P1', input, 'alice'));
  for (const patch of [{ authorVersion: 2 }, { author }, { action: 'commandeer' }, { head: { ...transaction.head, number: 1 } }, { head: { ...transaction.head, contentHash: 'c'.repeat(64) } }, { message: 'different' }, { attribution: { ...transaction.attribution, principalId: 'mallory' } }]) assert.equal(validRevisionAuthorResult({ ...receipt, transaction: { ...transaction, ...patch } }, 'P1', input, 'alice'), false);
  const acknowledgment = { revisionId: 'P1', operationId: 'operation', inputSha256: 'b'.repeat(64), accessEpoch: 9, saved: true, accessLost: true };
  assert.ok(validRevisionAuthorResult(acknowledgment, 'P1', input));
  assert.equal(validRevisionAuthorResult(acknowledgment, 'P1', input, 'bob'), false);
  const { authorId: _authorId, ...commandeer } = { ...input, action: 'commandeer' as const };
  assert.equal(validRevisionAuthorResult(acknowledgment, 'P1', commandeer, 'alice'), false);
  assert.equal(validRevisionAuthorResult({ ...acknowledgment, transaction }, 'P1', input), false);
  assert.equal(validRevisionAuthorResult({ ...acknowledgment, inputSha256: '' }, 'P1', input), false);
});

test('history validation rejects repeated, unordered, cross-revision or invented cursor records', () => {
  const history = { revisionId: 'P1', authorVersion: 1, transactions: [transaction], nextBefore: null, accessEpoch: 8 };
  assert.ok(isRevisionAuthorHistory(history, 'P1'));
  for (const patch of [{ transactions: [transaction, transaction] }, { authorVersion: 0 }, { transactions: [{ ...transaction, revisionId: 'L2' }] }, { nextBefore: 2 }, { transactions: [], nextBefore: 1 }, { accessEpoch: -1 }]) assert.equal(isRevisionAuthorHistory({ ...history, ...patch }, 'P1'), false);
});
