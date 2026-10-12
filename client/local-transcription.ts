import type { AudioClip } from './audio-inbox.ts';
import { decodeTranscriptionAudio } from './audio-decode.ts';
import { assertSession, type WorkspaceSession } from './session.ts';
import { isLocalTranscript, LOCAL_TRANSCRIPTION_LIMITS as LIMITS, TranscriptionCancelledError, type LocalTranscript, type TranscriptionProgress, type TranscriptionWorkerReply, type TranscriptionWorkerRequest } from '../shared/local-transcription.ts';
import { isTranscriptionRuntimePath, TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model.ts';
import { applicationBase } from './mount.ts';
import { onTranscriptionModelInvalidated, type InstalledTranscriptionModel } from './transcription-model.ts';
export { TranscriptionCancelledError } from '../shared/local-transcription.ts';

export interface TranscriptionWorkerPort {
  onmessage: ((event: MessageEvent<TranscriptionWorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: TranscriptionWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}
/** Dependency injection keeps lifecycle tests independent from browser codecs and real model inference. */
export interface LocalTranscriberDependencies {
  decode(bytes: ArrayBuffer, signal: AbortSignal): Promise<Float32Array>;
  worker(url: string): TranscriptionWorkerPort;
  controlled(): boolean;
  page: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  origin: string;
  basePath: string;
  onModelInvalidated(listener: () => void, basePath: string): () => void;
}
export interface LocalTranscriber {
  readonly busy: boolean;
  transcribe(clip: AudioClip, prepared: InstalledTranscriptionModel, onProgress?: (progress: TranscriptionProgress) => void): Promise<LocalTranscript>;
  cancel(): void;
  dispose(): void;
}
const defaults = (): LocalTranscriberDependencies => ({
  decode: decodeTranscriptionAudio,
  worker: url => new Worker(url, { type: 'module', name: 'local-audio-transcription' }) as unknown as TranscriptionWorkerPort,
  controlled: () => typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker?.controller),
  page: typeof window === 'undefined' ? null : window,
  origin: typeof location === 'undefined' ? '' : location.origin,
  basePath: applicationBase(),
  onModelInvalidated: onTranscriptionModelInvalidated,
});
const sha256 = async (bytes: ArrayBuffer): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');

export function createLocalTranscriber(session: WorkspaceSession, options: { isActive?: () => boolean; dependencies?: Partial<LocalTranscriberDependencies> } = {}): LocalTranscriber {
  const dependencies = { ...defaults(), ...options.dependencies };
  let disposed = false, current: { abort: AbortController; worker: TranscriptionWorkerPort | null; cancel: () => void } | null = null;
  const cancel = () => current?.cancel();
  const removeInvalidationListener = dependencies.onModelInvalidated(cancel, dependencies.basePath);
  const dispose = () => { if (disposed) return; disposed = true; cancel(); removeInvalidationListener(); session.cleanupCallbacks.delete(dispose); dependencies.page?.removeEventListener('pagehide', cancel); };
  session.cleanupCallbacks.add(dispose); dependencies.page?.addEventListener('pagehide', cancel);
  return {
    get busy() { return current !== null; }, cancel, dispose,
    async transcribe(clip, prepared, onProgress) {
      assertSession(session);
      if (disposed || options.isActive?.() === false) throw new TranscriptionCancelledError();
      if (current) throw new Error('A local transcription is already running. Cancel it before starting another.');
      if (!dependencies.controlled()) throw new Error('Reload this application after model setup so its offline service worker can verify the transcription runtime.');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(clip.id) || !(clip.blob instanceof Blob) || !clip.blob.size || clip.bytes !== clip.blob.size || clip.bytes > LIMITS.maxClipBytes || clip.mimeType !== clip.blob.type || clip.mimeType.length > 200 || !/^audio\//.test(clip.mimeType) || !Number.isFinite(clip.durationMs) || clip.durationMs <= 0 || clip.durationMs > LIMITS.maxDurationMs) throw new Error('The complete recording must match its metadata and fit the 25 MiB / 10 minute limits.');
      if (prepared.manifestId !== TRANSCRIPTION_MODEL_SHA256 || prepared.manifest.repository !== TRANSCRIPTION_MODEL.repository || prepared.manifest.revision !== TRANSCRIPTION_MODEL.revision || !(prepared.files instanceof Map) || prepared.files.size !== TRANSCRIPTION_MODEL.files.length || !(prepared.runtime.wasm instanceof ArrayBuffer)) throw new Error('Install and verify the pinned local transcription model before transcribing.');
      const runtimeUrl = (value: string, extension: string) => {
        const url = new URL(value, dependencies.origin);
        if (url.origin !== dependencies.origin || !url.pathname.startsWith(dependencies.basePath) || !isTranscriptionRuntimePath(url.pathname.slice(dependencies.basePath.length)) || !url.pathname.endsWith(extension) || url.search || url.hash) throw new Error('The installed transcription runtime does not belong to this application mount.');
        return url.href;
      };
      // Capture the verified installation's handles before asynchronous hashing/decoding. A UI selection change cannot replace them.
      const installed = { workerUrl: runtimeUrl(prepared.runtime.workerUrl, '.js'), factoryUrl: runtimeUrl(prepared.runtime.factoryUrl, '.mjs'), wasm: prepared.runtime.wasm, files: new Map(prepared.files), modelBaseUrl: prepared.modelBaseUrl };
      const source = { clipId: clip.id, audioBytes: clip.bytes, mimeType: clip.mimeType, blob: clip.blob };
      const runId = crypto.randomUUID(), createdAt = new Date().toISOString(), abort = new AbortController();
      let rejectCancelled!: (error: Error) => void;
      const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
      const job = { abort, worker: null as TranscriptionWorkerPort | null, cancel: () => { if (abort.signal.aborted) return; abort.abort(); job.worker?.terminate(); rejectCancelled(new TranscriptionCancelledError()); } };
      current = job;
      const check = () => { if (disposed || current !== job || abort.signal.aborted || options.isActive?.() === false) throw new TranscriptionCancelledError(); assertSession(session); };
      const progress = (phase: TranscriptionProgress['phase']) => { check(); onProgress?.({ phase }); check(); };
      const fence = setInterval(() => { try { check(); } catch { job.cancel(); } }, 100);
      const timeout = setTimeout(() => { job.worker?.terminate(); abort.abort(); rejectCancelled(new Error('Local transcription exceeded its 30 minute processing limit. The recording was retained.')); }, LIMITS.maxRunMs);
      try {
        const work = async (): Promise<LocalTranscript> => {
          progress('hashing'); const bytes = await source.blob.arrayBuffer(); check();
          const audioSha256 = await sha256(bytes); check();
          progress('decoding'); const samples = await dependencies.decode(bytes, abort.signal); check();
          if (!(samples instanceof Float32Array) || !samples.length || samples.length > LIMITS.maxSamples) throw new Error('Decoded audio exceeds the complete recording limit.');
          for (const sample of samples) if (!Number.isFinite(sample) || Math.abs(sample) > 1) throw new Error('Decoded audio contains invalid samples.');
          const decodedDurationMs = samples.length / LIMITS.sampleRate * 1000;
          progress('loading-model');
          const text = await new Promise<string>((resolve, reject) => {
            const worker = dependencies.worker(installed.workerUrl); job.worker = worker;
            worker.onerror = () => reject(new Error('The local transcription worker failed. The recording was retained.'));
            worker.onmessage = event => {
              try {
                check(); const message = event.data;
                if (!message || message.runId !== runId) return;
                if (message.kind === 'progress' && (message.phase === 'loading-model' || message.phase === 'transcribing')) progress(message.phase);
                else if (message.kind === 'complete') {
                  if (typeof message.text !== 'string' || message.text.length > LIMITS.maxTextCodeUnits) throw new Error('The complete generated text exceeds the transcript limit.');
                  resolve(message.text);
                } else if (message.kind === 'error') reject(new Error(typeof message.message === 'string' ? message.message.slice(0, 600) : 'Local transcription failed.'));
              } catch (error) { reject(error); }
            };
            const request: TranscriptionWorkerRequest = { runId, samples, files: installed.files, modelBaseUrl: installed.modelBaseUrl, factoryUrl: installed.factoryUrl, wasm: installed.wasm, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision };
            worker.postMessage(request, [samples.buffer]);
          });
          check();
          const result: LocalTranscript = { format: 'phabricator.local-transcript.v1', runId, clipId: source.clipId, audioSha256, audioBytes: source.audioBytes, mimeType: source.mimeType, createdAt, completedAt: new Date().toISOString(), decodedDurationMs, modelId: TRANSCRIPTION_MODEL.repository, modelRevision: TRANSCRIPTION_MODEL.revision, modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeVersion: '4.3.1', device: 'wasm', dtype: 'q8', language: 'en', options: { sampleRate: 16000, chunkLengthS: 30, strideLengthS: 5 }, text };
          if (!isLocalTranscript(result)) throw new Error('The generated transcript has invalid provenance or exceeds its limits.');
          return result;
        };
        return await Promise.race([work(), cancelled]);
      } finally { clearInterval(fence); clearTimeout(timeout); job.worker?.terminate(); abort.abort(); if (current === job) current = null; }
    },
  };
}
