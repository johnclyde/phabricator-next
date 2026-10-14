import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Columns2, LayoutDashboard, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { DASHBOARD_LAYOUT_NAMES, DASHBOARD_LAYOUTS, dashboardDefinition, parseDashboardDefinition, validDashboardReceipt, type Dashboard, type DashboardDefinition, type DashboardDetail, type DashboardHomeDetail, type DashboardList, type DashboardPanel, type DashboardQueryPanel, type DashboardReceipt } from '../shared/dashboards';
import { emptySearchQuery, SEARCH_KINDS, SEARCH_ORDERS, searchParameters, type SavedSearchList, type SearchKind, type SearchPage } from '../shared/search';
import type { AppState } from '../shared/types';
import { useWorkspace } from './SessionGate';
import { isNetworkError, type MutationMethod } from './offline';
import { onSessionLocked } from './session';
import { RemarkupBody } from './Remarkup';
import './dashboards.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : 'The operation could not be confirmed.';
const blank = (): DashboardDefinition => ({ name: '', description: '', visibility: 'private', layout: 'equal', panels: [] });
function exportValue(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Session identity is stable even when its context wrapper refreshes. Never cache query results on disk. */
function useDashboardRead<T extends { accessEpoch: number }>(path: string | null, online: boolean) {
  const client = useWorkspace(), session = client.session, current = useRef({ client, path, online }); current.current = { client, path, online };
  const source = useRef({ path, session });
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const generation = useRef(0), mounted = useRef(false);
  const reload = useCallback(async () => {
    const captured = current.current, ticket = ++generation.current;
    if (!captured.path || !captured.online || !captured.client.isActive()) { setValue(null); setLoading(false); return; }
    setError(''); setLoading(true);
    const active = () => mounted.current && ticket === generation.current && current.current.path === captured.path && current.current.client.session === session && captured.client.isActive();
    try {
      const result = await captured.client.request<T>(captured.path);
      if (!active()) return;
      if (result.accessEpoch !== captured.client.session?.accessEpoch) throw new Error('Workspace access changed. Refresh the dashboard.');
      source.current = { path: captured.path, session };
      setValue(result);
    } catch (failure) { if (active()) { setValue(null); setError(isNetworkError(failure) ? 'Reconnect and refresh to load this dashboard.' : errorText(failure)); } }
    finally { if (active()) setLoading(false); }
  }, [session]);
  useEffect(() => {
    mounted.current = true;
    const clear = () => { generation.current++; setValue(null); setLoading(false); };
    const changed = () => { clear(); queueMicrotask(() => { if (mounted.current && current.current.client.session === session) void reload(); }); };
    const access = client.onAccessChange(changed), snapshots = client.onTaskSnapshotChange(changed), locked = onSessionLocked(clear);
    return () => { mounted.current = false; generation.current++; access(); snapshots(); locked(); };
  }, [session, reload]);
  useEffect(() => { setValue(null); void reload(); return () => { generation.current++; }; }, [path, online, reload]);
  return { data: source.current.path === path && source.current.session === session && value?.accessEpoch === session?.accessEpoch ? value : null, error, loading, reload };
}

interface DashboardIntent { id: string; path: string; method: MutationMethod; body: unknown; label: string }
function intent(value: unknown): DashboardIntent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<DashboardIntent>;
  return typeof input.id === 'string' && typeof input.path === 'string' && /^(?:\/api\/dashboards(?:\/DASH-[a-f0-9-]{36}(?:\/delete)?)?|\/api\/dashboard-home)$/.test(input.path) && (input.method === 'POST' || input.method === 'PUT') && typeof input.label === 'string' && input.body && typeof input.body === 'object' ? input as DashboardIntent : null;
}
function useDashboardMutation(online: boolean) {
  const client = useWorkspace(), session = client.session, key = 'draft:dashboards:request';
  const [pending, setPending] = useState(() => intent(client.readStored(key, null))), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const sending = useRef(false), mounted = useRef(false), latest = useRef({ client, online, pending }); latest.current = { client, online, pending };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [session]);
  const send = async (request: DashboardIntent): Promise<DashboardReceipt | null> => {
    const captured = latest.current.client;
    const active = () => mounted.current && captured.session === latest.current.client.session && captured.isActive();
    if (sending.current || !latest.current.online || !active()) return null;
    sending.current = true; setBusy(true); setError('');
    try {
      if (latest.current.pending && JSON.stringify(latest.current.pending) !== JSON.stringify(request)) throw new Error('Resolve the unconfirmed request before submitting another change.');
      if (await captured.retainDraft(key, request, latest.current.pending, active) === 'unavailable') throw new Error('The request could not be retained safely. Export your draft and refresh.');
      if (!active()) return null;
      latest.current.pending = request; setPending(request);
      const receipt = await captured.request<DashboardReceipt>(request.path, { method: request.method, id: request.id, body: request.body });
      if (!active()) return null;
      if (receipt.accessEpoch !== captured.session?.accessEpoch || !validDashboardReceipt(receipt, request.path, request.method, request.body)) throw new Error('The dashboard response could not be verified. Retry the exact request.');
      await captured.removeRetainedDraftIfEqual(key, request);
      if (!active()) return null;
      latest.current.pending = null; setPending(null); return receipt;
    } catch (failure) { if (active()) setError(isNetworkError(failure) ? 'The outcome is unknown. Retry the exact request to recover its result without duplicating it.' : errorText(failure)); return null; }
    finally { sending.current = false; if (active()) setBusy(false); }
  };
  const forget = async () => {
    const request = latest.current.pending;
    if (!request || busy) return;
    if (await client.removeRetainedDraftIfEqual(key, request)) { latest.current.pending = null; setPending(null); setError(''); }
  };
  return { pending, error, busy, send, forget };
}
type DashboardMutation = ReturnType<typeof useDashboardMutation>;
function Recovery({ mutation, online, recovered }: { mutation: DashboardMutation; online: boolean; recovered: () => void }) {
  return <>{mutation.error && <p role="alert" className="error-banner">{mutation.error}</p>}{mutation.pending && <section className="dashboard-recovery" aria-label="Unconfirmed dashboard request"><h3>{mutation.pending.label}</h3><p>The original request is retained. Reconnecting never sends it automatically.</p><div className="dashboard-actions"><button className="button" disabled={!online || mutation.busy} onClick={() => void mutation.send(mutation.pending!).then(result => { if (result) recovered(); })}>Retry exact dashboard request</button><button className="button" onClick={() => exportValue(mutation.pending, 'dashboard-request')}>Export dashboard request</button><button className="button" disabled={mutation.busy} onClick={() => { if (window.confirm('Forget this request? Any completed server change remains recorded.')) void mutation.forget(); }}>Forget dashboard request</button></div></section>}</>;
}

function QueryPanel({ panel, online }: { panel: DashboardQueryPanel; online: boolean }) {
  const path = '/api/search?' + searchParameters(panel.query, panel.limit).toString(), result = useDashboardRead<SearchPage>(path, online);
  return <><p className="dashboard-query-note">Results use your current access.</p>{result.loading && <p role="status">Loading results…</p>}{result.error && <p role="alert">{result.error}</p>}{!online && <p>Reconnect to load current results.</p>}{result.data && <><p className="dashboard-query-note">{result.data.total} matching {result.data.total === 1 ? 'result' : 'results'}</p><ul className="dashboard-results">{result.data.items.map(item => <li key={`${item.kind}:${item.id}`}><a href={item.href}><span>{item.id}</span> {item.title}</a><small>{item.kind}{item.status ? ` · ${item.status.replaceAll('_', ' ')}` : ''}</small>{item.snippet && <p>{item.snippet}</p>}</li>)}</ul>{!result.data.items.length && <p>No matching results visible to you.</p>}</>}<a className="button" href={`#search?${searchParameters(panel.query).toString()}`}>Open full search</a></>;
}
function DashboardCanvas({ dashboard, online }: { dashboard: Dashboard; online: boolean }) {
  const columns = dashboard.layout === 'single' ? [0] : [0, 1];
  return <div className={`dashboard-canvas dashboard-layout-${dashboard.layout}`} aria-label={`${dashboard.name} panels`}>{columns.map(column => <div className="dashboard-column" key={column}>{dashboard.panels.filter(panel => panel.column === column).map(panel => <section className="panel dashboard-panel" key={panel.id} aria-label={panel.title}><div className="panel-heading"><h2>{panel.title}</h2></div><div className="card-body">{panel.kind === 'text' ? <RemarkupBody body={panel.text} contextKey={`${dashboard.id}:${dashboard.version}:${panel.id}`}/> : <QueryPanel key={`${dashboard.version}:${panel.id}`} panel={panel} online={online}/>}</div></section>)}</div>)}</div>;
}

interface EditorDraft { definition: DashboardDefinition; expectedVersion: number | null }
function editorDraft(value: unknown): EditorDraft | null {
  try {
    if (!value || typeof value !== 'object' || !('definition' in value) || !('expectedVersion' in value)) return null;
    const version = value.expectedVersion;
    if (version !== null && (!Number.isSafeInteger(version) || Number(version) < 1)) return null;
    const raw = value.definition as DashboardDefinition;
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || raw.name.length > 120 || !Array.isArray(raw.panels)) return null;
    // Incomplete names and an unfinished quoted search are normal editor states.
    // Validate the rest without discarding those exact unsent characters.
    const panels = raw.panels.map(panel => {
      if (!panel || typeof panel.title !== 'string' || panel.title.length > 120) throw new Error();
      if (panel.kind === 'query' && (typeof panel.query?.text !== 'string' || panel.query.text.length > 2000 || !Number.isFinite(panel.limit))) throw new Error();
      return { ...panel, title: panel.title.trim() || 'Untitled panel', ...(panel.kind === 'query' ? { query: { ...panel.query, text: '' }, limit: Math.max(1, Math.min(100, Math.floor(panel.limit))) } : {}) };
    });
    const parsed = parseDashboardDefinition({ ...raw, name: raw.name.trim() || 'Untitled dashboard', panels });
    return { definition: { ...parsed, name: raw.name, panels: parsed.panels.map((panel, index) => ({ ...panel, title: raw.panels[index]!.title, ...(panel.kind === 'query' ? { query: { ...panel.query, text: (raw.panels[index] as DashboardQueryPanel).query.text }, limit: (raw.panels[index] as DashboardQueryPanel).limit } : {}) })) }, expectedVersion: version as number | null };
  } catch { return null; }
}
function DashboardEditor({ dashboard, online, mutation, done, state }: { dashboard: Dashboard | null; online: boolean; mutation: DashboardMutation; done: (dashboard: Dashboard | null) => void; state: AppState }) {
  const client = useWorkspace(), key = `draft:dashboard-editor:${dashboard?.id ?? 'new'}`;
  const original = useRef(client.readStored<unknown>(key, null)), saved = editorDraft(original.current);
  const [draft, setDraft] = useState<EditorDraft>(() => saved ?? { definition: dashboard ? dashboardDefinition(dashboard) : blank(), expectedVersion: dashboard?.version ?? null });
  const [error, setError] = useState(''), [retentionError, setRetentionError] = useState('');
  const current = useRef(draft), session = client.session, mounted = useRef(true); current.current = draft;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const queries = useDashboardRead<SavedSearchList>('/api/search/queries', online);
  const change = (definition: DashboardDefinition) => {
    const next = { ...current.current, definition }, previous = original.current; current.current = next; setDraft(next); original.current = next;
    void client.retainDraft(key, next, previous, () => mounted.current && client.isActive() && client.session === session).then(result => { if (mounted.current && result === 'unavailable') setRetentionError('This draft could not replace another saved copy. Export it before leaving.'); });
  };
  const patchPanel = (id: string, patch: Partial<DashboardPanel>) => change({ ...draft.definition, panels: draft.definition.panels.map(panel => panel.id === id ? { ...panel, ...patch } as DashboardPanel : panel) });
  const move = (id: string, direction: -1 | 1) => {
    const panels = [...draft.definition.panels], index = panels.findIndex(panel => panel.id === id), target = index + direction;
    if (index >= 0 && target >= 0 && target < panels.length) { [panels[index], panels[target]] = [panels[target]!, panels[index]!]; change({ ...draft.definition, panels }); }
  };
  const add = (kind: 'text' | 'query') => {
    const base = { id: crypto.randomUUID(), title: kind === 'text' ? 'Notes' : 'Search results', column: 0 as const };
    change({ ...draft.definition, panels: [...draft.definition.panels, kind === 'text' ? { ...base, kind, text: '' } : { ...base, kind, query: emptySearchQuery(), limit: 10 }] });
  };
  const submit = async () => {
    setError(''); const captured = current.current;
    try {
      const definition = parseDashboardDefinition(captured.definition);
      const result = await mutation.send({ id: crypto.randomUUID(), path: dashboard ? `/api/dashboards/${dashboard.id}` : '/api/dashboards', method: dashboard ? 'PUT' : 'POST', label: dashboard ? 'Save dashboard changes' : 'Create dashboard', body: { ...definition, ...(dashboard ? { expectedVersion: captured.expectedVersion } : {}), expectedAccessEpoch: client.session?.accessEpoch ?? state.accessEpoch } });
      if (!result || !client.isActive()) return;
      if (JSON.stringify(current.current) === JSON.stringify(captured)) { await client.removeRetainedDraftIfEqual(key, captured); done(result.dashboard); }
      else if (result.dashboard) { const previous = original.current, next = { ...current.current, expectedVersion: result.dashboard.version }; setDraft(next); current.current = next; original.current = next; await client.retainDraft(key, next, previous); }
    } catch (failure) { setError(errorText(failure)); }
  };
  const definition = draft.definition;
  return <section className="panel dashboard-editor" aria-label="Dashboard editor"><div className="panel-heading"><h2>{dashboard ? 'Edit Dashboard' : 'Create Dashboard'}</h2></div><div className="card-body">
    {error && <p role="alert" className="error-banner">{error}</p>}{retentionError && <p role="alert">{retentionError}</p>}
    {dashboard && dashboard.version !== draft.expectedVersion && <p role="alert">The dashboard changed since this draft began. Export your work, then discard this draft to load the current version.</p>}
    <div className="dashboard-form-grid"><label>Dashboard name<input value={definition.name} maxLength={120} onChange={event => change({ ...definition, name: event.target.value })}/></label><label>Dashboard access<select value={definition.visibility} onChange={event => change({ ...definition, visibility: event.target.value as 'private' | 'workspace' })}><option value="private">Private — only me</option><option value="workspace">Shared with signed-in workspace members</option></select></label><label>Dashboard layout<select value={definition.layout} onChange={event => { const layout = event.target.value as DashboardDefinition['layout']; change({ ...definition, layout, panels: definition.panels.map(panel => ({ ...panel, column: layout === 'single' ? 0 : panel.column })) }); }}>{DASHBOARD_LAYOUTS.map(layout => <option key={layout} value={layout}>{DASHBOARD_LAYOUT_NAMES[layout]}</option>)}</select></label></div>
    <label>Description<textarea value={definition.description} rows={2} maxLength={10_000} onChange={event => change({ ...definition, description: event.target.value })}/></label>
    {definition.visibility === 'workspace' && <p className="dashboard-sharing-note">Panel text and search filters will be visible to signed-in workspace members. Each person sees only search results they can access.</p>}
    <div className="dashboard-panel-editors">{definition.panels.map((panel, index) => <fieldset key={panel.id} className="dashboard-panel-editor"><legend>Panel {index + 1}: {panel.kind === 'text' ? 'Text' : 'Query'}</legend><div className="dashboard-form-grid"><label>Panel {index + 1} title<input value={panel.title} maxLength={120} onChange={event => patchPanel(panel.id, { title: event.target.value })}/></label>{definition.layout !== 'single' && <label>Panel {index + 1} column<select value={panel.column} onChange={event => patchPanel(panel.id, { column: Number(event.target.value) as 0 | 1 })}><option value={0}>Left</option><option value={1}>Right</option></select></label>}</div>
      {panel.kind === 'text' ? <label>Panel {index + 1} text<textarea rows={5} value={panel.text} maxLength={100_000} onChange={event => patchPanel(panel.id, { text: event.target.value })}/></label> : <><label>Copy saved query into panel {index + 1}<select value="" onChange={event => { const selected = queries.data?.queries.find(query => query.id === event.target.value); if (selected) patchPanel(panel.id, { query: structuredClone(selected.query), title: selected.name }); }}><option value="">Choose a saved query…</option>{queries.data?.queries.map(query => <option key={query.id} value={query.id}>{query.name} ({query.visibility})</option>)}</select></label><p className="dashboard-query-note">Copies the filters into this panel. Later saved-query edits do not change this dashboard.</p><div className="dashboard-form-grid"><label>Panel {index + 1} search<input value={panel.query.text} maxLength={2000} onChange={event => patchPanel(panel.id, { query: { ...panel.query, text: event.target.value } })}/></label><label>Panel {index + 1} application<select value={panel.query.kinds.length === 1 ? panel.query.kinds[0] : ''} onChange={event => patchPanel(panel.id, { query: { ...panel.query, kinds: event.target.value ? [event.target.value as SearchKind] : [] } })}><option value="">All applications</option>{SEARCH_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label><label>Panel {index + 1} order<select value={panel.query.order} onChange={event => patchPanel(panel.id, { query: { ...panel.query, order: event.target.value as DashboardQueryPanel['query']['order'] } })}>{SEARCH_ORDERS.map(order => <option key={order} value={order}>{order}</option>)}</select></label><label>Panel {index + 1} results<input type="number" min={1} max={100} value={panel.limit} onChange={event => patchPanel(panel.id, { limit: Number(event.target.value) })}/></label></div><details><summary>All query filters</summary><pre>{JSON.stringify(panel.query, null, 2)}</pre></details></>}
      <div className="dashboard-actions"><button className="button" type="button" disabled={index === 0} onClick={() => move(panel.id, -1)} aria-label={`Move panel ${index + 1} up`}><ArrowUp size={15}/>Move up</button><button className="button" type="button" disabled={index === definition.panels.length - 1} onClick={() => move(panel.id, 1)} aria-label={`Move panel ${index + 1} down`}><ArrowDown size={15}/>Move down</button><button className="button" type="button" onClick={() => patchPanel(panel.id, { column: panel.column ? 0 : 1 })} disabled={definition.layout === 'single'} aria-label={`Move panel ${index + 1} to other column`}><Columns2 size={15}/>Other column</button><button className="button" type="button" onClick={() => change({ ...definition, panels: definition.panels.filter(item => item.id !== panel.id) })} aria-label={`Remove panel ${index + 1}`}><Trash2 size={15}/>Remove</button></div>
    </fieldset>)}</div><div className="dashboard-actions"><button className="button" disabled={definition.panels.length >= 100} onClick={() => add('text')}><Plus size={15}/>Add text panel</button><button className="button" disabled={definition.panels.length >= 100} onClick={() => add('query')}><Plus size={15}/>Add query panel</button></div>
    <div className="dashboard-actions dashboard-save-actions"><button className="button primary" disabled={!online || mutation.busy || !!mutation.pending} onClick={() => void submit()}>{dashboard ? 'Save dashboard' : 'Create dashboard'}</button><button className="button" onClick={() => exportValue(draft, 'dashboard-draft')}>Export dashboard draft</button><button className="button" disabled={mutation.busy} onClick={() => done(dashboard)}>Close editor</button><button className="button" disabled={mutation.busy} onClick={() => { if (!window.confirm('Discard this local dashboard draft?')) return; void client.removeRetainedDraftIfEqual(key, original.current).then(removed => { if (removed) { original.current = null; setDraft({ definition: dashboard ? dashboardDefinition(dashboard) : blank(), expectedVersion: dashboard?.version ?? null }); setRetentionError(''); } }); }}>Discard dashboard draft</button></div>{!online && <p>Editing is available offline. Reconnect before saving to the server.</p>}
  </div></section>;
}

export function Dashboards({ state, online, id, home = false, fallback }: { state: AppState; online: boolean; id?: string; home?: boolean; fallback?: ReactNode }) {
  const client = useWorkspace(), list = useDashboardRead<DashboardList>(home ? null : '/api/dashboards', online);
  const selected = useDashboardRead<DashboardDetail | DashboardHomeDetail>(home ? '/api/dashboard-home' : id ? `/api/dashboards/${id}` : null, online);
  const [editing, setEditing] = useState<Dashboard | 'new' | null>(null), mutation = useDashboardMutation(online);
  const dashboard = selected.data?.dashboard ?? null, preference = home && selected.data && 'home' in selected.data ? selected.data.home : list.data?.home;
  useEffect(() => { setEditing(null); }, [id, home]);
  const reload = () => { void list.reload(); void selected.reload(); };
  const done = (saved: Dashboard | null) => { setEditing(null); reload(); if (saved && !home) window.location.hash = `dashboards/${saved.id}`; };
  const changeHome = async (dashboardId: string | null) => {
    if (!preference) return;
    const result = await mutation.send({ id: crypto.randomUUID(), path: '/api/dashboard-home', method: 'POST', label: dashboardId ? 'Set my home dashboard' : 'Restore built-in home', body: { dashboardId, version: preference.version, expectedAccessEpoch: client.session?.accessEpoch ?? state.accessEpoch } });
    if (result) reload();
  };
  if (home && !dashboard) return <>{fallback}<div className="dashboard-home-choice"><a href="#dashboards">Choose a custom home dashboard</a>{selected.error && <p role="alert">{selected.error}</p>}</div></>;
  return <div className="dashboards" aria-label="Dashboards"><div className="dashboard-toolbar"><div><h1><LayoutDashboard size={23}/>{dashboard?.name ?? (id ? 'Dashboard' : 'Dashboards')}</h1><p>{dashboard ? `${dashboard.visibility === 'private' ? 'Private' : 'Workspace shared'} · Version ${dashboard.version}` : 'Build a home for your work with live queries and notes.'}</p></div><div className="dashboard-actions"><button className="button" disabled={!online || list.loading || selected.loading} onClick={reload}><RefreshCw size={15}/>Refresh dashboards</button>{!home && !id && <button className="button primary" onClick={() => setEditing('new')}><Plus size={15}/>New dashboard</button>}{dashboard && <a className="button" href="#dashboards">All dashboards</a>}{home && <button className="button" disabled={!online || mutation.busy || !!mutation.pending || !preference} onClick={() => void changeHome(null)}>Use built-in home</button>}</div></div>
    <Recovery mutation={mutation} online={online} recovered={reload}/>{list.error && <p role="alert">{list.error}</p>}{selected.error && <p role="alert">{selected.error}</p>}{!online && <p className="dashboard-offline">Reconnect to load dashboards and current search results.</p>}
    {editing ? <DashboardEditor key={editing === 'new' ? 'new' : editing.id} dashboard={editing === 'new' ? null : dashboard ?? editing} online={online} mutation={mutation} done={done} state={state}/> : dashboard ? <><div className="dashboard-actions">{dashboard.ownerId === state.currentPrincipalId && <><button className="button" onClick={() => setEditing(dashboard)}>Edit dashboard</button><button className="button" disabled={!online || mutation.busy || !!mutation.pending} onClick={() => { if (!window.confirm('Delete this dashboard? People using it as their home will return to the built-in home.')) return; void mutation.send({ id: crypto.randomUUID(), path: `/api/dashboards/${dashboard.id}/delete`, method: 'POST', label: 'Delete dashboard', body: { expectedVersion: dashboard.version, expectedAccessEpoch: client.session?.accessEpoch ?? state.accessEpoch } }).then(result => { if (result) { reload(); window.location.hash = 'dashboards'; } }); }}>Delete dashboard</button></>}{!home && <button className="button" disabled={!online || mutation.busy || !!mutation.pending || !preference || preference.dashboardId === dashboard.id} onClick={() => void changeHome(dashboard.id)}>{preference?.dashboardId === dashboard.id ? 'Your home dashboard' : 'Use as my home'}</button>}<button className="button" onClick={() => exportValue(dashboardDefinition(dashboard), 'dashboard')}>Export dashboard</button></div>{dashboard.description && <div className="dashboard-description"><RemarkupBody body={dashboard.description} contextKey={`${dashboard.id}:${dashboard.version}:description`}/></div>}<DashboardCanvas dashboard={dashboard} online={online}/>{!dashboard.panels.length && <p className="empty-state">This dashboard has no panels yet.</p>}</> : !id && <><div className="dashboard-catalog">{list.data?.dashboards.map(item => <article className="panel dashboard-card" key={item.id}><a href={`#dashboards/${item.id}`}><h2>{item.name}</h2></a><p>{item.visibility === 'private' ? 'Private' : 'Workspace shared'} · {item.panels.length} panels{item.ownerId === state.currentPrincipalId ? ' · Yours' : ''}</p>{preference?.dashboardId === item.id && <span className="badge">Your home</span>}</article>)}</div>{list.data && !list.data.dashboards.length && <p className="empty-state">No dashboards yet. Create one with a task query, review queue, or notes.</p>}{preference?.dashboardId && <button className="button" disabled={!online || mutation.busy || !!mutation.pending} onClick={() => void changeHome(null)}>Use built-in home</button>}</>}
  </div>;
}
