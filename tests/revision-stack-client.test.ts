import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalRevisionStack, revisionStackTopology, type RevisionStack, type RevisionStackNode } from '../shared/revision-stack.ts';
import { revisionStackLayout, STACK_ROW_HEIGHT, stackAccessMatches, stackNarration, verifiedRevisionStack } from '../client/revision-stack.ts';

function fixture(ids = ['D1', 'L2', 'L3', 'P4', 'P5'], pairs = [['D1', 'L2'], ['D1', 'L3'], ['P4', 'L2'], ['L2', 'P5'], ['L3', 'P5']], seed = 'D1'): RevisionStack {
  const nodes: RevisionStackNode[] = ids.map(id => ({ id, title: `Literal <b>${id}</b>`, kind: id.startsWith('D') ? 'code' : id.startsWith('P') ? 'paper' : 'document', status: id === 'L3' ? 'closed' : 'needs_review', currentVersion: 2, updatedAt: '2026-10-12T00:00:00.000Z', relationshipVersion: 3, head: { versionId: `${id}-v2`, number: 2, contentHash: 'a'.repeat(64) }, author: { principalId: 'U1', displayName: 'Original Writer' }, originalAuthor: { principalId: 'U1', displayName: 'Original Writer' }, authorVersion: 0 }));
  const edges = pairs.map(([childId, parentId]) => ({ childId: childId!, parentId: parentId! })).sort((a, b) => a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : a.parentId < b.parentId ? -1 : 1);
  const { order, openParentIds } = revisionStackTopology(seed, nodes, edges);
  const graph: RevisionStack = { format: 'phabricator.revision-stack.v2', revisionId: seed, accessEpoch: 7, snapshotId: '', nodes: order.map(id => nodes.find(node => node.id === id)!), edges, openParentIds };
  graph.snapshotId = createHash('sha256').update(canonicalRevisionStack(graph)).digest('hex'); return graph;
}

test('rendering requires a whole source-bound stack and matching canonical digest for saved and fetched data', async () => {
  const stack = fixture(); assert.equal(await verifiedRevisionStack(stack, 'D1'), stack);
  await assert.rejects(verifiedRevisionStack(stack, 'P4'), /invalid/);
  await assert.rejects(verifiedRevisionStack({ ...stack, snapshotId: '0'.repeat(64) }, 'D1'), /snapshot/);
  await assert.rejects(verifiedRevisionStack({ ...stack, nodes: stack.nodes.map(node => ({ ...node, title: 'Substituted title' })) }, 'D1'), /snapshot/);
  await assert.rejects(verifiedRevisionStack({ ...stack, edges: stack.edges.slice(1) }, 'D1'), /invalid|snapshot/);
  await assert.rejects(verifiedRevisionStack({ ...stack, openParentIds: ['L3'] }, 'D1'), /invalid/);
});

test('trace layout retains sibling branches, closed parents and each exact merge edge', () => {
  const stack = fixture(), layout = revisionStackLayout(stack), positions = new Map(layout.rows.map((row, index) => [row.id, index]));
  assert.equal(layout.rows.length, 5); assert.equal(layout.traces.length, 5); assert.ok(layout.lanes > 1);
  assert.deepEqual(layout.rows.find(row => row.id === 'D1')!.parents, ['L2', 'L3']);
  assert.deepEqual(layout.rows.find(row => row.id === 'L2')!.children, ['D1', 'P4']);
  assert.deepEqual(stack.openParentIds, ['L2', 'P5']);
  for (const edge of layout.traces) { assert.ok(positions.get(edge.childId)! < positions.get(edge.parentId)!); assert.ok(edge.path.endsWith(`V ${positions.get(edge.parentId)! * STACK_ROW_HEIGHT + STACK_ROW_HEIGHT / 2}`)); assert.ok(!edge.path.includes('NaN')); }
  assert.deepEqual(revisionStackLayout(stack), layout);
});

test('singleton and maximum-depth layouts remain bounded and preserve all nodes', () => {
  assert.deepEqual(revisionStackLayout(fixture(['D1'], [])).rows, [{ id: 'D1', lane: 0, parents: [], children: [] }]);
  const ids = Array.from({ length: 1000 }, (_, index) => `D${index + 1}`), pairs = ids.slice(0, -1).map((id, index) => [id, ids[index + 1]!]);
  const layout = revisionStackLayout(fixture(ids, pairs)); assert.equal(layout.rows.length, 1000); assert.equal(layout.traces.length, 999); assert.equal(layout.lanes, 1); assert.equal(layout.height, 1000 * STACK_ROW_HEIGHT);
});

test('unknown access fallback is limited to local offline snapshots and local narration is bounded', () => {
  assert.equal(stackAccessMatches(7, 7, false, true), true);
  assert.equal(stackAccessMatches(7, 8, true, false), false);
  assert.equal(stackAccessMatches(7, -1, true, false), true);
  assert.equal(stackAccessMatches(7, -1, true, true), false);
  assert.equal(stackAccessMatches(7, -1, false, false), false);
  const stack = fixture(); assert.match(stackNarration(stack, 'D1', true), /5 visible revisions and 2 open transitive parents/); assert.match(stackNarration(stack, 'D1'), /Current author: Original Writer/); assert.match(stackNarration(stack, 'D1'), /Direct parents: L2, L3/); assert.match(stackNarration(stack, 'L3'), /closed/);
  assert.equal(stackNarration(stack, 'L999'), 'No stack revision is selected.');
});
