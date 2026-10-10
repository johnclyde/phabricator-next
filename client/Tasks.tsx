import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, History, MessageSquare, Pencil, Plus, RefreshCw } from 'lucide-react';
import { diffWordsWithSpace } from 'diff';
import type { AppState, Priority, Task, TaskDetail, TaskField, TaskFieldChange, TaskHistory, TaskReference, TaskStatus, TaskTransaction, TaskUpdateResult, TaskSubscriptionPage, TaskSubscriptionStatus, TaskMergeInput, TaskMergeInInput, UpdateTaskInput } from '../shared/types';
import { isNetworkError, type MutationMethod } from './offline';
import { useWorkspace } from './SessionGate';
import { AccessSummary } from './Access';
import { isTaskClosed } from '../shared/tasks';

type Mutate = <T>(path: string, method: MutationMethod, body: unknown, label: string, allowQueue?: boolean) => Promise<T | null>;
const labels: Record<string, string> = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', duplicate: 'Duplicate', low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent', title: 'Title', description: 'Description', status: 'Status', priority: 'Priority', projectId: 'Project', ownerId: 'Owner' };
function member(id: string | null | undefined, state: AppState, empty = 'Unassigned') { if (!id) return empty; const person = state.principals.find(person => person.id === id); return person ? `${person.displayName}${person.disabled ? ' (disabled)' : ''}` : 'Unavailable member'; }
function date(value: string) { return new Date(value).toLocaleString(); }
function text(value: string | null) { return value === null ? 'None' : labels[value] || value; }
function download(value: unknown, filename: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function TaskPage({ id, state, online, mutate, manageAccess, refreshWorkspace }: { refreshWorkspace: () => Promise<void>; id: string; state: AppState; online: boolean; mutate: Mutate; manageAccess: () => void }) {
  const { request, readStored, writeStored, durable, unavailableObject, onTaskSnapshotChange, taskSnapshotGeneration } = useWorkspace();
  const [detail, setDetail] = useState<TaskDetail | null>(() => readStored(`task:${id}`, null));
  const editorTask = useRef<Task | null>(detail?.task || null);
  if (detail) editorTask.current = detail.task;
  const [snapshot, setSnapshot] = useState(true); const [loading, setLoading] = useState(false); const [paging, setPaging] = useState(false);
  const [error, setError] = useState(''); const [warning, setWarning] = useState(''); const [editing, setEditing] = useState(false);
  const [generation, setGeneration] = useState(taskSnapshotGeneration);
  const requests = useRef(0); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requests.current++; }; }, []);
  useEffect(() => onTaskSnapshotChange(() => { requests.current++; setDetail(null); setSnapshot(true); setGeneration(taskSnapshotGeneration()); setError('Task visibility changed. Reloading related information…'); }), []);
  const load = useCallback(async () => {
    const requestNumber = ++requests.current;
    setLoading(true);
    try {
      const next = await request<TaskDetail>(`/api/tasks/${id}`);
      if (!mounted.current || requestNumber !== requests.current || unavailableObject(id)) return;
      setDetail(next); setSnapshot(false); setError('');
      setWarning(writeStored(`task:${id}`, next) ? '' : 'This task is visible now, but browser storage could not save its history for offline reading.');
    } catch (failure) {
      if (!mounted.current || requestNumber !== requests.current) return;
      if (isNetworkError(failure)) { setSnapshot(true); if (!readStored(`task:${id}`, null)) setError(durable ? 'This task has not been saved on this device. Reconnect to open it.' : 'This task has not been loaded in this session. Reconnect to open it.'); }
      else setError(failure instanceof Error ? failure.message : 'Could not load this task.');
    } finally { if (mounted.current && requestNumber === requests.current) setLoading(false); }
  }, [id]);
  const currentVersion = state.tasks.find(task => task.id === id)?.version;
  useEffect(() => { void load(); }, [load, online, currentVersion, generation]);
  const older = async () => {
    if (!detail || detail.history.nextBefore === null) return;
    const requestNumber = requests.current; const snapshotGeneration = taskSnapshotGeneration();
    setPaging(true); setError('');
    try {
      const page = await request<TaskHistory>(`/api/tasks/${id}/history?before=${detail.history.nextBefore}&limit=20`);
      if (!mounted.current || requests.current !== requestNumber || taskSnapshotGeneration() !== snapshotGeneration) return;
      setDetail(current => {
        if (!current) return current;
        const rows = new Map([...current.history.transactions, ...page.transactions].map(item => [item.id, item]));
        const next = { ...current, history: { ...page, transactions: [...rows.values()].sort((a, b) => b.sequence - a.sequence) } };
        if (!writeStored(`task:${id}`, next)) setWarning('Older history is visible now but could not be saved for offline reading.');
        return next;
      });
    } catch (failure) { if (mounted.current && requestNumber === requests.current) setError(isNetworkError(failure) ? 'Reconnect to load older task history that has not been saved on this device.' : failure instanceof Error ? failure.message : 'Could not load older history.'); }
    finally { if (mounted.current) setPaging(false); }
  };
  const access = !detail || state.accessEpoch >= (detail.accessEpoch ?? -1) ? state.access[id] : detail.access;
  const canEdit = Boolean(access?.capabilities.edit); const canInteract = Boolean(access?.capabilities.interact);
  return <div className="task-page"><a className="back-link" href="#tasks"><ArrowLeft size={14}/>All tasks</a><div className="page-heading"><div><h1><span className="object-id">{id}</span> {detail?.task.title || 'Task'}</h1>{detail && <p><span className={`badge badge-${detail.task.status}`}>{text(detail.task.status)}</span> · {text(detail.task.priority)} priority · Version {detail.task.version}</p>}</div>{canEdit && <button className="button primary" disabled={!detail || !Number.isSafeInteger(detail.task.version)} onClick={() => setEditing(value => !value)}><Pencil size={15}/>{editing ? 'Close Editor' : 'Edit Task'}</button>}</div>
    <AccessSummary access={access} spaces={state.spaces} manage={manageAccess}/>
    {(snapshot || !online) && <div className="banner warning">{durable ? 'Saved task snapshot. Edits keep their original version; conflicts need your review before they can sync.' : 'Connection interrupted. Loaded task history stays in this tab only; reconnect to save.'}</div>}
    {warning && <div className="banner warning" role="status">{warning}</div>}{error && <div className="banner error" role="alert"><span>{error}</span><button disabled={loading} onClick={() => void load()}>Reload Task</button></div>}
    <div className="task-detail-layout"><div className="main-column">
      {editing && canEdit && editorTask.current && <TaskEditor task={editorTask.current} state={state} online={online} mutate={mutate} saved={async close => { if (close) setEditing(false); await load(); }}/>}
      {detail ? <><section className="panel"><div className="panel-heading"><h2>Description</h2><button className="text-button" disabled={loading} onClick={() => void load()}><RefreshCw size={14}/>Reload Task</button></div><pre className="task-detail-description">{detail.task.description || 'No description yet.'}</pre><dl className="metadata task-metadata"><dt>Project</dt><dd>{state.projects.find(project => project.id === detail.task.projectId)?.name || (detail.task.projectId ? 'Unavailable project' : 'None')}</dd><dt>Owner</dt><dd>{member(detail.task.ownerId, state)}</dd><dt>Author</dt><dd>{member(detail.task.authorId, state, 'Unknown (legacy)')}</dd><dt>Created</dt><dd>{date(detail.task.createdAt)}</dd><dt>Updated</dt><dd>{date(detail.task.updatedAt)}</dd></dl></section>
      <section className="panel task-history"><div className="panel-heading"><h2><History size={17}/>Task history</h2></div><p className="info-strip">Saved field changes, comments, and dependency changes form an append-only history.</p>{detail.history.transactions.some(item => item.kind === 'legacy') && <p className="info-strip">This task has a retained legacy snapshot. Earlier changes and their authors were not recorded.</p>}<ol>{detail.history.transactions.map(transaction => <Transaction key={transaction.id} transaction={transaction} state={state}/>)}</ol>{!detail.history.transactions.length && <p className="task-page-status">No visible history is available.</p>}{detail.history.nextBefore !== null && <div className="task-page-status"><button className="button" disabled={paging || !online || snapshot} onClick={() => void older()}>{paging ? 'Loading history…' : 'Load older history'}</button>{(!online || snapshot) && <p>Only loaded history is available offline.</p>}</div>}</section>
      </> : <section className="panel task-page-status"><p role="status">{loading ? 'Loading task history…' : 'Task information is unavailable. Reconnect and reload.'}</p><button className="button" disabled={loading} onClick={() => void load()}>Reload Task</button></section>}
      {canInteract ? <TaskComment key={id} taskId={id} online={online} mutate={mutate} saved={load}/> : <p className="info-strip">Read-only discussion. Interact access is required to add a comment.</p>}
    </div><aside className="right-column">{detail && <><Duplicates detail={detail} state={state} online={online && !snapshot} canEdit={canEdit} mutate={mutate} refresh={async () => { await refreshWorkspace(); await load(); }}/></>}{detail && <><Assignment detail={detail} state={state} online={online && !snapshot} canEdit={canEdit} mutate={mutate} saved={load}/><Subscribers task={detail.task} state={state} online={online && !snapshot} canEdit={canEdit} canInteract={canInteract} mutate={mutate} saved={load}/></>}{detail && <Dependencies detail={detail} state={state} online={online && !snapshot} canEdit={canEdit} mutate={mutate} saved={load}/>}</aside></div>
  </div>;
}

function Transaction({ transaction, state }: { transaction: TaskTransaction; state: AppState }) {
  const kind = { create: 'Created task', legacy: 'Retained legacy snapshot', edit: 'Edited task', comment: 'Commented', dependency: 'Changed dependency', dependency_status: 'Related task status changed', subscription: 'Following changed', merge: 'Merged duplicate' }[transaction.kind];
  return <li className={`task-transaction transaction-${transaction.kind}`}><header><strong>{transaction.actor || 'Unknown (legacy)'}</strong><span>{kind}</span><small>{date(transaction.createdAt)} · Task version {transaction.taskVersion}</small></header>
    {transaction.comment !== undefined && <p className="task-comment-body">{transaction.comment}</p>}
    {transaction.snapshot && <details className="task-baseline"><summary>{transaction.kind === 'legacy' ? 'View retained snapshot' : 'View original task fields'}</summary><dl><dt>Title</dt><dd>{transaction.snapshot.title}</dd><dt>Status</dt><dd>{text(transaction.snapshot.status)}</dd><dt>Priority</dt><dd>{text(transaction.snapshot.priority)}</dd><dt>Project</dt><dd>{transaction.snapshot.projectId || 'None'}</dd><dt>Owner</dt><dd>{member(transaction.snapshot.ownerId, state, transaction.snapshot.ownerId === undefined ? 'Not recorded' : 'Unassigned')}</dd><dt>Author</dt><dd>{member(transaction.snapshot.authorId, state, 'Unknown (legacy)')}</dd><dt>Description</dt><dd><pre>{transaction.snapshot.description}</pre></dd></dl></details>}
    {transaction.changes?.map(change => <FieldChange key={change.field} change={change} state={state}/>)}
    {transaction.subscription && <p>{member(transaction.subscription.principalId, state)} {transaction.subscription.newState === 'subscribed' ? 'started following' : 'stopped following'} this task{transaction.subscription.reason === 'created' ? ' after creating it' : transaction.subscription.reason === 'commented' ? ' after commenting' : transaction.subscription.reason === 'former_owner' ? ' after reassignment' : transaction.subscription.reason === 'merged' ? ' through a duplicate merge' : ''}.</p>}
    {transaction.merge && <p>{transaction.merge.direction === 'merged_into' ? 'Closed as a duplicate of' : 'Merged duplicate from'} <a href={`#${transaction.merge.taskId}`}>{transaction.merge.taskId}</a>. The original task and its history remain readable.</p>}
    {transaction.dependency && <p>{transaction.dependency.direction === 'depends_on' ? 'Dependency' : 'Dependent task'} {transaction.dependency.action}: <a href={`#${transaction.dependency.taskId}`}>{transaction.dependency.taskId}</a>.</p>}
    {transaction.dependencyStatus && <p><a href={`#${transaction.dependencyStatus.taskId}`}>{transaction.dependencyStatus.taskId}</a> changed from <strong>{text(transaction.dependencyStatus.oldStatus)}</strong> to <strong>{text(transaction.dependencyStatus.newStatus)}</strong>. This does not change this task’s status.</p>}
  </li>;
}
function FieldChange({ change, state }: { change: TaskFieldChange; state: AppState }) {
  const before = change.oldValueHidden ? 'Hidden by access rules' : change.oldValue;
  const after = change.newValueHidden ? 'Hidden by access rules' : change.newValue;
  const [expanded, setExpanded] = useState(false);
  const changes = useMemo(() => expanded && change.field === 'description' && !change.oldValueHidden && !change.newValueHidden ? diffWordsWithSpace(before || '', after || '', { timeout: 100, maxEditLength: 4000 }) : null, [change, before, after, expanded]);
  const display = (value: string | null) => change.field === 'ownerId' ? member(value, state) : value === null ? 'None' : change.field === 'status' || change.field === 'priority' ? text(value) : value;
  return <div className="task-field-change"><h4>{labels[change.field]}</h4><div className="task-change-values"><div><strong>Previous</strong><pre>{display(before)}</pre></div><div><strong>New</strong><pre>{display(after)}</pre></div></div>{change.field === 'description' && <details onToggle={event => setExpanded(event.currentTarget.open)}><summary>Show description diff</summary>{changes ? <pre className="task-description-diff">{changes.map((part, index) => part.added ? <ins key={index}>{part.value}</ins> : part.removed ? <del key={index}>{part.value}</del> : <span key={index}>{part.value}</span>)}</pre> : <p>Read the complete old and new descriptions above. An interactive diff is unavailable.</p>}</details>}</div>;
}
function Dependencies({ detail, state, online, canEdit, mutate, saved }: { detail: TaskDetail; state: AppState; online: boolean; canEdit: boolean; mutate: Mutate; saved: () => Promise<void> }) {
  const [chosen, setChosen] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const candidates = state.tasks.filter(task => task.id !== detail.task.id && !detail.dependsOn.some(item => item.id === task.id));
  const change = async (taskId: string, action: 'add' | 'remove') => {
    if (!online || !canEdit || busy) return;
    setBusy(true); setError('');
    try { await mutate(`/api/tasks/${detail.task.id}/dependencies`, 'POST', { taskId, action, expectedVersion: detail.task.version }, action === 'add' ? 'Dependency added' : 'Dependency removed', false); setChosen(''); await saved(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not change this dependency.'); await saved(); } finally { setBusy(false); }
  };
  const links = (items: TaskReference[], remove: boolean) => items.length ? <ul className="task-dependencies">{items.map(item => <li key={item.id}><div><a href={`#${item.id}`}><strong>{item.id}</strong> {item.title}</a><span className={`badge badge-${item.status}`}>{text(item.status)}</span></div>{remove && canEdit && <button className="text-button" disabled={!online || busy} onClick={() => void change(item.id, 'remove')} aria-label={`Remove dependency ${item.id}`}>Remove</button>}</li>)}</ul> : <p className="muted small">No visible tasks in this list.</p>;
  return <section className="panel task-dependency-panel"><div className="panel-heading"><h2>Visible dependencies</h2></div><div className="card-body"><p className="muted small">Relationships track work you depend on. Changing a related task never automatically closes this task.</p><h3>Depends on</h3>{links(detail.dependsOn, true)}<h3>Blocks</h3>{links(detail.blocks, false)}{canEdit && <form onSubmit={event => { event.preventDefault(); if (chosen) void change(chosen, 'add'); }}><label className="field"><span>Task to depend on</span><select aria-label="Task to depend on" value={chosen} disabled={!online || busy} onChange={event => setChosen(event.target.value)}><option value="">Choose a task…</option>{candidates.map(task => <option key={task.id} value={task.id}>{task.id}: {task.title}</option>)}</select></label><button className="button" disabled={!online || busy || !candidates.some(task => task.id === chosen)}><Plus size={14}/>Add Dependency</button></form>}{!online && canEdit && <p className="muted small">Reconnect to change dependencies.</p>}{error && <p className="error-text" role="alert">{error}</p>}</div></section>;
}

type EditableTaskField = Exclude<TaskField, 'ownerId'>;
type TaskDraft = { title: string; description: string; status: TaskStatus; priority: Priority; projectId: string | null; expectedVersion: number; changed: EditableTaskField[] };
function fields(task: Task): TaskDraft { return { title: task.title, description: task.description, status: task.status, priority: task.priority, projectId: task.projectId, expectedVersion: task.version, changed: [] }; }
function TaskEditor({ task, state, online, mutate, saved }: { task: Task; state: AppState; online: boolean; mutate: Mutate; saved: (close: boolean) => Promise<void> }) {
  const { readStored, writeStored, removeStoredIfEqual, draftIsHeld, durable, assertActive } = useWorkspace();
  const key = `task-draft:${task.id}`;
  const [draft, setDraft] = useState<TaskDraft>(() => readStored(key, fields(task)));
  const [persisted, setPersisted] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const mounted = useRef(true); const latest = useRef(draft); latest.current = draft;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const held = draftIsHeld(key);
  const wasHeld = useRef(held);
  useEffect(() => { if (wasHeld.current && !held) { const next = fields(task); latest.current = next; setDraft(next); setError(''); } wasHeld.current = held; }, [held]);
  const update = (patch: Partial<Pick<TaskDraft, EditableTaskField>>) => { const next = { ...latest.current, ...patch, changed: [...new Set([...(latest.current.changed || []), ...Object.keys(patch) as EditableTaskField[]])] }; latest.current = next; setDraft(next); setPersisted(writeStored(key, next)); };
  const submit = async () => {
    if (held || busy || !draft.title.trim() || !draft.changed?.length || !Number.isSafeInteger(draft.expectedVersion)) return;
    const submitted = { ...draft }; setBusy(true); setError('');
    try {
      const payload: UpdateTaskInput = { expectedVersion: submitted.expectedVersion };
      for (const field of submitted.changed) Object.assign(payload, { [field]: submitted[field] });
      await mutate<Task>(`/api/tasks/${task.id}`, 'PATCH', payload, 'Task updated'); assertActive();
      const cleared = removeStoredIfEqual(key, submitted);
      await saved(mounted.current && cleared && JSON.stringify(latest.current) === JSON.stringify(submitted));
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not save this task.'); } finally { if (mounted.current) setBusy(false); }
  };
  return <section className="panel task-editor"><div className="panel-heading"><h2>Edit task</h2><span>Based on version {draft.expectedVersion}</span></div><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="card-body">{draft.expectedVersion !== task.version && <p className="info-strip">This draft was written against version {draft.expectedVersion}; the task is now version {task.version}. Export or compare your draft before starting from the current task. Saving will never silently overwrite a newer version.</p>}{held && <p className="info-strip">This draft is set aside for export or discard. Clear its recovery copy before starting another edit here.</p>}<fieldset disabled={busy || held}><label className="field"><span>Task title</span><input aria-label="Task title" required maxLength={240} value={draft.title} onChange={event => update({ title: event.target.value })}/></label><label className="field"><span>Task description</span><textarea aria-label="Task description" rows={8} value={draft.description} onChange={event => update({ description: event.target.value })}/></label><div className="form-row"><label className="field"><span>Task status</span><select aria-label="Task status" value={draft.status} onChange={event => update({ status: event.target.value as TaskStatus })}>{['open', 'in_progress', 'resolved'].map(value => <option key={value} value={value}>{text(value)}</option>)}{(draft.status === 'duplicate' || task.status === 'duplicate') && <option value="duplicate" disabled={task.status !== 'duplicate'}>Duplicate</option>}</select></label><label className="field"><span>Task priority</span><select aria-label="Task priority" value={draft.priority} onChange={event => update({ priority: event.target.value as Priority })}>{['low', 'normal', 'high', 'urgent'].map(value => <option key={value} value={value}>{text(value)}</option>)}</select></label></div><label className="field"><span>Task project</span><select aria-label="Task project" value={draft.projectId || ''} onChange={event => update({ projectId: event.target.value || null })}><option value="">No project</option>{draft.projectId && !state.projects.some(project => project.id === draft.projectId) && <option value={draft.projectId}>Unavailable project — choose another</option>}{state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></fieldset>{error && <p className="error-text" role="alert">{error}</p>}<p className={persisted ? 'muted small' : 'error-text small'}>{persisted ? durable ? 'Draft changes stay on this device with their original task version.' : 'Draft changes stay in this tab only.' : 'Browser storage could not save this draft. Keep it open or export it.'}</p><div className="task-form-actions"><button type="button" className="button" onClick={() => download(draft, `${task.id}-draft.json`)}>Export Draft</button><button type="button" className="button" disabled={busy || held} onClick={() => { if (!window.confirm('Discard this unsaved task draft and start from the current task? Export it first to keep a copy.')) return; if (!removeStoredIfEqual(key, draft)) { setError('Could not clear this draft. Export it before trying again.'); return; } const next = fields(task); latest.current = next; setDraft(next); setError(''); }}>Start from Current Task</button><button className="button primary" disabled={busy || held || (!online && !durable) || !draft.title.trim() || !draft.changed?.length || !Number.isSafeInteger(draft.expectedVersion)}>{busy ? 'Saving…' : 'Save Task'}</button></div></div></form></section>;
}
function TaskComment({ taskId, online, mutate, saved }: { taskId: string; online: boolean; mutate: Mutate; saved: () => Promise<void> }) {
  const { readStored, writeStored, removeStoredIfEqual, draftIsHeld, durable, assertActive } = useWorkspace();
  const key = `task-comment:${taskId}`;
  const [body, setBody] = useState(() => readStored(key, { body: '' }).body); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [persisted, setPersisted] = useState(true);
  const latest = useRef(body); latest.current = body; const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const held = draftIsHeld(key);
  const wasHeld = useRef(held);
  useEffect(() => { if (wasHeld.current && !held) { latest.current = ''; setBody(''); setError(''); } wasHeld.current = held; }, [held]);
  const submit = async () => {
    if (held || busy || !body.trim()) return;
    const submitted = { body }; setBusy(true); setError('');
    try { await mutate<TaskTransaction>(`/api/tasks/${taskId}/comments`, 'POST', submitted, 'Task comment added'); assertActive(); const cleared = removeStoredIfEqual(key, submitted); if (mounted.current && cleared && latest.current === submitted.body) setBody(''); await saved(); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not save this comment.'); } finally { if (mounted.current) setBusy(false); }
  };
  return <section className="panel task-comment-form"><div className="panel-heading"><h2><MessageSquare size={17}/>Add a comment</h2></div><form className="card-body" onSubmit={event => { event.preventDefault(); void submit(); }}><label className="field"><span>Task comment</span><textarea aria-label="Task comment" required rows={4} maxLength={20000} value={body} disabled={busy || held} onChange={event => { const value = event.target.value; setBody(value); setPersisted(writeStored(key, { body: value })); }}/></label>{held && <p className="info-strip">This comment is set aside for export or discard.</p>}{error && <p className="error-text" role="alert">{error}</p>}<p className={persisted ? 'muted small' : 'error-text small'}>{persisted ? durable ? 'Comment draft stays on this device.' : 'Comment draft stays in this tab only.' : 'This comment is not stored. Keep it open or export it.'}</p><div className="task-form-actions">{body && <button type="button" className="button" onClick={() => download({ body }, `${taskId}-comment.json`)}>Export Comment</button>}<button className="button primary" disabled={busy || held || !body.trim() || (!online && !durable)}>{busy ? 'Saving…' : 'Add Task Comment'}</button></div></form></section>;
}

function Assignment({ detail, state, online, canEdit, mutate, saved }: { detail: TaskDetail; state: AppState; online: boolean; canEdit: boolean; mutate: Mutate; saved: () => Promise<void> }) {
  const { session } = useWorkspace();
  const selfId = state.currentPrincipalId || session?.state.account?.id || (session?.state.mode === 'local' ? `local:${session.state.workspaceId}` : '');
  const [chosen, setChosen] = useState(detail.task.ownerId || '');
  const [confirmation, setConfirmation] = useState<{ ownerId: string | null; expectedVersion: number } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => { setChosen(detail.task.ownerId || ''); }, [detail.task.ownerId]);
  const propose = (ownerId: string | null) => { setError(''); setConfirmation({ ownerId, expectedVersion: detail.task.version }); };
  const save = async () => {
    if (!confirmation || !canEdit || !online || busy) return;
    setBusy(true); setError('');
    try {
      const result = await mutate<TaskUpdateResult>(`/api/tasks/${detail.task.id}`, 'PATCH', confirmation, 'Assignment saved', false);
      setConfirmation(null);
      if (result && !('accessLost' in result)) await saved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not update this assignment.'); }
    finally { setBusy(false); }
  };
  return <section className="panel task-assignment-panel"><div className="panel-heading"><h2>Assignment</h2></div><div className="card-body"><p className="task-owner"><strong>{member(detail.task.ownerId, state)}</strong></p><p className="muted small">The owner automatically has view, edit, and interact access when the Space allows viewing. Assignment cannot grant access through a restricted Space.</p>{canEdit && <><label className="field"><span>Task owner</span><select aria-label="Task owner" value={chosen} disabled={!online || busy} onChange={event => { setChosen(event.target.value); setConfirmation(null); }}><option value="">Unassigned</option>{detail.task.ownerId && !state.principals.some(person => person.id === detail.task.ownerId && !person.disabled) && <option value={detail.task.ownerId} disabled>{member(detail.task.ownerId, state)}</option>}{state.principals.filter(person => !person.disabled).map(person => <option key={person.id} value={person.id}>{person.displayName} (@{person.username})</option>)}</select></label><div className="task-form-actions"><button className="button" disabled={!online || busy || chosen === (detail.task.ownerId || '')} onClick={() => propose(chosen || null)}>Change Owner</button>{selfId && detail.task.ownerId !== selfId && <button className="button" disabled={!online || busy} onClick={() => { setChosen(selfId); propose(selfId); }}>Assign to Me</button>}</div>{confirmation && <div className="task-assignment-confirmation" role="region" aria-label="Confirm assignment"><p>Change {detail.task.id} from <strong>{member(detail.task.ownerId, state)}</strong> to <strong>{member(confirmation.ownerId, state)}</strong>, based on version {confirmation.expectedVersion}?</p><p>Reassignment can remove your access. Other unsaved drafts will be set aside for export if access is lost. Field drafts keep their original version and may need a fresh edit afterward.</p><div className="task-form-actions"><button className="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel Assignment</button><button className="button primary" disabled={busy || !online} onClick={() => void save()}>{busy ? 'Saving…' : 'Confirm Assignment'}</button></div></div>}{!online && <p className="muted small">Reconnect to change ownership. Assignment is never queued offline.</p>}</>}{error && <p className="error-text" role="alert">{error}</p>}</div></section>;
}

function Subscribers({ task, state, online, canEdit, canInteract, mutate, saved }: { task: Task; state: AppState; online: boolean; canEdit: boolean; canInteract: boolean; mutate: Mutate; saved: () => Promise<void> }) {
  const { request, readStored, writeStored, taskSnapshotGeneration, unavailableObject } = useWorkspace();
  const key = `task:${task.id}:subscriptions`;
  const [page, setPage] = useState<TaskSubscriptionPage | null>(() => readStored(key, null));
  const [chosen, setChosen] = useState(''); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [warning, setWarning] = useState('');
  const mounted = useRef(true); const requests = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requests.current++; }; }, []);
  const load = useCallback(async (after?: string) => {
    const number = ++requests.current; const generation = taskSnapshotGeneration(); setLoading(true);
    try {
      const next = await request<TaskSubscriptionPage>(`/api/tasks/${task.id}/subscriptions${after ? `?after=${encodeURIComponent(after)}&limit=50` : ''}`);
      if (!mounted.current || requests.current !== number || generation !== taskSnapshotGeneration() || unavailableObject(task.id)) return;
      setPage(current => {
        const value = after && current ? { ...next, subscribers: [...new Map([...current.subscribers, ...next.subscribers].map(item => [item.principalId, item])).values()] } : next;
        if (!writeStored(key, value)) setWarning('The loaded following list could not be saved for offline reading.');
        return value;
      }); setError('');
    } catch (failure) { if (mounted.current && number === requests.current) setError(isNetworkError(failure) ? 'Reconnect to refresh the following list.' : failure instanceof Error ? failure.message : 'Could not load the following list.'); }
    finally { if (mounted.current && number === requests.current) setLoading(false); }
  }, [task.id]);
  useEffect(() => { if (online) void load(); }, [load, online, task.version, state.followingTaskIds.includes(task.id)]);
  const change = async (status: TaskSubscriptionStatus, action: 'subscribe' | 'unsubscribe') => {
    if (!online || busy) return;
    setBusy(true); setError('');
    try {
      await mutate<TaskSubscriptionStatus>(`/api/tasks/${task.id}/subscriptions`, 'POST', { principalId: status.principalId, action, expectedMembershipVersion: status.version }, action === 'subscribe' ? 'Following updated' : 'Following stopped', false);
      if (mounted.current) { setChosen(''); await load(); await saved(); }
    } catch (failure) { if (mounted.current) { setError(failure instanceof Error ? failure.message : 'Could not change following.'); } }
    finally { if (mounted.current) setBusy(false); }
  };
  const add = async () => {
    if (!chosen || !online || busy) return;
    setBusy(true); setError('');
    try {
      const status = await request<TaskSubscriptionStatus>(`/api/tasks/${task.id}/subscriptions/${encodeURIComponent(chosen)}`);
      if (!mounted.current) return;
      await mutate<TaskSubscriptionStatus>(`/api/tasks/${task.id}/subscriptions`, 'POST', { principalId: chosen, action: 'subscribe', expectedMembershipVersion: status.version }, 'Follower added', false);
      if (mounted.current) { setChosen(''); await load(); await saved(); }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not add this follower.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const subscribed = new Set(page?.subscribers.map(item => item.principalId));
  return <section className="panel task-subscribers"><div className="panel-heading"><h2>Following</h2><button className="text-button" disabled={!online || loading || busy} onClick={() => void load()}>Refresh Following</button></div><div className="card-body"><p className="muted small">Following records interest in this task. It does not grant access or send notifications yet. The owner follows automatically; creating or commenting starts following unless you previously opted out.</p>{page ? <><p className="task-following-status">{page.viewer.automatic ? 'You follow automatically as the owner.' : page.viewer.subscribed ? 'You are following this task.' : 'You are not following this task.'}</p><button className="button" disabled={!online || busy || loading || page.viewer.automatic} onClick={() => void change(page.viewer, page.viewer.subscribed ? 'unsubscribe' : 'subscribe')}>{page.viewer.subscribed ? 'Unfollow Task' : 'Follow Task'}</button>{page.viewer.automatic && <p className="muted small">Reassign the task before unfollowing as its owner.</p>}<ul className="task-followers">{page.subscribers.map(status => <li key={status.principalId}><span>{member(status.principalId, state)}{status.automatic && <small>Owner · automatic</small>}</span>{!status.automatic && (canEdit || status.principalId === page.viewer.principalId) && <button className="text-button" aria-label={`Remove follower ${member(status.principalId, state)}`} disabled={!online || busy || loading} onClick={() => void change(status, 'unsubscribe')}>Remove</button>}</li>)}</ul>{!page.subscribers.length && <p className="muted small">No followers are listed.</p>}{page.nextAfter && <button className="button" disabled={!online || loading || busy} onClick={() => void load(page.nextAfter!)}>Load more followers</button>}</> : <p className="muted small">{loading ? 'Loading following…' : 'No following list has been loaded.'}</p>}{(canInteract || canEdit) && <form onSubmit={event => { event.preventDefault(); void add(); }}><label className="field"><span>Member to follow task</span><select aria-label="Member to follow task" value={chosen} disabled={!online || busy || loading} onChange={event => setChosen(event.target.value)}><option value="">Choose a member…</option>{state.principals.filter(person => !person.disabled && !subscribed.has(person.id)).map(person => <option key={person.id} value={person.id}>{person.displayName} (@{person.username})</option>)}</select></label><button className="button" disabled={!online || busy || loading || !chosen}>Add Follower</button></form>}{!online && <p className="muted small">Loaded list only. Reconnect to follow or change members; these changes are never queued.</p>}{warning && <p className="error-text" role="status">{warning}</p>}{error && <p className="error-text" role="alert">{error} Refresh Following before trying again.</p>}</div></section>;
}

type MergeSelection = { mode: 'out' | 'in'; anchor: TaskReference; related: TaskReference[]; confirming: boolean };
function taskReference(task: Task): TaskReference { return { id: task.id, title: task.title, version: task.version, status: task.status, priority: task.priority }; }
function Duplicates({ detail, state, online, canEdit, mutate, refresh }: { detail: TaskDetail; state: AppState; online: boolean; canEdit: boolean; mutate: Mutate; refresh: () => Promise<void> }) {
  const [selection, setSelection] = useState<MergeSelection | null>(null);
  const [query, setQuery] = useState(''); const [includeClosed, setIncludeClosed] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const candidates = state.tasks.filter(task => task.id !== detail.task.id && state.access[task.id]?.capabilities.edit && (includeClosed || !isTaskClosed(task.status)) && `${task.id} ${task.title}`.toLowerCase().includes(query.toLowerCase()));
  const choose = (mode: 'out' | 'in') => { setSelection({ mode, anchor: taskReference(detail.task), related: [], confirming: false }); setQuery(''); setIncludeClosed(false); setError(''); };
  const toggle = (task: Task, selected: boolean) => setSelection(current => current ? { ...current, related: current.mode === 'out' ? [taskReference(task)] : selected ? [...current.related, taskReference(task)] : current.related.filter(item => item.id !== task.id), confirming: false } : current);
  const permitted = canEdit && selection?.related.every(task => state.access[task.id]?.capabilities.edit);
  const changed = selection && [selection.anchor, ...selection.related].some(task => state.tasks.find(current => current.id === task.id)?.version !== task.version);
  const submit = async () => {
    if (!selection || !selection.confirming || !selection.related.length || !online || !permitted || busy) return;
    const submitted = selection; setBusy(true); setError('');
    const body: TaskMergeInput | TaskMergeInInput = submitted.mode === 'out' ? { taskId: submitted.related[0]!.id, expectedVersion: submitted.anchor.version, expectedTargetVersion: submitted.related[0]!.version } : { sources: submitted.related.map(task => ({ taskId: task.id, expectedVersion: task.version })), expectedVersion: submitted.anchor.version };
    try {
      await mutate<TaskDetail>(`/api/tasks/${submitted.anchor.id}/${submitted.mode === 'out' ? 'merge' : 'merge-in'}`, 'POST', body, submitted.mode === 'out' ? 'Task closed as a duplicate. The original task remains readable.' : 'Duplicate tasks merged. Their original content and history remain readable.', false);
      if (mounted.current) { setSelection(null); await refresh(); }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not merge these tasks.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const references = (items: TaskReference[], label: string) => items.length > 0 && <><h3>{label}</h3><ul className="task-duplicate-links">{items.map(task => <li key={task.id}><a href={`#${task.id}`}>{task.id} {task.title}</a><span className={`badge badge-${task.status}`}>{text(task.status)}</span></li>)}</ul></>;
  const sources = selection ? selection.mode === 'out' ? [selection.anchor] : selection.related : [];
  const destination = selection ? selection.mode === 'out' ? selection.related[0] : selection.anchor : null;
  return <section className="panel task-duplicates"><div className="panel-heading"><h2>Duplicates</h2></div><div className="card-body">
    {references(detail.duplicateOf || [], 'Duplicate of')}{references(detail.duplicates || [], 'Merged duplicates')}
    {!detail.duplicateOf?.length && !detail.duplicates?.length && <p className="muted small">No visible duplicate relationships.</p>}
    {(detail.duplicateOf?.length || detail.duplicates?.length) ? <p className="muted small">Reopening a task keeps these recorded links. Duplicate relationships cannot be undone here.</p> : null}
    {canEdit && !selection && <div className="task-merge-actions"><button className="button" disabled={!online || busy} onClick={() => choose('out')}>Close As Duplicate</button><button className="button" disabled={!online || busy} onClick={() => choose('in')}>Merge Duplicates In</button></div>}
    {selection && <div className="task-merge-selection"><h3>{selection.mode === 'out' ? 'Choose the destination' : 'Choose duplicate tasks'}</h3><p className="muted small">{selection.anchor.id} is selected at version {selection.anchor.version}. Only tasks you can edit are listed.</p>
      {!selection.confirming ? <><label className="field"><span>Search merge tasks</span><input aria-label="Search merge tasks" value={query} disabled={busy} onChange={event => setQuery(event.target.value)}/></label><label className="checkbox"><input type="checkbox" checked={includeClosed} disabled={busy} onChange={event => setIncludeClosed(event.target.checked)}/>Include closed tasks</label><fieldset className="task-merge-candidates" disabled={!online || busy}><legend>{selection.mode === 'out' ? 'Destination task' : 'Source tasks'}</legend>{candidates.map(task => <label className="checkbox" key={task.id}><input type={selection.mode === 'out' ? 'radio' : 'checkbox'} name="merge-task" checked={selection.related.some(item => item.id === task.id)} disabled={selection.mode === 'in' && selection.related.length >= 100 && !selection.related.some(item => item.id === task.id)} onChange={event => toggle(task, event.target.checked)}/><span>{task.id} {task.title}<small>Version {task.version} · {text(task.status)}</small></span></label>)}{!candidates.length && <p className="muted small">No editable tasks match. Change the search or include closed tasks.</p>}</fieldset>{selection.related.length > 0 && <div className="task-merge-picked"><strong>Selected</strong>{selection.related.map(task => <p key={task.id}>{task.id} {task.title} · Version {task.version}<button className="text-button" aria-label={`Remove ${task.id} from merge`} onClick={() => setSelection(current => current ? { ...current, related: current.related.filter(item => item.id !== task.id) } : null)}>Remove</button></p>)}</div>}<button className="button primary" disabled={!online || busy || !permitted || !selection.related.length} onClick={() => setSelection({ ...selection, confirming: true })}>Review Merge</button></> : <div className="task-merge-confirmation" role="region" aria-label="Confirm duplicate merge"><h3>Review duplicate merge</h3><p><strong>Close as duplicate:</strong></p><ul>{sources.map(task => <li key={task.id}>{task.id} {task.title} · Version {task.version}</li>)}</ul><p><strong>Destination:</strong> {destination?.id} {destination?.title} · Version {destination?.version}</p><p>The destination gains each source’s author, owner, and followers as explicit followers, including members who previously opted out. Following does not grant access. Source descriptions, histories, owners, and dependencies stay in place.</p><p>The sources will close as duplicates and stay readable. These links cannot be undone; reopening keeps them. Unsaved field drafts keep their original versions and may conflict after this merge.</p><button className="button primary" disabled={!online || busy || !permitted || Boolean(changed)} onClick={() => void submit()}>{busy ? 'Merging…' : 'Confirm Duplicate Merge'}</button></div>}
      {changed && <p className="info-strip">A selected task has changed. The versions above have not been updated. Cancel and reload the task list before reviewing a new selection.</p>}{!permitted && <p className="info-strip">Editing access changed for a selected task. Cancel and reload before choosing again.</p>}
      <div className="task-form-actions"><button className="button" disabled={busy} onClick={() => { setSelection(null); setError(''); }}>Cancel Merge</button><button className="button" disabled={!online || busy} onClick={async () => { setSelection(null); setError(''); setBusy(true); try { await refresh(); } finally { if (mounted.current) setBusy(false); } }}>Cancel and Reload Tasks</button></div>
    </div>}
    {!online && canEdit && <p className="muted small">Reconnect to merge duplicates. Merges are never queued offline.</p>}{error && <p className="error-text" role="alert">{error} Cancel and reload before selecting newer versions.</p>}
  </div></section>;
}
