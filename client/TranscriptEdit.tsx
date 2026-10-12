import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RevisionDetail, RevisionVersion } from '../shared/types';
import type { DocxFileIdentity } from '../shared/docx';
import { createPassageAnchor } from '../shared/anchors';
import { createDocxPassageAnchor } from '../shared/docx-discussion';
import { applyTranscriptTextEdit, parseTranscriptEditInput, parseTranscriptEditOrigin, transcriptSourceEdit, validateTranscriptEditTarget, type TranscriptEditInput, type TranscriptEditOrigin, type TranscriptEditTarget } from '../shared/transcript-edit';
import { sourceSnapshotCanonical } from '../shared/source-snapshot';
import { useWorkspace } from './SessionGate';
import DraftAvailability from './DraftAvailability';
import TranscriptPicker from './TranscriptPicker';
import type { TranscriptSelection } from './transcript-source';
import { retainFileIntent, sameAssets } from './file-client';
import { sameDocxFile } from './docx-client';
import { SuggestionPreview } from './ReviewThreads';
import { onSessionLocked } from './session';
import { transcriptEditNarration, type RegisterTranscriptEdit, type TranscriptEditVoiceAction } from './transcript-edit-voice';

export interface TranscriptEditDraft {
  format: 'phabricator.transcript-edit-draft.v1'; revisionId: string;
  base: { id: string; number: number; contentHash: string };
  target: TranscriptEditTarget; replacement: string; message: string;
  origin: TranscriptEditOrigin | null; transcriptTitle: string; expectedAccessEpoch: number;
  sourceFile?: DocxFileIdentity;
}
export interface TranscriptEditRequest { id: string; body: TranscriptEditInput; draftKey: string; draft: TranscriptEditDraft; sourceFile?: DocxFileIdentity }
export const transcriptDraftKey = (id: string, versionId: string) => `transcript-edit-draft:${id}:${versionId}`;
const hashText = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const quote = (target: TranscriptEditTarget) => target.kind === 'text' ? target.anchor.quote : target.quote;
const failureText = (error: unknown) => error instanceof Error ? error.message : 'The transcript edit could not be completed.';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function draftValue(value: unknown, revisionId: string, version: RevisionVersion): TranscriptEditDraft | null {
  if (!record(value) || value.format !== 'phabricator.transcript-edit-draft.v1' || value.revisionId !== revisionId || !record(value.base) || value.base.id !== version.id || value.base.number !== version.number || value.base.contentHash !== version.contentHash || !Number.isSafeInteger(value.expectedAccessEpoch) || Number(value.expectedAccessEpoch) < 1 || typeof value.replacement !== 'string' || value.replacement.length > 20_000 || typeof value.message !== 'string' || value.message.length > 1000 || typeof value.transcriptTitle !== 'string' || value.transcriptTitle.length > 200 || !record(value.target)) return null;
  try {
    const target = value.target as unknown as TranscriptEditTarget;
    if (target.kind === 'text') { const anchor = createPassageAnchor(version, target.anchor.filePath, target.anchor); if (JSON.stringify(anchor) !== JSON.stringify(target.anchor)) return null; }
    else if (target.kind === 'docx') createDocxPassageAnchor(version, target);
    else return null;
    if (version.docx && (!record(value.sourceFile) || !sameDocxFile(version.docx.sourceFile, value.sourceFile as unknown as DocxFileIdentity))) return null;
    const origin = value.origin === null ? null : parseTranscriptEditOrigin(value.origin);
    return { format: value.format, revisionId, base: { id: version.id, number: version.number, contentHash: version.contentHash }, target: structuredClone(target), replacement: value.replacement, message: value.message, origin, transcriptTitle: value.transcriptTitle, expectedAccessEpoch: Number(value.expectedAccessEpoch), ...(version.docx ? { sourceFile: { ...version.docx.sourceFile } } : {}) };
  } catch { return null; }
}
function requestValue(value: unknown, revisionId: string): TranscriptEditRequest | null {
  if (!record(value) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.id) || typeof value.draftKey !== 'string' || !record(value.draft)) return null;
  try { const body = parseTranscriptEditInput(value.body); if (body.revisionId !== revisionId || value.draftKey !== transcriptDraftKey(revisionId, body.expectedVersionId)) return null; return { id: value.id, body, draftKey: value.draftKey, draft: value.draft as unknown as TranscriptEditDraft, ...(record(value.sourceFile) ? { sourceFile: value.sourceFile as unknown as DocxFileIdentity } : {}) }; } catch { return null; }
}
async function receiptVersion(detail: RevisionDetail, intent: TranscriptEditRequest, base: RevisionVersion): Promise<RevisionVersion> {
  const body = parseTranscriptEditInput(intent.body), digest = await hashText(JSON.stringify(body));
  const created = detail.versions?.find(item => item.revisionId === body.revisionId && item.number === body.expectedVersion + 1);
  if (detail.revision.id !== body.revisionId || !created || !created.id || !created.contentHash || created.message !== body.message || JSON.stringify(created.transcriptEdit) !== JSON.stringify(transcriptSourceEdit(body, digest))) throw new Error('The source receipt does not match this exact transcript edit. Keep the request for retry.');
  if (body.target.kind === 'text') {
    if (created.docx || JSON.stringify(created.files) !== JSON.stringify(applyTranscriptTextEdit(base, body)) || !sameAssets(created.assets, base.assets)) throw new Error('The saved source or figures differ from the exact preview. Keep the request for retry.');
  } else if (!created.docx || !base.docx || !intent.sourceFile || !sameDocxFile(created.docx.sourceFile, intent.sourceFile) || created.docx.sha256 === base.docx.sha256 || created.files.length) throw new Error('The Word receipt does not match the original file and new tracked package. Keep the request for retry.');
  if (await hashText(sourceSnapshotCanonical(created.files, created.assets, created.docx)) !== created.contentHash) throw new Error('The source receipt has an invalid immutable content identity. Keep the request for retry.');
  return created;
}
const ignoreRegistration: RegisterTranscriptEdit = () => {};
interface Props {
  detail: RevisionDetail; version: RevisionVersion; target?: TranscriptEditTarget | null;
  online: boolean; canEdit: boolean; current: boolean; accessEpoch: number | null;
  sourceContext: string; isSourceCurrent: () => boolean;
  register?: RegisterTranscriptEdit; close: () => void;
  completed: (detail: RevisionDetail, created: RevisionVersion) => Promise<void>;
}
export default function TranscriptEdit(props: Props) {
  return <DraftAvailability draftKey={transcriptDraftKey(props.detail.revision.id, props.version.id)}><DraftAvailability draftKey={`transcript-edit-request:${props.detail.revision.id}`}><TranscriptEditPanel {...props}/></DraftAvailability></DraftAvailability>;
}
function TranscriptEditPanel({ detail, version, target, online, canEdit, current, accessEpoch, sourceContext, isSourceCurrent, register = ignoreRegistration, close, completed }: Props) {
  const client = useWorkspace(), revisionId = detail.revision.id, key = transcriptDraftKey(revisionId, version.id), requestKey = `transcript-edit-request:${revisionId}`;
  const initial = client.readStored<unknown>(key, null);
  const makeDraft = (selected: TranscriptEditTarget): TranscriptEditDraft => ({ format: 'phabricator.transcript-edit-draft.v1', revisionId, base: { id: version.id, number: version.number, contentHash: version.contentHash }, target: structuredClone(selected), replacement: '', message: '', origin: null, transcriptTitle: '', expectedAccessEpoch: accessEpoch ?? client.session?.accessEpoch ?? 1, ...(version.docx ? { sourceFile: { ...version.docx.sourceFile } } : {}) });
  const [draft, setDraft] = useState<TranscriptEditDraft | null>(() => initial !== null ? draftValue(initial, revisionId, version) : target ? makeDraft(target) : null);
  const [raw, setRaw] = useState(initial), [pendingRaw, setPendingRaw] = useState<unknown>(() => client.readStored(requestKey, null));
  const [persisted, setPersisted] = useState(!client.draftHasUnsavedMemory(key)), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [preview, setPreview] = useState<TranscriptEditInput | null>(null);
  const mounted = useRef(true), present = useRef(true), sequence = useRef(0), busyRef = useRef(false), draftRef = useRef(draft), previewRef = useRef<TranscriptEditInput | null>(null), previewSource = useRef<string | null>(null), currentProps = useRef({ online, canEdit, current, accessEpoch, sourceContext, isSourceCurrent }); currentProps.current = { online, canEdit, current, accessEpoch, sourceContext, isSourceCurrent };
  const panel = useRef<HTMLElement>(null), draftWrites = useRef(0), draftChoice = useRef(0);
  const urls = useRef(new Set<string>()), pending = requestValue(pendingRaw, revisionId);
  const active = () => { try { client.assertActive(); return mounted.current && present.current && !client.unavailableObject(revisionId) && (!version.docx || !client.unavailableObject(version.docx.sourceFile.fileId)); } catch { return false; } };
  const authority = () => { const value = currentProps.current; return active() && value.canEdit && value.isSourceCurrent() && !client.draftIsHeld(key) && !client.draftIsHeld(requestKey); };
  const ready = () => { const value = currentProps.current; return authority() && value.current && value.online && value.accessEpoch !== null && value.accessEpoch === client.session?.accessEpoch && draftRef.current?.expectedAccessEpoch === value.accessEpoch; };
  const previewCurrent = () => Boolean(previewRef.current && previewSource.current === currentProps.current.sourceContext);
  const retire = () => { sequence.current++; previewRef.current = null; previewSource.current = null; if (mounted.current) setPreview(null); };
  const retainDraft = (value: TranscriptEditDraft, expected: unknown) => {
    const write = ++draftWrites.current;
    void client.retainTranscriptEditDraft(key, value, expected).then(status => {
      if (!active() || write !== draftWrites.current || JSON.stringify(draftRef.current) !== JSON.stringify(value)) return;
      setPersisted(status === 'saved' && !client.draftHasUnsavedMemory(key));
      if (status === 'memory') setNotice('Another view or browser storage prevented saving this copy. Your draft remains in this tab; export it before reload or lock.');
    }).catch(error => { if (active() && write === draftWrites.current) { setPersisted(false); setError(failureText(error)); } });
  };
  const update = (next: TranscriptEditDraft) => { if (!authority() || busyRef.current) return; if (next.replacement.length > 20000) { retire(); setError('The complete replacement exceeds 20,000 characters. It was not inserted or truncated.'); return; } window.dispatchEvent(new Event('transcript-edit-navigation')); retire(); draftChoice.current++; const previous = draftRef.current; draftRef.current = next; setDraft(next); setRaw(next); setNotice(''); retainDraft(next, previous); };
  const identity = () => JSON.stringify([revisionId, version.id, version.contentHash, currentProps.current.sourceContext, currentProps.current.accessEpoch, sequence.current, Boolean(previewRef.current), busyRef.current]);
  useEffect(() => {
    mounted.current = true; present.current = true;
    if (draftRef.current) { retainDraft(draftRef.current, initial); if (initial === null) setRaw(draftRef.current); }
    const frame = requestAnimationFrame(() => { if (authority()) { panel.current?.focus({ preventScroll: true }); panel.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); } });
    const changed = () => { retire(); setPendingRaw(client.readStored(requestKey, null)); };
    const storage = (event: StorageEvent) => { if (!event.key || [client.storageKey(key), client.storageKey(requestKey)].includes(event.key)) { changed(); setPersisted(!client.draftHasUnsavedMemory(key)); setNotice('Stored source-edit state changed in another view. Your draft remains in this tab; export it before reload if its browser copy differs. Prepare a fresh preview before saving.'); } };
    const hide = () => { present.current = false; retire(); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); };
    const show = () => { present.current = true; retire(); setPendingRaw(client.readStored(requestKey, null)); };
    const access = client.onAccessChange(changed), session = onSessionLocked(hide);
    window.addEventListener('storage', storage); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { mounted.current = false; draftWrites.current++; cancelAnimationFrame(frame); retire(); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); access(); session(); window.removeEventListener('storage', storage); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, [key]);
  useEffect(() => { retire(); }, [sourceContext, online, canEdit, accessEpoch]);
  // Discovering a newer head invalidates a fresh preview, but an exact submitted
  // request can still return its original receipt. Source/authority changes above
  // continue to retire the operation itself.
  useEffect(() => { previewRef.current = null; previewSource.current = null; setPreview(null); }, [current]);
  const exportValue = (value: unknown, suffix: string) => { if (!active()) return; const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); urls.current.add(url); const link = document.createElement('a'); link.href = url; link.download = `${revisionId}-transcript-${suffix}.json`; link.click(); setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000); };
  const prepare = async () => {
    if (!authority() || !draftRef.current || busyRef.current || pendingRaw !== null) return;
    const selected = structuredClone(draftRef.current), selectedContext = currentProps.current.sourceContext; retire(); const ticket = sequence.current; busyRef.current = true; setBusy('Preparing exact preview…'); setError('');
    try {
      if (!selected.origin) throw new Error('Choose an available local transcript draft first.');
      if (!ready()) throw new Error('Reconnect with current source and editing permissions before confirming this preview. Your draft remains retained.');
      const input = parseTranscriptEditInput({ format: 'phabricator.transcript-edit.v1', revisionId, expectedVersion: selected.base.number, expectedVersionId: selected.base.id, expectedContentHash: selected.base.contentHash, expectedAccessEpoch: selected.expectedAccessEpoch, target: selected.target, replacement: selected.replacement, message: selected.message, origin: { ...selected.origin, editedTextSha256: await hashText(selected.replacement) } });
      validateTranscriptEditTarget(version, input);
      if (!authority() || ticket !== sequence.current || selectedContext !== currentProps.current.sourceContext || !ready()) return;
      previewRef.current = input; previewSource.current = selectedContext; setPreview(input); setNotice('Exact preview ready. Saving sends only this replacement and client-reported provenance to the workspace server.');
    } catch (error) { if (active() && ticket === sequence.current) setError(failureText(error)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  };
  const send = async (retry?: TranscriptEditRequest) => {
    if (!authority() || !currentProps.current.online || busyRef.current) return;
    const input = retry?.body ?? previewRef.current;
    if (!input || (!retry && (!previewCurrent() || !ready() || pendingRaw !== null))) { setError('Prepare the current exact preview before saving.'); return; }
    const base = detail.versions.find(item => item.id === input.expectedVersionId && item.contentHash === input.expectedContentHash && item.number === input.expectedVersion);
    if (!base) { setError('The exact original source is unavailable. Export the retained request.'); return; }
    const intent: TranscriptEditRequest = retry ?? { id: crypto.randomUUID(), body: structuredClone(input), draftKey: key, draft: structuredClone(draftRef.current!), ...(version.docx ? { sourceFile: { ...version.docx.sourceFile } } : {}) };
    busyRef.current = true; setBusy('Saving transcript edit…'); setError(''); retire(); const ticket = sequence.current, operationEpoch = client.session?.accessEpoch;
    try {
      validateTranscriptEditTarget(base, intent.body);
      if (base.docx && (!intent.sourceFile || !sameDocxFile(base.docx.sourceFile, intent.sourceFile) || client.unavailableObject(intent.sourceFile.fileId))) throw new Error('The exact original Word file is unavailable. Export the retained request.');
      const retained = await retainFileIntent(client, requestKey, intent);
      if (active()) { setPendingRaw(retained.intent); if (!retained.persisted) setPersisted(false); }
      if (!retained.accepted) throw new Error('Another unconfirmed transcript edit is already retained. Export your draft and recover that exact request first.');
      if (!authority() || !currentProps.current.online || ticket !== sequence.current || (!retry && (!ready() || intent.body.expectedAccessEpoch !== client.session?.accessEpoch))) return;
      const response = await client.request<RevisionDetail>(`/api/revisions/${revisionId}/transcript-edits`, { method: 'POST', body: intent.body, id: intent.id }, intent.sourceFile ? [intent.sourceFile.fileId] : []);
      const created = await receiptVersion(response, intent, base); client.assertActive();
      const cleanupCurrent = () => authority() && ticket === sequence.current && operationEpoch === client.session?.accessEpoch;
      if (!cleanupCurrent()) return;
      await client.removeTranscriptEditStoredIfEqual(intent.draftKey, intent.draft, cleanupCurrent);
      if (!cleanupCurrent()) return;
      const requestRemoved = await client.removeTranscriptEditStoredIfEqual(requestKey, intent, cleanupCurrent);
      if (!cleanupCurrent()) return;
      if (!requestRemoved) throw new Error('The exact receipt was verified, but its retained request could not be cleared. Keep it for recovery; another copy was not overwritten.');
      setPendingRaw(client.readStored(requestKey, null)); setNotice(`Saved version ${created.number}. Previous acceptance no longer applies.`); await completed(response, created);
    } catch (error) { if (active() && ticket === sequence.current) setError(failureText(error)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  };
  const discard = async (request: boolean) => {
    if (!authority() || busyRef.current) return;
    const value = request ? pendingRaw : raw;
    if (value === null || !window.confirm(request ? 'Forget this request? A source version may already have been saved. Reload the revision before another save.' : 'Discard this retained transcript edit draft? Any submitted request stays separate.')) return;
    retire(); const ticket = sequence.current, epoch = client.session?.accessEpoch;
    const cleanupCurrent = () => authority() && ticket === sequence.current && epoch === client.session?.accessEpoch;
    busyRef.current = true; setBusy(request ? 'Forgetting the retained request…' : 'Discarding the retained draft…');
    try {
      const removed = await client.removeTranscriptEditStoredIfEqual(request ? requestKey : key, value, cleanupCurrent);
      if (!cleanupCurrent()) return;
      if (!removed) { setError('The retained copy changed in another view or could not be removed. It was kept for export.'); return; }
      if (request) setPendingRaw(client.readStored(requestKey, null));
      else { setRaw(null); setDraft(null); draftRef.current = null; close(); }
    } finally { busyRef.current = false; if (mounted.current) setBusy(''); }
  };
  const execute = (action: TranscriptEditVoiceAction) => {
    if (!authority()) return { text: 'This transcript edit is no longer available in the selected source.', identity: identity() };
    if (action === 'cancelTranscriptEdit') { retire(); setNotice('Confirmation canceled. The draft and any unconfirmed request were kept.'); return { text: 'Transcript edit confirmation canceled. Your draft and any unconfirmed request remain available.', identity: identity() }; }
    if (action === 'previewTranscriptEdit') { if (busyRef.current || pendingRaw !== null) return { text: 'Finish the current operation or recover the unconfirmed transcript edit first.', identity: identity() }; void prepare(); return { text: 'Preparing the exact transcript edit preview. Read the transcript edit when it is ready.', identity: identity() }; }
    if (action === 'readTranscriptEdit') return { text: pendingRaw !== null ? 'This transcript edit has an unconfirmed request. The server may already have saved it. Recover the exact request before preparing another edit.' : previewCurrent() ? transcriptEditNarration(previewRef.current!, true) : 'Prepare a current transcript edit preview first.', identity: identity() };
    if (!previewCurrent() || !ready() || busyRef.current || pendingRaw !== null) return { text: 'The exact preview is not ready for confirmation. Review the current source, replacement and permissions first.', identity: identity() };
    void send(); return { text: 'Saving the reviewed transcript edit. The version is not confirmed until the server receipt is checked.', identity: identity() };
  };
  const latest = useRef(execute); latest.current = execute;
  const context = identity();
  useLayoutEffect(() => { register({ revisionId, get identity() { return identity(); }, execute: action => latest.current(action) }); }, [context, register]);
  useLayoutEffect(() => () => register(null), [register]);
  const choose = (selection: TranscriptSelection) => { if (!draftRef.current) return; update({ ...draftRef.current, replacement: selection.replacement, origin: selection.origin, transcriptTitle: selection.title }); };
  const differs = Boolean(target && draft && JSON.stringify(target) !== JSON.stringify(draft.target));
  return <section ref={panel} tabIndex={-1} className="panel card-body transcript-source-edit" aria-label="Transcript source edit"><div className="file-actions"><h2>Replace passage with transcript · Version {version.number}</h2><button className="button" onClick={() => { window.dispatchEvent(new Event('transcript-edit-navigation')); retire(); close(); }}>Close transcript edit</button></div><p>The original version stays intact. This operation sends the replacement and client-reported provenance to the workspace server. Audio and the full original model transcript stay on this device.</p><p className="small muted">{client.durable ? 'Drafts and exact retry requests are retained in this browser for the local workspace.' : 'Drafts and exact retry requests stay only in this protected tab until sign-out, lock, or reload. Export unfinished work before leaving.'}</p>
    {error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}{busy && <p role="status">{busy}</p>}
    {!draft && <p className="banner warning">{raw !== null ? 'The retained transcript edit is malformed or belongs to another source. Export it before discarding it.' : 'Select an exact original passage to prepare an edit.'}</p>}
    {raw !== null && <div className="file-actions"><button className="button" onClick={() => exportValue(raw, 'draft')}>Export transcript edit draft</button><button className="button" disabled={Boolean(busy)} onClick={() => void discard(false)}>Discard transcript edit draft</button></div>}
    {differs && <div className="banner warning"><p>This retained draft targets another passage in this version. It has not been overwritten.</p><button className="button" disabled={Boolean(busy || pendingRaw)} onClick={() => { if (target && window.confirm('Replace this transcript edit draft with the newly selected passage? Export the existing draft first if you need it.')) update(makeDraft(target)); }}>Use newly selected passage</button></div>}
    {draft && <><p className="small muted">{draft.target.kind === 'text' ? draft.target.anchor.filePath : 'Supported Word passage'} · original version {draft.base.number} · {quote(draft.target).length.toLocaleString()} selected characters</p><pre className="transcript-target-quote" aria-label="Original transcript edit passage">{quote(draft.target)}</pre><TranscriptPicker key={JSON.stringify([sourceContext, draft.base, draft.target, draftChoice.current])} disabled={!authority() || Boolean(busy || pendingRaw)} choose={choose}/>{draft.origin && <p className="small muted">Chosen draft: {draft.transcriptTitle}. Editing this replacement does not change the saved transcript.</p>}<label className="field"><span>Transcript replacement</span><textarea aria-label="Transcript replacement" rows={6} value={draft.replacement} disabled={!authority() || Boolean(busy || pendingRaw)} onChange={event => update({ ...draft, replacement: event.target.value })}/></label><label className="field"><span>Transcript edit message</span><input aria-label="Transcript edit message" value={draft.message} maxLength={1000} disabled={!authority() || Boolean(busy || pendingRaw)} onChange={event => update({ ...draft, message: event.target.value })}/></label>{draft.replacement !== '' ? <SuggestionPreview original={quote(draft.target)} replacement={draft.replacement}/> : <p className="info-strip">Choose a transcript draft to preview a replacement. Empty transcription never deletes source.</p>}{draft.target.kind === 'docx' && <p className="small muted">Word replacements stay within one editable text run and support one line without tabs or line breaks. Saving records tracked deletion and insertion.</p>}
      {accessEpoch !== null && draft.expectedAccessEpoch !== accessEpoch && <div className="banner warning"><p>Editing permissions changed. This draft keeps its original source and replacement; review current permissions before preparing another preview.</p><button className="button" disabled={!authority() || !current || Boolean(busy || pendingRaw)} onClick={() => update({ ...draft, expectedAccessEpoch: accessEpoch })}>Review current edit permissions</button></div>}
      <div className="file-actions"><button className="button" disabled={!authority() || !current || !online || Boolean(busy || pendingRaw)} onClick={() => void prepare()}>Preview transcript edit</button><button className="button primary" disabled={!preview || !previewCurrent() || !ready() || Boolean(busy || pendingRaw)} onClick={() => void send()}>Save transcript edit</button><button className="button" onClick={() => { window.dispatchEvent(new Event('transcript-edit-navigation')); retire(); setNotice('Confirmation canceled. The draft was kept.'); }}>Cancel transcript edit confirmation</button></div><p className="small muted">Voice commands: preview transcript edit · read transcript edit · confirm transcript edit · cancel transcript edit. Only a current prepared preview can be confirmed.</p></>}
    {!current && <p className="banner warning">This draft belongs to a historical source. It cannot be saved onto a newer version; export it or select the current source and prepare another edit.</p>}{!online && <p className="info-strip">The draft is retained offline. Reconnect and preview and save explicitly. This edit never enters the automatic outbox.</p>}{!persisted && <p className="banner warning">This draft or request is only in this tab. Keep it open and export it.</p>}
    {pendingRaw !== null && <section className="transcript-request" aria-label="Unconfirmed transcript edit"><h3>Unconfirmed transcript edit</h3><p>The server may already have saved this edit. Its request ID, source, replacement and provenance stay fixed. Reconnecting never retries it.</p>{!pending && <p className="banner warning">The retained request is malformed or unsupported. Export it before forgetting it.</p>}<div className="file-actions"><button className="button" disabled={!pending || !authority() || !online || Boolean(busy)} onClick={() => { if (pending) void send(pending); }}>Retry exact transcript edit</button><button className="button" onClick={() => exportValue(pendingRaw, 'request')}>Export transcript edit request</button><button className="button" disabled={Boolean(busy)} onClick={() => void discard(true)}>Forget transcript edit request</button></div></section>}
  </section>;
}
export function TranscriptEditProvenance({ version }: { version: RevisionVersion }) {
  const edit = version.transcriptEdit; if (!edit) return null;
  return <details className="transcript-source-provenance"><summary>Transcript edit provenance</summary><p>This version records client-reported local transcription provenance. It is not AI review evidence or server verification of the audio or model output.</p><dl><dt>Original source</dt><dd>{edit.fromVersionId} · <code>{edit.fromContentHash}</code></dd><dt>Audio SHA-256</dt><dd><code>{edit.origin.audioSha256}</code> · {edit.origin.audioBytes} bytes</dd><dt>Transcript run</dt><dd>{edit.origin.runId}</dd><dt>Model</dt><dd>{edit.origin.modelId} · {edit.origin.modelRevision} · runtime {edit.origin.runtimeVersion}</dd><dt>Original / edited transcript SHA-256</dt><dd><code>{edit.origin.originalTextSha256}</code><br/><code>{edit.origin.editedTextSha256}</code></dd><dt>Operation SHA-256</dt><dd><code>{edit.inputSha256}</code></dd></dl></details>;
}
