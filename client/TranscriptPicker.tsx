import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWorkspace } from './SessionGate';
import { assertSession } from './session';
import { createTranscriptSource, type TranscriptClip, type TranscriptSelection, type TranscriptSource, type TranscriptSourceListing } from './transcript-source';

/** The parent must key the picker by its exact source target to retire a pending choice on navigation. */
export default function TranscriptPicker({ disabled = false, choose }: { disabled?: boolean; choose: (selection: TranscriptSelection) => void }) {
  const client = useWorkspace(), session = client.session;
  const [listing, setListing] = useState<TranscriptSourceListing | null>(null), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false), present = useRef(true), generation = useRef(0), source = useRef<TranscriptSource | null>(null), latest = useRef({ disabled, choose }); latest.current = { disabled, choose };
  const active = () => { try { assertSession(session); return mounted.current && present.current && !latest.current.disabled; } catch { return false; } };
  const retire = () => { generation.current++; source.current?.dispose(); source.current = null; };
  useLayoutEffect(() => { if (disabled) { retire(); setBusy(false); } }, [disabled]);
  useEffect(() => {
    mounted.current = true;
    const hide = () => { present.current = false; retire(); setListing(null); setSelected(''); setBusy(false); setError(''); };
    const show = () => { present.current = true; };
    session?.cleanupCallbacks.add(hide); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => { mounted.current = false; retire(); session?.cleanupCallbacks.delete(hide); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, [session]);
  const storage = () => { if (!active() || !session) throw new Error('This local transcript selection is no longer available.'); return source.current ??= createTranscriptSource(session, { isActive: active }); };
  const execute = async (clip?: TranscriptClip) => {
    if (!active() || busy) return;
    const ticket = ++generation.current; setBusy(true); setError('');
    try {
      if (clip) {
        const selection = await storage().select(clip);
        if (!active() || ticket !== generation.current) return;
        latest.current.choose(selection);
      } else {
        const result = await storage().list();
        if (!active() || ticket !== generation.current) return;
        setListing(result); setSelected('');
      }
    } catch (failure) { if (active() && ticket === generation.current) setError(failure instanceof Error ? failure.message : 'The local transcript could not be selected.'); }
    finally { if (active() && ticket === generation.current) setBusy(false); }
  };
  const clip = listing?.clips.find(item => item.id === selected);
  return <section className="transcript-picker" aria-label="Choose a local transcript"><p className="small muted">Choose an edited transcript from Audio. This reads local recordings only. The exact draft becomes the replacement; no model interprets it or changes the source.</p><button type="button" className="button" disabled={disabled || busy} onClick={() => void execute()}>{listing ? 'Reload local recordings' : 'Choose local transcript'}</button>
    {busy && <p role="status">Reading and verifying local transcript…</p>}{error && <p className="error-text" role="alert">{error}</p>}
    {listing?.issues.map((issue, index) => <p className="banner warning" role="status" key={`${issue.id}:${index}`}>{issue.message}</p>)}
    {listing && (listing.clips.length ? <><label className="field"><span>Recording for transcript</span><select aria-label="Recording for transcript" value={selected} disabled={disabled || busy} onChange={event => { generation.current++; setSelected(event.target.value); setError(''); }}><option value="">Choose a recording</option>{listing.clips.map(item => <option key={item.id} value={item.id}>{item.title}{item.temporary ? ' · Temporary recording' : ''} · {new Date(item.createdAt).toLocaleString()}</option>)}</select></label><button type="button" className="button" disabled={disabled || busy || !clip} onClick={() => { if (clip) void execute(clip); }}>Use transcript draft</button></> : <p className="info-strip">No recordings are available in this workspace. Record and transcribe audio in Audio first.</p>)}
  </section>;
}
