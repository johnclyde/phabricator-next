import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { BookOpen, Download, FileText, Plus, Trash2 } from 'lucide-react';
import type { SourceFile } from '../shared/types';
import { DEVICE_PAPER_FORMAT, DEVICE_PAPER_LIMITS, parseDevicePaperImport, serializeDevicePaper, type DevicePaper } from '../shared/device-papers';
import { deleteDevicePaper, DevicePaperConflictError, listDevicePapers, newDevicePaper, readDevicePaper, requestPersistentPaperStorage, saveDevicePaper } from './device-papers';
import { devicePaperHref, guardDevicePaperNavigation } from './device-paper-navigation';
import PaperMathPreview from './PaperMathPreview';
import { applicationPath } from './mount';

const STARTER = String.raw`\documentclass{article}
\usepackage{amsmath,amssymb}
\begin{document}
\section{Introduction}
Write your argument here. For example, $a^2 + b^2 = c^2$.

\[
  \sum_{k=1}^{n} k = \frac{n(n+1)}{2}
\]
\end{document}
`;
export const DEVICE_PAPER_NOTICE = 'Device papers stay in this browser profile, including after workspace sign-out. Anyone using this profile can open them. They are not uploaded or synchronized. Export backups before clearing browser data or changing devices.';
export function downloadPaperText(text: string, name: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportPaper(paper: DevicePaper) {
  let backup: string;
  try { backup = serializeDevicePaper(paper); } catch { backup = JSON.stringify({ format: DEVICE_PAPER_FORMAT, title: paper.title, files: paper.files, recoveryDraft: true }, null, 2) + '\n'; }
  downloadPaperText(backup, `${paper.title.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80) || 'paper'}.paper.json`, 'application/json');
}
function describe(failure: unknown) { return failure instanceof Error ? failure.message : 'Device storage is unavailable. Keep this tab open and export your paper.'; }

function OfflineReadiness() {
  const [ready, setReady] = useState(false), [checking, setChecking] = useState(true);
  const [persistent, setPersistent] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      const registration = await navigator.serviceWorker?.getRegistration(applicationPath('/'));
      const active = registration?.active;
      if (!active) { setReady(false); return; }
      const complete = await new Promise<boolean>(resolve => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 5000);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data?.type === 'phabricator.offline-shell.status.v1' && event.data.ready === true); };
        active.postMessage({ type: 'phabricator.offline-shell.status.v1' }, [channel.port2]);
      });
      setReady(complete);
      setPersistent(await navigator.storage?.persisted?.() ?? false);
    } catch { setReady(false); } finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); const changed = () => { void check(); }; navigator.serviceWorker?.addEventListener('controllerchange', changed); window.addEventListener('online', changed); return () => { navigator.serviceWorker?.removeEventListener('controllerchange', changed); window.removeEventListener('online', changed); }; }, [check]);
  return <div className="device-paper-readiness"><p role="status">{checking ? 'Checking offline availability…' : ready ? 'Ready to reopen offline — editor and math fonts are saved on this device.' : 'Offline editor is not ready yet. Connect and keep this page open while the app downloads.'}</p><button type="button" className="button" disabled={checking} onClick={() => void check()}>Check offline readiness</button><span>{persistent ? 'Persistent storage enabled. Keep exported backups too.' : 'Browser storage may be cleared under storage pressure.'}</span>{!persistent && <button className="text-button" onClick={() => void requestPersistentPaperStorage().then(result => setPersistent(result.persisted)).catch(() => setPersistent(false))}>Keep storage on this device</button>}</div>;
}

export default function DevicePapers({ id }: { id: string | null }) {
  const [papers, setPapers] = useState<DevicePaper[]>([]), [selected, setSelected] = useState<DevicePaper | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false);
  const [newTitle, setNewTitle] = useState('Untitled paper');
  const input = useRef<HTMLInputElement>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async () => { setPapers(await listDevicePapers()); }, []);
  useEffect(() => {
    let active = true; setLoading(true); setSelected(null); setError('');
    void Promise.all([listDevicePapers(), id ? readDevicePaper(id) : Promise.resolve(null)]).then(([items, paper]) => {
      if (!active) return; setPapers(items); setSelected(paper); if (id && !paper) setError('This device paper is missing. It may have been deleted in another tab.');
    }).catch(failure => { if (active) setError(describe(failure)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);
  const create = async (title: string, files: SourceFile[]) => {
    if (!consent || busy) return;
    setBusy(true); setError('');
    try { const from = location.hash; const saved = await saveDevicePaper(newDevicePaper(title, files), null); void requestPersistentPaperStorage().catch(() => {}); if (mounted.current && location.hash === from) location.hash = devicePaperHref(saved.id); }
    catch (failure) { setError(describe(failure)); } finally { setBusy(false); }
  };
  const importFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files || [])]; event.target.value = ''; if (!files.length || !consent || busy) return;
    setBusy(true); setError('');
    try {
      if (files.length > DEVICE_PAPER_LIMITS.files || files.reduce((total, file) => total + file.size, 0) > (files.length === 1 && files[0]!.name.endsWith('.json') ? DEVICE_PAPER_LIMITS.importBytes : DEVICE_PAPER_LIMITS.totalBytes)) throw new Error('Choose up to 200 text files totaling 10 MiB or an exported project smaller than 64 MiB.');
      const sources = await Promise.all(files.map(async file => ({ path: file.name, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()) })));
      const imported = files.length === 1 && files[0]!.name.endsWith('.json') ? parseDevicePaperImport(JSON.parse(sources[0]!.content)) : { title: files[0]!.name.replace(/\.[^.]+$/, ''), files: sources };
      const from = location.hash; const saved = await saveDevicePaper(newDevicePaper(imported.title, imported.files), null); void requestPersistentPaperStorage().catch(() => {}); if (mounted.current && location.hash === from) location.hash = devicePaperHref(saved.id);
    } catch (failure) { setError(describe(failure)); } finally { setBusy(false); }
  };
  return <main className="device-papers"><header className="device-papers-header"><a className="session-brand" href="#home"><img src={applicationPath('/icon.svg')} alt=""/>Phabricator <span>NEXT</span></a><a className="button" href="#papers">Workspace papers</a></header>
    <div className="page-heading"><div><h1><BookOpen size={26}/>Papers on this device</h1><p>Write, preview mathematics, and reopen your work offline.</p></div>{id && <a className="button" href={devicePaperHref()}>All device papers</a>}</div>
    <details className="device-paper-privacy"><summary>About device storage</summary><p>{DEVICE_PAPER_NOTICE}</p></details>
    <OfflineReadiness/>
    {error && <p role="alert" className="banner error">{error}</p>}
    {loading ? <p role="status">Opening device storage…</p> : selected ? <DevicePaperEditor key={selected.id} initial={selected} onSaved={() => { void refresh().catch(() => {}); }}/>: !id && <>
      <section className="panel device-paper-create"><h2>Start writing</h2><p>{DEVICE_PAPER_NOTICE}</p><label className="checkbox"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)}/>Keep papers in this browser profile</label><label className="field"><span>New paper title</span><input value={newTitle} maxLength={200} onChange={event => setNewTitle(event.target.value)}/></label><div className="device-paper-actions"><button className="button primary" disabled={!consent || busy || !newTitle.trim()} onClick={() => void create(newTitle, [{ path: 'main.tex', content: STARTER }])}><Plus size={16}/>Create device paper</button><button className="button" disabled={!consent || busy} onClick={() => input.current?.click()}>Import paper</button><input ref={input} type="file" aria-label="Import paper files" hidden multiple accept=".json,.tex,.bib,.sty,.cls,.txt,.md" onChange={event => void importFiles(event)}/></div><p className="muted">Import UTF-8 source files or a previously exported .paper.json project. Importing creates a new copy.</p></section>
      <section className="panel device-paper-list"><div className="panel-heading"><h2>Saved papers</h2><button className="text-button" onClick={() => void refresh().catch(failure => setError(describe(failure)))}>Refresh list</button></div>{papers.length ? papers.map(paper => <a href={devicePaperHref(paper.id)} key={paper.id}><FileText size={20}/><span><strong>{paper.title}</strong><small>{paper.files.length} source {paper.files.length === 1 ? 'file' : 'files'} · Saved {new Date(paper.updatedAt).toLocaleString()}</small></span></a>) : <p>No papers saved on this device yet.</p>}</section>
    </>}
  </main>;
}

function DevicePaperEditor({ initial, onSaved }: { initial: DevicePaper; onSaved: () => void }) {
  const [paper, setPaper] = useState(initial), [activeFile, setActiveFile] = useState(0), [view, setView] = useState<'both' | 'source' | 'preview'>('both');
  const [status, setStatus] = useState('Saved on this device'), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [busy, setBusy] = useState(false);
  const latest = useRef(initial), stored = useRef(initial), dirty = useRef(false), saving = useRef(false), blocked = useRef(false), operationBusy = useRef(false), mounted = useRef(true);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    const removeGuard = guardDevicePaperNavigation(() => !dirty.current || window.confirm('Your latest edits are not saved on this device. Leave this paper? Export your work first to keep it.'));
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { mounted.current = false; removeGuard(); window.removeEventListener('beforeunload', unload); };
  }, []);
  const persist = async () => {
    if (saving.current || blocked.current) return;
    saving.current = true;
    if (mounted.current) { setStatus('Saving on this device…'); setError(''); }
    try {
      while (dirty.current) {
        const submitted = latest.current;
        const saved = await saveDevicePaper({ ...submitted, revision: stored.current.revision }, stored.current.revision);
        stored.current = saved;
        if (latest.current === submitted) { latest.current = saved; dirty.current = false; if (mounted.current) setPaper(saved); }
        if (mounted.current) onSaved();
      }
      if (mounted.current) setStatus('Saved on this device');
    } catch (failure) {
      if (failure instanceof DevicePaperConflictError) blocked.current = true;
      if (mounted.current) { setConflict(blocked.current); setError(describe(failure)); setStatus('Latest edits are not saved'); }
    } finally { saving.current = false; }
  };
  const change = (next: DevicePaper) => { if (operationBusy.current) return; latest.current = next; dirty.current = true; setPaper(next); void persist(); };
  const changeFile = (field: keyof SourceFile, value: string) => change({ ...latest.current, files: latest.current.files.map((file, index) => index === activeFile ? { ...file, [field]: value } : file) });
  const insert = (value: string) => {
    const file = latest.current.files[activeFile]; if (!file || operationBusy.current) return;
    const text = editor.current?.value ?? file.content;
    const start = editor.current?.selectionStart ?? text.length, end = editor.current?.selectionEnd ?? start;
    changeFile('content', text.slice(0, start) + value + text.slice(end)); setView('both');
    requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(start + value.length, start + value.length); });
  };
  const copy = async () => {
    if (saving.current || operationBusy.current) return; operationBusy.current = true; setBusy(true);
    try { const saved = await saveDevicePaper(newDevicePaper(`${latest.current.title.slice(0, 193).replace(/[\uD800-\uDBFF]$/, '')} (copy)`, latest.current.files), null); dirty.current = false; if (mounted.current) location.hash = devicePaperHref(saved.id); }
    catch (failure) { setError(describe(failure)); } finally { operationBusy.current = false; if (mounted.current) setBusy(false); }
  };
  const reload = async () => {
    if (saving.current || operationBusy.current || !window.confirm('Replace the edits in this tab with the saved device copy? Export your current edits first if you need them.')) return;
    operationBusy.current = true; setBusy(true);
    try { const current = await readDevicePaper(initial.id); if (!current) throw new Error('This paper was deleted. Export your edits or save them as a new copy.'); latest.current = stored.current = current; dirty.current = blocked.current = false; setConflict(false); setError(''); setPaper(current); setActiveFile(0); setStatus('Saved on this device'); }
    catch (failure) { setError(describe(failure)); } finally { operationBusy.current = false; if (mounted.current) setBusy(false); }
  };
  const remove = async () => {
    if (saving.current || operationBusy.current || !window.confirm('Delete this paper from this browser profile? Export a backup first if you want to keep it.')) return;
    operationBusy.current = true; setBusy(true);
    try { await deleteDevicePaper(initial.id, stored.current.revision); dirty.current = false; if (mounted.current) location.hash = devicePaperHref(); }
    catch (failure) { if (failure instanceof DevicePaperConflictError) { blocked.current = true; setConflict(true); } setError(describe(failure)); } finally { operationBusy.current = false; if (mounted.current) setBusy(false); }
  };
  const file = paper.files[activeFile];
  return <section className="panel device-paper-editor" aria-label="Device paper editor"><fieldset className="policy-fields" disabled={busy}><div className="device-paper-editor-heading"><label className="field"><span>Paper title</span><input maxLength={200} value={paper.title} onChange={event => change({ ...latest.current, title: event.target.value })}/></label><p role="status" className={error ? 'device-paper-unsaved' : ''}>{status}</p></div>
    {error && <div className="banner error" role="alert"><p>{error}</p>{conflict && <p>Another tab changed or deleted the saved copy. Your edits remain here. Export them or save a new copy; the other tab’s work will not be overwritten.</p>}<div className="device-paper-actions">{!conflict && <button className="button" onClick={() => void persist()}>Retry device save</button>}<button className="button" disabled={busy} onClick={() => void copy()}>Save edits as new copy</button><button className="button" disabled={busy} onClick={() => void reload()}>Load saved copy</button></div></div>}
    <div className="device-paper-actions"><button className="button" onClick={() => exportPaper(latest.current)}><Download size={15}/>Export project</button><button className="button" disabled={!file} onClick={() => file && downloadPaperText(file.content, file.path.split('/').at(-1) || 'paper.tex')}>Download source file</button><button className="button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15}/>Delete device paper</button></div>
    <div className="editor-files" aria-label="Paper source files">{paper.files.map((item, index) => <button type="button" key={index} className={index === activeFile ? 'selected' : ''} onClick={() => setActiveFile(index)}>{item.path || 'Untitled'}</button>)}<button type="button" onClick={() => { let number = paper.files.length + 1; while (paper.files.some(file => file.path === `section-${number}.tex`)) number++; change({ ...latest.current, files: [...latest.current.files, { path: `section-${number}.tex`, content: '' }] }); setActiveFile(paper.files.length); }}><Plus size={15}/>Add source file</button></div>
    {file && <><div className="form-row"><label className="field"><span>Source file path</span><input value={file.path} onChange={event => changeFile('path', event.target.value)}/></label><button className="button" disabled={paper.files.length === 1} onClick={() => { if (window.confirm('Remove this source file from the device project?')) { change({ ...latest.current, files: latest.current.files.filter((_, index) => index !== activeFile) }); setActiveFile(0); } }}>Remove source file</button></div>
    <div className="device-paper-actions"><div className="segmented" role="group" aria-label="Editor view">{(['source', 'both', 'preview'] as const).map(mode => <button key={mode} aria-pressed={view === mode} className={view === mode ? 'selected' : ''} onClick={() => setView(mode)}>{mode === 'both' ? 'Source and preview' : mode === 'source' ? 'Source only' : 'Preview only'}</button>)}</div><button className="text-button" onClick={() => insert('\\(x\\)')}>Inline equation</button><button className="text-button" onClick={() => insert('\n\\[\n  x = y\n\\]\n')}>Display equation</button><button className="text-button" onClick={() => insert('\n\\section{New section}\n')}>Section</button></div>
    <div className={`device-paper-workspace device-paper-view-${view}`}>{view !== 'preview' && <label className="field"><span>Paper source</span><textarea aria-label="Paper source" ref={editor} className="source-editor" spellCheck={false} autoCapitalize="off" autoCorrect="off" rows={24} value={file.content} onChange={event => changeFile('content', event.target.value)}/></label>}{view !== 'source' && <div className="device-paper-live-preview"><h2>Live math preview</h2><p className="muted small">Preview of {file.path}. Full TeX layout, included files, and bibliography generation are not compiled here.</p><PaperMathPreview source={file.content}/></div>}</div></>}
  </fieldset></section>;
}
