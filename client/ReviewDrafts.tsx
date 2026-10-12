import { intentValue, editValue, type EditDraft, type Intent } from './review-draft-model';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateCommentInput, CreateReplyInput, RevisionDetail, ReviewComment } from '../shared/types';
import { REVIEW_DRAFT_LIMITS, isReviewDraftId, isReviewDraftPreview, isReviewDraftSnapshot, reviewDraftPayload, reviewDraftSaveInput, reviewDraftDiscardInput, reviewDraftPublishInput, reviewDraftRequestCanonical, validReviewDraftResult, type ReviewDraftEntry, type ReviewDraftInput, type ReviewDraftOperationKind, type ReviewDraftPayload, type ReviewDraftPreview, type ReviewDraftSnapshot } from '../shared/review-drafts';
import { createDocxPassageAnchor } from '../shared/docx-discussion';
import { createPassageAnchor } from '../shared/anchors';
import { useWorkspace } from './SessionGate';
import { useDraftRetention } from './draft-retention';
import { retainFileIntent, digestBytes } from './file-client';
import { onSessionLocked, RequestError } from './session';
import DraftAvailability from './DraftAvailability';
import { SuggestionPreview } from './ReviewThreads';

export type PrivateReviewComposerEntry = { kind: 'comment'; comment: CreateCommentInput } | { kind: 'reply'; threadId: string; reply: CreateReplyInput };
export type StagePrivateReview = (entry: PrivateReviewComposerEntry, cleanup: { key: string; value: unknown }) => Promise<boolean>;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const failText = (error: unknown) => error instanceof Error ? error.message : 'The private review could not be saved.';
function exportReview(client: ReturnType<typeof useWorkspace>, id: string, value: unknown, suffix: string) {
  client.assertActive(); if (client.unavailableObject(id)) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${id}-private-review-${suffix}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sourceId(payload: ReviewDraftPayload) { return payload.kind === 'reply' ? payload.viewedVersionId : payload.versionId; }
function sourceHash(payload: ReviewDraftPayload) { return payload.kind === 'reply' ? payload.viewedContentHash : payload.contentHash; }
function sourceAvailable(detail: RevisionDetail | null, payload: ReviewDraftPayload): boolean {
  const version = detail?.versions.find(item => item.id === sourceId(payload) && item.contentHash === sourceHash(payload));
  if (!version) return false;
  if (payload.kind === 'reply') return Boolean(detail?.threads.some(item => item.id === payload.threadId));
  if (payload.kind === 'comment') try { if (payload.docxPassage) createDocxPassageAnchor(version, payload.docxPassage); if (payload.passage && payload.filePath) createPassageAnchor(version, payload.filePath, payload.passage); } catch { return false; }
  if (payload.kind === 'comment' && payload.filePath !== null) { const file = version.files.find(item => item.path === payload.filePath); if (!file || payload.passage && file.content.slice(payload.passage.start, payload.passage.end) !== payload.passage.quote || payload.line !== null && payload.line > file.content.split('\n').length) return false; }
  return true;
}
function publishedCommentMatches(detail: RevisionDetail | null, payload: ReviewDraftPayload, comment: ReviewComment): boolean {
  if (!detail || comment.body !== payload.body || comment.revisionId !== detail.revision.id) return false;
  if (payload.kind === 'reply') {
    const thread = detail.threads.find(item => item.id === payload.threadId), root = detail.comments.find(item => item.id === thread?.rootCommentId);
    return Boolean(root && comment.threadId === payload.threadId && comment.viewedVersionId === payload.viewedVersionId && comment.versionId === root.versionId && comment.filePath === root.filePath && comment.line === root.line && same(comment.anchor, root.anchor) && same(comment.docxAnchor, root.docxAnchor) && comment.suggestion === undefined);
  }
  if (comment.versionId !== payload.versionId || comment.threadId !== comment.id || comment.viewedVersionId !== undefined) return false;
  if (payload.kind === 'summary') return comment.filePath === null && comment.line === null && !comment.anchor && !comment.docxAnchor && !comment.suggestion;
  const version = detail.versions.find(item => item.id === payload.versionId && item.contentHash === payload.contentHash); if (!version) return false;
  try {
    const anchor = payload.passage && payload.filePath ? createPassageAnchor(version, payload.filePath, payload.passage) : undefined;
    const word = payload.docxPassage ? createDocxPassageAnchor(version, payload.docxPassage) : undefined;
    const line = anchor ? version.files.find(item => item.path === anchor.filePath)!.content.slice(0, anchor.start).split('\n').length : payload.line;
    return comment.filePath === payload.filePath && comment.line === line && same(comment.anchor, anchor) && same(comment.docxAnchor, word) && same(comment.suggestion, payload.suggestion);
  } catch { return false; }
}
function Payload({ payload, detail }: { payload: ReviewDraftPayload; detail: RevisionDetail | null }) {
  const version = detail?.versions.find(item => item.id === sourceId(payload));
  return <div className="private-review-payload"><p className="small muted">{payload.kind === 'summary' ? 'Review summary' : payload.kind === 'reply' ? `Reply to thread ${payload.threadId}` : payload.suggestion ? 'Suggested edit' : 'New thread'} · {payload.kind === 'reply' ? 'viewed ' : ''}version {version?.number ?? sourceId(payload)}{payload.kind === 'comment' && payload.filePath ? ` · ${payload.filePath}${payload.line ? `:${payload.line}` : ''}` : ''}{payload.kind === 'comment' && payload.docxPassage ? ' · exact Word passage' : ''}</p><details className="private-review-source"><summary>Exact source identity</summary><p>Version <code>{sourceId(payload)}</code></p><p>SHA-256 <code>{sourceHash(payload)}</code></p></details><pre className="private-review-body">{payload.body}</pre>{payload.kind === 'comment' && (payload.passage || payload.docxPassage) && <><h4>Original quotation</h4><blockquote className="thread-quotation">{(payload.passage || payload.docxPassage)!.quote}</blockquote></>}{payload.kind === 'comment' && payload.suggestion && payload.passage && <SuggestionPreview original={payload.passage.quote} replacement={payload.suggestion.replacement}/>}</div>;
}

/** The owner stays mounted while the inspected immutable source changes. */
export function useReviewDrafts({ id, detail, online, canInteract, refreshed }: { id: string; detail: RevisionDetail | null; online: boolean; canInteract: boolean; refreshed: () => Promise<unknown> }) {
  const client = useWorkspace(), requestKey = `review-draft-request:${id}`, cacheKey = `review-drafts:${id}`, principalId = client.session?.state.account?.id || `local:${client.session?.state.workspaceId}`;
  const [snapshot, setSnapshot] = useState<ReviewDraftSnapshot | null>(() => { const value = client.readStored(cacheKey, null); return isReviewDraftSnapshot(value, id, principalId) ? value : null; }), [preview, setPreview] = useState<ReviewDraftPreview | null>(null), [pending, setPending] = useState<Intent | null>(() => intentValue(client.readStored(requestKey, null), id, principalId));
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [expanded, setExpanded] = useState(false), [summaryOpen, setSummaryOpen] = useState(false), [verified, setVerified] = useState(false), [newSummary, setNewSummary] = useState<EditDraft | null>(null), [, refreshLocal] = useState(0);
  const mounted = useRef(false), generation = useRef(0), readGeneration = useRef(0), operation = useRef(false), current = useRef(snapshot), currentPreview = useRef(preview), currentDetail = useRef(detail), capability = useRef(canInteract), connected = useRef(online), sourceContext = useRef(''), refresh = useRef(refreshed), loadRef = useRef<() => Promise<void>>(async () => {});
  currentDetail.current = detail; capability.current = canInteract; connected.current = online; refresh.current = refreshed;
  const active = () => { try { client.assertActive(); return mounted.current && !client.unavailableObject(id); } catch { return false; } };
  const retirePreview = () => { currentPreview.current = null; setPreview(null); };
  const show = (value: ReviewDraftSnapshot | null) => { current.current = value; setSnapshot(value); };
  const syncPending = () => setPending(intentValue(client.readStored(requestKey, null), id, principalId));
  const load = useCallback(async () => {
    if (!active() || !connected.current) return;
    const ticket = ++readGeneration.current, epoch = client.session?.accessEpoch;
    setLoading(true); setError(''); setVerified(false); retirePreview();
    try {
      let result: unknown;
      try { result = await client.request<unknown>(`/api/revisions/${id}/review-drafts`); }
      catch (failure) { if (!(failure instanceof RequestError && failure.code === 'ACCESS_CHANGED') || !active() || ticket !== readGeneration.current || !connected.current) throw failure; result = await client.request<unknown>(`/api/revisions/${id}/review-drafts`); }
      if (!active() || ticket !== readGeneration.current) return;
      if (!isReviewDraftSnapshot(result, id, principalId) || result.accessEpoch !== client.session?.accessEpoch) throw new Error('The private review snapshot could not be verified. Reload private drafts.');
      show(result); setVerified(true); client.writeStored(cacheKey, result); syncPending();
    } catch (failure) { if (active() && ticket === readGeneration.current) { show(null); setError(failText(failure)); } }
    finally { if (mounted.current && ticket === readGeneration.current) setLoading(false); }
  }, [id, principalId]);
  loadRef.current = load;
  useEffect(() => {
    mounted.current = true; void load();
    const retire = () => { generation.current++; readGeneration.current++; retirePreview(); show(null); setLoading(false); setBusy(false); operation.current = false; if (active()) { syncPending(); queueMicrotask(() => { if (active()) void loadRef.current(); }); } };
    const offSnapshot = client.onTaskSnapshotChange(retire), offAccess = client.onAccessChange(retire), offSession = onSessionLocked(() => { generation.current++; readGeneration.current++; retirePreview(); show(null); setPending(null); setError(''); setNotice(''); });
    const focus = () => { if (!operation.current) void loadRef.current(); }, storage = (event: StorageEvent) => { if (event.key === null || event.key?.startsWith(client.storageKey('review-draft'))) { retirePreview(); syncPending(); } }, hide = () => { generation.current++; readGeneration.current++; operation.current = false; retirePreview(); show(null); setPending(null); setError(''); setNotice(''); setLoading(false); setBusy(false); }, resume = () => { if (active()) { syncPending(); void loadRef.current(); } };
    window.addEventListener('comparison-navigation', retirePreview); window.addEventListener('focus', focus); window.addEventListener('storage', storage); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', resume);
    return () => { mounted.current = false; generation.current++; readGeneration.current++; offSnapshot(); offAccess(); offSession(); window.removeEventListener('comparison-navigation', retirePreview); window.removeEventListener('focus', focus); window.removeEventListener('storage', storage); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', resume); };
  }, [load]);
  useEffect(() => { retirePreview(); setVerified(false); if (online) void loadRef.current(); }, [online]);
  useEffect(() => { retirePreview(); }, [detail?.revision.currentVersion, detail?.threadEvents.length, detail?.threads.map(thread => `${thread.id}:${thread.version}`).join('|'), canInteract]);
  const contextChanged = useCallback((value: string) => { if (sourceContext.current !== value) { sourceContext.current = value; retirePreview(); } }, []);
  const send = async (intent: Intent): Promise<boolean> => {
    if (!active() || !connected.current || operation.current || intent.kind !== 'discard' && !capability.current || client.draftIsHeld(requestKey)) return false;
    const ticket = generation.current; let epoch = client.session?.accessEpoch;
    const authorized = () => active() && generation.current === ticket && client.session?.accessEpoch === epoch;
    operation.current = true; setBusy(true); setError(''); setNotice(''); retirePreview();
    try {
      const retained = await retainFileIntent(client, requestKey, intent); if (!authorized()) return false; syncPending();
      if (!retained.accepted) throw new Error('An earlier private review request is still unconfirmed. Retry or export that exact request first.');
      if (!retained.persisted) setNotice('This request is only in this tab. Keep it open or export the request.');
      const path = `/api/revisions/${id}/review-drafts/${intent.kind === 'publish' ? 'publish' : `${intent.entryId}${intent.kind === 'discard' ? '/discard' : ''}`}`;
      const result = await client.request<unknown>(path, { method: intent.kind === 'save' ? 'PUT' : 'POST', body: intent.input, id: intent.id });
      const hash = await digestBytes(new TextEncoder().encode(reviewDraftRequestCanonical(intent.kind, intent.entryId, intent.input)));
      if (!validReviewDraftResult(result, id, intent.kind, intent.input, intent.entryId, principalId) || result.inputSha256 !== hash) throw new Error('The receipt did not match the exact private review request. Keep it for explicit retry.');
      if (result.kind === 'publish' && (intent.entries.length !== result.published.length || result.published.some((item, index) => { const entry = intent.entries[index]; return !entry || entry.id !== item.draftId || entry.version !== item.draftVersion || entry.payloadSha256 !== item.payloadSha256 || !publishedCommentMatches(currentDetail.current, entry.payload, item.comment); }))) throw new Error('The publication receipt did not match every original private entry. Keep the exact request for retry.');
      if (!active() || generation.current !== ticket || result.accessEpoch !== client.session?.accessEpoch) return false;
      epoch = client.session?.accessEpoch;
      if (intent.kind === 'save' && !sourceAvailable(currentDetail.current, (intent.input as { payload: ReviewDraftPayload }).payload)) return false;
      await client.removeRetainedDraftIfEqual(requestKey, intent, authorized);
      if (intent.cleanup) await client.removeRetainedDraftIfEqual(intent.cleanup.key, intent.cleanup.value, authorized);
      if (!authorized()) return false;
      syncPending(); setExpanded(true); setNotice(intent.kind === 'publish' ? 'Private review published. The exact comments are now in discussion.' : intent.kind === 'discard' ? 'Private draft discarded.' : 'Private draft saved. It has not been published.');
      await loadRef.current(); if (intent.kind === 'publish' && authorized()) await refresh.current();
      return authorized();
    } catch (failure) { if (active() && generation.current === ticket) { syncPending(); setExpanded(true); setError(failText(failure)); } return false; }
    finally { if (mounted.current && generation.current === ticket) { operation.current = false; setBusy(false); } }
  };
  const perform = (kind: ReviewDraftOperationKind, entryId: string | null, input: ReviewDraftInput, cleanup?: Intent['cleanup'], entries: ReviewDraftEntry[] = []) => send({ id: crypto.randomUUID(), revisionId: id, principalId, kind, entryId, input: clone(input), entries: clone(entries), ...(cleanup ? { cleanup: clone(cleanup) } : {}) });
  const stage: StagePrivateReview = async (entry, cleanup) => {
    if (!verified || !current.current || current.current.accessEpoch !== client.session?.accessEpoch || pending || !active()) throw new Error('Reload private drafts before saving a private comment. Existing local text is retained.');
    const versionId = entry.kind === 'comment' ? entry.comment.versionId : entry.reply.viewedVersionId, version = currentDetail.current?.versions.find(item => item.id === versionId);
    if (!version) throw new Error('The exact source version is unavailable. Your local draft is retained.');
    const payload = reviewDraftPayload(entry.kind === 'comment' ? { kind: 'comment', ...entry.comment, contentHash: version.contentHash, filePath: entry.comment.filePath ?? null, line: entry.comment.line ?? null } : { kind: 'reply', ...entry.reply, threadId: entry.threadId, viewedContentHash: version.contentHash });
    return perform('save', crypto.randomUUID(), { expectedEntryVersion: 0, expectedAccessEpoch: current.current.accessEpoch, payload }, cleanup);
  };
  const prepare = async () => {
    if (!active() || !online || busy || pending || !canInteract) return;
    const ticket = generation.current, context = sourceContext.current, epoch = client.session?.accessEpoch, readTicket = ++readGeneration.current;
    setLoading(true); setError(''); setVerified(false); retirePreview();
    try {
      const result = await client.request<unknown>(`/api/revisions/${id}/review-drafts/preview`);
      if (!active() || ticket !== generation.current || context !== sourceContext.current || epoch !== client.session?.accessEpoch || readTicket !== readGeneration.current) return;
      if (!isReviewDraftPreview(result, id, principalId) || result.accessEpoch !== epoch || result.entries.some(entry => !sourceAvailable(currentDetail.current, entry.payload)) || !isReviewDraftPreview(result, id, principalId) || result.manifest.sources.some(pin => !currentDetail.current?.versions.some(version => version.id === pin.versionId && version.contentHash === pin.contentHash)) || result.manifest.threads.some(pin => !currentDetail.current?.threads.some(thread => thread.id === pin.threadId && thread.version === pin.version))) throw new Error('The complete private review could not be verified. Reload its source and private drafts.');
      for (const entry of result.entries) if (entry.payloadSha256 !== await digestBytes(new TextEncoder().encode(JSON.stringify(reviewDraftPayload(entry.payload))))) throw new Error('Private draft contents did not match the preview.');
      if (!active() || ticket !== generation.current || context !== sourceContext.current || epoch !== client.session?.accessEpoch || readTicket !== readGeneration.current) return;
      show(result); setVerified(true); currentPreview.current = result; setPreview(result); setExpanded(true);
    } catch (failure) { if (active() && ticket === generation.current) setError(failText(failure)); }
    finally { if (mounted.current && readTicket === readGeneration.current) setLoading(false); }
  };
  const liveHead = detail?.versions.find(item => item.number === detail.revision.currentVersion);
  const pinsCurrent = Boolean(preview && liveHead && preview.manifest.expectedHead.versionId === liveHead.id && preview.manifest.expectedHead.contentHash === liveHead.contentHash && preview.manifest.expectedHead.number === liveHead.number && preview.manifest.threads.every(pin => detail?.threads.some(thread => thread.id === pin.threadId && thread.version === pin.version)));
  const previewReady = Boolean(pinsCurrent && preview && online && canInteract && verified && snapshot && snapshot.setVersion === preview.setVersion && preview.accessEpoch === client.session?.accessEpoch && !pending && !busy && !loading);
  const head = detail?.versions.find(version => version.number === detail.revision.currentVersion);
  const summaryKey = `review-draft-summary:${id}`;
  const localChanged = () => { retirePreview(); refreshLocal(value => value + 1); };
  const retainedEdits = client.savedDraftRecords(`review-draft-edit:${id}:`).flatMap(row => { const draft = editValue(row.value); return draft && !snapshot?.entries.some(entry => entry.id === draft.id) ? [{ key: row.key, draft }] : []; });
  const retainedSummary = editValue(client.readStored(summaryKey, null));
  const summary = retainedSummary || newSummary;
  const tray = <section className="panel private-review" aria-label="Pending private review"><details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>Private review{snapshot ? ` · ${snapshot.entries.length} saved ${snapshot.entries.length === 1 ? 'draft' : 'drafts'}` : ''}{pending ? ' · unconfirmed request' : ''}</summary><div className="card-body"><p className="small muted">Only your account can read these saved drafts. Publish the complete review explicitly when ready. Saving drafts does not notify reviewers or change source.</p><div className="private-review-actions"><button className="button" disabled={!online || loading || busy} onClick={() => void load()}>{loading ? 'Loading private drafts…' : 'Reload private drafts'}</button><button className="button" disabled={!head || !canInteract} onClick={() => { if (!summary && head) setNewSummary({ id: crypto.randomUUID(), expectedEntryVersion: 0, payload: { kind: 'summary', body: '', versionId: head.id, contentHash: head.contentHash } }); setSummaryOpen(true); retirePreview(); }}>Write review summary</button></div>{!snapshot && <p role="status">{loading ? 'Loading your private review…' : 'Saved private drafts are unavailable. Reconnect and reload. Local unfinished work remains retained.'}</p>}{!online && <p className="info-strip">Offline: keep editing local drafts or export them. Saving and publishing require an explicit action after reconnecting.</p>}{error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
      {(summaryOpen || retainedSummary) && summary && <DraftAvailability draftKey={summaryKey}><PrivateDraftEditor key={summary.id} draftKey={summaryKey} initial={summary} detail={detail} online={online} enabled={verified && canInteract && Boolean(snapshot) && !pending && !busy} epoch={snapshot?.accessEpoch ?? -1} changed={localChanged} discarded={() => { setSummaryOpen(false); setNewSummary(null); localChanged(); }} save={(draft, key) => perform('save', draft.id, { expectedEntryVersion: draft.expectedEntryVersion, expectedAccessEpoch: current.current!.accessEpoch, payload: reviewDraftPayload(draft.payload) }, { key, value: draft }).then(saved => { if (saved && client.readStored(summaryKey, null) === null) { setSummaryOpen(false); setNewSummary(null); } return saved; })}/></DraftAvailability>}
      {snapshot?.entries.map(entry => <PrivateDraftCard key={entry.id} entry={entry} detail={detail} online={online} canInteract={canInteract && verified} busy={busy || Boolean(pending) || !verified} epoch={snapshot.accessEpoch} changed={localChanged} save={(draft, key) => perform('save', entry.id, { expectedEntryVersion: draft.expectedEntryVersion, expectedAccessEpoch: current.current!.accessEpoch, payload: reviewDraftPayload(draft.payload) }, { key, value: draft })} discard={() => perform('discard', entry.id, { expectedEntryVersion: entry.version, expectedAccessEpoch: current.current!.accessEpoch })}/>)}
      {retainedEdits.map(row => <section key={row.key} className="private-review-orphan"><h3>Retained local private edit</h3><p className="info-strip">The saved entry is absent from this reading. This local edit has not been published or retargeted. Export it or reload private drafts before continuing.</p><DraftAvailability draftKey={row.key}><PrivateDraftEditor draftKey={row.key} initial={row.draft} detail={detail} online={online} enabled={false} epoch={snapshot?.accessEpoch ?? -1} changed={localChanged} discarded={localChanged} save={async () => false}/></DraftAvailability></section>)}
      {snapshot?.entries.length === 0 && <p className="muted">No saved private drafts. Use Save Private Draft in a comment or reply, or write a review summary.</p>}
      {pending && <section className="private-review-request" aria-label="Unconfirmed private review request"><h3>Unconfirmed private review request</h3><p>{pending.kind === 'publish' ? 'Publication may already have completed. Retry the identical request to confirm; do not create another publication.' : 'The save or discard may already have completed. Its exact request is retained for retry.'}</p><div className="private-review-actions"><button className="button" disabled={!online || busy || pending.kind !== 'discard' && !canInteract} onClick={() => void send(pending)}>Retry exact private review request</button><button className="button" onClick={() => exportReview(client, id, pending, 'request')}>Export private review request</button><button className="button" disabled={busy} onClick={async () => { if (!window.confirm('Forget this exact request? It may already have succeeded. Reload private drafts and public discussion before starting another action. Export it first to keep recovery.')) return; const epoch = client.session?.accessEpoch, ticket = generation.current; await client.removeRetainedDraftIfEqual(requestKey, pending, () => active() && ticket === generation.current && epoch === client.session?.accessEpoch); if (active() && ticket === generation.current) { syncPending(); retirePreview(); } }}>Forget private review request</button></div></section>}
      {preview ? <section className="private-review-preview" aria-label="Complete private review preview"><h3>Publish this complete review?</h3><p>All {preview.entries.length} saved drafts below will become public discussion comments. Unsaved local edits are excluded. This does not accept the revision or apply suggested edits.</p>{preview.entries.map(entry => <article key={entry.id}><Payload payload={entry.payload} detail={detail}/></article>)}<div className="private-review-actions"><button className="button" onClick={retirePreview}>Cancel review preview</button><button className="button primary" disabled={!previewReady} onClick={() => { const exact = currentPreview.current; if (exact && previewReady) void perform('publish', null, { manifest: exact.manifest }, undefined, exact.entries); }}>Publish private review</button></div></section> : <button className="button primary" disabled={!online || !canInteract || !verified || !snapshot?.entries.length || busy || loading || Boolean(pending)} onClick={() => void prepare()}>Preview complete review</button>}
    </div></details></section>;
  return { stage, canStage: Boolean(verified && online && canInteract && snapshot && snapshot.accessEpoch === client.session?.accessEpoch && !pending && !busy && !loading), tray, contextChanged };
}

export function PrivateReviewSourceContext({ identity, changed }: { identity: string; changed: (value: string) => void }) { useEffect(() => changed(identity), [identity, changed]); return null; }
function PrivateDraftCard({ entry, detail, online, canInteract, busy, epoch, changed, save, discard }: { entry: ReviewDraftEntry; detail: RevisionDetail | null; online: boolean; canInteract: boolean; busy: boolean; epoch: number; changed: () => void; save: (draft: EditDraft, key: string) => Promise<boolean>; discard: () => Promise<boolean> }) {
  const client = useWorkspace(), key = `review-draft-edit:${entry.revisionId}:${entry.id}`;
  const retained = editValue(client.readStored(key, null)), [editing, setEditing] = useState(Boolean(retained));
  return <article className="private-review-entry" data-private-draft-id={entry.id}><h3>{entry.payload.kind === 'summary' ? 'Review summary' : entry.payload.kind === 'reply' ? 'Private reply' : entry.payload.suggestion ? 'Private suggested edit' : 'Private comment'}</h3><Payload payload={entry.payload} detail={detail}/><p className="small muted">Saved entry version {entry.version}. This location stays fixed across source changes.</p><div className="private-review-actions"><button className="button" disabled={!canInteract || busy} onClick={() => { changed(); setEditing(value => !value); }}>{editing ? 'Close private draft editor' : 'Edit private draft'}</button><button className="button" disabled={!online || busy} onClick={() => { if (window.confirm('Discard this saved private draft? It will not be published. Any different local edits remain retained.')) { changed(); void discard(); } }}>Discard private draft</button></div>{editing && <DraftAvailability draftKey={key}><PrivateDraftEditor draftKey={key} initial={retained || { id: entry.id, expectedEntryVersion: entry.version, payload: entry.payload }} detail={detail} online={online} enabled={canInteract && !busy} epoch={epoch} changed={changed} discarded={() => { setEditing(false); changed(); }} save={async (draft, draftKey) => { const success = await save(draft, draftKey); if (success && !client.readStored(key, null)) setEditing(false); return success; }} actualVersion={entry.version}/></DraftAvailability>}</article>;
}
function PrivateDraftEditor({ draftKey, initial, detail, online, enabled, epoch, changed, save, discarded, actualVersion }: { discarded: () => void; draftKey: string; initial: EditDraft; detail: RevisionDetail | null; online: boolean; enabled: boolean; epoch: number; changed: () => void; save: (draft: EditDraft, key: string) => Promise<boolean>; actualVersion?: number }) {
  const client = useWorkspace(), [draft, setDraft] = useState(() => clone(initial)), [persisted, setPersisted] = useState(() => !client.draftHasUnsavedMemory(draftKey)), [error, setError] = useState('');
  const latest = useRef(draft), mounted = useRef(false); latest.current = draft;
  const retain = useDraftRetention(client, draftKey, setPersisted);
  useEffect(() => { mounted.current = true; retain(latest.current); return () => { mounted.current = false; }; }, [draftKey, retain]);
  const update = (payload: ReviewDraftPayload) => { if (client.draftIsHeld(draftKey)) return; const next = { ...draft, payload }; latest.current = next; setDraft(next); retain(next); changed(); };
  let invalid = ''; try { reviewDraftPayload(draft.payload); } catch (failure) { invalid = failText(failure); }
  const stale = actualVersion !== undefined && actualVersion !== draft.expectedEntryVersion;
  return <section className="private-review-editor" aria-label={draft.payload.kind === 'summary' ? 'Private review summary draft' : 'Private review entry draft'}><p className="small muted">The exact original location stays fixed. Editing this local copy does not change the saved entry until you save it.</p><label className="field"><span>{draft.payload.kind === 'summary' ? 'Private review summary' : 'Private draft text'}</span><textarea aria-label={draft.payload.kind === 'summary' ? 'Private review summary' : 'Private draft text'} maxLength={REVIEW_DRAFT_LIMITS.body} rows={4} value={draft.payload.body} onChange={event => update({ ...draft.payload, body: event.target.value })}/></label>{draft.payload.kind === 'comment' && draft.payload.suggestion && <label className="field"><span>Private suggested replacement</span><textarea aria-label="Private suggested replacement" rows={4} maxLength={REVIEW_DRAFT_LIMITS.body} value={draft.payload.suggestion.replacement} onChange={event => { if (draft.payload.kind === 'comment') update({ ...draft.payload, suggestion: { replacement: event.target.value } }); }}/></label>}{stale && <p className="banner warning">This saved entry changed. Your local edit keeps its original entry version. Export it before choosing a new edit.</p>}{!persisted && <p className="error-text small" role="status">This private edit is only in this tab. Keep it open or export it.</p>}{error && <p className="error-text" role="alert">{error}</p>}<div className="private-review-actions"><button className="button primary" disabled={!online || !enabled || stale || epoch !== client.session?.accessEpoch || Boolean(invalid) || !sourceAvailable(detail, draft.payload)} onClick={async () => { const submitted = clone(latest.current); setError(''); try { await save(submitted, draftKey); } catch (failure) { if (mounted.current) setError(failText(failure)); } }}>Save private entry</button><button className="button" onClick={() => exportReview(client, draftKey.split(':')[1]!, draft, 'draft')}>Export private draft</button><button className="button" onClick={async () => { if (!window.confirm('Discard this exact local edit? A different saved copy or server draft will remain unchanged.')) return; const submitted = clone(latest.current), capturedEpoch = client.session?.accessEpoch; const current = () => mounted.current && client.isActive() && client.session?.accessEpoch === capturedEpoch && same(latest.current, submitted); const removed = await client.removeRetainedDraftIfEqual(draftKey, submitted, current); if (current() && removed) discarded(); }}>Discard local private edit</button></div></section>;
}
