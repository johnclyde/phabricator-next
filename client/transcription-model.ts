import { normalizeBasePath } from '../shared/mount';
import { TRANSCRIPTION_LIMITS, TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256, validateTranscriptionRuntimeManifest, type TranscriptionModelManifest, type TranscriptionRuntimeManifest, type TranscriptionRuntimeUrls } from '../shared/transcription-model';
import { applicationBase } from './mount';

export interface InstalledTranscriptionModel {
  manifest: TranscriptionModelManifest;
  manifestId: string;
  modelBaseUrl: string;
  files: Map<string, ArrayBuffer>;
  runtime: { workerUrl: string; factoryUrl: string; wasm: ArrayBuffer };
}
export interface TranscriptionModelStatus { status: 'missing' | 'ready' | 'corrupt' | 'unavailable'; message: string; bytes: number; manifestId: string }
export interface TranscriptionInstallProgress { phase: 'download' | 'verify'; path: string; loaded: number; total: number }
export class TranscriptionModelError extends Error {
  constructor(public code: 'missing' | 'corrupt' | 'unavailable' | 'download' | 'quota', message: string) { super(message); this.name = 'TranscriptionModelError'; }
}
interface InstalledMarker { format: 'phabricator.transcription-install.v1'; modelManifestSha256: string; runtimeManifestSha256: string }
interface Options {
  runtimeAssets: TranscriptionRuntimeUrls;
  basePath?: string;
  // Injected platform boundaries let tests prove failures without large downloads.
  origin?: string;
  cacheStorage?: CacheStorage;
  fetch?: typeof fetch;
  locks?: Pick<LockManager, 'request'>;
  controlled?: () => boolean;
  model?: TranscriptionModelManifest;
  modelSha256?: string;
}
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Model installation was canceled.', 'AbortError'); };
const digest = async (bytes: ArrayBuffer): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
function error(code: TranscriptionModelError['code'], message: string): never { throw new TranscriptionModelError(code, message); }

/** Cache names are mount scoped public data. Audio and transcripts never enter this cache. */
export function transcriptionCacheName(scope: string): string { return `phabricator-next-transcription:${encodeURIComponent(scope)}:v1`; }
/** Public invalidation contains only a mount identity; never model input or output. */
export function onTranscriptionModelInvalidated(listener: () => void, basePath = applicationBase()): () => void {
  if (typeof window === 'undefined') return () => {};
  const scope = new URL(normalizeBasePath(basePath), location.origin).href;
  const key = `${transcriptionCacheName(scope)}:invalidation`, seen = new Set<string>();
  const notify = (nonce: unknown) => {
    if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(nonce) || seen.has(nonce)) return;
    seen.add(nonce); if (seen.size > 64) seen.delete(seen.values().next().value!); listener();
  };
  const local = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail?.scope === scope) notify(detail.nonce); };
  const storage = (event: StorageEvent) => { if (event.key === key) notify(event.newValue); };
  window.addEventListener('transcription-model-invalidated', local);
  window.addEventListener('storage', storage);
  let channel: BroadcastChannel | null = null;
  try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(transcriptionCacheName(scope)); } catch { /* Storage events remain available when channel creation is denied. */ }
  if (channel) channel.onmessage = event => { if (event.data?.type === 'invalidate') notify(event.data.nonce); };
  return () => { window.removeEventListener('transcription-model-invalidated', local); window.removeEventListener('storage', storage); channel?.close(); };
}
function invalidate(scope: string): boolean {
  if (typeof window === 'undefined') return true;
  const nonce = crypto.randomUUID(), name = transcriptionCacheName(scope); let delivered = false;
  window.dispatchEvent(new CustomEvent('transcription-model-invalidated', { detail: { scope, nonce } }));
  try { if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(name); try { channel.postMessage({ type: 'invalidate', nonce }); delivered = true; } finally { channel.close(); } } } catch { /* Fall back to a public storage nonce. */ }
  try { window.localStorage.setItem(`${name}:invalidation`, nonce); delivered = true; } catch { /* Private audio and transcript data are never written here. */ }
  return delivered;
}

async function bounded(response: Response, maximum: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  check(signal);
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) error('corrupt', 'A transcription asset exceeds its declared size. Reinstall the model.');
  const reader = response.body?.getReader(); if (!reader) error('corrupt', 'A transcription asset has no readable body.');
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) { check(signal); const next = await reader.read(); check(signal); if (next.done) break; size += next.value.byteLength; if (size > maximum) { await reader.cancel(); error('corrupt', 'A transcription asset exceeds its permitted size.'); } chunks.push(next.value); }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result.buffer;
}

/** No operation downloads except install(). Every inference read verifies the complete installation. */
export function createTranscriptionModelCache(options: Options) {
  const basePath = normalizeBasePath(options.basePath ?? applicationBase());
  const origin = options.origin ?? globalThis.location?.origin;
  if (!origin || !/^https?:\/\//.test(origin)) error('unavailable', 'A same-origin browser context is required for local transcription.');
  const scope = new URL(basePath, origin).href, cacheName = transcriptionCacheName(scope);
  const model = options.model ?? TRANSCRIPTION_MODEL, manifestId = options.modelSha256 ?? TRANSCRIPTION_MODEL_SHA256;
  const modelBytes = model.files.reduce((sum, file) => sum + file.bytes, 0);
  const modelBaseUrl = new URL(`transcription-model/${model.id}/`, scope).href;
  const modelManifestUrl = new URL('transcription-model/manifest.json', scope).href;
  const runtimeManifestUrl = new URL('transcription-runtime.json', scope).href;
  const markerUrl = new URL('transcription-model/installed.json', scope).href;
  const cacheStorage = options.cacheStorage ?? globalThis.caches;
  const locks = options.locks ?? globalThis.navigator?.locks;
  const fetcher = options.fetch ?? globalThis.fetch;
  const runtimeUrls = Object.fromEntries(Object.entries(options.runtimeAssets).map(([role, path]) => [role, new URL(path, scope).href])) as unknown as TranscriptionRuntimeUrls;
  const runtimePaths = Object.values(runtimeUrls).map(value => { const url = new URL(value); if (url.origin !== origin || !url.href.startsWith(scope) || url.search || url.hash) error('corrupt', 'The transcription runtime must belong to this application mount.'); return url.pathname.slice(basePath.length); });
  const controlled = options.controlled ?? (() => Boolean(globalThis.navigator?.serviceWorker?.controller));
  const withLock = async <T>(mode: LockMode, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> => {
    check(signal); if (!cacheStorage || !locks) error('unavailable', 'This browser does not provide the Cache Storage and Web Locks needed for safe offline model installation.');
    return locks.request(cacheName, { mode, ...(signal ? { signal } : {}) }, async () => { check(signal); return action(); });
  };
  const download = async (url: string, maximum: number, signal?: AbortSignal) => {
    check(signal);
    const response = await fetcher(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal }); check(signal);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || response.type === 'opaque') error('download', 'The operator has not staged a complete local transcription model, or an asset could not be downloaded. No model was installed.');
    return bounded(response, maximum, signal);
  };
  const decodeJSON = (bytes: ArrayBuffer): unknown => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return error('corrupt', 'A transcription manifest is malformed. Reinstall the model.'); } };
  const verify = async (bytes: ArrayBuffer, expected: { bytes: number; sha256: string }, signal?: AbortSignal) => { check(signal); if (bytes.byteLength !== expected.bytes || await digest(bytes) !== expected.sha256) error('corrupt', 'A transcription asset failed its pinned size or SHA-256 check. Reinstall the model.'); check(signal); };
  const read = async (signal?: AbortSignal): Promise<InstalledTranscriptionModel & { bytes: number }> => withLock('shared', signal, async () => {
    if (!await cacheStorage.has(cacheName)) error('missing', 'Install the public model explicitly before transcribing offline.');
    const cache = await cacheStorage.open(cacheName), markerResponse = await cache.match(markerUrl);
    if (!markerResponse) error('missing', 'The model installation is incomplete. Install it again.');
    const marker = decodeJSON(await bounded(markerResponse, TRANSCRIPTION_LIMITS.manifestBytes, signal)) as InstalledMarker | null;
    if (!marker || Object.keys(marker).sort().join(',') !== 'format,modelManifestSha256,runtimeManifestSha256' || marker.format !== 'phabricator.transcription-install.v1' || marker.modelManifestSha256 !== manifestId || !/^[0-9a-f]{64}$/.test(marker.runtimeManifestSha256)) error('corrupt', 'The cached model belongs to another model version or is corrupt. Reinstall it explicitly.');
    const cached = async (url: string, maximum: number) => { const response = await cache.match(url); if (!response || response.status !== 200) error('corrupt', 'An installed transcription asset is missing. Reinstall the model.'); return bounded(response, maximum, signal); };
    const manifestBytes = await cached(modelManifestUrl, TRANSCRIPTION_LIMITS.manifestBytes);
    if (await digest(manifestBytes) !== manifestId) error('corrupt', 'The installed model manifest failed its pinned SHA-256 check.');
    const runtimeBytes = await cached(runtimeManifestUrl, TRANSCRIPTION_LIMITS.manifestBytes);
    if (await digest(runtimeBytes) !== marker.runtimeManifestSha256) error('corrupt', 'The installed runtime manifest failed its SHA-256 check.');
    const runtime = validateTranscriptionRuntimeManifest(decodeJSON(runtimeBytes), runtimePaths);
    const files = new Map<string, ArrayBuffer>();
    for (const file of model.files) { const bytes = await cached(new URL(file.path, modelBaseUrl).href, file.bytes); await verify(bytes, file, signal); files.set(file.path, bytes); }
    let wasm: ArrayBuffer | undefined;
    for (const file of runtime.files) { const url = new URL(file.path, scope).href, bytes = await cached(url, file.bytes); await verify(bytes, file, signal); if (url === runtimeUrls.wasm) wasm = bytes; }
    if (!wasm) error('corrupt', 'The installed transcription runtime has no verified WebAssembly binary.');
    check(signal);
    return { manifest: model, manifestId, modelBaseUrl, files, runtime: { workerUrl: runtimeUrls.worker, factoryUrl: runtimeUrls.factory, wasm }, bytes: modelBytes + runtime.files.reduce((sum, file) => sum + file.bytes, 0) };
  });
  return {
    manifest: model, manifestId,
    async status({ signal }: { signal?: AbortSignal } = {}): Promise<TranscriptionModelStatus> {
      try { const result = await read(signal); return { status: 'ready', message: 'Model and runtime verified on this device. Transcription can run offline.', bytes: result.bytes, manifestId }; }
      catch (failure) { check(signal); return { status: failure instanceof TranscriptionModelError && (failure.code === 'missing' || failure.code === 'corrupt') ? failure.code : 'unavailable', message: failure instanceof Error ? failure.message : 'Local model storage is unavailable.', bytes: modelBytes, manifestId }; }
    },
    async install({ signal, onProgress }: { signal?: AbortSignal; onProgress?: (value: TranscriptionInstallProgress) => void } = {}): Promise<TranscriptionModelStatus> {
      if (!controlled()) error('unavailable', 'Wait for the offline application service worker, then install the model again.');
      check(signal); if (!invalidate(scope)) error('unavailable', 'This browser cannot notify other tabs about model changes. Enable local storage or browser channels and try again.');
      return withLock('exclusive', signal, async () => {
        // A failed or canceled attempt never leaves a completed marker. Cross-tab operations share this lock.
        await cacheStorage.delete(cacheName); check(signal); const cache = await cacheStorage.open(cacheName);
        try {
          const manifestBytes = await download(modelManifestUrl, TRANSCRIPTION_LIMITS.manifestBytes, signal);
          if (await digest(manifestBytes) !== manifestId) error('corrupt', 'The operator-staged model manifest does not match this application release.');
          const runtimeBytes = await download(runtimeManifestUrl, TRANSCRIPTION_LIMITS.manifestBytes, signal);
          const runtime = validateTranscriptionRuntimeManifest(decodeJSON(runtimeBytes), runtimePaths), runtimeManifestSha256 = await digest(runtimeBytes);
          const total = modelBytes + runtime.files.reduce((sum, file) => sum + file.bytes, 0); let loaded = 0;
          const put = async (url: string, bytes: ArrayBuffer, type: string) => { check(signal); await cache.put(url, new Response(bytes, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(bytes.byteLength) } })); check(signal); };
          await put(modelManifestUrl, manifestBytes, 'application/json'); await put(runtimeManifestUrl, runtimeBytes, 'application/json');
          for (const file of [...model.files, ...runtime.files]) {
            const runtimeAsset = runtime.files.includes(file), url = new URL(file.path, runtimeAsset ? scope : modelBaseUrl).href;
            onProgress?.({ phase: 'download', path: file.path, loaded, total });
            const bytes = await download(runtimeAsset ? `${url}?transcription-install=1` : url, file.bytes, signal);
            onProgress?.({ phase: 'verify', path: file.path, loaded, total }); await verify(bytes, file, signal);
            await put(url, bytes, file.path.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(file.path) ? 'text/javascript' : file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
            loaded += bytes.byteLength; onProgress?.({ phase: 'verify', path: file.path, loaded, total });
          }
          const marker: InstalledMarker = { format: 'phabricator.transcription-install.v1', modelManifestSha256: manifestId, runtimeManifestSha256 };
          await put(markerUrl, new TextEncoder().encode(JSON.stringify(marker)).buffer, 'application/json');
          return { status: 'ready', message: 'Public model and runtime installed and verified. Audio was not uploaded.', bytes: total, manifestId };
        } catch (failure) {
          await cacheStorage.delete(cacheName); check(signal);
          if (failure instanceof DOMException && failure.name === 'QuotaExceededError') error('quota', 'There is not enough browser storage for the model. Nothing was installed; remove other data or try another browser.');
          throw failure;
        } finally { invalidate(scope); }
      });
    },
    read: ({ signal }: { signal?: AbortSignal } = {}) => read(signal),
    remove: async () => {
      if (!invalidate(scope)) error('unavailable', 'This browser cannot notify other tabs about model changes. Enable local storage or browser channels and try again.');
      return withLock('exclusive', undefined, async () => { await cacheStorage.delete(cacheName); invalidate(scope); });
    },
  };
}
