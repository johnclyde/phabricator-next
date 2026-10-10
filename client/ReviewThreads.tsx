import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MessageSquare, RotateCcw, CheckCircle2 } from 'lucide-react';
import { diffWordsWithSpace } from 'diff';
import type { ApplySuggestionInput, PassageInput, RevisionDetail, RevisionVersion, ReviewComment, ReviewThread } from '../shared/types';
import { lineRange, projectAnchor } from '../shared/anchors';
import type { MutationMethod } from './offline';
import { useWorkspace } from './SessionGate';

export interface CommentTarget { versionId: string; filePath: string; line: number | null; passage?: PassageInput; nonce: number }
type Mutate = <T>(path: string, method: MutationMethod, body: unknown, label: string, allowQueue?: boolean) => Promise<T | null>;
function timestamp(value: string) { return new Date(value).toLocaleString(); }
function lineAt(content: string, offset: number) { return content.slice(0, offset).split('\n').length; }

export function SuggestionPreview({ original, replacement }: { original: string; replacement: string }) {
  const bounded = original.length <= 20000 && replacement.length <= 20000;
  const changes = useMemo(() => bounded ? diffWordsWithSpace(original, replacement, { timeout: 80, maxEditLength: 4000 }) : null, [original, replacement, bounded]);
  if (!bounded) return <p className="error-text small">Choose an original passage and replacement of at most 20,000 characters each to preview this suggested edit.</p>;
  return <div className="suggestion-preview"><div className="suggestion-texts"><div><h5>Original passage</h5><pre className="suggestion-original">{original}</pre></div><div><h5>{replacement === '' ? 'Proposed deletion' : 'Proposed replacement'}</h5>{replacement === '' ? <p className="suggestion-deletion">Delete the selected passage. No replacement text.</p> : <pre className="suggestion-replacement">{replacement}</pre>}</div></div><details><summary>Show exact text diff</summary>{changes ? <pre className="suggestion-diff" aria-label="Suggested edit diff">{changes.map((part, index) => part.added ? <ins key={index}>{part.value}</ins> : part.removed ? <del key={index}>{part.value}</del> : <span key={index}>{part.value}</span>)}</pre> : <p className="muted small">The word diff exceeded its processing limit. Both complete texts are shown above.</p>}</details></div>;
}

/** The selectable text node is exact source; line numbers never enter its offsets. */
export function SourcePassages({ content, canComment, selectedLine, onLine, onPassage }: { content: string; canComment: boolean; selectedLine: number | null; onLine: (line: number) => void; onPassage: (passage: PassageInput) => void }) {
  const source = useRef<HTMLPreElement>(null);
  const [selection, setSelection] = useState<PassageInput | null>(null);
  const [startLine, setStartLine] = useState(1); const [endLine, setEndLine] = useState(1); const [error, setError] = useState('');
  const count = content.split('\n').length;
  const readSelection = () => {
    const selected = window.getSelection(); const element = source.current;
    if (!selected?.rangeCount || selected.isCollapsed || !element) return;
    const range = selected.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
    const before = range.cloneRange(); before.selectNodeContents(element); before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length, end = start + range.toString().length;
    const quote = content.slice(start, end);
    if (end > start && quote === range.toString()) { setSelection({ start, end, quote }); setError(''); }
  };
  useEffect(() => { document.addEventListener('selectionchange', readSelection); return () => document.removeEventListener('selectionchange', readSelection); }, [content]);
  return <div className="source-passages">
    <div className="passage-tools"><p>Select source text to discuss its exact wording, or choose a line range below. The original quotation stays with the thread.</p><button className="button" disabled={!canComment || !selection} onClick={() => { if (selection) onPassage(selection); }}><MessageSquare size={15}/>Comment on selected passage</button>{selection && <small className="selection-summary">Selected {selection.quote.length} characters · lines {lineAt(content, selection.start)}–{lineAt(content, Math.max(selection.start, selection.end - 1))}</small>}
      <form className="passage-range" onSubmit={event => { event.preventDefault(); try { if (!canComment) return; const passage = lineRange(content, startLine, endLine); setSelection(passage); setError(''); onPassage(passage); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Choose a nonempty source range.'); } }}><label>Passage start line<input type="number" min={1} max={count} step={1} required value={startLine} disabled={!canComment} onChange={event => setStartLine(Number(event.target.value))}/></label><label>Passage end line<input type="number" min={startLine} max={count} step={1} required value={endLine} disabled={!canComment} onChange={event => setEndLine(Number(event.target.value))}/></label><button className="button" disabled={!canComment}>Comment on line range</button></form>{error && <p className="error-text" role="alert">{error}</p>}
    </div>
    <div className="passage-source-scroll" role="region" aria-label="Source contents" tabIndex={0}><div className="passage-line-numbers" aria-label="Source line comments">{Array.from({ length: count }, (_, index) => <button key={index} type="button" disabled={!canComment} className={selectedLine === index + 1 ? 'selected-line' : ''} aria-label={canComment ? `Comment on line ${index + 1}` : `Line ${index + 1}`} onClick={() => onLine(index + 1)}>{index + 1}</button>)}</div><pre className="selectable-source" ref={source} tabIndex={0} aria-label="Source passage text" onPointerUp={readSelection} onKeyUp={readSelection}>{content}</pre></div>
  </div>;
}

export default function ReviewThreads({ detail, version, online, canEdit, canInteract, mutate, saved, suggestionApplied, openSource }: { detail: RevisionDetail; version: RevisionVersion; online: boolean; canEdit: boolean; canInteract: boolean; mutate: Mutate; saved: () => Promise<void>; suggestionApplied: () => Promise<void>; openSource: (versionId: string, filePath: string | null, line: number | null) => void }) {
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('all');
  const threads = useMemo(() => {
    const listed = new Map((detail.threads || []).map(thread => [thread.id, thread]));
    for (const comment of detail.comments) {
      const id = comment.threadId || comment.id;
      if (!listed.has(id)) listed.set(id, { id, revisionId: detail.revision.id, rootCommentId: id, status: 'open', version: 1, createdAt: comment.createdAt, updatedAt: comment.createdAt });
    }
    return [...listed.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }, [detail]);
  const shown = threads.filter(thread => filter === 'all' || thread.status === filter);
  return <div className="review-threads"><div className="thread-toolbar"><h3>Discussion across versions</h3><div className="filter-bar" aria-label="Thread status">{(['open', 'resolved', 'all'] as const).map(value => <button key={value} aria-pressed={filter === value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)} <span>{value === 'all' ? threads.length : threads.filter(thread => thread.status === value).length}</span></button>)}</div></div><p className="muted small">Threads retain their original version and quotation. Resolving a discussion does not change source, review evidence, or acceptance.</p>
    {shown.map(thread => <Thread key={thread.id} thread={thread} detail={detail} version={version} online={online} canEdit={canEdit} canInteract={canInteract} mutate={mutate} saved={saved} suggestionApplied={suggestionApplied} openSource={openSource}/>)}
    {!shown.length && <p className="muted no-comments">{threads.length ? 'No threads match this filter.' : 'No discussion threads yet. Start a discussion below or select a source passage.'}</p>}
  </div>;
}
function Thread({ thread, detail, version, online, canEdit, canInteract, mutate, saved, suggestionApplied, openSource }: { thread: ReviewThread; detail: RevisionDetail; version: RevisionVersion; online: boolean; canEdit: boolean; canInteract: boolean; mutate: Mutate; saved: () => Promise<void>; suggestionApplied: () => Promise<void>; openSource: (versionId: string, filePath: string | null, line: number | null) => void }) {
  const [reply, setReply] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const comments = detail.comments.filter(comment => (comment.threadId || comment.id) === thread.id);
  const root = comments.find(comment => comment.id === thread.rootCommentId) || comments[0];
  if (!root) return null;
  const original = detail.versions.find(item => item.id === root.versionId);
  const projection = root.anchor ? projectAnchor(root.anchor, version) : null;
  const source = root.anchor ? version.files.find(file => file.path === root.anchor?.filePath)?.content : undefined;
  const events = (detail.threadEvents || []).filter(event => event.threadId === thread.id);
  const changeStatus = async () => {
    if (!online || !canEdit) return;
    setBusy(true); setError('');
    try { await mutate(`/api/revisions/${detail.revision.id}/threads/${thread.id}`, 'PATCH', { status: thread.status === 'open' ? 'resolved' : 'open', expectedThreadVersion: thread.version, versionId: version.id }, thread.status === 'open' ? 'Thread resolved' : 'Thread reopened', false); await saved(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not change this thread.'); } finally { setBusy(false); }
  };
  let explanation: ReactNode = null;
  if (projection) {
    if (projection.status === 'original') explanation = `Original passage in version ${version.number}.`;
    else if (projection.status === 'relocated') explanation = `Exact quotation located in version ${version.number}. The thread remains anchored to its original version.`;
    else if (projection.status === 'ambiguous') explanation = `This quotation appears ${projection.occurrences} times in version ${version.number}. Its location is ambiguous; no new location was chosen.`;
    else if (projection.status === 'file_missing') explanation = `The original file is missing from version ${version.number}. The original quotation is retained.`;
    else explanation = `The original quotation is not present verbatim in version ${version.number}. The passage may have changed; inspect the original before resolving.`;
  }
  return <article className={`review-thread thread-${thread.status}`} data-thread-id={thread.id}><header className="thread-heading"><h4>Thread on version {original?.number ?? 'unknown'}</h4><span className={`badge ${thread.status === 'resolved' ? 'badge-resolved' : 'badge-open'}`}>{thread.status === 'resolved' ? 'Resolved' : 'Open'}</span><span className="muted small">{comments.length} {comments.length === 1 ? 'comment' : 'comments'}</span></header>
    {root.anchor && <div className="thread-anchor"><blockquote className="thread-quotation">{root.anchor.quote}</blockquote><p className={`anchor-projection projection-${projection?.status}`} role="status">{explanation}</p>{projection?.start !== null && projection?.start !== undefined && source !== undefined && <small>Shown source: {root.anchor.filePath}, line {lineAt(source, projection.start)}</small>}</div>}
    <button className="text-button original-thread-location" onClick={() => openSource(root.versionId, root.filePath, root.line)}>View original version {original?.number ?? ''}{root.filePath ? ` · ${root.filePath}${root.line ? `:${root.line}` : ''}` : ''}</button>
    {root.suggestion && root.anchor && <ThreadSuggestion root={root} thread={thread} detail={detail} online={online} canEdit={canEdit} mutate={mutate} saved={saved} applied={suggestionApplied} openSource={openSource}/>}
    {comments.map(comment => <Comment key={comment.id} comment={comment} versions={detail.versions}/>)}
    {events.length > 0 && <ol className="thread-events" aria-label="Thread state history">{events.map(event => { const viewed = detail.versions.find(item => item.id === event.versionId); return <li key={event.id}><span><strong>{event.actor}</strong> {event.action} while viewing version {viewed?.number ?? 'unknown'} · {timestamp(event.createdAt)}</span><button className="text-button" onClick={() => openSource(event.versionId, root.filePath, null)}>View version {viewed?.number ?? ''}</button></li>; })}</ol>}
    {error && <div className="banner error" role="alert">{error}<button onClick={() => void saved()}>Reload discussion</button></div>}
    <div className="thread-actions">{canInteract && <button className="button" onClick={() => setReply(!reply)}><MessageSquare size={15}/>{reply ? 'Close Reply' : 'Reply'}</button>}{canEdit && <button className="button" disabled={!online || busy} onClick={() => void changeStatus()}>{thread.status === 'open' ? <CheckCircle2 size={15}/> : <RotateCcw size={15}/>}{busy ? 'Saving…' : thread.status === 'open' ? 'Resolve Thread' : 'Reopen Thread'}</button>}{!online && canEdit && <small className="muted">Reconnect to resolve or reopen a thread.</small>}</div>
    {reply && canInteract && <ReplyComposer key={`${thread.id}:${version.id}`} revisionId={detail.revision.id} threadId={thread.id} version={version} originalNumber={original?.number} mutate={mutate} saved={saved}/>}
  </article>;
}
function ThreadSuggestion({ root, thread, detail, online, canEdit, mutate, saved, applied, openSource }: { root: ReviewComment; thread: ReviewThread; detail: RevisionDetail; online: boolean; canEdit: boolean; mutate: Mutate; saved: () => Promise<void>; applied: () => Promise<void>; openSource: (versionId: string, path: string | null, line: number | null) => void }) {
  const [confirmation, setConfirmation] = useState<ApplySuggestionInput | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const anchor = root.anchor!; const suggestion = root.suggestion!;
  const original = detail.versions.find(version => version.id === anchor.versionId);
  const current = detail.versions.find(version => version.number === detail.revision.currentVersion);
  const application = (detail.suggestionApplications || []).find(item => item.commentId === root.id);
  const destination = application && detail.versions.find(version => version.id === application.toVersionId);
  const exactCurrent = current?.id === anchor.versionId && current.contentHash === anchor.contentHash;
  const eligible = online && canEdit && exactCurrent && !application;
  const expected: ApplySuggestionInput | null = current ? { expectedVersion: detail.revision.currentVersion, expectedVersionId: current.id, expectedContentHash: current.contentHash, expectedThreadVersion: thread.version } : null;
  const confirmationCurrent = Boolean(confirmation && expected && JSON.stringify(confirmation) === JSON.stringify(expected));
  const apply = async () => {
    if (!eligible || !confirmation || !confirmationCurrent || busy) return;
    setBusy(true); setError('');
    try {
      await mutate<RevisionDetail>(`/api/revisions/${detail.revision.id}/suggestions/${root.id}/apply`, 'POST', confirmation, 'Suggested edit applied as a new version', false);
      setConfirmation(null); await applied();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not apply this suggested edit.'); setConfirmation(null); await saved(); }
    finally { setBusy(false); }
  };
  return <section className="thread-suggestion" aria-label="Suggested edit"><h4>Suggested edit</h4><p className="muted small">Original source: version {original?.number ?? 'unknown'} · {anchor.filePath}. This edit replaces this one anchored passage only.</p><SuggestionPreview original={anchor.quote} replacement={suggestion.replacement}/>
    {application ? <div className="suggestion-application"><CheckCircle2 size={16}/><span><strong>{application.actor}</strong> applied this edit as version {destination?.number ?? 'unknown'} · {timestamp(application.createdAt)}.</span><button className="text-button" onClick={() => openSource(application.toVersionId, anchor.filePath, null)}>View applied version {destination?.number ?? ''}</button></div> : <>
      {!exactCurrent && <p className="info-strip">The current source has changed since this suggestion was written. Create a new suggestion on the current version after reviewing it; this edit cannot be applied to a relocated passage.</p>}
      {!online && <p className="muted small">Reconnect to apply a suggested edit. Applying source changes is never queued offline.</p>}
      {!canEdit && <p className="muted small">Edit access is required to apply this suggestion.</p>}
      {!confirmation ? <button className="button" disabled={!eligible} onClick={() => { setConfirmation(expected); setError(''); }}>Review Suggested Edit</button> : <div className="suggestion-confirmation" role="region" aria-label="Confirm suggested edit"><h5>Apply this exact edit as a new version?</h5><p>Replace 1 passage in <strong>{anchor.filePath}</strong> from version <strong>{original?.number ?? 'unknown'}</strong>: {anchor.quote.length} source characters {suggestion.replacement === '' ? 'will be deleted' : `will be replaced with ${suggestion.replacement.length} characters`}. The complete original and proposed text are shown above.</p><p>The new source will need review again. Existing review evidence stays with its original version. This discussion stays {thread.status}.</p>{!confirmationCurrent && <p role="alert" className="error-text">The source or discussion changed after this preview. Cancel and review the suggestion again.</p>}<div className="thread-actions"><button type="button" className="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className="button primary" disabled={!eligible || !confirmationCurrent || busy} onClick={() => void apply()}>{busy ? 'Applying…' : 'Apply as New Version'}</button></div></div>}
    </>}{error && <p className="error-text" role="alert">{error}</p>}
  </section>;
}

function Comment({ comment, versions }: { comment: ReviewComment; versions: RevisionVersion[] }) {
  const original = versions.find(version => version.id === comment.versionId);
  const viewed = comment.viewedVersionId ? versions.find(version => version.id === comment.viewedVersionId) : null;
  return <div className="comment" data-comment-id={comment.id}><span className="avatar small-avatar">{comment.author.slice(0, 1).toUpperCase()}</span><div><div className="comment-meta"><strong>{comment.author}</strong><span>{timestamp(comment.createdAt)}</span><span>v{original?.number ?? '?'}{comment.filePath ? ` · ${comment.filePath}:${comment.line || 'passage'}` : ''}</span>{viewed && viewed.id !== comment.versionId && <span>Replied while viewing v{viewed.number}</span>}</div><p>{comment.body}</p></div></div>;
}
function ReplyComposer({ revisionId, threadId, version, originalNumber, mutate, saved }: { revisionId: string; threadId: string; version: RevisionVersion; originalNumber?: number; mutate: Mutate; saved: () => Promise<void> }) {
  const { readStored, writeStored, removeStored, durable, assertActive, quarantinedDrafts } = useWorkspace();
  const key = `comment-source:${revisionId}:reply:${threadId}:${version.id}`;
  const [body, setBody] = useState(() => readStored<{ body: string }>(key, { body: '' }).body);
  const mounted = useRef(true); const latestBody = useRef(body); latestBody.current = body;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [persisted, setPersisted] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const held = quarantinedDrafts().some(draft => draft.key === key);
  const submit = async () => {
    if (held || !body.trim()) return;
    const submitted = { body, viewedVersionId: version.id, threadId };
    setBusy(true); setError('');
    try {
      await mutate(`/api/revisions/${revisionId}/threads/${threadId}/replies`, 'POST', { body: submitted.body, viewedVersionId: submitted.viewedVersionId }, 'Reply added'); assertActive();
      const current = readStored<typeof submitted | null>(key, null);
      if (current && JSON.stringify(current) === JSON.stringify(submitted)) removeStored(key);
      if (mounted.current && latestBody.current === submitted.body) setBody('');
      await saved();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not save reply.'); } finally { if (mounted.current) setBusy(false); }
  };
  return <form className="thread-reply" onSubmit={event => { event.preventDefault(); void submit(); }}><label className="field"><span>Reply to this thread</span><textarea required rows={3} disabled={held || busy} value={body} onChange={event => { const value = event.target.value; setBody(value); setPersisted(writeStored(key, { body: value, viewedVersionId: version.id, threadId })); }}/></label><p className="muted small">Replying while viewing version {version.number}. The original version {originalNumber ?? ''} and location stay with the thread. A reply does not reopen a resolved thread.</p>{error && <div className="banner error" role="alert">{error}</div>}{held && <p className="info-strip">This reply draft is set aside for export or discard. Clear that recovery copy before starting another reply here.</p>}<div className="comment-form-footer"><span className={persisted ? 'muted small' : 'error-text small'}>{persisted ? durable ? 'Reply draft stays on this device.' : 'Reply draft stays in this tab only.' : 'This reply is not saved. Keep it open or export it.'}</span>{body && (!persisted || !durable) && <button type="button" className="button" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify({ body, viewedVersionId: version.id, threadId }, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'reply-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Export Draft</button>}<button className="button primary" disabled={held || busy || !body.trim()}>{busy ? 'Saving…' : 'Add Reply'}</button></div></form>;
}
