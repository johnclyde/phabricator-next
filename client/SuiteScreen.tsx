import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AppState } from '../shared/types';
import type { SuiteAccess, SuiteApp, SuiteDetail, SuiteList, SuiteRecord } from '../shared/suite';
import { useWorkspace } from './SessionGate';
import { useDraftRetention } from './draft-retention';
import { AutomationPanel, AutomationRecovery, AutomationRefresh, exportAutomation, useAutomationMutation, useAutomationRead, type AutomationIntent } from './AutomationSupport';
import './suite.css';

export interface SuiteField { name: string; label: string; type: 'text' | 'textarea' | 'select' | 'multi' | 'checkbox' | 'number' | 'datetime'; options?: { value: string; label: string }[]; required?: boolean; hint?: string }
export interface SuiteForm { key: string; label: string; fields: SuiteField[]; values?: Record<string, unknown>; confirm?: string; transform?: (values: Record<string, unknown>) => Record<string, unknown> }
interface Draft { recordId: string | null; version: number | null; form: Omit<SuiteForm, 'transform'>; values: Record<string, unknown>; access?: SuiteAccess }
interface SuiteIntent extends AutomationIntent { editorDraft?: Draft }
interface ReceiptDetail extends Omit<SuiteDetail, 'record'> { record: SuiteRecord | null; receipt: { version: number; replayed: boolean }; unavailable?: boolean }
function selectedId(app: SuiteApp): string | null { return location.hash.startsWith(`#${app}/`) ? location.hash.slice(app.length + 2) : null; }
export function SuiteScreen({ app, title, online, state, forms, render, summary }: { app: SuiteApp; title: string; online: boolean; state: AppState; forms(record: SuiteRecord | null, detail?: SuiteDetail, records?: SuiteRecord[]): SuiteForm[]; render(record: SuiteRecord): ReactNode; summary?(record: SuiteRecord): ReactNode }) {
  const client = useWorkspace(), key = `draft:automation:suite:${app}:editor`;
  const [id, setId] = useState(() => selectedId(app)), [query, setQuery] = useState(''), [cursors, setCursors] = useState<number[]>([]), [history, setHistory] = useState<number[]>([]);
  const [draft, setDraft] = useState<Draft | null>(() => client.readStored<Draft | null>(key, null)), [saved, setSaved] = useState(true), [notice, setNotice] = useState(''), [completing, setCompleting] = useState(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const live = useRef(true), screen = useRef({ client, id }); screen.current = { client, id };
  useEffect(() => { live.current = true; setCompleting(false); return () => { live.current = false; }; }, [client]);
  const retain = useDraftRetention(client, key, setSaved), mutation = useAutomationMutation(`suite:${app}`, online);
  const listing = useAutomationRead<SuiteList>(`/api/suite/${app}?q=${encodeURIComponent(query)}${cursors.length ? `&before=${cursors.at(-1)}` : ''}`, online);
  const selected = useAutomationRead<SuiteDetail>(id ? `/api/suite/${app}/${id}${history.length ? `?before=${history.at(-1)}` : ''}` : null, online);
  const draftSource = useAutomationRead<SuiteDetail>(draft?.recordId && draft.recordId !== id ? `/api/suite/${app}/${draft.recordId}` : null, online);
  useEffect(() => { const change = () => { setId(selectedId(app)); setHistory([]); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, [app]);
  const choose = (next: string | null) => { location.hash = next ? `${app}/${next}` : app; setId(next); setHistory([]); };
  const change = (value: Draft) => { setDraft(value); retain(value); };
  const busy = completing || mutation.busy || Boolean(mutation.pending);
  const available = selected.data ? forms(selected.data.record, selected.data, listing.data?.records) : [];
  const accessForm: SuiteForm = { key: 'access', label: 'Edit Access', fields: [], values: {} };
  const start = (form: SuiteForm, record: SuiteRecord | null) => {
    if (draft || busy) { setNotice('Save or discard the open draft before starting another action.'); return; }
    const values: Record<string, unknown> = {};
    for (const field of form.fields) values[field.name] = field.type === 'multi' ? [] : field.type === 'checkbox' ? false : '';
    Object.assign(values, form.values);
    const { transform: _transform, ...serializable } = form;
    change({ recordId: record?.id ?? null, version: record?.version ?? null, form: serializable, values, ...(!record || form.key === 'access' ? { access: record?.access ?? { spaceId: state.spaces.find(space => !space.archived)?.id ?? 'S1', visibility: 'workspace', memberIds: [], editorIds: [] } } : {}) });
    setNotice('');
  };
  const refresh = async () => { await listing.reload(); await selected.reload(); await draftSource.reload(); };
  const receive = async (intent: SuiteIntent) => {
    setCompleting(true);
    try {
      const submitted = intent.editorDraft ?? null;
      const result = await mutation.send<ReceiptDetail>(intent);
      if (!result) return;
      if (submitted && JSON.stringify(draftRef.current) === JSON.stringify(submitted) && await client.removeRetainedDraftIfEqual(key, submitted, () => JSON.stringify(draftRef.current) === JSON.stringify(submitted)) && JSON.stringify(draftRef.current) === JSON.stringify(submitted)) { setDraft(null); draftRef.current = null; }
      if (!live.current || screen.current.client !== client || !client.isActive() || location.hash.split('/')[0] !== `#${app}`) return;
      if (screen.current.id !== id) { await listing.reload(); return; }
      setNotice(result.unavailable ? 'Saved. Your access to this object has ended.' : result.receipt.replayed ? `Recovered the original operation at version ${result.receipt.version}. Showing the current authorized object.` : 'Saved.');
      const next = result.record?.id ?? null;
      if (result.record && next === id && result.accessEpoch === client.session?.accessEpoch) selected.setData({ ...result, record: result.record });
      choose(next);
      if (next === id) await refresh(); else await listing.reload();
    } finally { if (live.current && screen.current.client === client) setCompleting(false); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault(); if (!draft) return;
    if (draft.form.confirm && !window.confirm(draft.form.confirm)) return;
    const source = draft.recordId === id ? selected.data : draftSource.data;
    const liveForm = draft.recordId ? source && forms(source.record, source, listing.data?.records).find(form => form.key === draft.form.key) : forms(null, undefined, listing.data?.records).find(form => form.key === draft.form.key);
    const values = liveForm?.transform ? liveForm.transform(draft.values) : draft.values;
    const body = draft.recordId ? { ...values, expectedVersion: draft.version, ...(draft.form.key === 'access' ? { access: draft.access } : {}) } : { ...values, kind: draft.form.key, access: draft.access };
    void receive({ id: crypto.randomUUID(), method: 'POST', path: `/api/suite/${app}${draft.recordId ? `/${draft.recordId}/${draft.form.key}` : ''}`, body, label: draft.form.label, editorDraft: draft });
  };
  const baseline = draft?.recordId === id ? selected.data : draftSource.data, stale = Boolean(draft?.recordId && baseline && baseline.record.version !== draft.version);
  const people = state.principals.filter(person => !person.disabled).map(person => ({ value: person.id, label: person.displayName }));
  const errors = [listing.error, selected.error, draftSource.error, mutation.error].filter(Boolean);
  return <div className="automation-workspace suite-workspace" aria-label={`${title} workspace`}>
    <div className="automation-toolbar"><div className="automation-actions">{forms(null, undefined, listing.data?.records).map(form => <button className="button primary" key={form.key} disabled={!online || !state.canCreate || busy || Boolean(draft)} onClick={() => start(form, null)}>{form.label}</button>)}</div><AutomationRefresh busy={listing.loading || selected.loading} online={online} refresh={() => void refresh()}/></div>
    {!online && <p className="info-strip">You are offline. Keep drafts open or export them. Reconnecting never submits changes automatically.</p>}
    {errors.map((error, index) => <p className="banner error" role="alert" key={index}>{error}</p>)}
    {notice && <p className="info-strip" role="status">{notice}</p>}
    <AutomationRecovery pending={mutation.pending} busy={mutation.busy} online={online} retry={() => { if (mutation.pending) void receive(mutation.pending); }} forget={() => void mutation.forget()}/>
    {draft && <AutomationPanel title={draft.form.label}><form className="automation-form" aria-label={`${title} editor`} onSubmit={submit}>
      {draft.recordId && <p className="small muted">For <a href={`#${app}/${draft.recordId}`}>{draft.recordId}</a> · version {draft.version}</p>}
      {draft.form.fields.map(field => <SuiteInput key={field.name} field={field} value={draft.values[field.name]} change={value => change({ ...draft, values: { ...draft.values, [field.name]: value } })}/>)}
      {draft.access && !(app === 'phame' && draft.form.key === 'post') && <fieldset className="suite-access"><legend>Access</legend><SuiteInput field={{ name: 'space', label: 'Space', type: 'select', options: state.spaces.map(space => ({ value: space.id, label: space.name })) }} value={draft.access.spaceId} change={value => change({ ...draft, access: { ...draft.access!, spaceId: String(value) } })}/>{app !== 'conpherence' && !(app === 'almanac' && ['interface', 'binding'].includes(draft.form.key)) && <><SuiteInput field={{ name: 'visibility', label: 'Who can view', type: 'select', options: [{ value: 'workspace', label: 'People with access to this Space' }, { value: 'members', label: 'Selected people and editors' }] }} value={draft.access.visibility} change={value => change({ ...draft, access: { ...draft.access!, visibility: value as SuiteAccess['visibility'] } })}/><SuiteInput field={{ name: 'members', label: 'Selected people', type: 'multi', options: people }} value={draft.access.memberIds} change={value => change({ ...draft, access: { ...draft.access!, memberIds: value as string[] } })}/>{app !== 'slowvote' && !(app === 'phame' && !draft.recordId) && <SuiteInput field={{ name: 'editors', label: 'Additional editors', type: 'multi', options: people }} value={draft.access.editorIds} change={value => change({ ...draft, access: { ...draft.access!, editorIds: value as string[] } })}/>}</>}<p className="small muted">{app === 'almanac' && ['interface', 'binding'].includes(draft.form.key) ? 'Access and editing follow the current device or service and related records. The selected Space adds its own restrictions.' : 'Space restrictions always apply. Conversation participation, poll ownership, and blog roles may further restrict access.'} This does not enable anonymous access.</p></fieldset>}
      {app === 'phame' && draft.form.key === 'post' && <p className="small muted">This post inherits the selected blog's current Space and audience.</p>}
      {draft.recordId && draft.recordId !== id && <p className="info-strip">Return to <a href={`#${app}/${draft.recordId}`}>this object's details</a> to review the content before submitting this draft.</p>}
      {stale && <p className="banner warning">This object changed after you opened the draft. Review the current content before using its latest version.</p>}
      {!saved && <p className="banner warning">This draft may only be held in this tab. Export it before closing.</p>}
      <div className="automation-actions"><button className="button primary" disabled={!online || !state.canCreate || busy || stale || Boolean(draft.recordId && (!baseline || draft.recordId !== id))}>{draft.form.label}</button>{stale && <button className="button" type="button" disabled={busy} onClick={() => { if (baseline) change({ ...draft, version: baseline.record.version }); }}>Use Current Version</button>}<button className="button" type="button" onClick={() => exportAutomation(draft, `${app}-draft`)}>Export Draft</button><button className="button" type="button" disabled={mutation.busy} onClick={() => { if (window.confirm('Discard this unsaved draft?')) void client.removeRetainedDraftIfEqual(key, draft, () => JSON.stringify(draftRef.current) === JSON.stringify(draft)).then(removed => { if (removed && JSON.stringify(draftRef.current) === JSON.stringify(draft)) { setDraft(null); draftRef.current = null; } }); }}>Discard Draft</button></div>
    </form></AutomationPanel>}
    <div className="automation-layout"><AutomationPanel title={`${title} Objects`}><label className="field"><span>Search {title}</span><input value={query} onChange={event => { setQuery(event.target.value); setCursors([]); }}/></label><div className="automation-list">{listing.data?.records.map(record => <button type="button" className={record.id === id ? 'selected' : ''} key={record.id} onClick={() => choose(record.id)}><strong>{record.title}</strong><small>{record.kind} · version {record.version}</small>{summary && <small>{summary(record)}</small>}</button>)}</div>{!listing.data?.records.length && <p className="automation-empty">{listing.loading ? 'Loading…' : 'No visible objects match this search.'}</p>}<div className="automation-actions"><button className="button" disabled={!cursors.length || listing.loading} onClick={() => setCursors(values => values.slice(0, -1))}>Previous Page</button><button className="button" disabled={!listing.data?.nextBefore || listing.loading} onClick={() => { if (listing.data?.nextBefore) setCursors(values => [...values, listing.data!.nextBefore!]); }}>Next Page</button></div></AutomationPanel>
      <div className="automation-detail">{selected.data ? <><AutomationPanel title={selected.data.record.title}><p className="small muted suite-object-id">{selected.data.record.id} · version {selected.data.record.version}</p><div className="suite-content">{render(selected.data.record)}</div><div className="automation-actions">{available.map(form => <button className="button" disabled={!online || !state.canCreate || busy || selected.loading || Boolean(draft)} key={form.key} onClick={() => start(form, selected.data!.record)}>{form.label}</button>)}{selected.data.canEdit && app !== 'conpherence' && !(app === 'almanac' && ['interface', 'binding'].includes(selected.data.record.kind)) && !(app === 'phame' && selected.data.record.kind === 'post') && <button className="button" disabled={!online || busy || selected.loading || Boolean(draft)} onClick={() => start(accessForm, selected.data!.record)}>Edit Access</button>}</div></AutomationPanel><AutomationPanel title="History"><div className="automation-transcript">{selected.data.events.map(event => <article key={event.sequence}><h3>{event.summary}</h3><p>{event.actorName} · version {event.version} · {new Date(event.createdAt).toLocaleString()}</p></article>)}</div><div className="automation-actions"><button className="button" disabled={!history.length || selected.loading} onClick={() => setHistory(values => values.slice(0, -1))}>Newer History</button><button className="button" disabled={!selected.data.nextBefore || selected.loading} onClick={() => { if (selected.data?.nextBefore) setHistory(values => [...values, selected.data!.nextBefore!]); }}>Older History</button></div></AutomationPanel></> : <AutomationPanel title={`${title} Details`}><p className="automation-empty">{selected.loading ? 'Loading…' : 'Select an object to view its details and history.'}</p></AutomationPanel>}</div>
    </div>
  </div>;
}
function SuiteInput({ field, value, change }: { field: SuiteField; value: unknown; change(value: unknown): void }) {
  const id = useId(), options = field.options ?? [];
  if (field.type === 'multi') return <fieldset className="suite-multi"><legend>{field.label}{field.required ? ' (required)' : ''}</legend>{options.map(option => <label className="automation-check" key={option.value}><input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)} onChange={event => { const current = Array.isArray(value) ? value : []; change(event.target.checked ? [...current, option.value] : current.filter(item => item !== option.value)); }}/>{option.label}</label>)}{!options.length && <p className="muted">No options available.</p>}{field.hint && <p className="small muted">{field.hint}</p>}</fieldset>;
  if (field.type === 'checkbox') return <label className="automation-check"><input type="checkbox" checked={value === true} required={field.required} onChange={event => change(event.target.checked)}/>{field.label}</label>;
  return <label className="field"><span id={`${id}-label`}>{field.label}</span>{field.type === 'textarea' ? <textarea aria-labelledby={`${id}-label`} rows={5} value={String(value ?? '')} required={field.required} onChange={event => change(event.target.value)}/> : field.type === 'select' ? <select aria-labelledby={`${id}-label`} value={String(value ?? '')} required={field.required} onChange={event => change(event.target.value)}><option value="">Choose…</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <><input aria-labelledby={`${id}-label`} type={field.type === 'datetime' ? 'datetime-local' : field.type} list={options.length ? id : undefined} value={String(value ?? '')} required={field.required} onChange={event => change(field.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}/>{options.length > 0 && <datalist id={id}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</datalist>}</>}{field.hint && <small>{field.hint}</small>}</label>;
}
