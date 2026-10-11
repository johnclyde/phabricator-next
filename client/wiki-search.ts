import { canonicalWikiPath, type WikiStatus } from '../shared/wiki';
import { WIKI_SEARCH_MAX_FILTER_VALUES, type WikiDocumentSearchPage } from '../shared/wiki-search';

export interface WikiSearchFilters {
  queryKey: 'active' | 'all';
  statuses: WikiStatus[];
  paths: string;
  parentPaths: string;
  ancestorPaths: string;
}
export const emptyWikiSearch: WikiSearchFilters = { queryKey: 'active', statuses: [], paths: '', parentPaths: '', ancestorPaths: '' };
export const wikiSearchStatuses: WikiStatus[] = ['active', 'moved', 'deleted', 'stub'];
export function wikiSearchParameters(filters: WikiSearchFilters, query: string): string {
  const params = new URLSearchParams({ queryKey: filters.queryKey, limit: '25' });
  if (query.trim()) params.set('query', query.trim());
  for (const status of wikiSearchStatuses.filter(status => filters.statuses.includes(status))) params.append('statuses', status);
  for (const key of ['paths', 'parentPaths', 'ancestorPaths'] as const) {
    const paths = [...new Set(filters[key].split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(canonicalWikiPath))].sort();
    if (paths.length > WIKI_SEARCH_MAX_FILTER_VALUES) throw new Error(`Use at most ${WIKI_SEARCH_MAX_FILTER_VALUES} paths in each field.`);
    for (const path of paths) params.append(key, path);
  }
  return params.toString();
}
export function mergeWikiSearch(previous: WikiDocumentSearchPage | null, next: WikiDocumentSearchPage): WikiDocumentSearchPage {
  if (!previous) return next;
  if (previous.accessEpoch !== next.accessEpoch) throw new Error('Workspace access changed. Refresh the document search before loading more results.');
  return { ...next, documents: [...new Map([...previous.documents, ...next.documents].map(item => [item.id, item])).values()] };
}
