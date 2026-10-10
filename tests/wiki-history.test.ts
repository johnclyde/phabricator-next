import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeWikiHistory } from '../client/wiki-history.ts';
import type { WikiHistory } from '../shared/types.ts';

function history(high: number, low: number, firstAvailableVersion = 1): WikiHistory {
  return {
    firstAvailableVersion, nextBefore: low === firstAvailableVersion ? null : low,
    versions: Array.from({ length: high - low + 1 }, (_, index) => {
      const number = high - index;
      return { id: `V${number}`, documentId: 'W1', number, title: `Version ${number}`, slug: 'history', author: 'You', createdAt: '2026-10-10T00:00:00Z', message: '', kind: 'edit' as const, restoredFrom: null };
    }),
  };
}

test('wiki head refresh retains expanded immutable history without duplicate rows', () => {
  const expanded = mergeWikiHistory(23, history(3, 1), history(23, 4));
  const refreshed = mergeWikiHistory(24, history(24, 5), expanded);
  assert.equal(refreshed.versions.length, 24);
  assert.equal(refreshed.nextBefore, null);
  assert.deepEqual(refreshed.versions.map(version => version.number), Array.from({ length: 24 }, (_, index) => 24 - index));
});

test('wiki head jumps retain loaded pages but keep every gap pageable', () => {
  const jumped = mergeWikiHistory(48, history(48, 29), history(23, 4));
  const lateOlder = mergeWikiHistory(48, history(3, 1), jumped);
  assert.equal(lateOlder.versions.length, 43);
  assert.equal(lateOlder.nextBefore, 29);
  const filled = mergeWikiHistory(48, history(28, 9), lateOlder);
  assert.equal(filled.versions.length, 48);
  assert.equal(filled.nextBefore, null);
});

test('wiki history respects retained legacy boundaries and excludes rows beyond the authoritative head', () => {
  const merged = mergeWikiHistory(23, history(23, 10, 10), history(25, 1));
  assert.deepEqual(merged.versions.map(version => version.number), Array.from({ length: 14 }, (_, index) => 23 - index));
  assert.equal(merged.firstAvailableVersion, 10);
  assert.equal(merged.nextBefore, null);
});
