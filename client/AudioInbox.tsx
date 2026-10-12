import { useEffect, useRef, useState } from 'react';
import { Download, Mic, Square, Trash2 } from 'lucide-react';
import { useWorkspace } from './SessionGate';
import { AudioCapture, audioRecordingSupported, type AudioCaptureState } from './audio-recorder';
import { AUDIO_INBOX_LIMITS, createAudioClip, createAudioInbox, type AudioClip, type AudioClipMetadata, type AudioInbox as Inbox, type AudioInboxListing } from './audio-inbox';
import { discardTemporaryAudio, retainTemporaryAudio, temporaryAudio, type TemporaryAudio } from './audio-draft';
import { assertSession, onSessionLocked } from './session';

const duration = (milliseconds: number) => `${Math.floor(milliseconds / 60_000)}:${Math.floor(milliseconds / 1000) % 60 < 10 ? '0' : ''}${Math.floor(milliseconds / 1000) % 60}`;
const size = (bytes: number) => bytes === 0 ? '0 bytes' : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
function filename(clip: AudioClipMetadata): string {
  const name = clip.title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-').slice(0, 80).replace(/[. ]+$/g, '') || 'recording';
  const type = clip.mimeType.split(';')[0]!.toLowerCase();
  const extension = ({ 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' } as Record<string, string>)[type] || 'audio';
  return `${name}.${extension}`;
}
function AudioPlayback({ blob, label, active, autoplay = false }: { blob: Blob; label: string; active: () => boolean; autoplay?: boolean }) {
  const [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (!active()) return;
    const source = URL.createObjectURL(blob), element = player.current; setUrl(source); setFailed(false);
    const stop = () => { element?.pause(); element?.removeAttribute('src'); element?.load(); URL.revokeObjectURL(source); };
    const retire = () => { stop(); setUrl(''); };
    const unlock = onSessionLocked(retire); window.addEventListener('pagehide', retire);
    return () => { unlock(); window.removeEventListener('pagehide', retire); stop(); };
  }, [blob]);
  useEffect(() => { if (url && autoplay && active()) void player.current?.play().catch(() => { /* Native controls remain available if autoplay is blocked. */ }); }, [url, autoplay]);
  return <div className="audio-playback"><audio ref={player} controls preload="metadata" src={url || undefined} aria-label={label} onPlay={event => { if (!active()) event.currentTarget.pause(); }} onError={() => setFailed(true)}/>{failed && <p className="info-strip" role="status">This browser could not play the recording. Download its original bytes to try another audio player.</p>}</div>;
}
function SavedAudio({ clip, inbox, active, download, removed }: { clip: AudioClipMetadata; inbox: Inbox; active: () => boolean; download: (clip: AudioClip) => void; removed: () => void }) {
  const [loaded, setLoaded] = useState<AudioClip | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true), operation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; }; }, []);
  const available = () => mounted.current && active();
  const read = async (play: boolean) => {
    if (!available() || busy) return;
    const ticket = ++operation.current; setBusy(play ? 'play' : 'download'); setError('');
    try {
      const result = await inbox.read(clip.id);
      if (!available() || ticket !== operation.current) return;
      if (!result) throw new Error('This recording is no longer saved. Reload the audio inbox.');
      if (play) setLoaded(result); else download(result);
    } catch (failure) { if (available() && ticket === operation.current) setError(failure instanceof Error ? failure.message : 'The recording could not be read.'); }
    finally { if (available() && ticket === operation.current) setBusy(''); }
  };
  const remove = async () => {
    if (!available() || busy) return;
    const ticket = ++operation.current; setBusy('delete'); setError('');
    try { await inbox.delete(clip.id); if (available() && ticket === operation.current) { setLoaded(null); removed(); } }
    catch (failure) { if (available() && ticket === operation.current) setError(failure instanceof Error ? failure.message : 'The recording could not be deleted.'); }
    finally { if (available() && ticket === operation.current) setBusy(''); }
  };
  return <article className="panel audio-clip"><div className="audio-clip-heading"><div><h3>{clip.title}</h3><p className="small muted">{new Date(clip.createdAt).toLocaleString()} · {duration(clip.durationMs)} observed · {size(clip.bytes)}</p></div><span className="badge">{inbox.persistence === 'device' ? 'On this device' : 'This session only'}</span></div>
    {loaded && <AudioPlayback blob={loaded.blob} label={`Play ${clip.title}`} active={available} autoplay/>}
    <div className="audio-actions">{!loaded && <button className="button" disabled={Boolean(busy)} onClick={() => void read(true)}>{busy === 'play' ? 'Loading audio…' : 'Play audio'}</button>}<button className="button" disabled={Boolean(busy)} onClick={() => void read(false)}><Download size={15}/>Download audio</button><button className="button danger" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}><Trash2 size={15}/>Delete audio</button></div>
    {confirmDelete && <div className="audio-delete-confirmation"><p>Delete “{clip.title}” from {inbox.persistence === 'device' ? 'this device' : 'this session'}? Download it first if you need to keep a copy.</p><div className="audio-actions"><button className="button danger" disabled={Boolean(busy)} onClick={() => void remove()}>Confirm delete audio</button><button className="button" disabled={Boolean(busy)} onClick={() => setConfirmDelete(false)}>Keep audio</button></div></div>}
    {error && <p className="banner error" role="alert">{error}</p>}
  </article>;
}

export default function AudioInbox({ onRecordingChange }: { onRecordingChange?: (active: boolean) => void }) {
  const { session, durable } = useWorkspace();
  const [inbox, setInbox] = useState<Inbox | null>(null), [listing, setListing] = useState<AudioInboxListing | null>(null);
  const [temporary, setTemporary] = useState<TemporaryAudio | null>(() => temporaryAudio(session));
  const [capture, setCapture] = useState<AudioCaptureState>({ phase: 'idle', elapsedMs: 0, bytes: 0 });
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [loading, setLoading] = useState(true);
  const mounted = useRef(true), present = useRef(true), generation = useRef(0), listGeneration = useRef(0);
  const root = useRef<HTMLElement>(null), recorder = useRef<AudioCapture | null>(null), storage = useRef<Inbox | null>(null);
  const urls = useRef(new Set<string>()), callback = useRef(onRecordingChange); callback.current = onRecordingChange;
  const active = () => { if (!mounted.current || !present.current) return false; try { assertSession(session); return true; } catch { return false; } };
  const refresh = async () => {
    const current = storage.current; if (!current || !active()) return;
    const ticket = ++listGeneration.current; setLoading(true);
    try { const result = await current.list(); if (active() && ticket === listGeneration.current) { setListing(result); setError(''); } }
    catch (failure) { if (active() && ticket === listGeneration.current) setError(failure instanceof Error ? failure.message : 'Audio storage is unavailable.'); }
    finally { if (active() && ticket === listGeneration.current) setLoading(false); }
  };
  const stopPlayback = () => { for (const audio of root.current?.querySelectorAll('audio') || []) audio.pause(); };
  useEffect(() => {
    mounted.current = true; present.current = true;
    if (!session || !active()) return;
    const current = createAudioInbox(session); storage.current = current; setInbox(current); setTemporary(temporaryAudio(session));
    recorder.current = new AudioCapture({ active, microphone: value => callback.current?.(value), changed: value => { if (active()) setCapture(value); }, failed: message => { if (active()) setError(message); }, completed: result => {
      if (!active()) return;
      try { const clip = createAudioClip(result.blob, { title: `Recording ${new Date().toLocaleString()}`, durationMs: result.durationMs }); const draft = { clip, notice: result.notice }; retainTemporaryAudio(session, draft); setTemporary(draft); setNotice('Recording stopped. Listen, download, or explicitly retain this clip.'); }
      catch (failure) { setError(failure instanceof Error ? failure.message : 'The completed recording is unsupported and was not retained.'); }
    } });
    void refresh();
    const retire = () => { present.current = false; generation.current++; listGeneration.current++; recorder.current?.cancel(); stopPlayback(); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); setTemporary(null); setListing(null); setSaving(false); setLoading(false); setCapture({ phase: 'idle', elapsedMs: 0, bytes: 0 }); };
    const lock = onSessionLocked(retire);
    const hidden = () => { if (document.visibilityState === 'hidden') { recorder.current?.stop('Recording stopped when the page was hidden. Background capture is not guaranteed.'); stopPlayback(); } };
    const pagehide = () => { retire(); };
    const pageshow = () => { present.current = true; if (active()) { setTemporary(temporaryAudio(session)); setSaving(false); void refresh(); } };
    const unload = (event: BeforeUnloadEvent) => { if (recorder.current?.busy || temporaryAudio(session)) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow); window.addEventListener('beforeunload', unload);
    return () => { mounted.current = false; generation.current++; listGeneration.current++; recorder.current?.cancel(); recorder.current = null; stopPlayback(); current.dispose(); storage.current = null; for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); lock(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); window.removeEventListener('beforeunload', unload); };
  }, [session]);
  const download = (clip: AudioClip) => {
    if (!active()) return;
    const url = URL.createObjectURL(clip.blob); urls.current.add(url);
    const link = document.createElement('a'); link.href = url; link.download = filename(clip); document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
  };
  const save = async () => {
    if (!active() || !inbox || !temporary || saving || !session) return;
    const ticket = ++generation.current, draft = temporary; setSaving(true); setError('');
    try {
      await inbox.save(draft.clip);
      if (!active() || ticket !== generation.current) return;
      if (temporaryAudio(session)?.clip.id === draft.clip.id) discardTemporaryAudio(session);
      setTemporary(null); setNotice(durable ? 'Recording saved on this device.' : 'Recording kept in this session. Download it before signing out or reloading.'); await refresh();
    } catch (failure) { if (active() && ticket === generation.current) setError(failure instanceof Error ? failure.message : 'The recording was not saved. Download the temporary clip before leaving.'); }
    finally { if (active() && ticket === generation.current) setSaving(false); }
  };
  const title = (value: string) => { if (!active() || !temporary || !session || saving) return; const next = { ...temporary, clip: { ...temporary.clip, title: value } }; retainTemporaryAudio(session, next); setTemporary(next); };
  return <section className="audio-inbox" aria-label="Audio inbox" ref={root}>
    <div className="panel audio-policy"><p>{durable ? 'Nothing is uploaded. Save explicitly on this device; download important recordings.' : 'Nothing is uploaded. Audio stays in this tab only. Download before reload, sign out, or session lock.'}</p><p className="small muted">Offline transcription is still planned. Audio is not sent to AI.</p></div>
    {error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
    <section className="panel audio-recorder" aria-label="Audio recorder"><h2>New recording</h2><p className="small muted">Up to 10 minutes and 25 MiB. Stops when hidden. Stop before leaving Audio to keep the clip; navigation cancels an active recording.</p>
      {!audioRecordingSupported() && <p className="info-strip" role="status">Audio recording is unavailable in this browser. A supported browser on HTTPS or localhost is required. Saved recordings can still be downloaded.</p>}
      <div className="audio-record-status" role="status">{capture.phase === 'requesting' ? 'Waiting for microphone permission…' : capture.phase === 'recording' ? `Recording · ${duration(capture.elapsedMs)} · ${size(capture.bytes)} received` : capture.phase === 'stopping' ? 'Microphone stopped. Finishing the audio file…' : 'Microphone off'}</div>
      <div className="audio-actions">{capture.phase === 'idle' ? <button className="button primary" disabled={!audioRecordingSupported() || Boolean(temporary) || saving} onClick={() => { stopPlayback(); setError(''); setNotice(''); void recorder.current?.start(); }}><Mic size={16}/>Record audio</button> : capture.phase === 'requesting' ? <button className="button" onClick={() => { recorder.current?.cancel(); setNotice('Microphone request canceled. A later permission grant will not start recording.'); }}>Cancel microphone request</button> : <button className="button" disabled={capture.phase === 'stopping'} onClick={() => recorder.current?.stop()}><Square size={15}/>Stop recording</button>}</div>
      <details className="audio-help"><summary>Recording and storage details</summary><p>The browser may suspend capture or delay audio chunks when a phone locks or a tab is hidden. Timers do not guarantee background recording. Starting audio capture stops voice command listening in this tab.</p><p>A finished temporary clip survives navigation within this app, but not leaving the browser page, reloading, or session lock. Retaining it is explicit; if saving fails, download the temporary clip before leaving.</p><p>{durable ? 'Saved audio is held in this browser for this workspace. Browser data can be cleared or evicted. Download important recordings as a backup.' : 'Kept audio remains only in this signed-in tab’s memory. Reloading, closing, locking the session or signing out clears it; audio is excluded from the draft JSON export. Download each recording separately.'}</p><p>Audio is not transcribed or turned into a command. Nothing is uploaded or sent to a model.</p></details>
    </section>
    {temporary && <section className="panel audio-temporary" aria-label="Temporary recording"><div className="audio-clip-heading"><h2>Temporary recording</h2><span className="badge">Not saved</span></div><p>{duration(temporary.clip.durationMs)} observed · {size(temporary.clip.bytes)} · <code>{temporary.clip.mimeType}</code></p>{temporary.notice && <p className="info-strip" role="status">{temporary.notice}</p>}<label className="field"><span>Recording title</span><input aria-label="Recording title" value={temporary.clip.title} maxLength={AUDIO_INBOX_LIMITS.maxTitleCodeUnits} disabled={saving} onChange={event => title(event.target.value)}/></label><AudioPlayback blob={temporary.clip.blob} label="Recorded audio preview" active={active}/><div className="audio-actions"><button className="button primary" disabled={saving || !temporary.clip.title.trim() || !inbox} onClick={() => void save()}>{saving ? 'Saving audio…' : durable ? 'Save on this device' : 'Keep for this session'}</button><button className="button" disabled={saving} onClick={() => download(temporary.clip)}><Download size={15}/>Download recording</button><button className="button" disabled={saving} onClick={() => { if (!active() || !session) return; discardTemporaryAudio(session); setTemporary(null); setNotice('Temporary recording discarded.'); setError(''); }}>Discard recording</button></div><p className="small muted">Retaining audio is explicit. If a save fails, this temporary clip remains available to download.</p></section>}
    <div className="audio-list-heading"><h2>{durable ? 'Saved on this device' : 'Kept in this session'}</h2><button className="button" disabled={loading} onClick={() => void refresh()}>Reload audio inbox</button></div>
    {listing && <p className="small muted">{listing.clips.length} recordings · {size(listing.totalBytes)} · Limit: 100 recordings / 200 MiB</p>}
    {listing?.issues.map((issue, index) => <p className="banner warning" role="status" key={`${issue.id}:${index}`}>{issue.message}</p>)}
    {loading ? <p className="info-strip" role="status">Loading saved audio…</p> : listing?.clips.length === 0 ? <p className="panel audio-empty">No recordings have been {durable ? 'saved on this device' : 'kept in this session'}.</p> : null}
    {inbox && listing?.clips.map(clip => <SavedAudio key={clip.id} clip={clip} inbox={inbox} active={active} download={download} removed={() => { setListing(value => value ? { ...value, clips: value.clips.filter(item => item.id !== clip.id), totalBytes: Math.max(0, value.totalBytes - clip.bytes) } : value); setNotice('Recording deleted.'); void refresh(); }}/>) }
  </section>;
}
