import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySearchQuery, searchParameters } from '../shared/search';
import { searchRouteQuery } from '../client/search-route';
test('dashboard links retain exact search applications, projects, owners, dates, text and order', () => {
  const query = { ...emptySearchQuery(), text: '"legal motion" -draft', kinds: ['task' as const], statuses: ['awaiting_counsel'], projectIds: ['PROJ2'], ownerIds: ['me'], createdAfter: '2026-01-01T00:00:00.000Z', order: 'updated' as const };
  assert.deepEqual(searchRouteQuery(`#search?${searchParameters(query)}`), query);
  assert.equal(searchRouteQuery('#search'), null); assert.equal(searchRouteQuery('#search/SQ-example'), null);
});
test('search links reject malformed and unknown filters instead of broadening silently', () => {
  for (const hash of ['#search?private=true', '#search?kinds=no', '#search?kinds=["unknown"]', '#search?text=first&text=second', '#search?createdAfter=2026-02-31', '#search?limit=0']) assert.throws(() => searchRouteQuery(hash));
});
