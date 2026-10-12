import { isLocalTranscript, type LocalTranscript } from '../shared/local-transcription';
import type { AudioClip } from './audio-inbox';

export const AUDIO_TRANSCRIPT_LIMITS = Object.freeze({ maxRuns: 5, maxDraftCodeUnits: 100_000 });
export interface AudioTranscriptDraft { runId: string; text: string; updatedAt: string }
export interface AudioTranscriptBundle {
  format: 'phabricator.audio-transcripts.v1';
  version: number;
  runs: LocalTranscript[];
  draft: AudioTranscriptDraft | null;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const iso = (value: unknown): value is string => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const validLocalTranscript = isLocalTranscript;
export function copyLocalTranscript(value: LocalTranscript): LocalTranscript {
  return { format: value.format, runId: value.runId, clipId: value.clipId, audioSha256: value.audioSha256, audioBytes: value.audioBytes, mimeType: value.mimeType, createdAt: value.createdAt, completedAt: value.completedAt, decodedDurationMs: value.decodedDurationMs, modelId: value.modelId, modelRevision: value.modelRevision, modelManifestSha256: value.modelManifestSha256, runtimeVersion: value.runtimeVersion, device: value.device, dtype: value.dtype, language: value.language, text: value.text, options: { sampleRate: value.options.sampleRate, chunkLengthS: value.options.chunkLengthS, strideLengthS: value.options.strideLengthS } };
}
export function emptyAudioTranscripts(): AudioTranscriptBundle { return { format: 'phabricator.audio-transcripts.v1', version: 0, runs: [], draft: null }; }
export function readAudioTranscriptBundle(value: unknown, clip: Pick<AudioClip, 'id' | 'bytes' | 'mimeType'>): AudioTranscriptBundle {
  if (value === undefined) return emptyAudioTranscripts();
  if (!object(value) || value.format !== 'phabricator.audio-transcripts.v1' || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || !Array.isArray(value.runs) || value.runs.length > AUDIO_TRANSCRIPT_LIMITS.maxRuns) throw new Error('Saved transcript data is malformed or unsupported. The original audio was not changed.');
  const runs: LocalTranscript[] = [], seen = new Set<string>();
  for (const candidate of value.runs) {
    if (!validLocalTranscript(candidate) || candidate.clipId !== clip.id || candidate.audioBytes !== clip.bytes || candidate.mimeType !== clip.mimeType || seen.has(candidate.runId) || runs.some(run => run.audioSha256 !== candidate.audioSha256)) throw new Error('Saved transcripts do not match the exact audio identity, or contain unsupported results. The original audio remains available.');
    seen.add(candidate.runId); runs.push(copyLocalTranscript(candidate));
  }
  if (value.draft !== null && (!object(value.draft) || !id(value.draft.runId) || !seen.has(value.draft.runId) || typeof value.draft.text !== 'string' || value.draft.text.length > AUDIO_TRANSCRIPT_LIMITS.maxDraftCodeUnits || !iso(value.draft.updatedAt))) throw new Error('The saved transcript draft is malformed or refers to an unavailable model result.');
  const draft = value.draft as AudioTranscriptDraft | null;
  return { format: value.format, version: Number(value.version), runs, draft: draft ? { runId: draft.runId, text: draft.text, updatedAt: draft.updatedAt } : null };
}
export async function audioSha256(clip: AudioClip): Promise<string> {
  const bytes = await clip.blob.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function verifyTranscriptAudio(bundle: AudioTranscriptBundle, sha256: string): void {
  if (bundle.runs.some(run => run.audioSha256 !== sha256)) throw new Error('Saved transcripts belong to different audio bytes. No transcript was loaded or replaced.');
}
export function updateAudioTranscripts(previous: AudioTranscriptBundle, clip: Pick<AudioClip, 'id' | 'bytes' | 'mimeType'>, sha256: string, expectedVersion: number, result: LocalTranscript | null, draft: Pick<AudioTranscriptDraft, 'runId' | 'text'>): AudioTranscriptBundle {
  if (previous.version !== expectedVersion) throw new Error('The saved transcript changed in another view. Reload it before saving; your draft is still available to copy or download.');
  if (previous.version >= Number.MAX_SAFE_INTEGER) throw new Error('This transcript revision cannot be advanced safely.');
  verifyTranscriptAudio(previous, sha256);
  const runs = previous.runs.map(copyLocalTranscript);
  if (result) {
    if (!validLocalTranscript(result) || result.clipId !== clip.id || result.audioBytes !== clip.bytes || result.mimeType !== clip.mimeType || result.audioSha256 !== sha256) throw new Error('This model result does not match the exact saved audio bytes and metadata.');
    const known = runs.find(run => run.runId === result.runId);
    if (known && JSON.stringify(known) !== JSON.stringify(copyLocalTranscript(result))) throw new Error('An immutable model result with this identity already exists. It cannot be replaced.');
    if (!known) { if (runs.length >= AUDIO_TRANSCRIPT_LIMITS.maxRuns) throw new Error('This clip already has five saved transcription runs. Export what you need, then explicitly clear its saved transcripts before saving another run.'); runs.push(copyLocalTranscript(result)); }
  }
  if (!runs.some(run => run.runId === draft.runId) || typeof draft.text !== 'string' || draft.text.length > AUDIO_TRANSCRIPT_LIMITS.maxDraftCodeUnits) throw new Error('Choose an available model result and keep the transcript draft within 100,000 characters.');
  return { format: 'phabricator.audio-transcripts.v1', version: previous.version + 1, runs, draft: { runId: draft.runId, text: draft.text, updatedAt: new Date().toISOString() } };
}
