import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RevisionDetail, RevisionVersion } from '../shared/types';
import { DOCX_DISCUSSION_LIMITS, docxDiscussionBytes, docxDiscussionFilename, type DocxDiscussionExportInput, type DocxPassageInput } from '../shared/docx-discussion';
import { wordDiscussionSnapshot, wordDiscussionThreads, wordPassage } from './docx-discussion';
import { useWorkspace } from './SessionGate';
import { onSessionLocked } from './session';

export function WordPassagePicker({ version, blockId, initial, canComment, comment, close }: { version: RevisionVersion; blockId: string; initial?: DocxPassageInput; canComment: boolean; comment: (passage: DocxPassageInput) => void; close: () => void }) {
  const ranges = version.docx!.projection.editableRanges.filter(range => range.blockId === blockId && range.part === version.docx!.projection.mainPart);
  const first = initial ? ranges.find(range => range.id === initial.rangeId) : ranges[0];
  const [rangeId, setRangeId] = useState(first?.id || ''), [start, setStart] = useState(initial?.start ?? 0), [end, setEnd] = useState(initial?.end ?? Math.min(first?.text.length || 0, DOCX_DISCUSSION_LIMITS.quoteLength));
  const source = useRef<HTMLPreElement>(null), container = useRef<HTMLElement>(null);
  const range = ranges.find(item => item.id === rangeId);
  let passage: DocxPassageInput | null = null, error = '';
  try { passage = wordPassage(version, rangeId, start, end); } catch (failure) { error = failure instanceof Error ? failure.message : 'Choose an exact Word passage.'; }
  const readSelection = () => {
    const selected = window.getSelection(), element = source.current;
    if (!range || !selected?.rangeCount || selected.isCollapsed || !element) return;
    const chosen = selected.getRangeAt(0);
    if (!element.contains(chosen.startContainer) || !element.contains(chosen.endContainer)) return;
    const before = chosen.cloneRange(); before.selectNodeContents(element); before.setEnd(chosen.startContainer, chosen.startOffset);
    const left = before.toString().length, right = left + chosen.toString().length;
    if (range.text.slice(left, right) === chosen.toString()) { setStart(left); setEnd(right); }
  };
  useEffect(() => { container.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); source.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { document.addEventListener('selectionchange', readSelection); return () => document.removeEventListener('selectionchange', readSelection); }, [range]);
  return <section className="panel card-body docx-passage-picker" ref={container} aria-label="Word passage selection"><h2>Discuss a Word Passage · Version {version.number}</h2><p>Select text below, or choose character positions. Only the exact original passage is attached; later versions are never substituted.</p><label className="field"><span>Word text range</span><select value={rangeId} onChange={event => { const next = ranges.find(item => item.id === event.target.value); setRangeId(event.target.value); setStart(0); setEnd(Math.min(next?.text.length || 0, DOCX_DISCUSSION_LIMITS.quoteLength)); }}>{ranges.map((item, index) => <option value={item.id} key={item.id}>Text {index + 1} · {item.text.slice(0, 100)}</option>)}</select></label><pre className="selectable-source docx-passage-source" ref={source} tabIndex={0} aria-label="Selectable Word passage" onPointerUp={readSelection} onKeyUp={readSelection}>{range?.text}</pre><div className="docx-passage-offsets"><label className="field"><span>First character</span><input type="number" min={1} max={range?.text.length || 1} value={start + 1} onChange={event => setStart(Number(event.target.value) - 1)}/></label><label className="field"><span>Last character</span><input type="number" min={start + 1} max={range?.text.length || 1} value={end} onChange={event => setEnd(Number(event.target.value))}/></label></div>{passage && <><h3>Exact quotation</h3><blockquote className="thread-quotation">{passage.quote}</blockquote></>}{error && <p className="error-text" role="status">{error}</p>}<div className="file-actions"><button className="button primary" disabled={!canComment || !passage} onClick={() => { if (passage) comment(passage); }}>Comment on Word Passage</button><button className="button" onClick={close}>Close Passage Selection</button></div></section>;
}

export function WordDiscussionExport({ detail, version, online }: { detail: RevisionDetail; version: RevisionVersion; online: boolean }) {
  const client = useWorkspace(), id = detail.revision.id, eligible = wordDiscussionThreads(detail, version), snapshot = wordDiscussionSnapshot(detail, version);
  const [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [ready, setReady] = useState<{ context: string; epoch: number; bytes: Uint8Array<ArrayBuffer> } | null>(null);
  const mounted = useRef(true), generation = useRef(0), urls = useRef(new Set<string>());
  const context = JSON.stringify([snapshot, selected]), current = useRef(context); current.current = context;
  const active = () => mounted.current && client.isActive() && !client.unavailableObject(id) && !client.unavailableObject(version.docx!.sourceFile.fileId);
  const revoke = () => { for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); };
  const retire = () => { generation.current++; revoke(); setReady(null); setBusy(false); setError(''); };
  useLayoutEffect(retire, [context, online]);
  useEffect(() => { mounted.current = true; const off = client.onTaskSnapshotChange(retire), access = client.onAccessChange(retire), session = onSessionLocked(retire); return () => { mounted.current = false; generation.current++; revoke(); off(); access(); session(); }; }, [id, version.id]);
  const prepare = async () => {
    if (!online || busy || !active() || selected.length < 1 || selected.length > DOCX_DISCUSSION_LIMITS.threads) return;
    const threads = selected.map(threadId => eligible.find(item => item.thread.id === threadId));
    if (threads.some(item => !item)) { setError('A selected thread changed. Review the selection again.'); return; }
    const epoch = client.session?.accessEpoch ?? -1;
    if (epoch < 0 || detail.accessEpoch !== epoch) { setError('Reload the document to verify access before preparing a Word copy.'); return; }
    retire(); const ticket = generation.current, captured = context, snapshotGeneration = client.taskSnapshotGeneration(); setBusy(true);
    const valid = () => active() && ticket === generation.current && captured === current.current && epoch === client.session?.accessEpoch && snapshotGeneration === client.taskSnapshotGeneration();
    const input: DocxDiscussionExportInput = { versionId: version.id, contentHash: version.contentHash, expectedAccessEpoch: epoch, threads: threads.map(item => ({ threadId: item!.thread.id, expectedThreadVersion: item!.thread.version })) };
    try { const result = await client.request<unknown>(`/api/revisions/${id}/docx/export-discussion`, { method: 'POST', body: input }, [version.docx!.sourceFile.fileId]); if (!valid()) return; const bytes = await docxDiscussionBytes(result, id, input, version); if (valid()) setReady({ context: captured, epoch, bytes }); }
    catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : 'The Word discussion copy could not be prepared.'); }
    finally { if (valid()) setBusy(false); }
  };
  const available = ready && ready.context === context && ready.epoch === client.session?.accessEpoch && online ? ready : null;
  const download = () => { if (!available || !active() || available.epoch !== client.session?.accessEpoch) return; const url = URL.createObjectURL(new Blob([available.bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })); urls.current.add(url); const link = document.createElement('a'); link.href = url; link.download = docxDiscussionFilename(id, version.number); link.click(); setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000); };
  return <section className="panel card-body docx-discussion-export" aria-label="Export Word discussion"><h2>Export Selected Discussion to Word</h2><p>Create a separate Word copy of version {version.number} with selected workspace threads as classic comments. Each comment records the thread’s replies and status. The original package, review evidence, and acceptance stay unchanged.</p><p className="small muted">Select up to {DOCX_DISCUSSION_LIMITS.threads} threads anchored to this original version. Word’s modern reply and resolution controls are not reproduced. Prepared copies stay in this tab only.</p>{eligible.map(({ thread, root, comments }) => <label className="docx-export-thread" key={thread.id}><input type="checkbox" checked={selected.includes(thread.id)} disabled={!selected.includes(thread.id) && selected.length >= DOCX_DISCUSSION_LIMITS.threads} onChange={event => setSelected(value => event.target.checked ? [...value, thread.id] : value.filter(id => id !== thread.id))}/><span><strong>{root.body}</strong><small>{thread.status} · {comments.length} comments</small><q>{root.docxAnchor!.quote}</q></span></label>)}{!eligible.length && <p>No passage threads originate in this version yet.</p>}<div className="file-actions"><button className="button" disabled={!online || busy || !selected.length} onClick={() => void prepare()}>{busy ? 'Preparing Word Discussion…' : 'Prepare Word Discussion'}</button><button className="button" disabled={!available || busy} onClick={download}>Download Word Discussion</button></div>{available && <p role="status">Verified Word copy ready · {available.bytes.length.toLocaleString()} bytes · {selected.length} selected threads</p>}{!online && <p className="info-strip">Reconnect to prepare a copy explicitly. Reconnecting never exports discussion.</p>}{error && <p className="error-text" role="alert">{error}</p>}</section>;
}
