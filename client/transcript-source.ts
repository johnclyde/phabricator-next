import { isLocalTranscript, type LocalTranscript } from '../shared/local-transcription.ts';
import { parseTranscriptEditOrigin, transcriptEditText, TRANSCRIPT_EDIT_LIMITS, type TranscriptEditOrigin } from '../shared/transcript-edit.ts';
import { temporaryAudio } from './audio-draft.ts';
import { createAudioInbox, type AudioClip, type AudioClipMetadata, type AudioInbox, type AudioInboxIssue } from './audio-inbox.ts';
import { copyLocalTranscript, emptyAudioTranscripts, type AudioTranscriptBundle } from './audio-transcripts.ts';
import { temporaryTranscript } from './audio-transcript-drafts.ts';
import { assertSession, SessionChangedError, type WorkspaceSession } from './session.ts';

export interface TranscriptSelection { title: string; replacement: string; origin: TranscriptEditOrigin }
export interface TranscriptClip extends AudioClipMetadata { temporary: boolean }
export interface TranscriptSourceListing { clips: TranscriptClip[]; issues: AudioInboxIssue[] }
export interface TranscriptSource {
  list(): Promise<TranscriptSourceListing>;
  select(clip: TranscriptClip): Promise<TranscriptSelection>;
  dispose(): void;
}
const metadata = (clip: AudioClipMetadata): AudioClipMetadata => ({ id: clip.id, title: clip.title, createdAt: clip.createdAt, mimeType: clip.mimeType, durationMs: clip.durationMs, bytes: clip.bytes });
const sameMetadata = (left: AudioClipMetadata, right: AudioClipMetadata): boolean => JSON.stringify(metadata(left)) === JSON.stringify(metadata(right));
const hash = async (bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
export async function transcriptTextSha256(text: string): Promise<string> {
  transcriptEditText(text, 100_000, 'Transcript', true);
  return hash(new TextEncoder().encode(text));
}
interface Candidate { run: LocalTranscript; replacement: string }
/** A selected display run is not necessarily the parent of the user's edited draft. */
function candidate(session: WorkspaceSession, clip: AudioClip, bundle: AudioTranscriptBundle): Candidate {
  const memory = temporaryTranscript(session, clip.id);
  const draft = memory ? memory.draft : bundle.draft;
  if (!draft) throw new Error('This recording has no edited transcript draft. Open Audio and prepare a draft explicitly.');
  const known = bundle.runs.find(run => run.runId === draft.runId), pending = memory?.pending?.runId === draft.runId ? memory.pending : null;
  if (known && pending && JSON.stringify(copyLocalTranscript(known)) !== JSON.stringify(copyLocalTranscript(pending))) throw new Error('Two original model results claim this draft identity. Keep the draft and inspect Audio before continuing.');
  const run = pending ?? known;
  if (!run) throw new Error('The draft’s original model result is unavailable. Its text is still available in Audio to edit, copy, or download.');
  if (!isLocalTranscript(run) || run.clipId !== clip.id || run.audioBytes !== clip.bytes || run.mimeType !== clip.mimeType) throw new Error('The original model result does not match this recording. Nothing was changed.');
  transcriptEditText(run.text, 100_000, 'Original transcript', true);
  const replacement = transcriptEditText(draft.text, TRANSCRIPT_EDIT_LIMITS.textCodeUnits, 'Transcript replacement');
  return { run: copyLocalTranscript(run), replacement };
}

/** Local reads only. Creation does no I/O; list/select are always explicit caller actions. */
export function createTranscriptSource(session: WorkspaceSession, options: { isActive?: () => boolean; inbox?: AudioInbox } = {}): TranscriptSource {
  assertSession(session);
  let disposed = false, storage: AudioInbox | null = options.inbox ?? null;
  const active = () => { assertSession(session); if (disposed || options.isActive?.() === false) throw new SessionChangedError(); };
  const inbox = () => { active(); return storage ??= createAudioInbox(session); };
  const dispose = () => { if (disposed) return; disposed = true; storage?.dispose(); session.cleanupCallbacks.delete(dispose); if (typeof window !== 'undefined') window.removeEventListener('pagehide', dispose); };
  session.cleanupCallbacks.add(dispose);
  if (typeof window !== 'undefined') window.addEventListener('pagehide', dispose);
  return {
    async list() {
      active(); let saved;
      try { saved = await inbox().list(); }
      catch (error) {
        active(); const clip = temporaryAudio(session)?.clip;
        if (!clip) throw error;
        return { clips: [{ ...metadata(clip), temporary: true }], issues: [{ id: null, message: error instanceof Error ? error.message : 'Saved recordings could not be read. The temporary recording is still available.' }] };
      }
      active();
      const clips = saved.clips.map(clip => ({ ...metadata(clip), temporary: false }));
      const temporary = temporaryAudio(session)?.clip, issues = saved.issues.map(issue => ({ ...issue }));
      if (temporary) {
        const duplicate = clips.find(clip => clip.id === temporary.id);
        if (!duplicate) clips.push({ ...metadata(temporary), temporary: true });
        else if (!sameMetadata(duplicate, temporary)) issues.push({ id: temporary.id, message: 'A temporary recording has the same identity as a different saved recording. Inspect Audio before selecting it.' });
      }
      clips.sort((a, b) => a.createdAt === b.createdAt ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : a.createdAt > b.createdAt ? -1 : 1);
      return { clips, issues };
    },
    async select(selected) {
      active(); const expected = { ...metadata(selected), temporary: selected.temporary };
      const original = expected.temporary ? temporaryAudio(session)?.clip : await inbox().read(expected.id); active();
      if (!original || !sameMetadata(original, expected)) throw new Error('The selected recording changed or is unavailable. Reload the local recordings and choose again.');
      const clip = { ...metadata(original), blob: original.blob };
      if (!(clip.blob instanceof Blob) || clip.blob.size !== clip.bytes || clip.blob.type !== clip.mimeType || clip.bytes <= 0 || clip.bytes > 25 * 1024 * 1024) throw new Error('The selected audio does not match its recorded bytes.');
      const bundle = expected.temporary ? emptyAudioTranscripts() : await inbox().readTranscripts(expected.id); active();
      const snapshot = candidate(session, clip, bundle);
      // Strings and the immutable Blob are captured before hashing. Later edits
      // invalidate this preparation instead of being substituted into its result.
      const bytes = await clip.blob.arrayBuffer(); active();
      const [audioSha256, originalTextSha256, editedTextSha256] = await Promise.all([hash(bytes), transcriptTextSha256(snapshot.run.text), transcriptTextSha256(snapshot.replacement)]); active();
      if (audioSha256 !== snapshot.run.audioSha256) throw new Error('The transcript belongs to different audio bytes. The recording and draft were not changed.');
      let freshBundle = bundle;
      if (expected.temporary) {
        const fresh = temporaryAudio(session)?.clip;
        if (!fresh || !sameMetadata(clip, fresh) || fresh.blob !== clip.blob) throw new Error('The temporary recording changed while preparing this edit. Choose it again.');
      } else {
        freshBundle = await inbox().readTranscripts(expected.id); active();
        const fresh = await inbox().read(expected.id); active();
        if (!fresh || !sameMetadata(fresh, clip)) throw new Error('The original saved recording changed while preparing this edit. Choose it again.');
      }
      if (JSON.stringify(candidate(session, clip, freshBundle)) !== JSON.stringify(snapshot)) throw new Error('The transcript draft or its original result changed while preparing this edit. Choose it again; nothing was applied.');
      active();
      return { title: clip.title, replacement: snapshot.replacement, origin: parseTranscriptEditOrigin({ kind: 'client-local-transcript', clipId: clip.id, runId: snapshot.run.runId, audioSha256, audioBytes: clip.bytes, modelId: snapshot.run.modelId, modelRevision: snapshot.run.modelRevision, modelManifestSha256: snapshot.run.modelManifestSha256, runtimeVersion: snapshot.run.runtimeVersion, originalTextSha256, editedTextSha256 }) };
    },
    dispose,
  };
}
