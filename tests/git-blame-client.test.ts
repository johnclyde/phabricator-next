import test from 'node:test';
import assert from 'node:assert/strict';
import { repositorySelection } from '../client/repository-cache.ts';
import { blameCacheKey, blamePage, blameQuery } from '../client/repository-blame.ts';

const commitId = 'a'.repeat(40);
test('blame selections retain exact commit/path/line without source or origin identities', () => {
  const selection = { commitId, path: '研究/line:1\t.txt', view: 'blame', selectedLine: 100 };
  assert.deepEqual(repositorySelection({ ...selection, content: 'private source', origin: 'b'.repeat(40), baseCommitId: null }), selection);
  for (const patch of [{ commitId: 'main' }, { path: '' }, { path: '../file' }, { selectedLine: 0 }, { selectedLine: 1.5 }, { selectedLine: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal(repositorySelection({ ...selection, ...patch }), null);
  assert.deepEqual(repositorySelection({ ...selection, view: 'file' }), { commitId, path: selection.path, view: 'file' });
});
test('blame keys and queries preserve exact path bytes and distinguish selection identities', () => {
  const selection = { commitId, path: 'old:研究\t&.txt' };
  assert.deepEqual(JSON.parse(blameCacheKey(selection)), ['blame', commitId, selection.path]);
  const query = new URLSearchParams(blameQuery(selection)); assert.equal(query.get('commit'), commitId); assert.equal(query.get('path'), selection.path);
  assert.notEqual(blameCacheKey(selection), blameCacheKey({ ...selection, path: `${selection.path} ` }));
  assert.notEqual(blameCacheKey(selection), blameCacheKey({ ...selection, commitId: 'b'.repeat(40) }));
});
test('blame windows bound large newline-heavy source and include exact final lines', () => {
  assert.deepEqual(blamePage(1, 0), { start: 0, end: 0 });
  assert.deepEqual(blamePage(100, 101), { start: 0, end: 100 });
  assert.deepEqual(blamePage(101, 101), { start: 100, end: 101 });
  assert.deepEqual(blamePage(999999, 5000), { start: 4900, end: 5000 });
  assert.deepEqual(blamePage(1, 5000), { start: 0, end: 100 });
});
