import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderGit2, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import type { AppState } from '../shared/types';
import { ownersDefinition, parseOwnersDefinition, validOwnersReceipt, type OwnerReference, type OwnersDefinition, type OwnersDetail, type OwnersHistory, type OwnersList, type OwnersPackage, type OwnersPath, type OwnersReceipt, type OwnersResolve } from '../shared/owners';
import { useWorkspace } from './SessionGate';
import { useDraftRetention } from './draft-retention';
import { isNetworkError } from './offline';
import { AutomationPanel, automationError, exportAutomation, useAutomationRead } from './AutomationSupport';
import { RemarkupBody } from './Remarkup';
import './owners.css';

const reviewLabels: Record<OwnersDefinition['autoReview'], string> = {
  none: 'No automatic review', subscribe: 'Subscribe when the author is not an owner', 'subscribe-always': 'Subscribe to all changes',
  review: 'Review when the author is not an owner', 'review-always': 'Review all changes',
};
const auditLabels: Record<OwnersDefinition['auditing'], string> = {
  none: 'No automatic audit', audit: 'Audit commits with no owner involvement', unreviewed: 'Audit unreviewed commits',
  'uninvolved-unreviewed': 'Audit unreviewed commits or commits with no owner involvement', all: 'Audit all commits',
};
const dominionLabels: Record<OwnersDefinition['dominion'], string> = { strong: 'Strong — control all matching paths', weak: 'Weak — yield to more specific packages' };
const packageId = (value: unknown): value is string => typeof value === 'string' && /^OWN-[a-f0-9-]{36}$/.test(value);
const ownerKey = (owner: OwnerReference) => `${owner.kind}:${owner.id}`;
function ownerName(owner: OwnerReference, state: AppState): string {
  return owner.kind === 'person' ? state.principals.find(person => person.id === owner.id)?.displayName ?? 'Unavailable person' : state.projects.find(project => project.id === owner.id)?.name ?? 'Unavailable project';
}
const empty = (state: AppState): OwnersDefinition => ({ name: '', description: '', status: 'active', visibility: 'workspace', owners: [{ kind: 'person', id: state.currentPrincipalId }], dominion: 'strong', autoReview: 'none', auditing: 'none', paths: [] });

interface OwnersIntent { id: string; path: string; method: 'POST' | 'PUT'; body: unknown; label: string }
function readIntent(value: unknown): OwnersIntent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<OwnersIntent>;
  return typeof input.id === 'string' && typeof input.path === 'string' && (input.path === '/api/owners' && input.method === 'POST' || /^\/api\/owners\/OWN-[a-f0-9-]{36}$/.test(input.path) && input.method === 'PUT') && typeof input.label === 'string' && input.body && typeof input.body === 'object' ? input as OwnersIntent : null;
}
/** A missing response keeps its exact inputs; recovery never repeats an edit with a new version. */
function useOwnersMutation(online: boolean) {
  const client = useWorkspace(), session = client.session, key = 'draft:automation:owners:request';
  const [pending, setPending] = useState(() => readIntent(client.readStored(key, null))), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false), sending = useRef(false), latest = useRef({ client, online, pending }); latest.current = { client, online, pending };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, [session]);
  const send = async (request: OwnersIntent): Promise<OwnersReceipt | null> => {
    const captured = latest.current.client;
    const active = () => mounted.current && latest.current.client.session === captured.session && captured.isActive();
    if (!active() || sending.current || !latest.current.online) return null;
    sending.current = true; setBusy(true); setError('');
    try {
      if (latest.current.pending && JSON.stringify(latest.current.pending) !== JSON.stringify(request)) throw new Error('Resolve the unconfirmed request before submitting another package change.');
      if (await captured.retainDraft(key, request, latest.current.pending, active) === 'unavailable') throw new Error('The request could not be retained safely. Export your draft and refresh.');
      if (!active()) return null;
      latest.current.pending = request; setPending(request);
      const receipt = await captured.request<OwnersReceipt>(request.path, { id: request.id, method: request.method, body: request.body });
      if (!active()) return null;
      if (receipt.accessEpoch !== captured.session?.accessEpoch || !validOwnersReceipt(receipt, request.path, request.method, request.body)) throw new Error('The package response could not be verified. Retry the exact request to recover its result.');
      await captured.removeRetainedDraftIfEqual(key, request);
      if (!active()) return null;
      latest.current.pending = null; setPending(null); return receipt;
    } catch (failure) { if (active()) setError(isNetworkError(failure) ? 'The outcome is unknown. Retry the exact request to recover its result without duplicating it.' : automationError(failure)); return null; }
    finally { sending.current = false; if (active()) setBusy(false); }
  };
  const forget = async () => {
    const captured = latest.current.pending;
    if (!captured || sending.current) return;
    if (await client.removeRetainedDraftIfEqual(key, captured) && client.isActive()) { latest.current.pending = null; setPending(null); setError(''); }
  };
  return { pending, busy, error, send, forget };
}
type OwnersMutation = ReturnType<typeof useOwnersMutation>;

interface EditorDraft { definition: OwnersDefinition; expectedVersion: number | null }
function readEditorDraft(value: unknown): EditorDraft | null {
  try {
    if (!value || typeof value !== 'object' || !('definition' in value) || !('expectedVersion' in value)) return null;
    const raw = value.definition as OwnersDefinition, version = value.expectedVersion;
    if (version !== null && (!Number.isSafeInteger(version) || Number(version) < 1) || !raw || typeof raw.name !== 'string' || raw.name.length > 160 || !Array.isArray(raw.paths)) return null;
    // A blank new name or path is an unfinished draft, not a reason to erase it.
    if (raw.paths.length > 10_000 || raw.paths.some(path => !path || typeof path.path !== 'string' || path.path.length > 4096 || typeof path.repositoryId !== 'string' || path.repositoryId.length > 128 || typeof path.excluded !== 'boolean')) return null;
    const parsed = parseOwnersDefinition({ ...raw, name: raw.name.trim() || 'Untitled package', paths: [] });
    return { definition: { ...parsed, name: raw.name, paths: raw.paths }, expectedVersion: version as number | null };
  } catch { return null; }
}

function OwnersEditor({ source, id, state, online, mutation, done, adopt, canEdit }: { source: OwnersPackage | null; id?: string; state: AppState; online: boolean; mutation: OwnersMutation; done: (result?: OwnersPackage | null) => void; adopt: (receipt: OwnersReceipt) => void; canEdit: boolean }) {
  const client = useWorkspace(), key = `draft:owners-editor:${id ?? 'new'}`;
  const [draft, setDraft] = useState<EditorDraft>(() => readEditorDraft(client.readStored(key, null)) ?? { definition: source ? ownersDefinition(source) : empty(state), expectedVersion: source?.version ?? null });
  const [error, setError] = useState(''), [persisted, setPersisted] = useState(true), retain = useDraftRetention(client, key, setPersisted);
  const current = useRef(draft), mounted = useRef(true), adopting = useRef(false); current.current = draft;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = () => mounted.current && client.isActive();
  const change = (definition: OwnersDefinition) => { if (adopting.current) return; const next = { ...current.current, definition }; current.current = next; setDraft(next); retain(next); };
  const definition = draft.definition, stale = !!source && source.version !== draft.expectedVersion;
  const people = state.principals.filter(person => !person.disabled), projects = state.projects.filter(project => project.status !== 'archived');
  const repositories = state.repositories.filter(repository => state.access[repository.id]?.capabilities.edit);
  const patchPath = (index: number, patch: Partial<OwnersPath>) => change({ ...definition, paths: definition.paths.map((path, position) => position === index ? { ...path, ...patch } : path) });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); const captured = current.current;
    try {
      const validated = parseOwnersDefinition(captured.definition);
      const result = await mutation.send({ id: crypto.randomUUID(), path: id ? `/api/owners/${id}` : '/api/owners', method: id ? 'PUT' : 'POST', label: id ? 'Save ownership package' : 'Create ownership package', body: { ...validated, ...(id ? { expectedVersion: captured.expectedVersion } : {}), expectedAccessEpoch: client.session?.accessEpoch ?? state.accessEpoch } });
      if (!result || !active()) return;
      if (JSON.stringify(current.current) === JSON.stringify(captured)) { await client.removeRetainedDraftIfEqual(key, captured); if (active()) done(result.package); }
      else if (result.package) {
        // New typing belongs to the acknowledged object. Keep the committed
        // receipt version as its baseline even if the current package advanced.
        adopting.current = true;
        const previous = current.current, next = { ...previous, expectedVersion: result.receipt.version }, destination = `draft:owners-editor:${result.receipt.id}`;
        if (await client.retainDraft(destination, next, destination === key ? previous : null, active) === 'unavailable') throw new Error(`Package saved as ${result.receipt.id}. The newer edits could not move safely; export this draft before continuing.`);
        if (!active()) return;
        if (destination !== key) await client.removeRetainedDraftIfEqual(key, previous);
        if (!active()) return;
        current.current = next; setDraft(next); if (destination === key) retain(next); adopt(result);
      }
    } catch (failure) { if (active()) setError(automationError(failure)); }
    finally { adopting.current = false; }
  };
  return <section className="panel owners-editor" aria-label="Ownership package editor"><div className="panel-heading"><h2>{id ? 'Edit Package' : 'Create Package'}</h2></div><form className="card-body owners-form" onSubmit={event => void submit(event)}>
    {error && <p className="banner error" role="alert">{error}</p>}{stale && <p className="banner warning" role="alert">This package changed after the draft began. Export your work, then discard this draft to load the latest package.</p>}{!persisted && <p className="banner warning">This draft is retained in this tab. Export a copy before closing it.</p>}
    <div className="owners-grid"><label>Package name<input aria-label="Package name" value={definition.name} maxLength={160} required onChange={event => change({ ...definition, name: event.target.value })}/></label><label>Package visibility<select aria-label="Package visibility" value={definition.visibility} onChange={event => change({ ...definition, visibility: event.target.value as OwnersDefinition['visibility'] })}><option value="workspace">Workspace members</option><option value="private">Creator and package owners</option></select></label></div>
    <label>Description<textarea aria-label="Package description" rows={3} value={definition.description} onChange={event => change({ ...definition, description: event.target.value })}/></label>
    <fieldset><legend>Owners</legend><label>Add an owner<select aria-label="Add an owner" value="" onChange={event => { const [kind, ...rest] = event.target.value.split(':'); const id = rest.join(':'); if ((kind === 'person' || kind === 'project') && id) change({ ...definition, owners: [...definition.owners, { kind, id }] }); }}><option value="">Choose a person or project…</option><optgroup label="People">{people.filter(person => !definition.owners.some(owner => owner.kind === 'person' && owner.id === person.id)).map(person => <option key={person.id} value={`person:${person.id}`}>{person.displayName}</option>)}</optgroup><optgroup label="Projects">{projects.filter(project => !definition.owners.some(owner => owner.kind === 'project' && owner.id === project.id)).map(project => <option key={project.id} value={`project:${project.id}`}>{project.name}</option>)}</optgroup></select></label>
      <ul className="owners-selected">{definition.owners.map(owner => <li key={ownerKey(owner)}><span><Users size={15}/>{ownerName(owner, state)} <small>{owner.kind === 'project' ? 'Project members' : 'Person'}</small></span><button type="button" className="button" aria-label={`Remove owner ${ownerName(owner, state)}`} onClick={() => change({ ...definition, owners: definition.owners.filter(candidate => ownerKey(candidate) !== ownerKey(owner)) })}><Trash2 size={14}/>Remove</button></li>)}</ul>{!definition.owners.length && <p className="muted">This package has no owners yet.</p>}
    </fieldset>
    <fieldset><legend>Repository paths</legend><p className="muted small">Use repository-relative paths. A directory includes its descendants; exclusions remove matching paths from this package.</p>{definition.paths.map((path, index) => <div className="owners-path-editor" key={index}><label>Repository {index + 1}<select aria-label={`Path ${index + 1} repository`} value={path.repositoryId} onChange={event => patchPath(index, { repositoryId: event.target.value })}><option value="">Choose a repository…</option>{repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.id} {repository.name}</option>)}{path.repositoryId && !repositories.some(repository => repository.id === path.repositoryId) && <option value={path.repositoryId}>Unavailable repository</option>}</select></label><label>Path {index + 1}<input aria-label={`Path ${index + 1}`} value={path.path} placeholder="/src/" onChange={event => patchPath(index, { path: event.target.value })}/></label><label>Rule {index + 1}<select aria-label={`Path ${index + 1} rule`} value={path.excluded ? 'exclude' : 'include'} onChange={event => patchPath(index, { excluded: event.target.value === 'exclude' })}><option value="include">Include</option><option value="exclude">Exclude</option></select></label><button type="button" className="button" aria-label={`Remove path ${index + 1}`} onClick={() => change({ ...definition, paths: definition.paths.filter((_, position) => position !== index) })}><Trash2 size={15}/><span>Remove</span></button></div>)}<button type="button" className="button" onClick={() => change({ ...definition, paths: [...definition.paths, { repositoryId: repositories[0]?.id ?? '', path: '/', excluded: false }] })}><Plus size={15}/>Add repository path</button></fieldset>
    <div className="owners-grid"><label>Package status<select aria-label="Package status" value={definition.status} onChange={event => change({ ...definition, status: event.target.value as OwnersDefinition['status'] })}><option value="active">Active</option><option value="archived">Archived</option></select></label><label>Dominion<select aria-label="Dominion" value={definition.dominion} onChange={event => change({ ...definition, dominion: event.target.value as OwnersDefinition['dominion'] })}>{Object.entries(dominionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Automatic review<select aria-label="Automatic review" value={definition.autoReview} onChange={event => change({ ...definition, autoReview: event.target.value as OwnersDefinition['autoReview'] })}>{Object.entries(reviewLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Commit auditing<select aria-label="Commit auditing" value={definition.auditing} onChange={event => change({ ...definition, auditing: event.target.value as OwnersDefinition['auditing'] })}>{Object.entries(auditLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <p className="owners-note">Packages route reviews and audits. Repository and revision access are controlled separately. Shared package names, owners, and path rules are visible to workspace members who can view their repositories.</p>
    <div className="owners-actions"><button type="submit" className="button primary" disabled={!online || !canEdit || mutation.busy || !!mutation.pending || stale}>{id ? 'Save package' : 'Create package'}</button><button type="button" className="button" onClick={() => exportAutomation(draft, 'ownership-package-draft')}>Export package draft</button><button type="button" className="button" disabled={mutation.busy} onClick={() => done()}>Close editor</button><button type="button" className="button" disabled={mutation.busy || !!id && !source} onClick={() => { if (!window.confirm('Discard this unsaved ownership package draft?')) return; void client.removeRetainedDraftIfEqual(key, current.current).then(removed => { if (removed) { const next = { definition: source ? ownersDefinition(source) : empty(state), expectedVersion: source?.version ?? null }; current.current = next; setDraft(next); } }); }}>Discard package draft</button></div>{!online && <p className="muted">You can edit this draft offline. Reconnect before saving.</p>}
  </form></section>;
}

function MatchPreview({ state, online }: { state: AppState; online: boolean }) {
  const [repositoryId, setRepositoryId] = useState(state.repositories[0]?.id ?? ''), [paths, setPaths] = useState(''), [path, setPath] = useState<string | null>(null), [error, setError] = useState('');
  const preview = useAutomationRead<OwnersResolve>(path, online);
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError('');
    const values = paths.split(/\r?\n/).filter(Boolean);
    if (!repositoryId || !values.length) { setError('Choose a repository and enter at least one path.'); return; }
    const query = new URLSearchParams({ repositoryId, paths: JSON.stringify(values) }), next = `/api/owners/resolve?${query}`;
    if (next === path) void preview.reload(); else setPath(next);
  };
  return <section className="panel" aria-label="Ownership matching preview"><div className="panel-heading"><h2>Find Owners by Path</h2></div><div className="card-body"><form className="owners-form" onSubmit={submit}><label>Preview repository<select aria-label="Preview repository" value={repositoryId} onChange={event => { setRepositoryId(event.target.value); setPath(null); }}><option value="">Choose a repository…</option>{state.repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.id} {repository.name}</option>)}</select></label><label>Paths to check<textarea aria-label="Paths to check" value={paths} rows={3} placeholder={'src/example.ts\ndocs/guide.md'} onChange={event => { setPaths(event.target.value); setPath(null); }}/><small>One path per line. Preview uses the saved active packages you can access.</small></label><button className="button" disabled={!online || preview.loading}>Preview ownership</button></form>{(error || preview.error) && <p role="alert" className="banner error">{error || preview.error}</p>}{preview.data && <div className="owners-match-results" role="region" aria-label="Ownership matches">{preview.data.matches.map(match => <article key={match.package.id}><a href={`#owners/${match.package.id}`}><strong>{match.package.name}</strong></a><span className="badge">{match.package.dominion}</span><ul>{match.paths.map(value => <li key={value}><code>{value}</code></li>)}</ul></article>)}{!preview.data.matches.length && <p>No visible active package owns these paths.</p>}</div>}</div></section>;
}

export default function Owners({ state, online, id }: { state: AppState; online: boolean; id?: string }) {
  const client = useWorkspace(), list = useAutomationRead<OwnersList>('/api/owners', online), selected = useAutomationRead<OwnersDetail>(id && packageId(id) ? `/api/owners/${id}` : null, online);
  const history = useAutomationRead<OwnersHistory>(id && packageId(id) ? `/api/owners/${id}/history` : null, online), mutation = useOwnersMutation(online);
  const [editing, setEditing] = useState<string | null>(null), [filter, setFilter] = useState(''), [status, setStatus] = useState<'active' | 'archived' | ''>('active'), [mine, setMine] = useState(false), [notice, setNotice] = useState('');
  const [acknowledged, setAcknowledged] = useState<OwnersReceipt | null>(null), adoptingId = useRef<string | null>(null);
  useEffect(() => { if (adoptingId.current === id) adoptingId.current = null; else { setEditing(null); setAcknowledged(null); setNotice(''); } }, [id]);
  const current = selected.data?.package ?? null, retained = readEditorDraft(client.readStored(`draft:owners-editor:${id ?? 'new'}`, null));
  const refresh = () => { void list.reload(); void selected.reload(); void history.reload(); };
  const recovered = (receipt: OwnersReceipt) => { setNotice(receipt.receipt.action === 'create' ? 'Ownership package created.' : 'Ownership package saved.'); refresh(); if (receipt.package) location.hash = `owners/${receipt.package.id}`; };
  const done = (result?: OwnersPackage | null) => { setEditing(null); setAcknowledged(null); refresh(); if (result) { setNotice('Ownership package saved.'); location.hash = `owners/${result.id}`; } };
  const adopt = (receipt: OwnersReceipt) => {
    if (!receipt.package) return;
    setAcknowledged(receipt); setEditing(receipt.receipt.id); setNotice('Package saved. Your newer edits remain in this package draft.');
    if (id !== receipt.receipt.id) { adoptingId.current = receipt.receipt.id; location.hash = `owners/${receipt.receipt.id}`; }
    refresh();
  };
  const acknowledgedSource = acknowledged && acknowledged.accessEpoch === client.session?.accessEpoch && acknowledged.package?.id === editing ? acknowledged.package : null;
  const editorSource = acknowledgedSource && (!current || acknowledgedSource.version > current.version) ? acknowledgedSource : current;
  const packages = list.data?.packages.filter(item => (!status || item.status === status) && (!mine || item.owners.some(owner => owner.kind === 'person' ? owner.id === state.currentPrincipalId : state.joinedProjectIds.includes(owner.id))) && (!filter.trim() || `${item.name} ${item.description}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))) ?? [];
  const changeStatus = async () => {
    if (!current) return;
    const next = current.status === 'active' ? 'archived' : 'active';
    if (!window.confirm(next === 'archived' ? 'Archive this package? It will stop matching paths and routing new reviews and audits.' : 'Reactivate this ownership package?')) return;
    const result = await mutation.send({ id: crypto.randomUUID(), path: `/api/owners/${current.id}`, method: 'PUT', label: next === 'archived' ? 'Archive ownership package' : 'Reactivate ownership package', body: { ...ownersDefinition(current), status: next, expectedVersion: current.version, expectedAccessEpoch: client.session?.accessEpoch ?? state.accessEpoch } });
    if (result) recovered(result);
  };
  return <div className="owners-workspace" aria-label="Owners workspace"><div className="owners-toolbar"><div><h1><FolderGit2 size={24}/>{current?.name ?? 'Owners'}</h1><p className="muted">Ownership packages connect repository paths with the people responsible for them.</p></div><div className="owners-actions"><button className="button" disabled={!online || list.loading || selected.loading} onClick={refresh}><RefreshCw size={15}/>Refresh owners</button>{id && <a className="button" href="#owners">All packages</a>}{!id && <button className="button primary" disabled={(online ? !list.data?.canCreate : !state.canCreate) || !!editing || mutation.busy || !!mutation.pending} onClick={() => setEditing('new')}><Plus size={15}/>New package</button>}</div></div>
    {[list.error, selected.error, history.error, mutation.error].filter(Boolean).map((error, index) => <p key={index} role="alert" className="banner error">{error}</p>)}{notice && <p role="status" className="info-strip">{notice}</p>}{!online && <p className="info-strip">Reconnect to load packages and check ownership. Drafts are never submitted automatically.</p>}
    {mutation.pending && <section className="owners-recovery" aria-label="Unconfirmed ownership package request"><h3>{mutation.pending.label}</h3><p>The original request is retained. Reconnecting never sends it automatically.</p><div className="owners-actions"><button className="button" disabled={!online || mutation.busy} onClick={() => void mutation.send(mutation.pending!).then(result => { if (result) recovered(result); })}>Retry exact package request</button><button className="button" onClick={() => exportAutomation(mutation.pending, 'ownership-package-request')}>Export package request</button><button className="button" disabled={mutation.busy} onClick={() => { if (window.confirm('Forget this request? Any completed server change remains recorded.')) void mutation.forget(); }}>Forget package request</button></div></section>}
    {!editing && retained && <div className="owners-actions"><button className="button" onClick={() => setEditing(id ?? 'new')}>Resume package draft</button></div>}
    {editing ? <OwnersEditor key={editing} id={editing === 'new' ? undefined : editing} source={editing === 'new' ? null : editorSource} state={state} online={online} mutation={mutation} done={done} adopt={adopt} canEdit={editing === 'new' ? !!list.data?.canCreate : !!selected.data?.canEdit}/> : current ? <><div className="owners-actions">{selected.data?.canEdit && <><button className="button" disabled={mutation.busy || !!mutation.pending} onClick={() => setEditing(current.id)}>Edit package</button><button className="button" disabled={!online || mutation.busy || !!mutation.pending} onClick={() => void changeStatus()}>{current.status === 'active' ? 'Archive package' : 'Reactivate package'}</button></>}<button className="button" onClick={() => exportAutomation(ownersDefinition(current), 'ownership-package')}>Export package</button></div>
      <div className="owners-detail-grid"><div><AutomationPanel title="Package Details" actions={<span className="badge">{current.status}</span>}><dl className="owners-properties"><dt>Visibility</dt><dd>{current.visibility === 'workspace' ? 'Workspace members' : 'Creator and package owners'}</dd><dt>Dominion</dt><dd>{dominionLabels[current.dominion]}</dd><dt>Automatic review</dt><dd>{reviewLabels[current.autoReview]}</dd><dt>Commit auditing</dt><dd>{auditLabels[current.auditing]}</dd><dt>Version</dt><dd>{current.version}</dd></dl>{current.description && <RemarkupBody body={current.description} contextKey={`${current.id}:${current.version}`}/>}</AutomationPanel>
      <AutomationPanel title="Package Owners"><ul className="owners-people">{current.owners.map(owner => <li key={ownerKey(owner)}><Users size={16}/>{owner.kind === 'project' ? <a href={`#${owner.id}`}>{ownerName(owner, state)}</a> : <span>{ownerName(owner, state)}</span>}<small>{owner.kind === 'project' ? 'Project members' : 'Person'}</small></li>)}</ul>{!current.owners.length && <p className="muted">No package owners assigned.</p>}</AutomationPanel>
      <AutomationPanel title="Owned Paths"><ul className="owners-paths">{current.paths.map((path, index) => <li key={index}><span className={`badge ${path.excluded ? 'owners-excluded' : ''}`}>{path.excluded ? 'Exclude' : 'Include'}</span><a href={`#${path.repositoryId}`}>{state.repositories.find(repository => repository.id === path.repositoryId)?.name ?? path.repositoryId}</a><code>{path.path}</code></li>)}</ul>{!current.paths.length && <p className="muted">No repository paths configured.</p>}</AutomationPanel></div><MatchPreview state={state} online={online}/></div>
      <AutomationPanel title="Package History"><ol className="owners-history">{history.data?.history.map(entry => <li key={entry.package.version}><strong>{entry.actorName}</strong> {entry.package.version === 1 ? 'created' : 'updated'} the package<span className="badge">Version {entry.package.version}</span><time dateTime={entry.package.updatedAt}>{new Date(entry.package.updatedAt).toLocaleString()}</time><details><summary>Package settings at this version</summary><dl className="owners-properties"><dt>Name</dt><dd>{entry.package.name}</dd><dt>Status</dt><dd>{entry.package.status}</dd><dt>Visibility</dt><dd>{entry.package.visibility}</dd><dt>Owners</dt><dd>{entry.package.owners.map(owner => ownerName(owner, state)).join(', ') || 'None'}</dd><dt>Dominion</dt><dd>{dominionLabels[entry.package.dominion]}</dd><dt>Automatic review</dt><dd>{reviewLabels[entry.package.autoReview]}</dd><dt>Commit auditing</dt><dd>{auditLabels[entry.package.auditing]}</dd></dl><ul className="owners-paths">{entry.package.paths.map((path, index) => <li key={index}><span>{path.excluded ? 'Exclude' : 'Include'}</span><span>{path.repositoryId}</span><code>{path.path}</code></li>)}</ul>{entry.package.description && <p className="owners-description">{entry.package.description}</p>}</details></li>)}</ol>{history.loading && <p role="status">Loading package history…</p>}</AutomationPanel>
    </> : !id ? <div className="owners-detail-grid"><section className="panel" aria-label="Ownership packages"><div className="panel-heading"><h2>Ownership Packages</h2></div><div className="card-body"><div className="owners-form owners-filters"><label>Filter packages<input aria-label="Filter packages" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Name or description"/></label><label>Package list status<select aria-label="Package list status" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">Active packages</option><option value="archived">Archived packages</option><option value="">All packages</option></select></label><label className="owners-checkbox"><input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)}/>Owned by me or my projects</label></div><div className="owners-list">{packages.map(item => <article key={item.id}><div><a href={`#owners/${item.id}`}><strong>{item.name}</strong></a><span className="badge">{item.status}</span></div><p className="muted small">{item.owners.map(owner => ownerName(owner, state)).join(', ') || 'No owners'} · {item.paths.length} path {item.paths.length === 1 ? 'rule' : 'rules'} · {item.visibility === 'workspace' ? 'Workspace' : 'Private'}</p>{item.description && <p>{item.description}</p>}</article>)}</div>{list.loading && <p role="status">Loading ownership packages…</p>}{list.data && !packages.length && <p className="empty-state">No visible packages match these filters.</p>}</div></section><MatchPreview state={state} online={online}/></div> : !selected.loading && !selected.error && <p className="empty-state">This package is unavailable.</p>}
  </div>;
}
