import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RevisionAuthorHistory, RevisionAuthorTransaction, RevisionAuthorshipSnapshot } from '../shared/revision-authorship.ts';
import { revisionAuthorInput } from '../shared/revision-authorship.ts';
import { authorDraft, authorDraftMatches, authorHistory, authorIntent, authorReading, authorSnapshot, mergeAuthorHistory, prepareAuthorDraft, verifiedAuthorResult } from '../client/revision-authorship.ts';

const alice = { principalId: 'U1', displayName: 'Original author' }, bob = { principalId: 'U2', displayName: 'Current <script>author</script>' };
const snapshot: RevisionAuthorshipSnapshot = { authorship: { revisionId: 'L1', version: 0, author: alice, originalAuthor: alice, updatedAt: null }, head: { versionId: 'version-1', number: 1, contentHash: 'a'.repeat(64) }, status: 'accepted', closeOnAccept: false, accessEpoch: 5, access: { policy: { objectId: 'L1', spaceId: 'S1', version: 1, rules: { view: { kind: 'workspace' }, edit: { kind: 'workspace' }, interact: { kind: 'workspace' } } }, capabilities: { view: true, edit: true, interact: false, managePolicy: true }, viewLabel: 'Workspace', editLabel: 'Workspace', interactLabel: 'No one' } };
const history: RevisionAuthorHistory = { revisionId: 'L1', authorVersion: 0, transactions: [], nextBefore: null, accessEpoch: 5 };
const input = { ...prepareAuthorDraft(snapshot, { authorId: bob.principalId }), message: ' Exact authorship note. ' };
const transaction: RevisionAuthorTransaction = { id: 'transaction-1', revisionId: 'L1', operationId: 'operation-1', authorVersion: 1, action: 'assign', previousAuthor: alice, author: bob, head: snapshot.head, message: input.message, attribution: { principalId: 'U1', displayName: 'Original author', requestId: 'request-1', credentialId: null }, createdAt: '2026-10-11T12:00:00.000Z' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('authorship reading binds the current snapshot and history without deriving current owner from original attribution', () => {
  assert.deepEqual(authorReading({ snapshot, history }, 'L1'), { snapshot, history });
  assert.equal(authorReading({ snapshot, history: { ...history, accessEpoch: 6 } }, 'L1'), null);
  assert.equal(authorReading({ snapshot, history: { ...history, authorVersion: 1 } }, 'L1'), null);
  assert.equal(authorReading({ snapshot, history, staleLabel: 'private' }, 'L1'), null);
  assert.equal(authorSnapshot({ ...snapshot, authorship: undefined }, 'L1'), false);
  assert.equal(authorSnapshot({ ...snapshot, authorship: { ...snapshot.authorship, author: bob } }, 'L1'), false);
  assert.equal(authorSnapshot({ ...snapshot, access: { ...snapshot.access, capabilities: { ...snapshot.access.capabilities, view: false } } }, 'L1'), false);
  assert.equal(authorSnapshot(snapshot, 'P1'), false);
});

test('author history continuation rejects unordered, repeated and cross-version snapshots', () => {
  const first = { ...history, authorVersion: 2, transactions: [{ ...transaction, authorVersion: 2 }], nextBefore: 2 };
  const next = { ...history, authorVersion: 2, transactions: [{ ...transaction, id: 'older', operationId: 'older-op' }], nextBefore: null };
  assert.deepEqual(mergeAuthorHistory(first, next).transactions.map(item => item.authorVersion), [2, 1]);
  assert.throws(() => mergeAuthorHistory(first, first), /changed/);
  assert.throws(() => mergeAuthorHistory(first, { ...next, authorVersion: 3 }), /changed/);
  assert.throws(() => mergeAuthorHistory(first, { ...next, accessEpoch: 6 }), /changed/);
  assert.throws(() => mergeAuthorHistory(first, { ...next, transactions: [{ ...next.transactions[0]!, operationId: transaction.operationId }] }), /changed/);
  assert.equal(authorHistory({ ...first, nextBefore: 1 }, 'L1'), false);
  assert.equal(authorHistory({ ...first, transactions: [...next.transactions, ...first.transactions] }, 'L1'), false);
  assert.equal(authorHistory({ ...first, transactions: [first.transactions[0], { ...transaction, id: 'different' }] }, 'L1'), false);
});

test('drafts and immutable requests retain exact original pins and whitespace with no member labels', () => {
  assert.deepEqual(authorDraft(input), input);
  assert.equal(authorDraft({ ...input, authorName: 'Private label' }), null);
  assert.equal(authorDraft({ ...input, authorId: null }), null);
  assert.equal(authorDraftMatches(input, snapshot), true);
  assert.equal(authorDraftMatches(input, { ...snapshot, authorship: { ...snapshot.authorship, version: 1 } }), false);
  assert.equal(authorDraftMatches(input, { ...snapshot, head: { ...snapshot.head, contentHash: 'b'.repeat(64) } }), false);
  assert.equal(authorDraftMatches(input, { ...snapshot, accessEpoch: 6 }), false);
  const intent = { id: '12345678-1234-4123-8123-123456789abc', revisionId: 'L1', body: input, draft: input };
  assert.deepEqual(authorIntent(intent, 'L1'), intent);
  assert.equal(authorIntent({ ...intent, id: '-'.repeat(36) }, 'L1'), null);
  assert.equal(authorIntent({ ...intent, draft: { ...input, message: 'Newer text' } }, 'L1'), null);
  assert.equal(authorIntent(intent, 'P1'), null);
  assert.equal(prepareAuthorDraft(snapshot, 'commandeer').action, 'commandeer');
});

test('full and content-free receipts must bind exact normalized input hash and trusted actor', async () => {
  const receipt = { revisionId: 'L1', operationId: 'operation-1', inputSha256: digest(revisionAuthorInput(input)), transaction, accessEpoch: 6 };
  assert.deepEqual(await verifiedAuthorResult(receipt, 'L1', input, 'U1'), receipt);
  await assert.rejects(verifiedAuthorResult({ ...receipt, transaction: { ...transaction, message: input.message.trim() } }, 'L1', input, 'U1'), /receipt/);
  await assert.rejects(verifiedAuthorResult(receipt, 'L1', input, 'U2'), /receipt/);
  await assert.rejects(verifiedAuthorResult({ ...receipt, inputSha256: 'b'.repeat(64) }, 'L1', input, 'U1'), /different request/);
  const ack = { revisionId: 'L1', operationId: 'operation-1', inputSha256: receipt.inputSha256, saved: true as const, accessLost: true as const, accessEpoch: 6 };
  assert.deepEqual(await verifiedAuthorResult(ack, 'L1', input, 'U1'), ack);
  await assert.rejects(verifiedAuthorResult({ ...ack, author: bob }, 'L1', input, 'U1'), /receipt/);
  await assert.rejects(verifiedAuthorResult(ack, 'L1', { ...input, message: 'Another action' }, 'U1'), /different request/);
});
