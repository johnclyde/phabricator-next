import RevisionTestPlan, { creationMetadataError, requiresTestPlan } from './RevisionTestPlan';
import { useEffect, useRef, useState } from 'react';
import type { AppState, RevisionDetail } from '../shared/types';
import { isGitObjectId, type GitImportInput } from '../shared/repositories';
import { projectDisplayName } from '../shared/projects';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';

interface ImportDraft { repositoryId: string; requestId: string; attempted: boolean; input: GitImportInput }
export function parseImportDraft(value: unknown, repositoryId: string): ImportDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as ImportDraft; const input = draft.input;
  if (draft.repositoryId !== repositoryId || typeof draft.requestId !== 'string' || typeof draft.attempted !== 'boolean' || !input || !isGitObjectId(input.commitId) || !['code', 'paper', 'document'].includes(input.kind) || typeof input.title !== 'string' || (input.summary !== undefined && typeof input.summary !== 'string') || (input.testPlan !== undefined && typeof input.testPlan !== 'string') || (input.projectId !== undefined && input.projectId !== null && typeof input.projectId !== 'string') || (input.draft !== undefined && typeof input.draft !== 'boolean')) return null;
  return { repositoryId, requestId: draft.requestId, attempted: draft.attempted, input: { commitId: input.commitId, kind: input.kind, title: input.title, ...(input.summary === undefined ? {} : { summary: input.summary }), ...(input.testPlan === undefined ? {} : { testPlan: input.testPlan }), ...(input.projectId === undefined ? {} : { projectId: input.projectId }), ...(input.draft === undefined ? {} : { draft: input.draft }) } };
}
const json = (value: unknown) => JSON.stringify(value);
function exportIntent(draft: ImportDraft) { const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${draft.repositoryId}-import-intent.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export default function RepositoryImport({ repositoryId, commitId, state, online, close, refreshWorkspace, opened }: { repositoryId: string; commitId: string; state: AppState; online: boolean; close: () => void; refreshWorkspace: () => Promise<void>; opened: (detail: RevisionDetail) => void }) {
  const { request, readStored, writeStored, removeStoredIfEqual, quarantinedDrafts, discardQuarantinedDraft, draftIsHeld, draftHasUnsavedMemory, isActive, unavailableObject, onAccessChange, durable } = useWorkspace();
  const key = `repository-import:${repositoryId}`;
  const [draft, setDraft] = useState<ImportDraft>(() => parseImportDraft(readStored(key, null), repositoryId) || { repositoryId, requestId: crypto.randomUUID(), attempted: false, input: { commitId, kind: 'code', title: '', summary: '', testPlan: '', projectId: null } });
  const latest = useRef(draft); latest.current = draft; const mounted = useRef(true);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [persisted, setPersisted] = useState(() => !draftHasUnsavedMemory(key));
  const heading = useRef<HTMLHeadingElement>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null); const [, accessChanged] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => onAccessChange(() => accessChanged(value => value + 1)), []);
  useEffect(() => { const frame = requestAnimationFrame(() => { if (!mounted.current) return; heading.current?.focus({ preventScroll: true }); heading.current?.closest('section')?.scrollIntoView({ block: 'start' }); }); return () => cancelAnimationFrame(frame); }, [recoveryKey]);
  const held = draftIsHeld(key); const recovery = quarantinedDrafts().filter(item => item.key.replace(/:unsaved-memory$/, '') === key);
  const active = () => mounted.current && isActive() && !unavailableObject(repositoryId);
  const wasHeld = useRef(false);
  useEffect(() => {
    if (held && !wasHeld.current && !recoveryKey) { const blank: ImportDraft = { repositoryId, requestId: crypto.randomUUID(), attempted: false, input: { commitId, kind: 'code', title: '', summary: '', testPlan: '', projectId: null } }; latest.current = blank; setDraft(blank); }
    wasHeld.current = held;
    if (recoveryKey && !busy && !recovery.some(item => item.key === recoveryKey)) close();
  }, [held, recoveryKey, recovery.length, busy]);
  const metadataError = draft.attempted ? null : creationMetadataError(draft.input, state);
  const canEdit = Boolean(state.access[repositoryId]?.capabilities.edit);
  const saveDraft = (next: ImportDraft) => { latest.current = next; setDraft(next); setPersisted(writeStored(key, next)); };
  const update = (patch: Partial<GitImportInput>) => { if (!active() || busy || draft.attempted || held) return; saveDraft({ ...draft, input: { ...draft.input, ...patch } }); };
  const same = (expected: ImportDraft) => active() && json(latest.current) === json(expected);
  const submit = async () => {
    if (!active() || !online || !canEdit || busy || !draft.input.title.length || metadataError || (held && !recoveryKey)) return;
    const original = structuredClone(draft); const submitted = { ...original, attempted: true };
    if (!recoveryKey) saveDraft(submitted); else { latest.current = submitted; setDraft(submitted); }
    setBusy(true); setError('');
    try {
      const result = await request<RevisionDetail>(`/api/repositories/${repositoryId}/import-revision`, { method: 'POST', id: submitted.requestId, body: submitted.input });
      if (!isActive()) return;
      if (result.revision.repositoryId !== repositoryId || !result.versions.some(version => version.gitSource?.repositoryId === repositoryId && version.gitSource.commitId === submitted.input.commitId)) throw new Error('The returned review does not match this import. Retain the request and retry it exactly.');
      const ownsResult = same(submitted) && (!recoveryKey || recovery.some(item => item.key === recoveryKey && json(parseImportDraft(item.value, repositoryId)) === json(original)));
      if (recoveryKey) { const record = quarantinedDrafts().find(item => item.key === recoveryKey); if (record && json(parseImportDraft(record.value, repositoryId)) === json(original)) await discardQuarantinedDraft(recoveryKey); }
      else { removeStoredIfEqual(key, submitted); removeStoredIfEqual(key, original); }
      await refreshWorkspace();
      // A submitted request may finish after this editor was closed, remounted,
      // replaced in another tab, or lost source access. It never owns that UI.
      if (ownsResult && same(submitted) && (recoveryKey || !readStored(key, null))) opened(result);
    } catch (failure) { if (active()) setError(isNetworkError(failure) ? 'The outcome is not confirmed. Retry this exact submitted import when connected; its request ID prevents a second review.' : failure instanceof Error ? failure.message : 'The import could not be confirmed. Keep this request for explicit retry.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const startOver = () => {
    if (!active() || busy || held) return;
    if (!window.confirm(draft.attempted ? 'This request may already have created a review. Export it before starting a different import. Start a new request with a new ID?' : 'Discard this import draft and start a new one for the currently selected commit?')) return;
    removeStoredIfEqual(key, draft); saveDraft({ repositoryId, requestId: crypto.randomUUID(), attempted: false, input: { commitId, kind: 'code', title: '', summary: '', testPlan: '', projectId: null } }); setError('');
  };
  return <section className="panel repository-import" aria-label="Import pinned commit as review"><div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Import as Review</h2><button className="button" onClick={close}>Close Import</button></div><div className="card-body">
    <p>Import the complete text tree at this exact commit. The server accepts every file or rejects the whole import; binary files, symbolic links, submodules and unsupported or oversized source are never silently omitted.</p>
    <p className="info-strip">The new review copies this repository’s access rules and Space. Viewing it continues to require source repository access, including after later edits. Importing never runs source or starts an AI review.</p>
    {held && !recoveryKey ? <><p className="banner warning">This import was set aside after access changed. Review a retained request explicitly before retrying it.</p>{recovery.map(item => { const retained = parseImportDraft(item.value, repositoryId); return retained && <button className="button" key={item.key} disabled={!online || !canEdit} onClick={() => { latest.current = retained; setDraft(retained); setRecoveryKey(item.key); setError(''); }}>Review Retained Import{item.key.endsWith(':unsaved-memory') ? ' (unsaved copy)' : ''}</button>; })}</> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>Pinned source: <code className="repository-commit-id">{draft.input.commitId}</code></p>
      <fieldset disabled={busy || draft.attempted || held}><label className="checkbox"><input type="checkbox" checked={Boolean(draft.input.draft)} onChange={event => update({ draft: event.target.checked })}/>Start as a draft before requesting review</label><label className="field"><span>Review kind</span><select aria-label="Review kind" value={draft.input.kind} onChange={event => update({ kind: event.target.value as GitImportInput['kind'] })}><option value="code">Code revision</option><option value="paper">Academic paper</option><option value="document">Document draft</option></select></label><label className="field"><span>Review title</span><input aria-label="Review title" required maxLength={255} value={draft.input.title} onChange={event => update({ title: event.target.value })}/></label><label className="field"><span>Review summary</span><textarea aria-label="Review summary" rows={3} maxLength={100000} value={draft.input.summary || ''} onChange={event => update({ summary: event.target.value })}/></label><RevisionTestPlan value={draft.input.testPlan || ''} required={requiresTestPlan(state)} change={testPlan => update({ testPlan })}/>{metadataError && <p className="small muted">{metadataError}</p>}<label className="field"><span>Review project</span><select aria-label="Review project" value={draft.input.projectId || ''} onChange={event => update({ projectId: event.target.value || null })}><option value="">No project</option>{draft.input.projectId && !state.projects.some(project => project.id === draft.input.projectId) && <option value={draft.input.projectId}>Unavailable selected project</option>}{state.projects.map(project => <option key={project.id} value={project.id}>{projectDisplayName(project)}</option>)}</select></label></fieldset>
      <p className="small muted">{draft.attempted ? 'The submitted input and request ID are fixed. Retry confirms that exact request; it does not select a newer branch head.' : 'This source commit stays pinned even if you browse another reference.'} {durable ? 'The import draft is retained on this device.' : 'The import draft is retained only in this signed-in tab.'}</p>
      {!persisted && <p className="banner warning" role="status">Browser storage could not save this draft. Keep this tab open and export the request before reloading or closing it.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="repository-import-actions"><button className="button primary" disabled={!online || !canEdit || busy || !draft.input.title.length || Boolean(metadataError)}>{busy ? 'Importing…' : draft.attempted ? 'Retry Exact Import' : 'Import Complete Commit'}</button><button className="button" type="button" onClick={() => exportIntent(draft)}>Export Import Request</button>{!held && <button className="button" type="button" disabled={busy} onClick={startOver}>Start New Import</button>}</div>
      {!online && <p className="info-strip">Import requires a connection. It is never added to the offline outbox.</p>}{!canEdit && <p className="info-strip">Import requires permission to edit the source repository.</p>}
    </form>}
  </div></section>;
}
