import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from './transcription-model.ts';

/** Generated text is an unverified local AI output, bound to the original encoded audio bytes. */
export interface LocalTranscript {
  format: 'phabricator.local-transcript.v1';
  runId: string; clipId: string; audioSha256: string; audioBytes: number; mimeType: string;
  createdAt: string; completedAt: string; decodedDurationMs: number;
  modelId: string; modelRevision: string; modelManifestSha256: string;
  runtimeVersion: '4.3.1'; device: 'wasm'; dtype: 'q8'; language: 'en';
  options: { sampleRate: 16000; chunkLengthS: 30; strideLengthS: 5 };
  text: string;
}
export type TranscriptionPhase = 'hashing' | 'decoding' | 'loading-model' | 'transcribing';
export interface TranscriptionProgress { phase: TranscriptionPhase }
export const LOCAL_TRANSCRIPTION_LIMITS = Object.freeze({ maxDurationMs: 600_000, maxClipBytes: 25 * 1024 * 1024, sampleRate: 16_000, maxChannels: 2, maxSamples: 9_600_000, maxTextCodeUnits: 100_000, maxRunMs: 30 * 60_000 });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isoTime = (value: unknown): value is string => typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** Persisted output stays bounded and source-addressed; an empty result is legitimate and never replaced with invented text. */
export function isLocalTranscript(value: unknown): value is LocalTranscript {
  if (!record(value) || value.format !== 'phabricator.local-transcript.v1' || !identity(value.runId) || !identity(value.clipId) || !digest(value.audioSha256) || value.modelManifestSha256 !== TRANSCRIPTION_MODEL_SHA256) return false;
  if (!Number.isSafeInteger(value.audioBytes) || Number(value.audioBytes) < 1 || Number(value.audioBytes) > LOCAL_TRANSCRIPTION_LIMITS.maxClipBytes || typeof value.mimeType !== 'string' || value.mimeType.length > 200 || !/^audio\/[a-z0-9!#$&^_.+-]+(?:[\x20\t]*;[\x20-\x7e]*)?$/i.test(value.mimeType)) return false;
  if (!isoTime(value.createdAt) || !isoTime(value.completedAt) || Date.parse(value.completedAt) < Date.parse(value.createdAt) || typeof value.decodedDurationMs !== 'number' || !Number.isFinite(value.decodedDurationMs) || value.decodedDurationMs <= 0 || value.decodedDurationMs > LOCAL_TRANSCRIPTION_LIMITS.maxDurationMs) return false;
  if (value.modelId !== TRANSCRIPTION_MODEL.repository || value.modelRevision !== TRANSCRIPTION_MODEL.revision || value.runtimeVersion !== '4.3.1' || value.device !== 'wasm' || value.dtype !== TRANSCRIPTION_MODEL.dtype || value.language !== TRANSCRIPTION_MODEL.language) return false;
  return record(value.options) && value.options.sampleRate === 16000 && value.options.chunkLengthS === 30 && value.options.strideLengthS === 5 && typeof value.text === 'string' && value.text.length <= LOCAL_TRANSCRIPTION_LIMITS.maxTextCodeUnits;
}
export class TranscriptionCancelledError extends Error {
  constructor() { super('Local transcription was cancelled.'); this.name = 'TranscriptionCancelledError'; }
}
export interface TranscriptionWorkerRequest {
  runId: string; samples: Float32Array; files: Map<string, ArrayBuffer>; modelBaseUrl: string;
  factoryUrl: string; wasm: ArrayBuffer; modelId: string; modelRevision: string;
}
export type TranscriptionWorkerReply = { runId: string; kind: 'progress'; phase: 'loading-model' | 'transcribing' } | { runId: string; kind: 'complete'; text: string } | { runId: string; kind: 'error'; message: string };
