import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalRevisionStack, isRevisionStack, REVISION_STACK_FORMAT, REVISION_STACK_LIMITS, revisionStackTopology, type RevisionStack, type RevisionStackNode, type RevisionStackEdge } from '../shared/revision-stack.ts';

const node = (id: string, status: RevisionStackNode['status'] = 'needs_review'): RevisionStackNode => ({ id, title: `Manuscript ${id}`, kind: 'paper', status, currentVersion: 1, updatedAt: '2026-10-11T00:00:00Z', relationshipVersion: 0, head: { versionId: `source-${id}`, number: 1, contentHash: 'a'.repeat(64) }, author: { principalId: 'U1', displayName: 'Original author' }, originalAuthor: { principalId: 'U1', displayName: 'Original author' }, authorVersion: 0, lifecycleVersion: 0 });
function make(nodes: RevisionStackNode[], edges: RevisionStackEdge[], revisionId = 'P1'): RevisionStack {
  const topology = revisionStackTopology(revisionId, nodes, edges);
  const stack: RevisionStack = { format: REVISION_STACK_FORMAT, revisionId, accessEpoch: 3, closeOnAccept: false, snapshotId: '', nodes: topology.order.map(id => nodes.find(item => item.id === id)!), edges: [...edges].sort((a, b) => a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : a.parentId < b.parentId ? -1 : 1), openParentIds: topology.openParentIds };
  stack.snapshotId = createHash('sha256').update(canonicalRevisionStack(stack)).digest('hex'); return stack;
}

test('stack topology includes collaterals and keeps closed intermediates while counting only open ancestors', () => {
  const nodes = [node('P1'), node('D2', 'closed'), node('L3', 'accepted'), node('P4'), node('D5'), node('L6')];
  const edges = [{ childId: 'P1', parentId: 'D2' }, { childId: 'D2', parentId: 'L3' }, { childId: 'P4', parentId: 'D2' }, { childId: 'D5', parentId: 'P1' }, { childId: 'D5', parentId: 'L6' }];
  const stack = make(nodes, edges);
  assert.equal(isRevisionStack(stack, 'P1'), true); assert.deepEqual(stack.openParentIds, ['L3']);
  assert.deepEqual(stack.nodes.map(item => item.id), ['D5', 'L6', 'P1', 'P4', 'D2', 'L3']);
  assert.deepEqual(revisionStackTopology('P1', [...nodes].reverse(), [...edges].reverse()), { order: stack.nodes.map(item => item.id), openParentIds: ['L3'] });
  assert.equal(stack.nodes.filter(item => item.status === 'closed').length, 1);
});

test('stack guards reject cycles, disconnected rows, invented edges, altered ordering and incorrect open counts', () => {
  const stack = make([node('P1'), node('P2'), node('L3')], [{ childId: 'P1', parentId: 'P2' }, { childId: 'P2', parentId: 'L3' }]);
  for (const corrupt of [
    { ...stack, nodes: [...stack.nodes, node('D4')] }, { ...stack, nodes: [...stack.nodes].reverse() }, { ...stack, openParentIds: ['P1', 'P2', 'L3'] },
    { ...stack, openParentIds: ['P2'] }, { ...stack, edges: [...stack.edges, { childId: 'L3', parentId: 'P1' }] }, { ...stack, edges: [...stack.edges, stack.edges[0]] },
    { ...stack, edges: [{ childId: 'P1', parentId: 'D4' }] }, { ...stack, edges: [...stack.edges].reverse() },
    { ...stack, nodes: stack.nodes.map((item, index) => index ? item : { ...item, head: { ...item.head, number: 2 } }) },
    { ...stack, nodes: stack.nodes.map((item, index) => index ? item : { ...item, kind: ['paper'] }) },
    { ...stack, nodes: stack.nodes.map((item, index) => index ? item : { ...item, status: ['needs_review'] }) },
    { ...stack, privatePath: 'unsupported data' }, { ...stack, snapshotId: 'not-a-digest' }, { ...stack, accessEpoch: -1 },
  ]) assert.equal(isRevisionStack(corrupt, 'P1'), false);
  assert.equal(isRevisionStack(stack, 'D2'), false);
  assert.throws(() => revisionStackTopology('P1', [node('P1'), node('P2')], [{ childId: 'P1', parentId: 'P2' }, { childId: 'P2', parentId: 'P1' }]));
});

test('canonical stack identity covers current metadata, source, original author, graph versions and access epoch', () => {
  const stack = make([node('P1')], []), digest = (value: RevisionStack) => createHash('sha256').update(canonicalRevisionStack(value)).digest('hex');
  assert.equal(digest(stack), stack.snapshotId); assert.equal(digest({ ...stack, snapshotId: 'b'.repeat(64) }), stack.snapshotId);
  // Canonical field order must not depend on the order used to construct an object.
  assert.equal(canonicalRevisionStack({ ...stack, nodes: stack.nodes.map(item => ({ author: item.author, originalAuthor: item.originalAuthor, authorVersion: item.authorVersion, lifecycleVersion: item.lifecycleVersion, head: item.head, relationshipVersion: item.relationshipVersion, updatedAt: item.updatedAt, currentVersion: item.currentVersion, status: item.status, kind: item.kind, title: item.title, id: item.id })) }), canonicalRevisionStack(stack));
  for (const patch of [{ title: 'Changed title' }, { status: 'accepted' }, { relationshipVersion: 2 }, { author: null, originalAuthor: null, authorVersion: 0, lifecycleVersion: 0 }, { head: { ...stack.nodes[0]!.head, contentHash: 'b'.repeat(64) } }]) assert.notEqual(digest({ ...stack, nodes: [{ ...stack.nodes[0]!, ...patch } as RevisionStackNode] }), stack.snapshotId);
  assert.notEqual(digest({ ...stack, accessEpoch: 4 }), stack.snapshotId);
});

test('bounded stack reads cannot masquerade as a partial graph or retain excessive metadata', () => {
  const single = make([node('P1')], []); assert.equal(isRevisionStack(single), true);
  assert.equal(isRevisionStack({ ...single, nodes: Array.from({ length: REVISION_STACK_LIMITS.nodes + 1 }, (_, i) => node(`P${i + 1}`)) }), false);
  const nodes = Array.from({ length: REVISION_STACK_LIMITS.nodes }, (_, index) => ({ ...node(`P${index + 1}`), title: '🧪'.repeat(500) }));
  const edges = nodes.slice(1).map(item => ({ childId: item.id, parentId: 'P1' })), large = make(nodes, edges);
  assert.ok(new TextEncoder().encode(canonicalRevisionStack(large)).byteLength > REVISION_STACK_LIMITS.bytes);
  assert.equal(isRevisionStack(large), false);
});
