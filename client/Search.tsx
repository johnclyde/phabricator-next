import { useEffect, useRef, useState } from 'react';
import type { AppState } from '../shared/types';
import { SEARCH_KINDS, SEARCH_ORDERS, emptySearchQuery, parseSearchQuery, searchParameters, type SearchKind, type SearchPage, type SearchQuery, type SavedSearchDetail, type SavedSearchList, type SavedSearchReceipt } from '../shared/search';
import { useWorkspace } from './SessionGate';
import { onSessionLocked } from './session';
import { isNetworkError } from './offline';
import { AutomationPanel, automationError, exportAutomation, useAutomationRead } from './AutomationSupport';
import './search.css';
import { searchRouteQuery } from './search-route';

const names: Record<SearchKind, string> = { task: 'Tasks', revision: 'Code revisions', paper: 'Papers', document: 'Document revisions', wiki: 'Wiki', project: 'Projects', repository: 'Repositories', paste: 'Pastes', file: 'Files', almanac: 'Almanac', conpherence: 'Conversations', calendar: 'Calendar', slowvote: 'Polls', phame: 'Blogs', legalpad: 'Agreements' };
interface SaveIntent { id: string; path: string; body: unknown; label: string }
function intent(value: unknown): SaveIntent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<SaveIntent>;
  return typeof item.id === 'string' && typeof item.label === 'string' && typeof item.path === 'string' && /^\/api\/search\/queries(?:\/SQ-[a-f0-9-]+(?:\/delete)?)?$/.test(item.path) && item.body !== undefined ? item as SaveIntent : null;
}
function savedId(): string | null { return /^#search\/(SQ-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(location.hash)?.[1] ?? null; }
function initialSearch(text: string): { query: SearchQuery | null; error: string } {
  try {
    if (location.hash.startsWith('#search/')) { if (!savedId()) throw new Error('This saved-query link is invalid.'); return { query: null, error: '' }; }
    return { query: searchRouteQuery(location.hash) ?? { ...emptySearchQuery(), text }, error: '' };
  } catch (error) { return { query: null, error: automationError(error) }; }
}
function validReceipt(receipt: SavedSearchReceipt, operation: SaveIntent): boolean {
  try {
    const route = /^\/api\/search\/queries(?:\/(SQ-[a-f0-9-]{36})(\/delete)?)?$/.exec(operation.path);
    if (!route || !receipt?.receipt || !operation.body || typeof operation.body !== 'object') return false;
    const action = !route[1] ? 'create' : route[2] ? 'delete' : 'update', input = operation.body as { expectedVersion?: number };
    if (receipt.receipt.action !== action || typeof receipt.receipt.replayed !== 'boolean' || !Number.isSafeInteger(receipt.receipt.version) || receipt.receipt.version !== (input.expectedVersion ?? 0) + 1 || !/^SQ-[a-f0-9-]{36}$/.test(receipt.receipt.id) || route[1] && receipt.receipt.id !== route[1]) return false;
    if (receipt.query) {
      if (receipt.query.id !== receipt.receipt.id || receipt.query.version < receipt.receipt.version || typeof receipt.query.name !== 'string' || typeof receipt.query.ownerId !== 'string' || !['private', 'workspace'].includes(receipt.query.visibility)) return false;
      parseSearchQuery(receipt.query.query);
    }
    return true;
  } catch { return false; }
}
function QueryKeys({ label, value, change, placeholder }: { label: string; value: string[]; change: (value: string[]) => void; placeholder: string }) {
  const [raw, setRaw] = useState(value.join(', '));
  const parsed = (text: string) => text.split(',').map(item => item.trim()).filter(Boolean);
  useEffect(() => { if (JSON.stringify(parsed(raw)) !== JSON.stringify(value)) setRaw(value.join(', ')); }, [JSON.stringify(value)]);
  return <label className="field"><span>{label}</span><input value={raw} placeholder={placeholder} onChange={event => { setRaw(event.target.value); change(parsed(event.target.value)); }}/></label>;
}
export function SearchResults({ page }: { page: SearchPage }) {
  return <div className="workspace-search-results">{page.items.map(item => <article className="workspace-search-result" key={`${item.kind}:${item.id}`}><div className="workspace-search-result-heading"><a href={item.href}><span className="object-id">{item.id}</span> <strong>{item.title}</strong></a><span className="muted small">{names[item.kind]}</span></div>{item.snippet && <p className="search-snippet">{item.snippet}</p>}<div className="search-result-meta">{item.status && <span>{item.status.replaceAll('_', ' ')}</span>}{item.priority && <span>{item.priority}</span>}{item.updatedAt && <time dateTime={item.updatedAt}>Updated {new Date(item.updatedAt).toLocaleDateString()}</time>}</div></article>)}{page.items.length === 0 && <p className="empty">No results match this query.</p>}</div>;
}

/** Search results live only in the current verified session, never in an offline cache. */
export default function WorkspaceSearch({ state, online, initialText = '', requestSequence = 0 }: { state: AppState; online: boolean; initialText?: string; requestSequence?: number }) {
  const client = useWorkspace(), requestKey = 'draft:search:request';
  const [initial] = useState(() => initialSearch(initialText));
  const [draft, setDraft] = useState<SearchQuery>(() => initial.query ?? emptySearchQuery());
  const [query, setQuery] = useState<SearchQuery | null>(initial.query), [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState(savedId), [name, setName] = useState(''), [visibility, setVisibility] = useState<'private' | 'workspace'>('private');
  const [pending, setPending] = useState<SaveIntent | null>(() => intent(client.readStored(requestKey, null))), [busy, setBusy] = useState(false), [error, setError] = useState(initial.error), [notice, setNotice] = useState('');
  const live = useRef(false), sending = useRef(false), latest = useRef({ client, online }); latest.current = { client, online };
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const observedEpoch = useRef(client.session?.accessEpoch);
  const editor = useRef({ draft, name, visibility, selected }); editor.current = { draft, name, visibility, selected };
  const baseline = useRef<{ id: string; version: number; signature: string } | null>(null);
  const signature = (value = editor.current) => JSON.stringify([value.draft, value.name, value.visibility]);
  const results = useAutomationRead<SearchPage>(query ? `/api/search?${searchParameters(query, 50, cursors.at(-1) ?? null)}` : null, online);
  const saved = useAutomationRead<SavedSearchList>('/api/search/queries', online);
  const detail = useAutomationRead<SavedSearchDetail>(selected ? `/api/search/queries/${selected}` : null, online);
  const currentDetail = detail.data?.query.id === selected && detail.data.accessEpoch === client.session?.accessEpoch ? detail.data : null;
  const currentResults = online && query && results.data && results.data.accessEpoch === client.session?.accessEpoch && JSON.stringify(results.data.query) === JSON.stringify(query) ? results.data : null;
  const currentSaved = online && saved.data && saved.data.accessEpoch === client.session?.accessEpoch ? saved.data.queries : [];
  const field = <K extends keyof SearchQuery>(key: K, value: SearchQuery[K]) => setDraft(current => ({ ...current, [key]: value }));
  const run = (value: SearchQuery) => { try { const parsed = parseSearchQuery(value); setDraft(parsed); setQuery(parsed); setCursors([null]); setError(''); } catch (failure) { setError(automationError(failure)); } };
  useEffect(() => {
    live.current = true;
    const retire = () => {
      setNotice(''); setCursors([null]); setPending(intent(client.readStored(requestKey, null)));
      if (editor.current.selected) { baseline.current = null; setQuery(null); setDraft(emptySearchQuery()); setName(''); setVisibility('private'); }
    };
    const access = client.onAccessChange(retire), locked = onSessionLocked(() => { retire(); setQuery(null); setPending(null); });
    const snapshots = client.onTaskSnapshotChange(() => {
      setCursors(current => current.length > 1 ? [null] : current);
      // The transport broadcasts snapshot invalidation just before advancing
      // accessEpoch. Saved queries are not ordinary objects in /api/state, so
      // their access changes do not necessarily emit onAccessChange.
      queueMicrotask(() => {
        if (!live.current || !client.isActive()) return;
        const epoch = client.session?.accessEpoch;
        if (observedEpoch.current !== epoch) { observedEpoch.current = epoch; retire(); }
      });
    });
    const hash = () => {
      const id = savedId(); setSelected(id); setNotice(''); baseline.current = null; setCursors([null]);
      if (id) { setQuery(null); setDraft(emptySearchQuery()); setName(''); setVisibility('private'); setError(''); return; }
      const route = initialSearch('');
      if (route.error) { setQuery(null); setError(route.error); results.setData(null); return; }
      if (location.hash.startsWith('#search?')) run(route.query!);
    };
    window.addEventListener('hashchange', hash);
    return () => { live.current = false; access(); snapshots(); locked(); window.removeEventListener('hashchange', hash); };
  }, [client.session]);
  useEffect(() => { if (requestSequence) { setSelected(null); setName(''); setVisibility('private'); run({ ...emptySearchQuery(), text: initialText }); } }, [requestSequence]);
  useEffect(() => {
    if (!currentDetail) return;
    const savedQuery = currentDetail.query, before = baseline.current;
    if (before?.id === savedQuery.id && before.signature !== signature()) {
      if (before.version !== savedQuery.version) setNotice('The saved query changed. Your local edits are retained; reload the saved query before replacing it.');
      return;
    }
    baseline.current = { id: savedQuery.id, version: savedQuery.version, signature: JSON.stringify([savedQuery.query, savedQuery.name, savedQuery.visibility]) };
    setName(savedQuery.name); setVisibility(savedQuery.visibility); run(savedQuery.query);
  }, [currentDetail?.query.id, currentDetail?.query.version, currentDetail?.accessEpoch]);
  const send = async (operation: SaveIntent) => {
    if (sending.current || !latest.current.online || !client.isActive() || client.draftIsHeld(requestKey)) return;
    sending.current = true; setBusy(true); setError(''); setNotice('');
    const submitted = operation.body as { query?: SearchQuery; name?: string; visibility?: string };
    const submittedSignature = submitted.query && typeof submitted.name === 'string' && typeof submitted.visibility === 'string'
      ? JSON.stringify([submitted.query, submitted.name, submitted.visibility]) : signature();
    const active = () => live.current && client.isActive() && client.session === latest.current.client.session;
    try {
      if (pendingRef.current && JSON.stringify(pendingRef.current) !== JSON.stringify(operation)) throw new Error('Recover the earlier request before saving another query.');
      const retained = await client.retainDraft(requestKey, operation, pendingRef.current, active);
      if (!active()) return;
      if (retained === 'unavailable') throw new Error('The request could not be retained. Export your query and refresh before saving.');
      pendingRef.current = operation; setPending(operation);
      const receipt = await client.request<SavedSearchReceipt>(operation.path, { method: 'POST', id: operation.id, body: operation.body });
      // A visibility change can retire reads during this response. The exact request
      // remains recoverable; never replace its expected version with a newer one.
      if (!active()) return;
      if (receipt.accessEpoch !== client.session?.accessEpoch || !validReceipt(receipt, operation)) throw new Error('The saved-query response could not be verified. Retry the exact request.');
      await client.removeRetainedDraftIfEqual(requestKey, operation, active); if (!active()) return;
      pendingRef.current = null; setPending(null); setNotice(receipt.receipt.action === 'delete' ? 'Query deleted.' : 'Query saved.');
      const install = submittedSignature === signature();
      if (install) {
        baseline.current = null; setSelected(receipt.query?.id ?? null);
        if (receipt.query) { setName(receipt.query.name); setVisibility(receipt.query.visibility); run(receipt.query.query); location.hash = `search/${receipt.query.id}`; }
        else { location.hash = 'search'; setName(''); setVisibility('private'); }
      } else setNotice('Query saved. Your newer local edits are still in the form.');
      await saved.reload();
      if (install) await detail.reload();
    } catch (failure) { if (active()) setError(isNetworkError(failure) ? 'The outcome is unknown. Retry this exact request to recover the saved query.' : automationError(failure)); }
    finally { sending.current = false; if (live.current) setBusy(false); }
  };
  const save = (replace: boolean) => {
    try {
      const parsed = parseSearchQuery(draft);
      if (!name.trim()) throw new Error('Give this query a name.');
      if (replace && !currentDetail?.canEdit) throw new Error('Reload your saved query before updating it.');
      if (replace && baseline.current?.id !== selected) throw new Error('Reload the saved query before replacing it.');
      void send({ id: crypto.randomUUID(), path: `/api/search/queries${replace ? `/${selected}` : ''}`, label: replace ? 'Update query' : 'Save query', body: { name: name.trim(), visibility, query: parsed, ...(replace ? { expectedVersion: baseline.current!.version } : {}) } });
    } catch (failure) { setError(automationError(failure)); }
  };
  const remove = () => { if (currentDetail?.canEdit && window.confirm(`Delete the saved query “${currentDetail.query.name}”?`)) void send({ id: crypto.randomUUID(), path: `/api/search/queries/${selected}/delete`, body: { expectedVersion: currentDetail.query.version }, label: 'Delete query' }); };
  const reloadSaved = () => {
    if (!currentDetail) return;
    if (baseline.current && baseline.current.signature !== signature() && !window.confirm('Replace your unsaved query edits with the current saved query?')) return;
    const selectedQuery = currentDetail.query;
    baseline.current = { id: selectedQuery.id, version: selectedQuery.version, signature: JSON.stringify([selectedQuery.query, selectedQuery.name, selectedQuery.visibility]) };
    setName(selectedQuery.name); setVisibility(selectedQuery.visibility); run(selectedQuery.query); setNotice('Loaded the current saved query.');
  };
  return <div className="workspace-search">
    <AutomationPanel title="Saved queries"><div className="search-saved-list"><a className={`button ${!selected ? 'selected' : ''}`} href="#search" onClick={() => { baseline.current = null; setSelected(null); setName(''); setVisibility('private'); run(emptySearchQuery()); }}>New query</a>{currentSaved.map(item => <a key={item.id} href={`#search/${item.id}`} className={`button ${selected === item.id ? 'selected' : ''}`}>{item.name}<span className="muted small">{item.visibility === 'workspace' ? 'Shared' : 'Private'}</span></a>)}</div>{saved.error && <p role="alert">{saved.error}</p>}{detail.error && <p role="alert">{detail.error}</p>}</AutomationPanel>
    <AutomationPanel title="Search workspace">
      <form onSubmit={event => { event.preventDefault(); run(draft); }}>
        <label className="field"><span>Full-text query</span><input aria-label="Full-text query" value={draft.text} maxLength={2000} onChange={event => field('text', event.target.value)} placeholder={'Words, "exact phrase", prefix*, -excluded'}/><small>Search visible titles and content. Combine words, quote a phrase, or exclude a word with a minus sign.</small></label>
        <div className="search-filter-grid"><label className="field"><span>Applications</span><select multiple aria-label="Search applications" value={draft.kinds} onChange={event => field('kinds', [...event.target.selectedOptions].map(item => item.value as SearchKind))}>{SEARCH_KINDS.map(kind => <option key={kind} value={kind}>{names[kind]}</option>)}</select><small>No selection searches all applications.</small></label><div><label className="field"><span>Owner</span><select value={draft.ownerIds.length === 1 ? draft.ownerIds[0] : ''} onChange={event => field('ownerIds', event.target.value ? [event.target.value] : [])}><option value="">Any owner</option><option value="none">Unassigned</option>{state.principals.map(person => <option key={person.id} value={person.id}>{person.displayName}{person.id === state.currentPrincipalId ? ' (me)' : ''}</option>)}{draft.ownerIds.filter(id => id !== 'none' && !state.principals.some(person => person.id === id)).map(id => <option key={id} value={id}>Unavailable selected owner</option>)}</select></label><label className="field"><span>Project tags</span><select multiple aria-label="Search project tags" value={draft.projectIds} onChange={event => field('projectIds', [...event.target.selectedOptions].map(item => item.value))}>{state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}{draft.projectIds.filter(id => !state.projects.some(project => project.id === id)).map(id => <option key={id} value={id}>Unavailable selected project</option>)}</select></label></div><div><QueryKeys label="Status keys" value={draft.statuses} change={value => field('statuses', value)} placeholder="open, in_progress"/><QueryKeys label="Priority keys" value={draft.priorities} change={value => field('priorities', value)} placeholder="high, urgent"/><label className="field"><span>Order</span><select value={draft.order} onChange={event => field('order', event.target.value as SearchQuery['order'])}>{SEARCH_ORDERS.map(order => <option key={order} value={order}>{order[0]!.toUpperCase() + order.slice(1)}</option>)}</select></label></div></div>
        <details><summary>Date filters</summary><div className="search-filter-grid">{(['createdAfter', 'createdBefore', 'updatedAfter', 'updatedBefore'] as const).map(key => <label className="field" key={key}><span>{key.startsWith('created') ? 'Created' : 'Updated'} {key.endsWith('After') ? 'on or after' : 'before'}</span><input type="date" value={draft[key]?.slice(0, 10) ?? ''} onChange={event => field(key, event.target.value || null)}/></label>)}</div></details>
        <div className="search-actions"><button className="button primary" disabled={!online || results.loading}>Search</button><button type="button" className="button" onClick={() => run(emptySearchQuery())}>Clear filters</button><button type="button" className="button" onClick={() => exportAutomation(draft, 'search-query')}>Export query</button></div>
      </form>
      <details className="search-save"><summary>{selected ? 'Manage saved query' : 'Save this query'}</summary><label className="field"><span>Query name</span><input value={name} onChange={event => setName(event.target.value)} maxLength={200}/></label><label className="field"><span>Query visibility</span><select value={visibility} onChange={event => setVisibility(event.target.value as 'private' | 'workspace')}><option value="private">Private — only me</option><option value="workspace">Shared with the workspace</option></select><small>Sharing exposes this query’s words and filters. Results always follow each viewer’s access.</small></label><div className="search-actions">{currentDetail && <button className="button" disabled={busy} onClick={reloadSaved}>Reload saved query</button>}<button className="button" disabled={!online || busy || !!pending || !state.canCreate} onClick={() => save(false)}>Save as new query</button>{currentDetail?.canEdit && <><button className="button primary" disabled={!online || busy || !!pending} onClick={() => save(true)}>Update saved query</button><button className="button danger" disabled={!online || busy || !!pending} onClick={remove}>Delete saved query</button></>}</div></details>
      {!online && <p className="info-strip">Reconnect to search or save. Queries never submit automatically.</p>}{notice && <p role="status">{notice}</p>}{error && <p className="error-text" role="alert">{error}</p>}
      {pending && <section className="search-recovery" aria-label="Unconfirmed saved query"><h3>{pending.label}: response not confirmed</h3><p>The exact request is retained. Retrying cannot create a duplicate.</p><div className="search-actions"><button className="button" disabled={!online || busy} onClick={() => void send(pending)}>Retry saved query request</button><button className="button" onClick={() => exportAutomation(pending, 'saved-query-request')}>Export request</button><button className="button" disabled={busy} onClick={() => { if (window.confirm('Forget the local request? Any server change remains saved.')) void client.removeRetainedDraftIfEqual(requestKey, pending).then(removed => { if (removed && live.current) setPending(null); }); }}>Forget request</button></div></section>}
    </AutomationPanel>
    <AutomationPanel title={currentResults ? `${currentResults.total} matching results` : 'Search results'} actions={<button className="button" disabled={!online || results.loading || !query} onClick={() => { if (cursors.length > 1) setCursors([null]); else void results.reload(); }}>Refresh results</button>}>
      {results.loading && <p role="status">Searching…</p>}{results.error && <p className="error-text" role="alert">{results.error}</p>}{currentResults && <><SearchResults page={currentResults}/><div className="search-actions"><button className="button" disabled={cursors.length < 2 || results.loading} onClick={() => setCursors(current => current.slice(0, -1))}>Previous results</button><span>Page {cursors.length}</span><button className="button" disabled={!currentResults.nextCursor || results.loading} onClick={() => setCursors(current => [...current, currentResults.nextCursor])}>Next results</button></div></>}
    </AutomationPanel>
  </div>;
}
