/** Workspace search contracts contain no server, browser, or React dependencies. */
export const SEARCH_KINDS = ['task', 'revision', 'paper', 'document', 'wiki', 'project', 'repository', 'paste', 'file', 'almanac', 'conpherence', 'calendar', 'slowvote', 'phame', 'legalpad', 'owners'] as const;
export type SearchKind = typeof SEARCH_KINDS[number];
export const SEARCH_ORDERS = ['relevance', 'updated', 'created', 'title'] as const;
export type SearchOrder = typeof SEARCH_ORDERS[number];
export interface SearchQuery {
  text: string; kinds: SearchKind[]; statuses: string[]; priorities: string[]; ownerIds: string[]; projectIds: string[];
  createdAfter: string | null; createdBefore: string | null; updatedAfter: string | null; updatedBefore: string | null;
  order: SearchOrder;
}
export interface SearchRequest extends SearchQuery { limit: number; cursor: string | null }
export interface SearchResult {
  id: string; kind: SearchKind; title: string; snippet: string; href: string;
  status: string | null; priority: string | null; ownerId: string | null; projectIds: string[];
  createdAt: string | null; updatedAt: string | null;
}
export interface SearchPage { query: SearchQuery; items: SearchResult[]; total: number; nextCursor: string | null; accessEpoch: number }
export interface SavedSearchQuery { id: string; ownerId: string; name: string; visibility: 'private' | 'workspace'; query: SearchQuery; version: number; createdAt: string; updatedAt: string }
export interface SavedSearchList { queries: SavedSearchQuery[]; accessEpoch: number }
export interface SavedSearchDetail { query: SavedSearchQuery; canEdit: boolean; accessEpoch: number }
export interface SavedSearchInput { name: string; visibility: 'private' | 'workspace'; query: SearchQuery; expectedVersion?: number }
export interface SavedSearchReceipt { query: SavedSearchQuery | null; receipt: { id: string; version: number; action: 'create' | 'update' | 'delete'; replayed: boolean }; accessEpoch: number }
export const emptySearchQuery = (): SearchQuery => ({ text: '', kinds: [], statuses: [], priorities: [], ownerIds: [], projectIds: [], createdAfter: null, createdBefore: null, updatedAfter: null, updatedBefore: null, order: 'relevance' });
const fields = ['text', 'kinds', 'statuses', 'priorities', 'ownerIds', 'projectIds', 'createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore', 'order'] as const;
export function parseSearchQuery(value: unknown): SearchQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Search must be an object.');
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!(fields as readonly string[]).includes(key)) throw new Error(`Unknown search field: ${key}.`);
  const result = emptySearchQuery();
  if (input.text !== undefined) {
    if (typeof input.text !== 'string' || input.text.length > 2000 || /[\u0000-\u001f\u007f]/u.test(input.text)) throw new Error('Search text must contain at most 2,000 printable characters.');
    result.text = input.text.trim();
  }
  searchTerms(result.text);
  for (const field of ['kinds', 'statuses', 'priorities', 'ownerIds', 'projectIds'] as const) {
    const values = input[field] ?? [];
    if (!Array.isArray(values) || values.length > 100 || values.some(item => typeof item !== 'string' || !item || item.length > 160 || /[\u0000-\u001f\u007f]/u.test(item))) throw new Error(`${field} must be a list of at most 100 values.`);
    const sorted = [...new Set(values as string[])].sort();
    if (field === 'kinds') { if (sorted.some(kind => !SEARCH_KINDS.includes(kind as SearchKind))) throw new Error('Unknown search application.'); result.kinds = sorted as SearchKind[]; }
    else result[field] = sorted;
  }
  for (const field of ['createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore'] as const) {
    const date = input[field];
    if (date === undefined || date === null || date === '') continue;
    if (typeof date !== 'string' || !/^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{3})?Z)?$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date.slice(0, 10)) throw new Error('Use a valid ISO date or UTC timestamp.');
    result[field] = new Date(date).toISOString();
  }
  if (result.createdAfter && result.createdBefore && result.createdAfter >= result.createdBefore || result.updatedAfter && result.updatedBefore && result.updatedAfter >= result.updatedBefore) throw new Error('The start date must precede the end date.');
  if (input.order !== undefined) { if (!SEARCH_ORDERS.includes(input.order as SearchOrder)) throw new Error('Unknown search order.'); result.order = input.order as SearchOrder; }
  return result;
}
export interface SearchTerm { text: string; exclude: boolean; prefix: boolean }
/** All plain terms must match. Quotes select a phrase; a trailing * selects a prefix. */
export function searchTerms(text: string): SearchTerm[] {
  const terms: SearchTerm[] = []; let offset = 0;
  while (offset < text.length) {
    if (/\s/u.test(text[offset]!)) { offset++; continue; }
    const exclude = text[offset] === '-'; if (exclude) offset++;
    let term: string;
    if (text[offset] === '"') {
      const end = text.indexOf('"', offset + 1); if (end < 0) throw new Error('Close the quoted search phrase.');
      term = text.slice(offset + 1, end); offset = end + 1;
    } else { const start = offset; while (offset < text.length && !/\s/u.test(text[offset]!)) offset++; term = text.slice(start, offset); }
    const prefix = text[offset] === '*' || term.endsWith('*');
    if (text[offset] === '*') offset++;
    if (term.endsWith('*')) term = term.slice(0, -1);
    if (!/[\p{L}\p{N}]/u.test(term) || term.includes('"') || term.includes('*')) throw new Error('Search terms must contain letters or numbers; use * only at the end.');
    terms.push({ text: term, exclude, prefix });
    if (terms.length > 100) throw new Error('Use at most 100 search terms.');
  }
  if (terms.length && terms.every(term => term.exclude)) throw new Error('Include a positive search term before excluding words.');
  return terms;
}
export function searchParameters(query: SearchQuery, limit = 50, cursor: string | null = null): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) { if (value.length) params.set(key, JSON.stringify(value)); }
    else if (value) params.set(key, value);
  }
  params.set('limit', String(limit)); if (cursor) params.set('cursor', cursor); return params;
}
