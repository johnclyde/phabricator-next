import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, ShieldCheck, X } from 'lucide-react';
import type { AppState, SpaceSummary } from '../shared/types';
import type { Audience, ProjectAudience, ObjectAccess } from '../shared/policy';
import type { PublicAccount } from '../shared/auth';
import type { MutationMethod } from './offline';
import { useWorkspace } from './SessionGate';
import { authorIntent, verifiedAuthorResult } from './revision-authorship';

export type AccessMutation = <T>(path: string, method: MutationMethod, body: unknown, label: string, allowQueue?: boolean) => Promise<T | null>;
type AudienceEditorProps = { label: string; principals: PublicAccount[]; disabled?: boolean } & ({ project: true; value: ProjectAudience; onChange: (value: ProjectAudience) => void } | { project?: false; value: Audience; onChange: (value: Audience) => void });
export function AudienceEditor(props: AudienceEditorProps) {
  const { label, value, principals, disabled = false } = props;
  const onChange = (next: ProjectAudience) => { if (props.project) props.onChange(next); else if (next.kind !== 'project-members') props.onChange(next); };
  const { session } = useWorkspace();
  const selected = value.kind === 'principals' ? value.principalIds : [];
  return <fieldset className="audience-editor" disabled={disabled}><legend>{label}</legend>
    <select aria-label={label} value={value.kind} onChange={event => onChange(event.target.value === 'project-members' ? { kind: 'project-members' } : event.target.value === 'workspace' ? { kind: 'workspace' } : { kind: 'principals', principalIds: session?.state.account ? [session.state.account.id] : session?.state.mode === 'local' ? [`local:${session.state.workspaceId}`] : [] })}>
      <option value="workspace">Workspace members</option><option value="principals">Selected members</option>{props.project && <option value="project-members">Members of this project</option>}
    </select>
    {value.kind === 'project-members' && <p className="muted small">This rule follows membership in this project. Space access still limits viewing.</p>}{value.kind === 'principals' && <div className="audience-members">{principals.filter(person => !person.disabled || selected.includes(person.id)).map(person => <label className="checkbox" key={person.id}><input type="checkbox" checked={selected.includes(person.id)} onChange={event => onChange({ kind: 'principals', principalIds: event.target.checked ? [...selected, person.id] : selected.filter(id => id !== person.id) })}/>{person.displayName} <small>@{person.username}{person.disabled ? ' · disabled' : ''}</small></label>)}{selected.filter(id => !principals.some(person => person.id === id)).map(id => <label key={id} className="checkbox"><input type="checkbox" checked onChange={() => onChange({ kind: 'principals', principalIds: selected.filter(item => item !== id) })}/>Unavailable member <small>{id}</small></label>)}{!selected.length && <p className="muted small">No members selected. This rule grants access to no one.</p>}</div>}
  </fieldset>;
}
export function SpacePicker({ spaces, value, onChange, retainArchivedId }: { spaces: SpaceSummary[]; value: string; onChange: (value: string) => void; retainArchivedId?: string }) {
  const options = spaces.filter(space => !space.archived || space.id === retainArchivedId);
  const missing = value && !options.some(space => space.id === value);
  return <label className="field"><span>Space</span><select required aria-label="Space" value={value} onChange={event => onChange(event.target.value)}><option value="" disabled>Choose a Space</option>{missing && <option value={value} disabled>Selected Space unavailable or archived ({value})</option>}{options.map(space => <option key={space.id} value={space.id}>{space.name} ({space.id}){space.archived ? ' · Archived' : ''}</option>)}</select><small>Space access limits who can see this object. Object rules can restrict it further.</small>{missing && <small className="error-text">Choose an available Space explicitly before saving.</small>}</label>;
}
export function AccessSummary({ access, spaces, manage }: { access?: ObjectAccess; spaces: SpaceSummary[]; manage?: () => void }) {
  const space = spaces.find(item => item.id === access?.policy.spaceId);
  return <section className="panel access-summary"><div className="panel-heading"><h2><ShieldCheck size={17}/>Access</h2>{access?.capabilities.managePolicy && manage && <button className="text-button" onClick={manage}>Manage access</button>}</div>{access ? <dl className="metadata">{access.inheritedFrom && <><dt>Inherited policies</dt><dd>These rules come from <a href={`#${access.inheritedFrom.projectId}`}>the parent project</a>. Manage them on that project.</dd></>}<dt>Space</dt><dd>{space?.name || access.policy.spaceId}{space?.archived ? ' · Archived' : ''}</dd><dt>View</dt><dd>{access.viewLabel}</dd><dt>Edit</dt><dd>{access.editLabel}</dd><dt>Interact</dt><dd>{access.interactLabel}</dd>{access.policy.kind === 'project' && <><dt>Join</dt><dd>{access.joinLabel || 'Requires verified join access'}</dd><dt>Project members</dt><dd>Project members automatically have view access while the Space permits viewing. Membership alone does not grant editing access. Editors can join ordinary leaf projects; parent and milestone membership is managed through its source projects.</dd></>}{access.automatic?.kind === 'file-author' && <><dt>Uploader</dt><dd>The uploader automatically has view, edit, and interact access while the file’s Space permits viewing. Explicit attachments can also grant viewers of another object download access within this Space.</dd></>}{access.automatic?.kind === 'paste-author' && <><dt>Paste author</dt><dd>The author automatically has view, edit, and interact access while the paste’s Space permits viewing.</dd></>}{access.automatic?.kind === 'revision-author' && <><dt>Current author</dt><dd>The current author automatically has view and edit access within the Space and any repository or source File boundaries. Interact access follows its explicit rule.</dd></>}{access.automatic?.kind === 'task-owner' && <><dt>Owner</dt><dd>The current owner automatically has view, edit, and interact access while the Space permits viewing. Object rules cannot remove the owner’s access within that boundary.</dd></>}</dl> : <p className="info-strip">Access has not been verified. Reconnect before making changes.</p>}</section>;
}
export function AccessDialog({ id, state, online, mutate, close }: { id: string; state: AppState; online: boolean; mutate: AccessMutation; close: () => void }) {
  const { request } = useWorkspace();
  const [access, setAccess] = useState<ObjectAccess | null>(state.access[id] || null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); void reload(); }, []);
  const reload = async () => { setBusy(true); try { setAccess(await request<ObjectAccess>(`/api/policies/${id}`)); setError(''); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not load access rules.'); } finally { setBusy(false); } };
  const canManage = Boolean(state.access[id]?.capabilities.managePolicy && access?.capabilities.managePolicy && online);
  const spaceAvailable = state.spaces.some(space => space.id === access?.policy.spaceId && (!space.archived || space.id === state.access[id]?.policy.spaceId));
  const changeRule = (capability: 'view' | 'edit' | 'interact' | 'join', rule: ProjectAudience) => setAccess(current => {
    if (!current) return current;
    if (current.policy.kind === 'project') return { ...current, policy: { ...current.policy, rules: { ...current.policy.rules, [capability]: rule } } };
    if (capability === 'join' || rule.kind === 'project-members') return current;
    return { ...current, policy: { ...current.policy, rules: { ...current.policy.rules, [capability]: rule } } };
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!access || !canManage || !spaceAvailable) return;
    if (!window.confirm(`Save access rules for ${id}? Space and object rules determine which members can read, edit, and interact with this object. Changes apply to future requests; previously read or exported copies cannot be recalled.`)) return;
    setBusy(true); setError('');
    try { await mutate(`/api/policies/${id}`, 'PUT', { expectedVersion: access.policy.version, spaceId: access.policy.spaceId, ...access.policy.rules }, `${id} access updated`, false); close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save access rules.'); } finally { setBusy(false); }
  };
  return <dialog className="modal access-dialog" ref={dialog} onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={submit}><div className="modal-heading"><h2>Access for {id}</h2><button type="button" className="icon-button" aria-label="Close access dialog" onClick={close}><X size={20}/></button></div><div className="modal-body">
    {error && <div className="banner error" role="alert">{error}<button type="button" onClick={() => void reload()} disabled={busy}>Reload access</button></div>}
    {access && <><AccessSummary access={access} spaces={state.spaces}/><p className="muted small">View access is required for editing and interaction. Interact access covers comments and recorded reviews. Editing also permits changing access rules.</p>{canManage ? <><SpacePicker spaces={state.spaces} retainArchivedId={state.access[id]?.policy.spaceId} value={access.policy.spaceId} onChange={spaceId => setAccess({ ...access, policy: { ...access.policy, spaceId } })}/>{access.policy.kind === 'project' ? (['view', 'edit', 'interact', 'join'] as const).map(capability => <AudienceEditor project key={capability} label={`${capability[0].toUpperCase()}${capability.slice(1)} access`} principals={state.principals} value={access.policy.kind === 'project' ? access.policy.rules[capability] : { kind: 'workspace' }} onChange={rule => changeRule(capability, rule)}/>) : (['view', 'edit', 'interact'] as const).map(capability => <AudienceEditor key={capability} label={`${capability[0].toUpperCase()}${capability.slice(1)} access`} principals={state.principals} value={access.policy.kind !== 'project' ? access.policy.rules[capability] : { kind: 'workspace' }} onChange={rule => changeRule(capability, rule)}/>)}</> : <p className="info-strip">{access?.inheritedFrom ? 'Milestones inherit their parent’s access policies. Edit the parent project to change these rules.' : online ? 'You can read these access rules. Editing access requires permission to edit this object.' : 'Reconnect to change access rules.'}</p>}</>}
  </div><div className="modal-footer"><button className="button" type="button" onClick={close}>Close</button>{canManage && <button className="button primary" disabled={busy || !spaceAvailable}>{busy ? 'Saving…' : 'Save Access'}</button>}</div></form></dialog>;
}
export function ObjectUnavailable({ reload }: { reload: () => void }) { return <section className="panel"><div className="wiki-status" role="status"><h2>Object unavailable</h2><p>This object does not exist or you no longer have access. Any saved drafts are set aside below for export or discard.</p><button className="button" onClick={reload}>Reload workspace</button></div></section>; }
export function QuarantinedDrafts({ refreshWorkspace }: { refreshWorkspace?: () => Promise<void> }) {
  const client = useWorkspace();
  const { quarantinedDrafts, quarantineWarning, retryQuarantineStorage, discardQuarantinedDraft, onAccessChange, durable } = client;
  const [, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(''), [confirmation, setConfirmation] = useState('');
  const confirmAuthor = async (key: string, value: unknown, id: string) => {
    const intent = authorIntent(value, id); if (!intent || confirming || !client.isActive()) return;
    setConfirming(key); setError(''); setConfirmation('');
    try {
      const result = await client.request<unknown>(`/api/revisions/${id}/authorship`, { method: 'POST', body: intent.body, id: intent.id });
      const principal = client.session?.state.account?.id || `local:${client.session?.state.workspaceId}`;
      await verifiedAuthorResult(result, id, intent.body, principal);
      if (!client.isActive()) return;
      await client.acknowledgeRevisionAuthorIntent(`revision-author-request:${id}`, intent, `revision-author-draft:${id}`, intent.draft);
      if (client.isActive()) { setConfirmation(`The submitted authorship change for ${id} is confirmed. Other drafts remain retained.`); setRevision(value => value + 1); await refreshWorkspace?.(); }
    } catch (error) { if (client.isActive()) setError(error instanceof Error ? error.message : 'The submitted change could not be confirmed.'); }
    finally { if (client.isActive()) setConfirming(''); }
  };
  useEffect(() => { const unload = (event: BeforeUnloadEvent) => { if (quarantineWarning()) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', unload); return () => window.removeEventListener('beforeunload', unload); }, []);
  useEffect(() => onAccessChange(() => setRevision(value => value + 1)), []);
  const drafts = quarantinedDrafts();
  const warning = quarantineWarning();
  if (!drafts.length && !warning && !confirmation) return null;
  return <section className="panel quarantined-drafts"><div className="panel-heading"><h2>Drafts set aside after access changed</h2><span>{drafts.length}</span></div><p className="info-strip">{durable && warning ? 'Saved originals are on hold while their recovery copies need attention. Export this work before leaving. Nothing held here will submit automatically.' : durable ? 'These drafts are saved on this device until you explicitly discard them. Exporting keeps the saved recovery copy. They will never submit automatically, even if access returns.' : 'These unsaved drafts stay in this session for export or discard. They will never submit automatically. Export before signing out or leaving this page.'}</p>{warning && <div className="banner warning" role="alert"><span>{warning}</span><button onClick={() => { retryQuarantineStorage(); setRevision(value => value + 1); }}>Retry saving drafts</button></div>}{error && <div className="banner error" role="alert">{error}</div>}{confirmation && <p className="info-strip" role="status">{confirmation}</p>}{drafts.map(draft => <div className="quarantined-draft" key={draft.recoveryId}><div><strong>{draft.objectId} · Unsaved draft</strong><small>{draft.reason}</small><details><summary>Inspect your saved draft</summary><pre>{JSON.stringify(draft.value, null, 2)}</pre></details></div><button className="button" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(draft.value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${draft.objectId}-unsaved-draft.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={15}/>Export Draft</button>{/^revision-author-request:[DPL]\d+(?::unsaved-memory)?$/.test(draft.key) && authorIntent(draft.value, draft.objectId) && <button className="button" disabled={Boolean(confirming) || !navigator.onLine} onClick={() => void confirmAuthor(draft.recoveryId, draft.value, draft.objectId)}>Confirm Submitted Authorship Change</button>}<button className="button danger" onClick={async () => { if (window.confirm(`Discard this unsaved draft for ${draft.objectId}? Export it first to keep a copy.`)) { try { await discardQuarantinedDraft(draft); setError(''); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not discard this draft.'); } } }}>Discard Draft</button></div>)}</section>;
}
