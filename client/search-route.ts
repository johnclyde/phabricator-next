import { parseSearchQuery, type SearchQuery } from '../shared/search';

/** Panel links carry the same typed filters as the search API. */
export function searchRouteQuery(hash: string): SearchQuery | null {
  if (!hash.startsWith('#search?')) return null;
  const params = new URLSearchParams(hash.slice('#search?'.length));
  const query: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (seen.has(key)) throw new Error(`Duplicate search filter: ${key}.`); seen.add(key);
    if (key === 'limit') { if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error('Invalid search page size.'); continue; }
    query[key] = ['kinds', 'statuses', 'priorities', 'ownerIds', 'projectIds'].includes(key) ? JSON.parse(value) : value;
  }
  return parseSearchQuery(query);
}
