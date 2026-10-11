import test from 'node:test';
import assert from 'node:assert/strict';
import { patchAccessMatches, patchCacheKey, patchPair, patchQuery } from '../client/repository-patch.ts';
import { putRepositoryCache, repositoryCache } from '../client/repository-cache.ts';

const base = 'a'.repeat(40), target = 'b'.repeat(40);
test('offline patch access only falls back to the matching saved local epoch before session authority is known', () => {
  assert.equal(patchAccessMatches(4, -1, true, 4), true);
  assert.equal(patchAccessMatches(4, -1, false, 4), false); // Online or protected session.
  assert.equal(patchAccessMatches(4, -1, true), false);
  assert.equal(patchAccessMatches(4, -1, true, 3), false);
  assert.equal(patchAccessMatches(4, undefined, true, 4), false);
  assert.equal(patchAccessMatches(4, -2, true, 4), false);
  assert.equal(patchAccessMatches(4, 5, true, 4), false);
  assert.equal(patchAccessMatches(4, 3, true, 4), false);
  assert.equal(patchAccessMatches(4, 4, false), true);
  assert.equal(patchAccessMatches(-1, -1, true, -1), false);
  assert.equal(patchAccessMatches(4.5, 4.5, true, 4.5), false);
});
test('patch preparation and cache identity pin an ordered pair independently of selected changed paths', () => {
  const query = patchPair({ commitId: target, baseCommitId: base });
  assert.deepEqual(query, { base, target });
  assert.deepEqual(JSON.parse(patchCacheKey(query)), ['patch', 'git-binary-patch-v1', base, target]);
  assert.notEqual(patchCacheKey(query), patchCacheKey({ base: target, target: base }));
  assert.equal(new URLSearchParams(patchQuery(query)).get('target'), target);
  const empty = patchPair({ commitId: target }); assert.deepEqual(empty, { base: null, target }); assert.equal(new URLSearchParams(patchQuery(empty)).get('base'), 'empty');
});
test('large patch envelopes cannot bypass the repository offline cache bound', () => {
  const key = patchCacheKey({ base, target });
  const prior = putRepositoryCache(repositoryCache(null), 'detail', { accessEpoch: 4, title: 'Offline repository' });
  const large = putRepositoryCache(putRepositoryCache(prior, key, { accessEpoch: 4, dataBase64: '' }), key, { accessEpoch: 4, dataBase64: 'A'.repeat(2_000_000) });
  assert.equal(large.entries.some(item => item.key === key), false);
  assert.deepEqual(large.entries, prior.entries);
  assert.deepEqual(putRepositoryCache(prior, key, { accessEpoch: 5, dataBase64: 'A'.repeat(2_000_000) }), { accessEpoch: 5, entries: [] });
  const small = putRepositoryCache(large, key, { accessEpoch: 4, dataBase64: 'Ynl0ZXM=' });
  assert.equal(small.entries.some(item => item.key === key), true);
  assert.equal(putRepositoryCache(small, 'new-epoch', { accessEpoch: 5 }).entries.some(item => item.key === key), false);
});
