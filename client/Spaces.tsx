import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Layers, Plus, X } from 'lucide-react';
import { audienceLabel, type Audience } from '../shared/policy';
import type { AppState, SpaceSummary } from '../shared/types';
import { AudienceEditor, type AccessMutation } from './Access';
import { useWorkspace } from './SessionGate';

export default function Spaces({ state, online, mutate, query }: { state: AppState; online: boolean; mutate: AccessMutation; query: string }) {
  const [editing, setEditing] = useState<SpaceSummary | 'new' | null>(null);
  const selected = typeof editing === 'object' && editing ? state.spaces.find(space => space.id === editing.id) : null;
  useEffect(() => { if (editing && editing !== 'new' && !selected) setEditing(null); }, [state.spaces, editing, selected]);
  return <div className="spaces-view"><div className="info-strip">Spaces limit visibility across related work. Each object also has its own view, edit, and interact rules. A Space name alone does not make content private.</div><div className="spaces-toolbar"><span className="muted">{state.spaces.length} accessible Spaces</span><button className="button primary" disabled={!online || !state.canCreate} onClick={() => setEditing('new')}><Plus size={16}/>Create Space</button></div><div className="card-grid">{state.spaces.filter(space => `${space.name} ${space.description} ${space.id}`.toLowerCase().includes(query.toLowerCase())).map(space => <section className="panel space-card" key={space.id}><div className="panel-heading"><h2><Layers size={17}/>{space.name}</h2><span className="object-id">{space.id}</span></div><div className="card-body"><p>{space.description || 'No description.'}</p><div className="space-status">{space.isDefault && <span className="badge">Default Space</span>}{space.archived && <span className="badge badge-closed">Archived</span>}</div><dl className="metadata"><dt>Can view</dt><dd>{audienceLabel(space.view)}</dd><dt>Can manage Space</dt><dd>{audienceLabel(space.edit)}</dd></dl><p className="muted small">Objects may restrict access further. Space management does not grant edit access to every object.</p>{space.capabilities.edit && <button className="button" disabled={!online} onClick={() => setEditing(space)}>Manage Space</button>}</div></section>)}</div>{!state.spaces.length && <div className="empty">No Spaces are visible to this account.</div>}{editing && (editing === 'new' || selected) && <SpaceDialog key={editing === 'new' ? 'new' : editing.id} space={editing === 'new' ? null : selected!} state={state} online={online} mutate={mutate} close={() => setEditing(null)}/>}</div>;
}
function SpaceDialog({ space, state, online, mutate, close }: { space: SpaceSummary | null; state: AppState; online: boolean; mutate: AccessMutation; close: () => void }) {
  const { session } = useWorkspace();
  const creator: Audience = { kind: 'principals', principalIds: session?.state.account ? [session.state.account.id] : session?.state.mode === 'local' ? [`local:${session.state.workspaceId}`] : [] };
  const [name, setName] = useState(space?.name || ''); const [description, setDescription] = useState(space?.description || '');
  const [view, setView] = useState<Audience>(space?.view || creator); const [edit, setEdit] = useState<Audience>(space?.edit || creator);
  const [archived, setArchived] = useState(space?.archived || false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [expectedVersion] = useState(space?.version);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const canSave = online && (space ? space.capabilities.edit : state.canCreate);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!canSave) return;
    if (space && !window.confirm(`Save changes to Space “${name}”? View changes affect every object in this Space. Previously read or exported copies cannot be recalled.`)) return;
    setBusy(true); setError('');
    try { await mutate(space ? `/api/spaces/${space.id}` : '/api/spaces', space ? 'PATCH' : 'POST', { name, description, view, edit, ...(space ? { expectedVersion, archived } : {}) }, space ? 'Space updated' : 'Space created', false); close(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save Space.'); } finally { setBusy(false); }
  };
  return <dialog className="modal" ref={dialog} onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={submit}><div className="modal-heading"><h2>{space ? `Manage Space ${space.id}` : 'Create Space'}</h2><button className="icon-button" type="button" aria-label="Close Space dialog" onClick={close}><X size={20}/></button></div><div className="modal-body">{error && <div className="banner error" role="alert">{error}</div>}<fieldset className="policy-fields" disabled={!canSave}><label className="field"><span>Space name</span><input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)}/></label><label className="field"><span>Description</span><textarea rows={3} value={description} onChange={event => setDescription(event.target.value)}/></label><AudienceEditor label="View access" principals={state.principals} value={view} onChange={setView}/><AudienceEditor label="Manage Space access" principals={state.principals} value={edit} onChange={setEdit}/>{space && !space.isDefault && <label className="checkbox"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)}/>Archive Space (retain existing objects; prevent new placement)</label>}</fieldset><p className="muted small">New Spaces start with access for you alone. Sharing requires choosing the members or the workspace explicitly. Objects retain their own access rules.</p>{!canSave && <p className="info-strip">Reconnect with permission to manage this Space before saving.</p>}</div><div className="modal-footer"><button type="button" className="button" onClick={close}>Cancel</button><button className="button primary" disabled={busy || !canSave}>{busy ? 'Saving…' : space ? 'Save Space' : 'Create Space'}</button></div></form></dialog>;
}
