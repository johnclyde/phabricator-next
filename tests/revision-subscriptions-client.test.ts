import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mergeMuteHistory, mergeSubscribers, mergeSubscriptionHistory, prepareSubscriptionDraft, subscriptionAuthority, subscriptionDraftMatches, subscriptionIntent, subscriptionReading, subscriptionSnapshot, verifiedSubscriptionResult } from '../client/revision-subscriptions.ts';
import { revisionSubscriptionInput, type RevisionMuteHistory, type RevisionSubscriptionHistory, type RevisionSubscriptionReceipt } from '../shared/revision-subscriptions.ts';
import { history, muteHistory, person, reading, snapshot } from './revision-subscriptions-client-fixture.ts';
const date = '2026-10-01T00:00:00.000Z', attribution = { principalId: 'U1', displayName: 'Reader', credentialId: null, requestId: 'request' };
const transaction = (sequence: number) => ({ id: `event-${sequence}`, revisionId: 'P1', operationId: `operation-${sequence}`, subscriptionVersion: sequence, principalId: `U${sequence}`, displayName: `Person ${sequence}`, version: 1, before: null, after: 'subscribed' as const, reason: 'explicit' as const, commentId: null, authorVersion: 0, reviewerVersion: 0, attribution, createdAt: date });
test('following caches bind private mute history to the viewer, versions and current access', () => {
  assert.deepEqual(subscriptionReading(reading, 'P1', 'U1'), reading); assert.equal(subscriptionReading(reading, 'P1', 'U2'), null);
  for (const malformed of [{ ...reading, muteHistory: { ...muteHistory, principalId: 'U2' } }, { ...reading, history: { ...history, accessEpoch: 2 } }, { ...reading, muteHistory: { ...muteHistory, muteVersion: 1 } }, { ...reading, snapshot: { ...snapshot, nextAfter: 'U9' } }, { ...reading, snapshot: { ...snapshot, access: { ...snapshot.access, capabilities: { ...snapshot.access.capabilities, view: false } } } }]) assert.equal(subscriptionReading(malformed, 'P1'), null);
});
test('following pages preserve exact role snapshots and reject overlap, backwards pages and fabricated cursors', () => {
  const following = (id: string) => ({ ...person(id), automatic: ['reviewer' as const], following: true });
  const before = { ...snapshot, subscribers: [following('U2')], nextAfter: 'U2' }, next = { ...snapshot, subscribers: [following('U3')], nextAfter: null };
  assert.deepEqual(mergeSubscribers(before, next).subscribers.map(item => item.principalId), ['U2', 'U3']);
  assert.equal(subscriptionSnapshot({ ...before, nextAfter: 'U99' }, 'P1'), false);
  for (const bad of [{ ...next, subscribers: [following('U2')] }, { ...next, roleDigest: 'b'.repeat(64) }, { ...next, viewer: person('U9'), mute: { ...snapshot.mute, principalId: 'U9' } }, { ...next, mute: { ...snapshot.mute, version: 1, muted: true, updatedAt: date } }]) assert.throws(() => mergeSubscribers(before, bad), /changed/);
});
test('cached following can include the complete explicit, reviewer and author union', () => {
  const subscribers = Array.from({ length: 1101 }, (_, index) => ({ ...person(`U${String(index + 1000).padStart(5, '0')}`), ...(index < 1000 ? { version: 1, state: 'subscribed' as const, updatedAt: date } : { automatic: [index === 1100 ? 'author' as const : 'reviewer' as const] }), following: true }));
  const complete = { ...snapshot, subscriptionVersion: 1000, subscribers };
  assert.equal(subscriptionSnapshot(complete, 'P1'), true);
  assert.equal(subscriptionSnapshot({ ...complete, subscribers: [...subscribers, { ...person('U99999'), automatic: ['reviewer'], following: true }] }, 'P1'), false);
});
test('public and private histories stay independent and reject mixed or overlapping continuations', () => {
  const before: RevisionSubscriptionHistory = { ...history, subscriptionVersion: 2, transactions: [transaction(2)], nextBefore: 2 }, next = { ...before, transactions: [transaction(1)], nextBefore: null };
  assert.equal(mergeSubscriptionHistory(before, next).transactions.length, 2); assert.throws(() => mergeSubscriptionHistory(before, before), /changed/);
  const privateEvent = (version: number) => ({ id: `mute-${version}`, revisionId: 'P1', operationId: `mute-op-${version}`, principalId: 'U1', version, before: version === 2, after: version !== 2, attribution, createdAt: date });
  const first: RevisionMuteHistory = { ...muteHistory, muteVersion: 2, transactions: [privateEvent(2)], nextBefore: 2 }, second = { ...first, transactions: [privateEvent(1)], nextBefore: null };
  assert.equal(mergeMuteHistory(first, second).transactions.length, 2); assert.throws(() => mergeMuteHistory(first, { ...second, principalId: 'U2' }), /changed/);
});
test('drafts retain original pins across source-only reviewer counters; real roles or preference changes never silently rebase', () => {
  const draft = prepareSubscriptionDraft(snapshot, 'subscribe');
  assert.equal(subscriptionDraftMatches(draft, { ...snapshot, reviewerVersion: 3 }), true);
  assert.equal(subscriptionDraftMatches(draft, { ...snapshot, reviewerVersion: 3, roleDigest: 'b'.repeat(64) }), false);
  assert.equal(subscriptionDraftMatches(draft, { ...snapshot, authorVersion: 1 }), false);
  const mute = prepareSubscriptionDraft(snapshot, 'mute'); assert.equal(subscriptionDraftMatches(mute, { ...snapshot, authorVersion: 10, reviewerVersion: 12, roleDigest: 'b'.repeat(64) }), true);
  assert.equal(subscriptionDraftMatches(mute, { ...snapshot, mute: { ...snapshot.mute, version: 1, muted: true, updatedAt: date } }), false);
  const target = { ...person('U2'), version: 4, state: 'unsubscribed' as const, updatedAt: date }, selected = prepareSubscriptionDraft(snapshot, 'subscribe', target, { status: target, authorVersion: 0, reviewerVersion: 2, roleDigest: snapshot.roleDigest, accessEpoch: 1 });
  assert.equal('expectedSubscriptionVersion' in selected.input && selected.input.expectedSubscriptionVersion, 4); assert.equal(selected.input.expectedReviewerVersion, 2);
  const intent = { id: '61eb8a98-0397-49d3-bf10-cf67fffcf83b', revisionId: 'P1', body: draft.input, draft }; assert.deepEqual(subscriptionIntent(intent, 'P1'), intent); assert.equal(subscriptionIntent({ ...intent, draft: mute }, 'P1'), null); assert.equal(subscriptionIntent({ ...intent, id: '-'.repeat(36) }, 'P1'), null);
});
test('self preferences use View, adding others uses Interact or Edit, removing others uses Edit', () => {
  assert.equal(subscriptionAuthority(prepareSubscriptionDraft(snapshot, 'subscribe'), 'U1'), 'view'); assert.equal(subscriptionAuthority(prepareSubscriptionDraft(snapshot, 'mute'), 'U1'), 'view');
  assert.equal(subscriptionAuthority(prepareSubscriptionDraft(snapshot, 'subscribe', person('U2')), 'U1'), 'interact_or_edit'); assert.equal(subscriptionAuthority(prepareSubscriptionDraft(snapshot, 'unsubscribe', person('U2')), 'U1'), 'edit');
  assert.equal(subscriptionAuthority({ ...prepareSubscriptionDraft(snapshot, 'mute').input, principalId: 'U2' }, 'U1'), null);
});
test('receipts bind the exact normalized request digest and actor before cleanup', async () => {
  const input = prepareSubscriptionDraft(snapshot, 'subscribe').input, normalized = revisionSubscriptionInput(input), tx = transaction(1);
  const receipt: RevisionSubscriptionReceipt = { revisionId: 'P1', operationId: tx.operationId, inputSha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex'), changed: true, accessEpoch: 1, kind: 'subscription', subscriptionVersion: 1, status: { ...snapshot.viewer, displayName: tx.displayName, version: 1, state: 'subscribed', following: true, updatedAt: date }, transaction: tx };
  assert.deepEqual(await verifiedSubscriptionResult(receipt, 'P1', input, 'U1'), receipt);
  await assert.rejects(verifiedSubscriptionResult({ ...receipt, inputSha256: 'b'.repeat(64) }, 'P1', input, 'U1'), /different request/);
  await assert.rejects(verifiedSubscriptionResult(receipt, 'P1', input, 'U2'), /does not match/);
});
