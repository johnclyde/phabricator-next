import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyDraft, dependencyHistory, dependencyIntent, dependencyPage, dependencySnapshot, emptyDependencyDraft, mergeDependencyHistory, mergeDependencyPage } from '../client/revision-dependencies.ts';
import type { RevisionDependencyHistory, RevisionDependencyPage } from '../shared/revision-dependencies.ts';

const reference = { id: 'P2', title: '<script>literal title</script>', kind: 'paper' as const, status: 'needs_review' as const, currentVersion: 2, updatedAt: '2026-01-01T00:00:00.000Z' };
const parents: RevisionDependencyPage = { revisionId: 'L1', direction: 'parents', relationshipVersion: 3, revisions: [reference], nextAfter: 'P2', accessEpoch: 7 };
const children: RevisionDependencyPage = { ...parents, direction: 'children', revisions: [], nextAfter: null };
const history: RevisionDependencyHistory = { revisionId: 'L1', relationshipVersion: 3, accessEpoch: 7, transactions: [], nextBefore: null };
const snapshot = { revisionId: 'L1', relationshipVersion: 3, accessEpoch: 7, parents, children, history };

test('relationship snapshots require exact source, epoch and relationship versions across every page', () => {
  assert.deepEqual(dependencySnapshot(snapshot, 'L1'), snapshot);
  assert.equal(dependencySnapshot(snapshot, 'D1'), null);
  assert.equal(dependencySnapshot({ ...snapshot, children: { ...children, relationshipVersion: 4 } }, 'L1'), null);
  assert.equal(dependencySnapshot({ ...snapshot, history: { ...history, accessEpoch: 8 } }, 'L1'), null);
  assert.equal(dependencyPage({ ...parents, revisions: [reference, reference] }, 'L1', 'parents'), false);
  assert.equal(dependencyPage({ ...parents, revisions: [{ ...reference, id: 'L1' }] }, 'L1', 'parents'), false);
  assert.equal(dependencyPage({ ...parents, revisions: [{ ...reference, currentVersion: 0 }] }, 'L1', 'parents'), false);
  assert.equal(dependencyHistory({ ...history, nextBefore: -1 }, 'L1'), false);
});

test('paging permits empty terminal pages but rejects changed pins, arbitrary cursors and overlapping or unordered rows', () => {
  assert.deepEqual(mergeDependencyPage(parents, { ...parents, revisions: [], nextAfter: null }), { ...parents, nextAfter: null });
  assert.deepEqual(mergeDependencyPage(parents, { ...parents, revisions: [{ ...reference, id: 'P3' }], nextAfter: null }).revisions.map(item => item.id), ['P2', 'P3']);
  assert.throws(() => mergeDependencyPage(parents, { ...parents, relationshipVersion: 4 }), /changed/);
  assert.throws(() => mergeDependencyPage(parents, { ...parents, accessEpoch: 8 }), /changed/);
  assert.throws(() => mergeDependencyPage(parents, parents), /changed/);
  assert.throws(() => mergeDependencyPage(parents, { ...parents, revisions: [{ ...reference, id: 'D3' }], nextAfter: null }), /changed/);
  assert.equal(dependencyPage({ ...parents, nextAfter: 'arbitrary' }, 'L1', 'parents'), false);
  assert.equal(dependencyPage({ ...parents, nextAfter: 'P3' }, 'L1', 'parents'), false);
  assert.equal(dependencyPage({ ...parents, revisions: [{ ...reference, id: 'P3' }, reference] }, 'L1', 'parents'), false);
  assert.throws(() => mergeDependencyHistory(history, { ...history, relationshipVersion: 4 }), /changed/);
  assert.throws(() => mergeDependencyHistory(history, { ...history, accessEpoch: 8 }), /changed/);
});

test('history continuation is strictly descending with a positive last-visible sequence cursor', () => {
  const transaction = { id: '12345678-1234-4123-8123-123456789abc', operationId: '12345678-1234-4123-8123-123456789def', revisionId: 'L1', sequence: 8, relationshipVersion: 3, actor: 'Reviewer', attribution: { principalId: 'U1', displayName: 'Reviewer', requestId: 'request', credentialId: null }, createdAt: reference.updatedAt, change: { direction: 'parents' as const, action: 'added' as const, revisionId: 'P2' } };
  const first = { ...history, transactions: [transaction], nextBefore: 8 }, older = { ...transaction, id: '12345678-1234-4123-8123-123456789aaa', sequence: 6 };
  assert.equal(dependencyHistory(first, 'L1'), true);
  assert.deepEqual(mergeDependencyHistory(first, { ...history, transactions: [older] }).transactions.map(item => item.sequence), [8, 6]);
  assert.throws(() => mergeDependencyHistory(first, first), /changed/);
  assert.throws(() => mergeDependencyHistory(first, { ...history, transactions: [{ ...older, sequence: 9 }] }), /changed/);
  assert.equal(dependencyHistory({ ...first, nextBefore: 0 }, 'L1'), false);
  assert.equal(dependencyHistory({ ...first, nextBefore: 7 }, 'L1'), false);
  assert.equal(dependencyHistory({ ...first, transactions: [older, transaction] }, 'L1'), false);
  assert.equal(dependencyHistory({ ...first, transactions: [transaction, { ...older, sequence: 8 }] }, 'L1'), false);
});

test('ID-only drafts keep original concurrency pins without retaining titles or silently changing scope', () => {
  const initial = emptyDependencyDraft(snapshot, 'parents');
  assert.deepEqual(dependencyDraft(initial), initial);
  assert.deepEqual(dependencyDraft({ ...initial, add: ['P2', 'D3'] }), { ...initial, add: ['D3', 'P2'] });
  assert.equal(dependencyDraft({ ...initial, title: 'Private peer title' }), null);
  assert.equal(dependencyDraft({ ...initial, add: ['P2'], title: 'Private peer title' }), null);
  assert.equal(dependencyDraft({ ...initial, add: ['P2'], remove: ['P2'] }), null);
  assert.equal(dependencyDraft({ ...initial, add: ['F1'] }), null);
  assert.equal(dependencyDraft({ ...initial, expectedAccessEpoch: -1 }), null);
  const retained = { ...initial, add: ['P2'] };
  emptyDependencyDraft({ ...snapshot, relationshipVersion: 4, accessEpoch: 8 }, 'children');
  assert.equal(retained.expectedRelationshipVersion, 3); assert.equal(retained.expectedAccessEpoch, 7);
  const intent = { id: '12345678-1234-4123-8123-123456789abc', revisionId: 'L1', body: retained, draft: retained };
  assert.deepEqual(dependencyIntent(intent, 'L1'), intent);
  assert.equal(dependencyIntent({ ...intent, id: '-'.repeat(36) }, 'L1'), null);
  assert.equal(dependencyIntent({ ...intent, draft: { ...retained, add: ['P3'] } }, 'L1'), null);
});
