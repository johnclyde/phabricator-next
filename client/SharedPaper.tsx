import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { SharedPaper as SharedPaperDocument } from '../shared/paper-shares';
import PaperMathPreview from './PaperMathPreview';
import { applicationPath } from './mount';

const unavailable = 'This link is unavailable. It may have been revoked or entered incorrectly.';
const validToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);
function validDocument(value: unknown): value is SharedPaperDocument {
  if (!value || typeof value !== 'object') return false;
  const paper = value as Partial<SharedPaperDocument>;
  return typeof paper.title === 'string' && Number.isSafeInteger(paper.versionNumber) && Number(paper.versionNumber) > 0
    && typeof paper.contentHash === 'string' && /^[a-f0-9]{64}$/.test(paper.contentHash)
    && Array.isArray(paper.files) && paper.files.length > 0 && paper.files.every(file => file && typeof file.path === 'string' && typeof file.content === 'string');
}

/** A capability reader has no workspace client, persistent store, or offline fallback. */
export default function SharedPaper({ token }: { token: string }) {
  const [result, setResult] = useState<{ token: string; paper: SharedPaperDocument } | null>(null);
  const [status, setStatus] = useState<'loading' | 'unavailable' | 'paused'>('loading');
  const [path, setPath] = useState(''), [view, setView] = useState<'preview' | 'source'>('preview');
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    let mounted = true, sequence = 0;
    let transport: AbortController | null = null;
    const here = () => mounted && location.hash === `#paper-share/${token}` && navigator.onLine && document.visibilityState !== 'hidden';
    const clear = (next: typeof status, synchronous = false) => {
      sequence++; transport?.abort(); transport = null;
      const update = () => { setResult(null); setStatus(next); };
      if (synchronous) flushSync(update); else update();
    };
    const read = async (replace = false) => {
      if (!validToken(token)) { clear('unavailable'); return; }
      if (!here()) { clear('paused'); return; }
      if (replace) { setResult(null); setStatus('loading'); }
      const ticket = ++sequence;
      transport?.abort(); const controller = new AbortController(); transport = controller;
      const deadline = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(applicationPath('/api/paper-shares/read'), {
          method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(unavailable);
        const paper: unknown = await response.json();
        if (!validDocument(paper)) throw new Error(unavailable);
        if (!here() || ticket !== sequence) return;
        setResult({ token, paper }); setPath(current => paper.files.some(file => file.path === current) ? current : paper.files[0]!.path);
      } catch {
        if (mounted && ticket === sequence) { setResult(null); setStatus(here() ? 'unavailable' : 'paused'); }
      } finally { clearTimeout(deadline); }
    };
    const resume = () => { if (here()) void read(true); };
    const hide = () => clear('paused', true);
    const visibility = () => document.visibilityState === 'hidden' ? hide() : resume();
    const hash = () => { if (location.hash !== `#paper-share/${token}`) hide(); };
    reload.current = resume;
    void read(true);
    const interval = setInterval(() => { if (here()) void read(); }, 20_000);
    window.addEventListener('focus', resume); window.addEventListener('online', resume); window.addEventListener('offline', hide);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', resume); window.addEventListener('hashchange', hash);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted = false; sequence++; transport?.abort(); clearInterval(interval); reload.current = () => {};
      window.removeEventListener('focus', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', hide);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', resume); window.removeEventListener('hashchange', hash);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [token]);
  const paper = result?.token === token && location.hash === `#paper-share/${token}` && navigator.onLine && document.visibilityState !== 'hidden' ? result.paper : null;
  const file = paper?.files.find(item => item.path === path) || paper?.files[0];
  const download = () => {
    if (!file || !paper || location.hash !== `#paper-share/${token}` || !navigator.onLine || document.visibilityState === 'hidden') return;
    const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = file.path.split(/[\\/]/).at(-1) || 'paper.tex'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <main className="shared-paper-page" aria-label="Shared paper">
    <header className="shared-paper-brand">Phabricator<span>Next</span><span className="shared-paper-badge">Shared paper</span></header>
    {paper && file ? <article className="shared-paper-document"><header className="shared-paper-heading"><h1>{paper.title}</h1><p>Version {paper.versionNumber} · Read only</p><p className="muted">Anyone with this link can read this version. The owner can revoke the link; previously downloaded copies remain with their recipients.</p></header>
      <div className="shared-paper-toolbar"><label className="field"><span>Paper file</span><select aria-label="Paper file" value={file.path} onChange={event => setPath(event.target.value)}>{paper.files.map(item => <option key={item.path} value={item.path}>{item.path}</option>)}</select></label><div className="shared-paper-actions" role="group" aria-label="Paper view"><button className="button" aria-pressed={view === 'preview'} onClick={() => setView('preview')}>Preview</button><button className="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>Source</button><button className="button" onClick={download}>Download source</button></div></div>
      {view === 'preview' ? <PaperMathPreview key={`${paper.contentHash}:${file.path}`} source={file.content}/> : <pre className="shared-paper-source" aria-label="Paper source">{file.content}</pre>}
    </article> : <section className="shared-paper-status" role="status"><h1>{status === 'loading' && validToken(token) ? 'Opening shared paper…' : status === 'paused' ? 'Reconnect to open this paper' : 'Paper unavailable'}</h1><p>{status === 'loading' && validToken(token) ? 'Checking this link.' : status === 'paused' ? 'Shared papers require a connection to verify that their links are still active.' : unavailable}</p><button className="button" disabled={!navigator.onLine} onClick={() => reload.current()}>Retry</button></section>}
  </main>;
}
