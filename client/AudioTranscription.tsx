import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { LocalTranscript, TranscriptionProgress } from '../shared/local-transcription';
import { TRANSCRIPTION_MODEL } from '../shared/transcription-model';
import { createLocalTranscriber, TranscriptionCancelledError, type LocalTranscriber } from './local-transcription';
import { createTranscriptionModelCache, onTranscriptionModelInvalidated, type TranscriptionModelStatus, type TranscriptionInstallProgress } from './transcription-model';
import { transcriptionRuntimeAssets } from './transcription-runtime-assets';
import type { AudioClip, AudioClipMetadata, AudioInbox } from './audio-inbox';
import { AUDIO_TRANSCRIPT_LIMITS, emptyAudioTranscripts, type AudioTranscriptBundle } from './audio-transcripts';
import { discardTemporaryTranscript, retainTemporaryTranscript, temporaryTranscript } from './audio-transcript-drafts';
import { assertSession, onSessionLocked, type WorkspaceSession } from './session';

type Cache = ReturnType<typeof createTranscriptionModelCache>;
interface TranscriptionContext {
  session: WorkspaceSession | null;
  status: TranscriptionModelStatus | null;
  setup: string;
  progress: TranscriptionInstallProgress | null;
  busy: string | null;
  message: string;
  active: () => boolean;
  install: () => void;
  remove: () => void;
  refresh: () => void;
  cancel: (clipId?: string) => void;
  transcribe: (clipId: string, read: () => Promise<AudioClip>, progress: (value: TranscriptionProgress) => void) => Promise<LocalTranscript>;
}
const Context = createContext<TranscriptionContext | null>(null);
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Local transcription is unavailable.';
const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
export function AudioTranscriptionProvider({ session, active, children }: { session: WorkspaceSession | null; active: () => boolean; children: ReactNode }) {
  const [status, setStatus] = useState<TranscriptionModelStatus | null>(null), [setup, setSetup] = useState(''), [progress, setProgress] = useState<TranscriptionInstallProgress | null>(null), [busy, setBusy] = useState<string | null>(null), [message, setMessage] = useState('');
  const cache = useRef<Cache | null>(null), controller = useRef<LocalTranscriber | null>(null), abort = useRef<AbortController | null>(null);
  const mounted = useRef(false), present = useRef(true), sequence = useRef(0), selected = useRef<string | null>(null), settingUp = useRef(false), activity = useRef(active); activity.current = active;
  const available = () => { if (!mounted.current || !present.current || !activity.current()) return false; try { assertSession(session); return true; } catch { return false; } };
  const cancel = (clipId?: string) => {
    if (clipId && selected.current !== clipId) return;
    sequence.current++; abort.current?.abort(); abort.current = null; controller.current?.cancel(); selected.current = null; settingUp.current = false;
    if (mounted.current) { setBusy(null); setSetup(''); setProgress(null); }
  };
  const refresh = async () => {
    if (!available() || !cache.current || selected.current || settingUp.current) return;
    const ticket = ++sequence.current, stop = new AbortController(); abort.current = stop; settingUp.current = true; setSetup('Checking installed model…');
    try { const value = await cache.current.status({ signal: stop.signal }); if (available() && sequence.current === ticket) { setStatus(value); setMessage(''); } }
    catch (error) { if (available() && sequence.current === ticket) setMessage(messageOf(error)); }
    finally { if (available() && sequence.current === ticket) { settingUp.current = false; setSetup(''); abort.current = null; } }
  };
  useEffect(() => {
    mounted.current = true; present.current = true;
    if (!session) return;
    try { cache.current = createTranscriptionModelCache({ runtimeAssets: transcriptionRuntimeAssets }); controller.current = createLocalTranscriber(session, { isActive: available }); void refresh(); }
    catch (error) { setMessage(messageOf(error)); }
    const retire = () => { present.current = false; cancel(); setStatus(null); setMessage(''); };
    const unlock = onSessionLocked(retire);
    const invalidated = onTranscriptionModelInvalidated(() => { if (selected.current) cancel(); setStatus(null); if (available() && !settingUp.current) setMessage('The installed model changed. Check or install the model before transcribing again.'); });
    const resume = () => { present.current = true; if (available()) void refresh(); };
    window.addEventListener('pagehide', retire); window.addEventListener('pageshow', resume);
    return () => { mounted.current = false; cancel(); controller.current?.dispose(); controller.current = null; cache.current = null; unlock(); invalidated(); window.removeEventListener('pagehide', retire); window.removeEventListener('pageshow', resume); };
  }, [session]);
  const install = async () => {
    if (!available() || !cache.current || settingUp.current || selected.current) return;
    const ticket = ++sequence.current, stop = new AbortController(); abort.current = stop; settingUp.current = true; setSetup('Installing model…'); setMessage('');
    try { const value = await cache.current.install({ signal: stop.signal, onProgress: value => { if (available() && ticket === sequence.current) setProgress(value); } }); if (available() && ticket === sequence.current) setStatus(value); }
    catch (error) { if (available() && ticket === sequence.current) { setStatus(null); setMessage(messageOf(error)); } }
    finally { if (available() && ticket === sequence.current) { settingUp.current = false; abort.current = null; setSetup(''); setProgress(null); } }
  };
  const remove = async () => {
    if (!available() || !cache.current) return;
    cancel(); const ticket = ++sequence.current; settingUp.current = true; setSetup('Removing model…'); setStatus(null); setMessage('');
    try { await cache.current.remove(); if (available() && ticket === sequence.current) setMessage('Public model removed from this browser. Saved audio and transcripts were kept.'); }
    catch (error) { if (available() && ticket === sequence.current) setMessage(messageOf(error)); }
    finally { if (available() && ticket === sequence.current) { settingUp.current = false; setSetup(''); void refresh(); } }
  };
  const transcribe = async (clipId: string, read: () => Promise<AudioClip>, report: (value: TranscriptionProgress) => void): Promise<LocalTranscript> => {
    if (!available() || !cache.current || !controller.current) throw new Error('Local transcription is unavailable in this session.');
    if (selected.current || settingUp.current) throw new Error('Finish or cancel the current transcription or model operation first.');
    const ticket = ++sequence.current, stop = new AbortController(); abort.current = stop; selected.current = clipId; setBusy(clipId);
    const check = () => { if (!available() || ticket !== sequence.current) throw new TranscriptionCancelledError(); };
    try {
      const clip = await read(); check(); if (clip.id !== clipId) throw new Error('The original audio selection changed.');
      const prepared = await cache.current.read({ signal: stop.signal }); check();
      const result = await controller.current.transcribe(clip, prepared, value => { if (available() && ticket === sequence.current) report(value); }); check(); return result;
    } finally { if (available() && ticket === sequence.current) { abort.current = null; selected.current = null; setBusy(null); } }
  };
  return <Context.Provider value={{ session, status, setup, progress, busy, message, active: available, install: () => void install(), remove: () => void remove(), refresh: () => void refresh(), cancel, transcribe }}>{children}</Context.Provider>;
}
export function useAudioTranscription() { const value = useContext(Context); if (!value) throw new Error('Audio transcription requires the audio inbox.'); return value; }
export function LocalTranscriptionModel() {
  const model = useAudioTranscription(), [confirm, setConfirm] = useState(false);
  const downloading = model.setup === 'Installing model…';
  return <section className="panel transcription-model" aria-label="Local transcription model"><h2>Offline transcription</h2><p>Optional English speech recognition runs on this device. Installing downloads public model files from this workspace; audio and transcripts are never uploaded.</p><p className="small muted">Whisper tiny.en · CPU · {mebibytes(TRANSCRIPTION_MODEL.files.reduce((sum, file) => sum + file.bytes, 0))} model, plus browser runtime. Keep this page open while working; phones may suspend background processing.</p><p role="status">{model.setup || model.status?.message || model.message || 'Model is not installed.'}</p>{model.message && model.status && <p role="status">{model.message}</p>}
    {model.progress && <p className="small muted">{model.progress.phase === 'download' ? 'Downloading' : 'Verifying'} · {mebibytes(model.progress.loaded)} / {mebibytes(model.progress.total)} verified</p>}
    <div className="audio-actions">{downloading ? <button className="button" onClick={() => { model.cancel(); model.refresh(); }}>Cancel download</button> : <><button className="button" disabled={Boolean(model.setup || model.busy)} onClick={model.install}>{model.status?.status === 'ready' ? 'Reinstall model' : 'Install model'}</button><button className="button" disabled={Boolean(model.setup)} onClick={() => setConfirm(true)}>Remove model</button><button className="button" disabled={Boolean(model.setup || model.busy)} onClick={model.refresh}>Check installed model</button></>}</div>
    {confirm && <div className="audio-delete-confirmation"><p>Remove the public model from this browser? Running transcription will stop. Audio and saved transcripts remain available.</p><div className="audio-actions"><button className="button danger" onClick={() => { setConfirm(false); model.remove(); }}>Confirm remove model</button><button className="button" onClick={() => setConfirm(false)}>Keep model</button></div></div>}
  </section>;
}
const phases: Record<TranscriptionProgress['phase'], string> = { hashing: 'Checking exact audio bytes…', decoding: 'Decoding audio on this device…', 'loading-model': 'Loading the installed model…', transcribing: 'Transcribing on this device…' };
export function AudioTranscription({ clip, inbox, read }: { clip: AudioClipMetadata; inbox?: AudioInbox; read: () => Promise<AudioClip> }) {
  const [open, setOpen] = useState(false);
  return <details className="audio-transcription" onToggle={event => setOpen(event.currentTarget.open)}><summary>Transcription</summary>{open && <TranscriptEditor key={clip.id} clip={clip} inbox={inbox} read={read}/>}</details>;
}
function TranscriptEditor({ clip, inbox, read }: { clip: AudioClipMetadata; inbox?: AudioInbox; read: () => Promise<AudioClip> }) {
  const model = useAudioTranscription(), { session } = model;
  const initial = temporaryTranscript(session, clip.id);
  const [bundle, setBundle] = useState<AudioTranscriptBundle>(emptyAudioTranscripts), [pending, setPending] = useState<LocalTranscript | null>(initial?.pending ?? null), [draft, setDraft] = useState<{ runId: string; text: string } | null>(initial?.draft ?? null), [selected, setSelected] = useState(initial?.selectedRunId ?? '');
  const draftHasSource = Boolean(draft && (pending?.runId === draft.runId || bundle.runs.some(run => run.runId === draft.runId)));
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loaded, setLoaded] = useState(!inbox), [confirmClear, setConfirmClear] = useState(false);
  const mounted = useRef(false), operation = useRef(0), copied = useRef(0), urls = useRef(new Set<string>()), latest = useRef(model); latest.current = model;
  const available = () => mounted.current && latest.current.active();
  const remember = (result: LocalTranscript | null, edit: typeof draft, choice: string) => { if (available() && session) retainTemporaryTranscript(session, clip.id, { pending: result, draft: edit, selectedRunId: choice }); };
  const load = async () => {
    if (!available() || !inbox) return;
    const ticket = ++operation.current; copied.current++; setBusy('Loading saved transcripts…'); setError('');
    try { const result = await inbox.readTranscripts(clip.id); if (!available() || ticket !== operation.current) return; copied.current++; setBundle(result); setLoaded(true); const memory = temporaryTranscript(session, clip.id); if (!memory) { setDraft(result.draft); setSelected(result.draft?.runId ?? result.runs.at(-1)?.runId ?? ''); } }
    catch (failure) { if (available() && ticket === operation.current) { setError(messageOf(failure)); setLoaded(false); } }
    finally { if (available() && ticket === operation.current) setBusy(''); }
  };
  useEffect(() => {
    mounted.current = true; void load();
    const retire = () => { operation.current++; copied.current++; latest.current.cancel(clip.id); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); setPending(null); setDraft(null); setBundle(emptyAudioTranscripts()); setSelected(''); setNotice(''); setError(''); setBusy(''); setLoaded(!inbox); };
    const unlock = onSessionLocked(retire); window.addEventListener('pagehide', retire);
    const show = () => { if (available()) void load(); }; window.addEventListener('pageshow', show);
    return () => { mounted.current = false; operation.current++; copied.current++; latest.current.cancel(clip.id); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); unlock(); window.removeEventListener('pagehide', retire); window.removeEventListener('pageshow', show); };
  }, [clip.id, inbox]);
  const run = async () => {
    if (!available() || busy || pending) return;
    const ticket = ++operation.current; copied.current++; setBusy('Verifying installed model…'); setError(''); setNotice('');
    try {
      const result = await model.transcribe(clip.id, read, value => { if (available() && ticket === operation.current) setBusy(phases[value.phase]); });
      if (!available() || ticket !== operation.current) return;
      const edit = draft ?? { runId: result.runId, text: result.text }; copied.current++; setPending(result); setSelected(result.runId); setDraft(edit); remember(result, edit, result.runId); setNotice('Local model result ready. Check it against the audio; saving the result and draft is explicit.');
    } catch (failure) { if (available() && ticket === operation.current) { if (failure instanceof TranscriptionCancelledError || (failure instanceof DOMException && failure.name === 'AbortError')) setNotice('Transcription canceled. No new transcript was saved.'); else setError(messageOf(failure)); } }
    finally { if (available() && ticket === operation.current) setBusy(''); }
  };
  const save = async () => {
    if (!available() || !inbox || !draft || !draftHasSource || busy || !loaded) return;
    const ticket = ++operation.current; setBusy('Saving transcript…'); setError('');
    try { const result = await inbox.saveTranscript(clip.id, bundle.version, pending, draft); if (!available() || ticket !== operation.current) return; setBundle(result); setPending(null); setDraft(result.draft); if (session) discardTemporaryTranscript(session, clip.id); setNotice(inbox.persistence === 'device' ? 'Transcript saved on this device.' : 'Transcript kept in this session only. Export it before reloading or locking.'); }
    catch (failure) { if (available() && ticket === operation.current) setError(messageOf(failure)); }
    finally { if (available() && ticket === operation.current) setBusy(''); }
  };
  const clear = async () => {
    if (!available() || !inbox || busy || !loaded) return;
    const ticket = ++operation.current; setBusy('Clearing saved transcripts…'); setError('');
    try { const result = await inbox.clearTranscripts(clip.id, bundle.version); if (!available() || ticket !== operation.current) return; setBundle(result); const remainingDraft = pending ? (draft?.runId === pending.runId ? draft : { runId: pending.runId, text: pending.text }) : null; setDraft(remainingDraft); setSelected(pending?.runId ?? ''); copied.current++; if (pending) remember(pending, remainingDraft, pending.runId); else if (session) discardTemporaryTranscript(session, clip.id); setConfirmClear(false); setNotice('Saved transcripts cleared. Original audio and any new unsaved model result were kept.'); }
    catch (failure) { if (available() && ticket === operation.current) setError(messageOf(failure)); }
    finally { if (available() && ticket === operation.current) setBusy(''); }
  };
  const runs = pending && !bundle.runs.some(run => run.runId === pending.runId) ? [...bundle.runs, pending] : bundle.runs;
  const result = runs.find(run => run.runId === selected) ?? null;
  const edit = (value: string) => { if (!available() || !draft || busy) return; copied.current++; const next = { ...draft, text: value }; setDraft(next); remember(pending, next, selected); };
  const copy = async (text: string, name: string) => {
    if (!available()) return; const ticket = ++copied.current;
    try { await navigator.clipboard.writeText(text); if (available() && ticket === copied.current) setNotice(`${name} copied.`); }
    catch { if (available() && ticket === copied.current) setError('Clipboard access failed. Select the text or download it instead.'); }
  };
  const download = (text: string, kind: string) => {
    if (!available()) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); urls.current.add(url);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${clip.title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-').slice(0, 80) || 'recording'}-${kind}.txt`; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 1000);
  };
  return <section className="transcript-editor" aria-label={`Transcription for ${clip.title}`}><p className="small muted">AI output can omit or invent words. Review against the audio. The original result is immutable; your draft is separate and never changes a paper, revision, or command.</p>
    <div className="audio-actions">{model.busy === clip.id ? <button className="button" onClick={() => model.cancel(clip.id)}>Cancel transcription</button> : <button className="button" disabled={Boolean(busy || model.busy || model.setup || pending) || model.status?.status !== 'ready'} onClick={() => void run()}>Transcribe on this device</button>}{inbox && <button className="button" disabled={Boolean(busy)} onClick={() => void load()}>Reload saved transcripts</button>}</div>
    {busy && <p role="status">{busy}</p>}{error && <p className="banner error" role="alert">{error}</p>}{notice && <p className="info-strip" role="status">{notice}</p>}
    {!inbox && <p className="small muted">Save or keep the audio first to retain its transcript. Until then, copy or download the text.</p>}
    {runs.length > 0 && <><label className="field"><span>Transcription run</span><select aria-label="Transcription run" value={selected} disabled={Boolean(busy)} onChange={event => { copied.current++; setSelected(event.target.value); if (pending || temporaryTranscript(session, clip.id)) remember(pending, draft, event.target.value); }}>{runs.map((run, index) => <option key={run.runId} value={run.runId}>{`Run ${index + 1} · ${new Date(run.completedAt).toLocaleString()}${pending?.runId === run.runId ? ' · Not saved' : ''}`}</option>)}</select></label>
      {result && <><label className="field"><span>Original model transcript</span><textarea aria-label="Original model transcript" readOnly value={result.text} rows={5}/></label>{result.text === '' && <p className="info-strip">The model returned no text. No substitute transcript was invented.</p>}<div className="audio-actions"><button className="button" onClick={() => void copy(result.text, 'Original transcript')}>Copy original transcript</button><button className="button" onClick={() => download(result.text, 'original-transcript')}>Download original transcript</button><button className="button" disabled={Boolean(busy)} onClick={() => { if (!available()) return; const next = { runId: result.runId, text: result.text }; copied.current++; setDraft(next); remember(pending, next, selected); }}>Replace draft with this result</button></div>
      <details className="transcript-provenance"><summary>Exact audio and model provenance</summary><dl><dt>Audio SHA-256</dt><dd><code>{result.audioSha256}</code></dd><dt>Original encoded audio</dt><dd>{result.audioBytes} bytes · {result.mimeType}</dd><dt>Model</dt><dd>{result.modelId} · {result.modelRevision}</dd><dt>Model manifest SHA-256</dt><dd><code>{result.modelManifestSha256}</code></dd><dt>Runtime</dt><dd>Transformers.js {result.runtimeVersion} · CPU WASM · {result.dtype} · English · 16 kHz · 30 s chunks / 5 s stride</dd><dt>Run</dt><dd>{result.runId} · {result.completedAt}</dd></dl></details></>}
    </>}
    {draft && <>{loaded && !draftHasSource && <p className="banner warning" role="status">This draft’s original model result is unavailable. Your edited text is still here to edit, copy, or download. Saving requires an available model result; replacing the draft with a new result will replace this text.</p>}<label className="field"><span>Transcript draft</span><textarea aria-label="Transcript draft" value={draft.text} maxLength={AUDIO_TRANSCRIPT_LIMITS.maxDraftCodeUnits} rows={7} disabled={Boolean(busy)} onChange={event => edit(event.target.value)}/></label><p className="small muted">Draft based on {runs.findIndex(run => run.runId === draft.runId) >= 0 ? `run ${runs.findIndex(run => run.runId === draft.runId) + 1}` : loaded ? 'an unavailable model result' : 'a model result being checked'} · {draft.text.length.toLocaleString()} / 100,000 characters. Selecting a run does not replace this draft.</p><div className="audio-actions"><button className="button primary" disabled={!inbox || !loaded || !draftHasSource || Boolean(busy)} onClick={() => void save()}>Save transcript</button><button className="button" onClick={() => void copy(draft.text, 'Transcript draft')}>Copy transcript draft</button><button className="button" onClick={() => download(draft.text, 'transcript-draft')}>Download transcript draft</button></div></>}
    {pending && <button className="button" disabled={Boolean(busy)} onClick={() => { if (!available()) return; setPending(null); setDraft(bundle.draft); setSelected(bundle.draft?.runId ?? bundle.runs.at(-1)?.runId ?? ''); copied.current++; if (session) discardTemporaryTranscript(session, clip.id); setNotice('Unsaved transcript and draft discarded.'); }}>Discard unsaved transcript</button>}
    {inbox && bundle.runs.length > 0 && <><p className="small muted">{bundle.runs.length} / 5 saved model results. Saved drafts and originals share the audio’s storage lifetime; deleting audio deletes its transcripts.</p><button className="button danger" disabled={Boolean(busy)} onClick={() => setConfirmClear(true)}>Clear saved transcripts</button>{confirmClear && <div className="audio-delete-confirmation"><p>Clear all saved results and the editable draft for this clip? Export what you need first. Original audio will remain.</p><div className="audio-actions"><button className="button danger" disabled={Boolean(busy)} onClick={() => void clear()}>Confirm clear transcripts</button><button className="button" onClick={() => setConfirmClear(false)}>Keep transcripts</button></div></div>}</>}
    <p className="small muted">Unsaved text survives navigation within this app, but is lost when leaving the browser page, reloading, signing out, or locking. Copy, download, or explicitly save before leaving.</p>
  </section>;
}
