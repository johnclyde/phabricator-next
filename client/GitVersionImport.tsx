import { useDraftRetention } from './draft-retention';
import { useEffect, useRef, useState } from 'react';
import type { RevisionDetail, RevisionVersion } from '../shared/types';
import { isGitObjectId, type GitRefs, type GitVersionImportInput } from '../shared/repositories';
import { useWorkspace } from './SessionGate';
import { isNetworkError } from './offline';

export interface GitVersionIntent { revisionId: string; repositoryId: string; requestId: string; attempted: boolean; input: GitVersionImportInput }
export function parseGitVersionIntent(value: unknown, revisionId: string, repositoryId: string): GitVersionIntent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as GitVersionIntent; const input = item.input;
  if (item.revisionId !== revisionId || item.repositoryId !== repositoryId || typeof item.requestId !== 'string' || !item.requestId || typeof item.attempted !== 'boolean' || !input || typeof input.commitId !== 'string' || (input.commitId.length > 256 || input.commitId.includes('\0')) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || typeof input.expectedVersionId !== 'string' || !input.expectedVersionId || typeof input.expectedContentHash !== 'string' || !input.expectedContentHash || typeof input.message !== 'string') return null;
  return { revisionId, repositoryId, requestId: item.requestId, attempted: item.attempted, input: { commitId: input.commitId, expectedVersion: input.expectedVersion, expectedVersionId: input.expectedVersionId, expectedContentHash: input.expectedContentHash, message: input.message } };
}
export function importedGitVersion(result: RevisionDetail, intent: GitVersionIntent): RevisionVersion | null {
  if (!result || result.revision?.id !== intent.revisionId || result.revision.repositoryId !== intent.repositoryId || !Array.isArray(result.versions)) return null;
  const base = result.versions.find(version => version.revisionId === intent.revisionId && version.number === intent.input.expectedVersion && version.id === intent.input.expectedVersionId && version.contentHash === intent.input.expectedContentHash);
  const version = result.versions.find(version => version.revisionId === intent.revisionId && version.number === intent.input.expectedVersion + 1);
  const source = version?.gitSource;
  if (!base || !version || typeof version.id !== 'string' || !version.id || typeof version.contentHash !== 'string' || !version.contentHash || version.message !== intent.input.message || !source || source.kind !== 'git' || source.scope !== 'complete-text-tree' || source.repositoryId !== intent.repositoryId || !['sha1', 'sha256'].includes(source.objectFormat) || source.commitId !== intent.input.commitId || !isGitObjectId(source.commitId, source.objectFormat) || !isGitObjectId(source.treeId, source.objectFormat)) return null;
  return version;
}
const json = (value: unknown) => JSON.stringify(value);
const sameRequest = (left: GitVersionIntent | null, right: GitVersionIntent) => Boolean(left && left.revisionId === right.revisionId && left.repositoryId === right.repositoryId && left.requestId === right.requestId && json(left.input) === json(right.input));
function exportIntent(value: GitVersionIntent) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${value.revisionId}-git-version-request.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export default function GitVersionImport({ revisionId, repositoryId, base, online, canEdit, canViewSource, close, saved, refreshWorkspace }: { revisionId: string; repositoryId: string; base: RevisionVersion; online: boolean; canEdit: boolean; canViewSource: boolean; close: () => void; saved: (version: RevisionVersion) => Promise<void>; refreshWorkspace: () => Promise<void> }) {
  const client = useWorkspace(); const { request, readStored, draftHasUnsavedMemory, draftIsHeld, savedDraftRecords, quarantinedDrafts, discardQuarantinedDraft, onAccessChange, isActive, unavailableObject, durable, storageKey } = client;
  const key = `revision-git-import:${revisionId}`;
  const blank = (version: RevisionVersion, commitId = ''): GitVersionIntent => ({ revisionId, repositoryId, requestId: crypto.randomUUID(), attempted: false, input: { commitId, expectedVersion: version.number, expectedVersionId: version.id, expectedContentHash: version.contentHash, message: '' } });
  const [draft, setDraft] = useState(() => parseGitVersionIntent(readStored(key, null), revisionId, repositoryId) || blank(base));
  const latest = useRef(draft); latest.current = draft; const mounted = useRef(true); const savedAtOpen = useRef(saved);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [persisted, setPersisted] = useState(() => !draftHasUnsavedMemory(key));
  const [recordKey, setRecordKey] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null); const [, changed] = useState(0); const wasHeld = useRef(false);
  const [refs, setRefs] = useState<GitRefs | null>(null); const [refChoice, setRefChoice] = useState(''); const [loadingRefs, setLoadingRefs] = useState(false);
  const retain = useDraftRetention(client, key, setPersisted);
  const operation = useRef(0), permission = useRef({ canEdit, canViewSource }); permission.current = { canEdit, canViewSource };
  const operationGuard = () => { const ticket = ++operation.current; let epoch = client.session?.accessEpoch; return Object.assign(() => active() && operation.current === ticket && client.session?.accessEpoch === epoch && permission.current.canEdit && permission.current.canViewSource, { bindReceipt: () => { epoch = client.session?.accessEpoch; } }); };
  const heading = useRef<HTMLHeadingElement>(null);
  const active = () => mounted.current && isActive() && !unavailableObject(revisionId) && !unavailableObject(repositoryId);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const sync = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(storageKey(key))) changed(value => value + 1); }; window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync); }, []);
  useEffect(() => onAccessChange(ids => { if (ids.includes(repositoryId) || ids.includes(revisionId)) { setRefs(null); setRefChoice(''); } changed(value => value + 1); }), []);
  useEffect(() => { const frame = requestAnimationFrame(() => { if (mounted.current) { heading.current?.focus({ preventScroll: true }); heading.current?.closest('section')?.scrollIntoView({ block: 'start' }); } }); return () => cancelAnimationFrame(frame); }, [recoveryKey, recordKey]);
  const held = draftIsHeld(recordKey || key); const recovery = quarantinedDrafts().filter(item => item.key.replace(/:unsaved-memory$/, '') === key || item.key.startsWith(`${key}:submitted:`));
  const submissions = savedDraftRecords(`${key}:submitted:`).flatMap(item => { const intent = parseGitVersionIntent(item.value, revisionId, repositoryId); return intent ? [{ ...item, intent }] : []; });
  useEffect(() => { if (held && !wasHeld.current && !recoveryKey) { const next = blank(base); latest.current = next; setDraft(next); } wasHeld.current = held; if (recoveryKey && !busy && !recovery.some(item => item.recoveryId === recoveryKey)) close(); }, [held, recoveryKey, recovery.length, busy]);
  const store = (next: GitVersionIntent) => { latest.current = next; setDraft(next); retain(next); };
  const update = (patch: Partial<GitVersionImportInput>) => { if (active() && !busy && !held && !draft.attempted) store({ ...draft, input: { ...draft.input, ...patch } }); };
  const same = (value: GitVersionIntent) => active() && json(latest.current) === json(value);
  const submit = async () => {
    if (!active() || !online || !canEdit || !canViewSource || busy || !isGitObjectId(draft.input.commitId) || !draft.input.message.trim() || (held && !recoveryKey)) return;
    const original = structuredClone(draft); const submitted = { ...original, requestId: original.attempted || recoveryKey ? original.requestId : crypto.randomUUID(), attempted: true };
    const submissionKey = `${key}:submitted:${submitted.requestId}`;
    const existingRaw = readStored(submissionKey, null); const existing = parseGitVersionIntent(existingRaw, revisionId, repositoryId);
    if (existingRaw && (!existing || !sameRequest(existing, submitted))) { setError('This request ID already belongs to a different submitted intent. Export this draft and explicitly review a new base.'); return; }
    const isCurrent = operationGuard(); setBusy(true); setError('');
    try {
      // Explicit recovery uses the already-retained exact record. Held records
      // remain quarantined until a matching receipt is verified; ordinary draft
      // retention must not bypass that hold or replace another recovery copy.
      const recovered = recoveryKey ? quarantinedDrafts().find(item => item.recoveryId === recoveryKey) : null;
      if (recoveryKey && (!recovered || !sameRequest(parseGitVersionIntent(recovered.value, revisionId, repositoryId), submitted))) throw new Error('The selected recovery copy changed. Review the retained request again before retrying.');
      const retention = recovered ? 'memory' : await client.retainDraft(submissionKey, submitted, existingRaw, isCurrent); if (!isCurrent()) return; if (retention === 'unavailable') throw new Error('This exact request cannot be retained under current access. Export it before retrying.');
      if (recoveryKey || recordKey) { latest.current = submitted; setDraft(submitted); setPersisted(retention === 'saved'); } else { store(submitted); if (retention !== 'saved') setPersisted(false); }
      const result = await request<RevisionDetail>(`/api/revisions/${revisionId}/import-git`, { method: 'POST', id: submitted.requestId, body: submitted.input }, [repositoryId]);
      isCurrent.bindReceipt(); if (!isCurrent()) return;
      const imported = importedGitVersion(result, submitted);
      if (!imported) throw new Error('The returned version does not match this request. Keep it for exact retry.');
      const ownsResult = same(submitted);
      // An attempt marker is not part of the immutable operation identity. A
      // first retry of an unsubmitted held draft may only update tab memory.
      for (const record of quarantinedDrafts()) if ((record.key.replace(/:unsaved-memory$/, '') === key || record.key.startsWith(`${key}:submitted:`)) && sameRequest(parseGitVersionIntent(record.value, revisionId, repositoryId), submitted)) { if (!isCurrent()) return; await discardQuarantinedDraft(record); }
      if (!isCurrent()) return; await client.removeRetainedDraftIfEqual(submissionKey, submitted, isCurrent); if (!isCurrent()) return;
      await client.removeRetainedDraftIfEqual(key, submitted, isCurrent); if (!isCurrent()) return; if (!recordKey && !recoveryKey) await client.removeRetainedDraftIfEqual(key, original, isCurrent); if (!isCurrent()) return;
      await refreshWorkspace();
      if (isCurrent() && ownsResult && same(submitted) && (recoveryKey || recordKey || !readStored(key, null))) { await savedAtOpen.current(imported); if (same(submitted)) close(); }
    } catch (failure) { if (active()) setError(isNetworkError(failure) ? 'The outcome is not confirmed. Retry the exact request when connected; its ID prevents a second version. Do not start a new request just to retry.' : failure instanceof Error ? failure.message : 'Import could not be confirmed. Keep the original request for retry.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const refreshBase = async () => {
    if (!active() || !online || busy || held || !canEdit || !canViewSource) return;
    if (!window.confirm('Start a new request using the review’s current version? This replaces the old intent and request ID. Export it first if its outcome is uncertain. Your unsaved source editor drafts stay intact.')) return;
    const original = structuredClone(draft), isCurrent = operationGuard(); setBusy(true); setError('');
    try { const detail = await request<RevisionDetail>(`/api/revisions/${revisionId}`); isCurrent.bindReceipt(); if (!isCurrent() || !same(original)) return; const current = detail.versions.find(version => version.number === detail.revision.currentVersion); if (!current || current.revisionId !== revisionId || detail.revision.id !== revisionId || detail.revision.repositoryId !== repositoryId) throw new Error('The current linked review version is unavailable.'); if (!recordKey) await client.removeRetainedDraftIfEqual(key, original, isCurrent); if (!isCurrent() || !same(original)) return; setRecordKey(null); store(blank(current, original.input.commitId)); setRefs(null); setRefChoice(''); if (isCurrent()) await refreshWorkspace(); }
    catch (failure) { if (active()) setError(failure instanceof Error ? failure.message : 'Could not refresh the review base.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const loadRefs = async () => { if (!active() || !online || loadingRefs) return; setLoadingRefs(true); setError(''); try { const next = await request<GitRefs>(`/api/repositories/${repositoryId}/refs`); if (active()) setRefs(next); } catch (failure) { if (active()) { setRefs(null); setError(failure instanceof Error ? failure.message : 'References unavailable. An exact submitted request can still be retried.'); } } finally { if (mounted.current) setLoadingRefs(false); } };
  const discardSubmission = async (record: { key: string; intent: GitVersionIntent }) => {
    if (!active() || busy || !window.confirm('Discard this submitted request? Its import may already have committed. Export it first if the outcome is uncertain. This does not undo any imported version.')) return;
    const isCurrent = operationGuard(); setBusy(true); try { await client.removeRetainedDraftIfEqual(record.key, record.intent, isCurrent); if (!isCurrent()) return; await client.removeRetainedDraftIfEqual(key, record.intent, isCurrent); if (!isCurrent()) return;
      if (sameRequest(latest.current, record.intent)) close(); else changed(value => value + 1);
    } finally { if (mounted.current) setBusy(false); }
  };
  const chosen = refs?.refs.find(ref => ref.name === refChoice);
  return <section className="panel repository-import" aria-label="Import Git as next version"><div className="panel-heading"><h2 ref={heading} tabIndex={-1}>Import Git as Next Version</h2><button className="button" onClick={close}>Close Git Import</button></div><div className="card-body">
    <p className="banner warning">Replace the complete source tree of this review. Files absent from the selected commit will be deleted in the new version. Every file must be supported text; the whole import is rejected if any file is unsupported. Existing source, comments and review evidence remain in their original versions.</p>
    <p>Source repository: <a href={`#${repositoryId}`}>{repositoryId}</a>. This review keeps its own access rules and Space. Importing resets acceptance, never runs source and never starts AI review. Unsaved source editor drafts are preserved separately.</p>
    {submissions.length > 0 && <div className="version-import-submissions"><h3>Submitted Version Imports</h3><p>Unconfirmed requests keep their own commit, review base and request ID, independently of newer drafts. Review one explicitly to retry it.</p>{submissions.map(item => <div className="repository-import-actions" key={item.key}><span>From version {item.intent.input.expectedVersion} · <code>{item.intent.input.commitId.slice(0, 12)}</code></span><button className="button" disabled={busy || !canEdit || !canViewSource} type="button" onClick={() => { latest.current = item.intent; setDraft(item.intent); setRecordKey(item.key); setRecoveryKey(null); setPersisted(!draftHasUnsavedMemory(item.key)); setError(''); }}>Review Submitted Version Import</button><button className="button" type="button" onClick={() => exportIntent(item.intent)}>Export Submitted Version Import</button><button className="button" disabled={busy} type="button" onClick={() => discardSubmission(item)}>Discard Submitted Version Import</button></div>)}</div>}
    {recovery.length > 0 && !recoveryKey && <><p className="info-strip">This request was set aside after access changed. Review a retained copy explicitly before retrying.</p>{recovery.map(item => { const value = parseGitVersionIntent(item.value, revisionId, repositoryId); return value && <button className="button" key={item.recoveryId} disabled={!online || !canEdit || !canViewSource} onClick={() => { latest.current = value; setDraft(value); setRecordKey(item.key.replace(/:unsaved-memory$/, '')); setRecoveryKey(item.recoveryId); setError(''); }}>Review Retained Version Import{item.key.endsWith(':unsaved-memory') ? ' (unsaved copy)' : ''}</button>; })}</>}
    {(!held || recoveryKey) && <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>Pinned review base: <strong>Version {draft.input.expectedVersion}</strong></p><p className="small muted">Snapshot <code className="repository-commit-id">{draft.input.expectedVersionId}</code> · Content <code className="repository-commit-id">{draft.input.expectedContentHash}</code></p>
      <fieldset disabled={busy || held || draft.attempted}><label className="field"><span>Git commit to import</span><input aria-label="Git commit to import" value={draft.input.commitId} onChange={event => update({ commitId: event.target.value.trim() })} spellCheck={false} required/></label><button className="button" type="button" disabled={!online || loadingRefs} onClick={() => void loadRefs()}>{loadingRefs ? 'Loading references…' : 'Load Source References'}</button>{refs && <div className="repository-ref-controls"><label className="field"><span>Source reference</span><select aria-label="Source reference" value={refChoice} onChange={event => setRefChoice(event.target.value)}><option value="">Choose a branch or tag</option>{refs.refs.map(ref => <option key={ref.name} value={ref.name} disabled={!ref.commitId}>{ref.name} · {ref.commitId?.slice(0, 12) || 'No commit'}</option>)}</select></label><button className="button" type="button" disabled={!chosen?.commitId} onClick={() => { if (chosen?.commitId) update({ commitId: chosen.commitId }); }}>Pin Selected Commit</button></div>}<label className="field"><span>Import message</span><input aria-label="Import message" value={draft.input.message} onChange={event => update({ message: event.target.value })} maxLength={2000} required/></label></fieldset>
      <p className="small muted">{draft.attempted ? 'Submitted commit, review base and request ID are fixed. Retry confirms exactly this request, including when source browsing is unavailable.' : 'Selecting a reference copies its full commit ID once. Later branch or review changes never update these pins automatically.'} {persisted && durable ? 'This intent is saved on this device.' : 'This intent stays only in this tab; export before leaving or signing out.'}</p>
      {!persisted && <p className="banner warning" role="status">This intent is only in this tab. Storage is unavailable or another saved copy changed; export it before reloading or closing.</p>}{error && <p className="error-text" role="alert">{error}</p>}
      <div className="repository-import-actions"><button className="button primary" disabled={!online || !canEdit || !canViewSource || busy || !isGitObjectId(draft.input.commitId) || !draft.input.message.trim()}>{busy ? 'Importing version…' : draft.attempted ? 'Retry Exact Version Import' : 'Replace Source with Git Commit'}</button><button className="button" type="button" onClick={() => exportIntent(draft)}>Export Version Import Request</button>{!held && <button className="button" type="button" disabled={!online || busy || !canEdit || !canViewSource} onClick={() => void refreshBase()}>Review Current Base</button>}</div>
      {!online && <p className="info-strip">Connect to import. This operation is never sent by the offline outbox.</p>}{(!canEdit || !canViewSource) && <p className="info-strip">Import requires edit access to this review and view access to its source repository.</p>}
    </form>}
  </div></section>;
}
