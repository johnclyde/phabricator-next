import test from 'node:test';
import assert from 'node:assert/strict';
import { repositorySelection } from '../client/repository-cache.ts';
import { comparisonCacheKey, comparisonQuery, validComparisonFile } from '../client/repository-comparison.ts';
import type { GitCommit, GitComparison, GitComparisonFile } from '../shared/repositories.ts';

const base = 'a'.repeat(40), target = 'b'.repeat(40);
test('comparison selection retains only exact pair and side paths, with explicit empty tree identity', () => {
  const selection = { commitId: target, path: '', view: 'changes' as const, baseCommitId: base, beforePath: 'old:name → value', afterPath: 'new/研究.md' };
  assert.deepEqual(repositorySelection({ ...selection, content: 'never retained in selection', branch: 'main' }), selection);
  for (const patch of [{ baseCommitId: undefined }, { baseCommitId: 'main' }, { baseCommitId: 'a'.repeat(64) }, { beforePath: '' }, { afterPath: '../source' }, { baseCommitId: null }]) assert.equal(repositorySelection({ ...selection, ...patch }), null);
  assert.deepEqual(repositorySelection({ commitId: target, path: 'ignored', view: 'changes', baseCommitId: null }), { commitId: target, path: '', view: 'changes', baseCommitId: null, beforePath: null, afterPath: null });
});
test('comparison cache and URL identities distinguish ordered commit pairs, absent sides and renamed paths', () => {
  const selection = { commitId: target, path: '', view: 'changes' as const, baseCommitId: base, beforePath: 'a:&old.txt', afterPath: 'new/研究.md' };
  const query = new URLSearchParams(comparisonQuery(selection, true));
  assert.equal(query.get('base'), base); assert.equal(query.get('target'), target); assert.equal(query.get('beforePath'), selection.beforePath); assert.equal(query.get('afterPath'), selection.afterPath);
  assert.notEqual(comparisonCacheKey(selection, true), comparisonCacheKey({ ...selection, beforePath: selection.afterPath, afterPath: selection.beforePath }, true));
  assert.notEqual(comparisonCacheKey(selection), comparisonCacheKey({ ...selection, commitId: base, baseCommitId: target }));
  const empty = new URLSearchParams(comparisonQuery({ ...selection, baseCommitId: null, beforePath: null }, true)); assert.equal(empty.get('base'), 'empty'); assert.equal(empty.has('beforePath'), false);
});
test('file display requires the selected inventory entry and its current access/tree snapshot', () => {
  const person = { name: 'Author', email: 'author@example.invalid', timestamp: '2026-01-01T00:00:00.000Z' };
  const commit = (id: string, treeId: string): GitCommit => ({ id, treeId, parentIds: [], message: 'Commit', messageTruncated: false, author: person, committer: person });
  const before = { path: 'old.txt', objectId: 'c'.repeat(40), mode: '100644', type: 'file' as const, size: 4 }, after = { ...before, path: 'new.txt' };
  const change = { id: 'd'.repeat(64), status: 'renamed' as const, similarity: 100, before, after };
  const inventory: GitComparison = { repositoryId: 'R1', objectFormat: 'sha1', accessEpoch: 5, baseCommit: commit(base, 'e'.repeat(40)), targetCommit: commit(target, 'f'.repeat(40)), baseTreeId: 'e'.repeat(40), targetTreeId: 'f'.repeat(40), algorithm: 'git-M50-C50', changes: [change] };
  const file: GitComparisonFile = { ...inventory, change, before: { repositoryId: 'R1', objectFormat: 'sha1', commitId: base, ...before, state: 'text', content: 'same' }, after: { repositoryId: 'R1', objectFormat: 'sha1', commitId: target, ...after, state: 'text', content: 'same' } };
  const selection = { commitId: target, path: '', view: 'changes' as const, baseCommitId: base, beforePath: 'old.txt', afterPath: 'new.txt' };
  assert.equal(validComparisonFile(file, 'R1', selection, inventory), true);
  assert.equal(validComparisonFile({ ...file, accessEpoch: 4 }, 'R1', selection, inventory), false);
  assert.equal(validComparisonFile(file, 'R1', selection, { ...inventory, changes: [{ ...change, id: '0'.repeat(64) }] }), false);
  assert.equal(validComparisonFile(file, 'R1', { ...selection, beforePath: null }, inventory), false);
});
