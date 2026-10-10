import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, History, MessageSquare, Pencil, Plus, RefreshCw } from 'lucide-react';
import { diffWordsWithSpace } from 'diff';
import type { AppState, Priority, Task, TaskDetail, TaskField, TaskFieldChange, TaskHistory, TaskReference, TaskStatus, TaskTransaction, UpdateTaskInput } from '../shared/types';
import { isNetworkError, type MutationMethod } from './offline';
import { useWorkspace } from './SessionGate';
import { AccessSummary } from './Access';

type Mutate = <T>(path: string, method: MutationMethod, body: unknown, label: string, allowQueue?: boolean) => Promise<T | null>;
const labels: Record<string, string> = { open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent', title: 'Title', description: 'Description', status: 'Status', priority: 'Priority', projectId: 'Project' };
function date(value: string) { return new Date(value).toLocaleString(); }
function text(value: string | null) { return value === null ? 'None' : labels[value] || value; }
function download(value: unknown, filename: string) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function TaskPage({ id, state, online, mutate, manageAccess }: { id: string; state: AppState; online: boolean; mutate: Mutate; manageAccess: () => void }) {
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
      {detail ? <><section className="panel"><div className="panel-heading"><h2>Description</h2><button className="text-button" disabled={loading} onClick={() => void load()}><RefreshCw size={14}/>Reload Task</button></div><pre className="task-detail-description">{detail.task.description || 'No description yet.'}</pre><dl className="metadata task-metadata"><dt>Project</dt><dd>{state.projects.find(project => project.id === detail.task.projectId)?.name || (detail.task.projectId ? 'Unavailable project' : 'None')}</dd><dt>Created</dt><dd>{date(detail.task.createdAt)}</dd><dt>Updated</dt><dd>{date(detail.task.updatedAt)}</dd></dl></section>
      <section className="panel task-history"><div className="panel-heading"><h2><History size={17}/>Task history</h2></div><p className="info-strip">Saved field changes, comments, and dependency changes form an append-only history.</p>{detail.history.transactions.some(item => item.kind === 'legacy') && <p className="info-strip">This task has a retained legacy snapshot. Earlier changes and their authors were not recorded.</p>}<ol>{detail.history.transactions.map(transaction => <Transaction key={transaction.id} transaction={transaction}/>)}</ol>{!detail.history.transactions.length && <p className="task-page-status">No visible history is available.</p>}{detail.history.nextBefore !== null && <div className="task-page-status"><button className="button" disabled={paging || !online || snapshot} onClick={() => void older()}>{paging ? 'Loading history…' : 'Load older history'}</button>{(!online || snapshot) && <p>Only loaded history is available offline.</p>}</div>}</section>
      </> : <section className="panel task-page-status"><p role="status">{loading ? 'Loading task history…' : 'Task information is unavailable. Reconnect and reload.'}</p><button className="button" disabled={loading} onClick={() => void load()}>Reload Task</button></section>}
      {canInteract ? <TaskComment key={id} taskId={id} online={online} mutate={mutate} saved={load}/> : <p className="info-strip">Read-only discussion. Interact access is required to add a comment.</p>}
    </div><aside className="right-column">{detail && <Dependencies detail={detail} state={state} online={online && !snapshot} canEdit={canEdit} mutate={mutate} saved={load}/>}</aside></div>
  </div>;
}

function Transaction({ transaction }: { transaction: TaskTransaction }) {
  const kind = { create: 'Created task', legacy: 'Retained legacy snapshot', edit: 'Edited task', comment: 'Commented', dependency: 'Changed dependency', dependency_status: 'Related task status changed' }[transaction.kind];
  return <li className={`task-transaction transaction-${transaction.kind}`}><header><strong>{transaction.actor || 'Unknown (legacy)'}</strong><span>{kind}</span><small>{date(transaction.createdAt)} · Task version {transaction.taskVersion}</small></header>
    {transaction.comment !== undefined && <p className="task-comment-body">{transaction.comment}</p>}
    {transaction.snapshot && <details className="task-baseline"><summary>{transaction.kind === 'legacy' ? 'View retained snapshot' : 'View original task fields'}</summary><dl><dt>Title</dt><dd>{transaction.snapshot.title}</dd><dt>Status</dt><dd>{text(transaction.snapshot.status)}</dd><dt>Priority</dt><dd>{text(transaction.snapshot.priority)}</dd><dt>Project</dt><dd>{transaction.snapshot.projectId || 'None'}</dd><dt>Description</dt><dd><pre>{transaction.snapshot.description}</pre></dd></dl></details>}
    {transaction.changes?.map(change => <FieldChange key={change.field} change={change}/>)}
    {transaction.dependency && <p>{transaction.dependency.direction === 'depends_on' ? 'Dependency' : 'Dependent task'} {transaction.dependency.action}: <a href={`#${transaction.dependency.taskId}`}>{transaction.dependency.taskId}</a>.</p>}
    {transaction.dependencyStatus && <p><a href={`#${transaction.dependencyStatus.taskId}`}>{transaction.dependencyStatus.taskId}</a> changed from <strong>{text(transaction.dependencyStatus.oldStatus)}</strong> to <strong>{text(transaction.dependencyStatus.newStatus)}</strong>. This does not change this task’s status.</p>}
  </li>;
}
function FieldChange({ change }: { change: TaskFieldChange }) {
  const before = change.oldValueHidden ? 'Hidden by access rules' : change.oldValue;
  const after = change.newValueHidden ? 'Hidden by access rules' : change.newValue;
  const [expanded, setExpanded] = useState(false);
  const changes = useMemo(() => expanded && change.field === 'description' && !change.oldValueHidden && !change.newValueHidden ? diffWordsWithSpace(before || '', after || '', { timeout: 100, maxEditLength: 4000 }) : null, [change, before, after, expanded]);
  const display = (value: string | null) => value === null ? 'None' : change.field === 'status' || change.field === 'priority' ? text(value) : value;
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

type TaskDraft = { title: string; description: string; status: TaskStatus; priority: Priority; projectId: string | null; expectedVersion: number; changed: TaskField[] };
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
  const update = (patch: Partial<Pick<TaskDraft, TaskField>>) => { const next = { ...latest.current, ...patch, changed: [...new Set([...(latest.current.changed || []), ...Object.keys(patch) as TaskField[]])] }; latest.current = next; setDraft(next); setPersisted(writeStored(key, next)); };
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
  return <section className="panel task-editor"><div className="panel-heading"><h2>Edit task</h2><span>Based on version {draft.expectedVersion}</span></div><form onSubmit={event => { event.preventDefault(); void submit(); }}><div className="card-body">{draft.expectedVersion !== task.version && <p className="info-strip">This draft was written against version {draft.expectedVersion}; the task is now version {task.version}. Export or compare your draft before starting from the current task. Saving will never silently overwrite a newer version.</p>}{held && <p className="info-strip">This draft is set aside for export or discard. Clear its recovery copy before starting another edit here.</p>}<fieldset disabled={busy || held}><label className="field"><span>Task title</span><input aria-label="Task title" required maxLength={240} value={draft.title} onChange={event => update({ title: event.target.value })}/></label><label className="field"><span>Task description</span><textarea aria-label="Task description" rows={8} value={draft.description} onChange={event => update({ description: event.target.value })}/></label><div className="form-row"><label className="field"><span>Task status</span><select aria-label="Task status" value={draft.status} onChange={event => update({ status: event.target.value as TaskStatus })}>{['open', 'in_progress', 'resolved'].map(value => <option key={value} value={value}>{text(value)}</option>)}</select></label><label className="field"><span>Task priority</span><select aria-label="Task priority" value={draft.priority} onChange={event => update({ priority: event.target.value as Priority })}>{['low', 'normal', 'high', 'urgent'].map(value => <option key={value} value={value}>{text(value)}</option>)}</select></label></div><label className="field"><span>Task project</span><select aria-label="Task project" value={draft.projectId || ''} onChange={event => update({ projectId: event.target.value || null })}><option value="">No project</option>{draft.projectId && !state.projects.some(project => project.id === draft.projectId) && <option value={draft.projectId}>Unavailable project — choose another</option>}{state.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></fieldset>{error && <p className="error-text" role="alert">{error}</p>}<p className={persisted ? 'muted small' : 'error-text small'}>{persisted ? durable ? 'Draft changes stay on this device with their original task version.' : 'Draft changes stay in this tab only.' : 'Browser storage could not save this draft. Keep it open or export it.'}</p><div className="task-form-actions"><button type="button" className="button" onClick={() => download(draft, `${task.id}-draft.json`)}>Export Draft</button><button type="button" className="button" disabled={busy || held} onClick={() => { if (!window.confirm('Discard this unsaved task draft and start from the current task? Export it first to keep a copy.')) return; if (!removeStoredIfEqual(key, draft)) { setError('Could not clear this draft. Export it before trying again.'); return; } const next = fields(task); latest.current = next; setDraft(next); setError(''); }}>Start from Current Task</button><button className="button primary" disabled={busy || held || (!online && !durable) || !draft.title.trim() || !draft.changed?.length || !Number.isSafeInteger(draft.expectedVersion)}>{busy ? 'Saving…' : 'Save Task'}</button></div></div></form></section>;
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
