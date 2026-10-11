import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';
import type { WikiDocumentSearchPage } from '../shared/wiki-search';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';
import { wikiHref } from './wiki-client';
import { emptyWikiSearch, mergeWikiSearch, wikiSearchParameters, wikiSearchStatuses, type WikiSearchFilters } from './wiki-search';

type SearchResult = { filter: string; page: WikiDocumentSearchPage };
const titleCase = (value: string) => value[0]!.toUpperCase() + value.slice(1);
export default function WikiDiscovery({ online, query, changeQuery, refreshWorkspace }: { online: boolean; query: string; changeQuery: (value: string) => void; refreshWorkspace: () => Promise<void> }) {
  const client = useWorkspace();
  const [filters, setFilters] = useState<WikiSearchFilters>(emptyWikiSearch), [draft, setDraft] = useState<WikiSearchFilters>(emptyWikiSearch), [search, setSearch] = useState(query);
  const [result, setResult] = useState<SearchResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(true), [snapshot, setSnapshot] = useState(!online);
  const generation = useRef(0), mounted = useRef(true), latest = useRef(result), loadCurrent = useRef<() => void>(() => {}), refreshCurrent = useRef(refreshWorkspace);
  refreshCurrent.current = refreshWorkspace;
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 250); return () => clearTimeout(timer); }, [query]);
  const prepared = useMemo(() => { try { return { filter: wikiSearchParameters(filters, search), error: '' }; } catch (failure) { return { filter: '', error: failure instanceof Error ? failure.message : 'Check the wiki path filters.' }; } }, [filters, search]);
  const filter = prepared.filter, cache = `wiki-search:${filter}`, page = result?.filter === filter && search === query ? result.page : null;
  const storeResult = (value: SearchResult | null) => { latest.current = value; setResult(value); };
  const load = useCallback(async (after?: string) => {
    const ticket = ++generation.current;
    if (!filter || prepared.error) { storeResult(null); setBusy(false); return; }
    if (!online) { const cached = client.readStored<WikiDocumentSearchPage | null>(cache, null); storeResult(cached ? { filter, page: cached } : null); setBusy(false); setSnapshot(true); return; }
    setBusy(true); setError('');
    try {
      const next = await client.request<WikiDocumentSearchPage>(`/api/documents?${filter}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      if (!mounted.current || ticket !== generation.current || !client.isActive()) return;
      if (!Number.isSafeInteger(next.accessEpoch) || Number(next.accessEpoch) < 0) throw new Error('Document search could not confirm current access. Refresh the workspace and try again.');
      const previous = after && latest.current?.filter === filter ? latest.current.page : null;
      if (after && !previous) return;
      const merged = mergeWikiSearch(previous, next);
      storeResult({ filter, page: merged }); setSaved(client.writeStored(cache, merged)); setSnapshot(false);
    } catch (failure) {
      if (!mounted.current || ticket !== generation.current) return;
      if (isNetworkError(failure)) { setSnapshot(true); if (!latest.current || latest.current.filter !== filter) { const cached = client.readStored<WikiDocumentSearchPage | null>(cache, null); storeResult(cached ? { filter, page: cached } : null); } }
      else { storeResult(null); client.removeStored(cache); void refreshCurrent.current(); }
      setError(failure instanceof Error ? failure.message : 'Document search could not be loaded.');
    } finally { if (mounted.current && ticket === generation.current) setBusy(false); }
  }, [online, filter, prepared.error]);
  loadCurrent.current = () => void load();
  useEffect(() => {
    mounted.current = true; generation.current++; const cached = client.readStored<WikiDocumentSearchPage | null>(cache, null); storeResult(cached ? { filter, page: cached } : null); setError(''); setSaved(true); void load();
    const focus = () => loadCurrent.current();
    const off = client.onTaskSnapshotChange(() => { generation.current++; storeResult(null); setBusy(false); queueMicrotask(() => { if (mounted.current) { loadCurrent.current(); void refreshCurrent.current(); } }); });
    window.addEventListener('focus', focus);
    return () => { mounted.current = false; generation.current++; off(); window.removeEventListener('focus', focus); };
  }, [load]);
  const preset = (queryKey: 'active' | 'all') => { const next = { ...filters, queryKey, statuses: [] }; setFilters(next); setDraft(next); };
  const selectedStatuses = draft.statuses.length ? draft.statuses : draft.queryKey === 'active' ? ['active'] : [];
  const apply = () => { try { wikiSearchParameters(draft, search); setFilters(draft); setError(''); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the wiki path filters.'); } };
  return <div className="wiki-discovery">
    <div className="file-actions"><a className="button" href={wikiHref('/')}>Open Wiki Root</a><form className="wiki-path-search" onSubmit={event => { event.preventDefault(); const path = new FormData(event.currentTarget).get('path'); if (typeof path === 'string') { try { location.hash = wikiHref(path).slice(1); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the wiki path.'); } } }}><input aria-label="Open wiki path" name="path" placeholder="guides/getting-started/"/><button className="button">Open Path</button></form></div>
    <section className="panel"><div className="panel-heading"><h2><BookOpen size={17}/>Documents</h2><button className="button" disabled={!online || busy} onClick={() => void load()}><RefreshCw size={15}/>Refresh Documents</button></div>
      <div className="filter-bar" aria-label="Wiki document views"><button className={filters.queryKey === 'active' && !filters.statuses.length ? 'selected' : ''} aria-pressed={filters.queryKey === 'active' && !filters.statuses.length} onClick={() => preset('active')}>Active</button><button className={filters.queryKey === 'all' && !filters.statuses.length ? 'selected' : ''} aria-pressed={filters.queryKey === 'all' && !filters.statuses.length} onClick={() => preset('all')}>All</button></div>
      <div className="wiki-search-controls"><label className="field"><span>Search published documents</span><input type="search" aria-label="Search published documents" value={query} onChange={event => changeQuery(event.target.value)} placeholder="Published title or content"/><small>Search uses the published page. Newer saved drafts remain in each document’s history.</small></label>
        <details><summary>Refine Search</summary><form onSubmit={event => { event.preventDefault(); apply(); }}><fieldset className="wiki-status-filters"><legend>Status</legend>{wikiSearchStatuses.map(status => <label className="checkbox" key={status}><input type="checkbox" checked={selectedStatuses.includes(status)} onChange={event => setDraft({ ...draft, queryKey: 'all', statuses: wikiSearchStatuses.filter(value => value === status ? event.target.checked : selectedStatuses.includes(value)) })}/>{titleCase(status)}</label>)}<small>Leave all statuses unchecked to include every status.</small></fieldset><div className="wiki-search-paths">{([{ key: 'paths', label: 'Exact paths', help: 'Match documents at these paths.' }, { key: 'parentPaths', label: 'Direct children of paths', help: 'Match immediate children of these paths.' }, { key: 'ancestorPaths', label: 'Descendants of paths', help: 'Match children at any depth below these paths.' }] as const).map(item => <label className="field" key={item.key}><span>{item.label}</span><textarea aria-label={item.label} rows={2} value={draft[item.key]} onChange={event => setDraft({ ...draft, [item.key]: event.target.value })}/><small>{item.help} One path per line; use / for the wiki root.</small></label>)}</div><p className="small muted">Paths in a field are alternatives. Parent and ancestor paths are alternatives; exact paths further narrow the results.</p><div className="file-actions"><button className="button primary">Apply Filters</button><button className="button" type="button" onClick={() => { setFilters(emptyWikiSearch); setDraft(emptyWikiSearch); changeQuery(''); }}>Reset Search</button></div></form></details>
      </div>
      {(error || prepared.error) && <p className="error-text card-body" role="alert">{prepared.error || error}</p>}{!saved && <p className="banner warning">These results could not be saved for offline access.</p>}{(snapshot || !online) && <p className="info-strip">Saved search snapshot. Reconnect to refresh results or search content that has not been saved.</p>}
      <div className="wiki-search-results" aria-busy={busy}>{page?.documents.map(item => <article className={`wiki-search-row ${item.status !== 'active' ? 'wiki-search-inactive' : ''}`} key={item.id}><BookOpen size={20}/><div><h3><a href={wikiHref(item.path)}>{item.title}</a></h3><div className="wiki-search-meta"><a href={`#${item.id}`}>{item.id} · Document &amp; history</a><span className={`badge ${item.status === 'active' ? 'badge-accepted' : 'badge-closed'}`}>{titleCase(item.status)}</span></div><a className="wiki-search-path" href={wikiHref(item.path)}>{item.path}</a><p className="wiki-search-snippet">{item.published.snippet || (item.published.kind === 'delete' ? 'Deleted-page marker.' : item.published.kind === 'move_away' ? 'Moved-page marker.' : 'No published text.')}</p><small>Published version {item.published.version}{item.version !== item.published.version ? ` · Latest content ${item.version}` : ''} · {item.published.author || 'Unknown author'} · {new Date(item.published.createdAt).toLocaleString()}</small></div></article>)}</div>
      {!page?.documents.length && <p className="info-strip">{busy || search !== query ? 'Searching documents…' : !online && !page ? 'This search has not been saved on this device.' : page?.nextAfter ? 'No matching documents in this portion. Continue searching.' : 'No documents match this search.'}</p>}
      {page && <div className="wiki-search-footer"><span>{page.documents.length} {page.documents.length === 1 ? 'document' : 'documents'} loaded</span>{page.nextAfter !== null && <button className="button" disabled={!online || busy || snapshot} onClick={() => void load(page.nextAfter!)}>{page.documents.length ? 'Load More Documents' : 'Continue Search'}</button>}</div>}
    </section>
  </div>;
}
