import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROJECT_DEPTH, normalizeProjectTags, visibleProjectScope, type ProjectTagNode } from '../shared/project-hierarchy';
import { projectDisplayName } from '../shared/projects';

const graph: ProjectTagNode[] = [
  { id: 'root', kind: 'project', parentId: null },
  { id: 'child', kind: 'project', parentId: 'root' },
  { id: 'sibling', kind: 'project', parentId: 'root' },
  { id: 'leaf', kind: 'project', parentId: 'child' },
  { id: 'm1', kind: 'milestone', parentId: 'root' },
  { id: 'm2', kind: 'milestone', parentId: 'root' },
  { id: 'cm', kind: 'milestone', parentId: 'child' },
  { id: 'other', kind: 'project', parentId: null },
];

test('task tags apply last-input-wins to ancestors and same-parent milestones', () => {
  for (const [input, expected] of [
    [['root', 'leaf'], ['leaf']], [['leaf', 'root'], ['root']],
    [['root', 'm1'], ['m1']], [['m1', 'root'], ['root']],
    [['m1', 'm2'], ['m2']], [['m2', 'm1'], ['m1']],
    [['child', 'sibling'], ['child', 'sibling']], [['m1', 'cm'], ['m1', 'cm']],
    [['child', 'm1'], ['child', 'm1']], [['other', 'root', 'leaf', 'sibling', 'm1', 'm2'], ['other', 'leaf', 'sibling', 'm2']],
    [['child', 'sibling', 'root', 'leaf'], ['leaf']], [['root', 'leaf', 'root'], ['root']],
  ]) assert.deepEqual(normalizeProjectTags(input!, graph), expected, JSON.stringify(input));
  assert.deepEqual(normalizeProjectTags([], graph), []);
  assert.deepEqual(normalizeProjectTags(['m1', 'other', 'm1'], graph), ['other', 'm1']);
  const archived = graph.map(node => ({ ...node, status: 'archived' }));
  assert.deepEqual(normalizeProjectTags(['root', 'm1', 'm2'], archived), ['m2'], 'archiving does not dissolve hierarchy conflicts');
});

test('visible parent filters do not infer paths through missing or cyclic nodes', () => {
  assert.deepEqual(visibleProjectScope('root', graph), ['root', 'child', 'sibling', 'leaf', 'm1', 'm2', 'cm']);
  assert.deepEqual(visibleProjectScope('child', graph), ['child', 'leaf', 'cm']);
  assert.deepEqual(visibleProjectScope('m1', graph), ['m1']);
  assert.deepEqual(visibleProjectScope('missing', graph), []);
  assert.deepEqual(visibleProjectScope('root', graph.filter(node => node.id !== 'child')), ['root', 'sibling', 'm1', 'm2']);
  const cyclic = graph.map(node => node.id === 'child' ? { ...node, parentId: 'leaf' } : node);
  assert.deepEqual(visibleProjectScope('root', cyclic), ['root', 'sibling', 'm1', 'm2']);
  assert.throws(() => normalizeProjectTags(['leaf'], cyclic), /invalid/);
  assert.throws(() => normalizeProjectTags(['leaf'], graph.filter(node => node.id !== 'child')), /incomplete/);
  assert.throws(() => normalizeProjectTags(['missing'], graph), /incomplete/);
  assert.throws(() => normalizeProjectTags(['leaf'], [...graph, graph[0]!]), /duplicate/);
});

test('hierarchy helpers enforce sixteen levels and disallow milestone parents', () => {
  const deep: ProjectTagNode[] = Array.from({ length: MAX_PROJECT_DEPTH + 2 }, (_, index) => ({ id: `n${index}`, parentId: index ? `n${index - 1}` : null, kind: 'project' }));
  assert.deepEqual(normalizeProjectTags(['n0', `n${MAX_PROJECT_DEPTH}`], deep), [`n${MAX_PROJECT_DEPTH}`]);
  assert.throws(() => normalizeProjectTags([`n${MAX_PROJECT_DEPTH + 1}`], deep), /invalid/);
  assert.throws(() => normalizeProjectTags(['child'], [{ id: 'child', kind: 'project', parentId: 'm' }, { id: 'm', kind: 'milestone', parentId: null }]), /invalid/);
  assert.throws(() => normalizeProjectTags(['m'], [{ id: 'm', kind: 'milestone', parentId: null }]), /parent/);
});

test('historical project labels never require live hierarchy data', () => {
  assert.equal(projectDisplayName({ name: 'Recorded name' }), 'Recorded name');
  assert.equal(projectDisplayName({ name: 'Release', displayName: 'Research (Release)' }), 'Research (Release)');
});
