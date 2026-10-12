import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTranscriptionModelCache, onTranscriptionModelInvalidated, transcriptionCacheName } from '../client/transcription-model.ts';
import { TRANSCRIPTION_MODEL, TRANSCRIPTION_MODEL_SHA256, transcriptionModelManifestText, validateTranscriptionRuntimeManifest, type TranscriptionModelManifest } from '../shared/transcription-model.ts';
import { prepareTranscriptionModel } from '../scripts/prepare-transcription-model.ts';
import { serveTranscriptionModel, transcriptionModelDirectory } from '../server/transcription-model.ts';
import { createApp } from '../server/app.ts';
import { createStore } from '../server/store.ts';
import { createAuth } from '../server/auth.ts';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const body = (text: string) => new TextEncoder().encode(text);
const tinyFiles = [{ path: 'config.json', data: '{"model_type":"whisper"}' }, { path: 'onnx/test.onnx', data: 'public test model bytes' }];
const model: TranscriptionModelManifest = { ...TRANSCRIPTION_MODEL, files: tinyFiles.map(file => ({ path: file.path, bytes: body(file.data).length, sha256: sha(file.data), source: `https://example.test/${file.path}` })) };
const manifestText = JSON.stringify(model) + '\n', modelSha256 = sha(manifestText);
class MemoryCache {
  rows = new Map<string, Response>(); fail = false;
  async match(key: string) { return this.rows.get(key)?.clone(); }
  async put(key: string, value: Response) { if (this.fail) throw new DOMException('Storage full', 'QuotaExceededError'); this.rows.set(key, value.clone()); }
}
class MemoryCaches {
  caches = new Map<string, MemoryCache>(); failPut = false;
  async has(name: string) { return this.caches.has(name); }
  async open(name: string) { let cache = this.caches.get(name); if (!cache) { cache = new MemoryCache(); cache.fail = this.failPut; this.caches.set(name, cache); } return cache; }
  async delete(name: string) { return this.caches.delete(name); }
}
class SerialLocks {
  tails = new Map<string, Promise<unknown>>();
  async request<T>(name: string, options: { signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => { if (options.signal?.aborted) throw new DOMException('Canceled', 'AbortError'); return callback(); }); this.tails.set(name, next); return next;
  }
}
function fixture(basePath = '/', platform = { cache: new MemoryCaches(), locks: new SerialLocks() }) {
  const scope = `https://example.test${basePath}`, runtimeAssets = { worker: `${basePath}assets/transcription-worker-unit.js`, factory: `${basePath}assets/transcription-runtime-unit.mjs`, wasm: `${basePath}assets/transcription-runtime-unit.wasm` };
  const runtimeFiles = Object.values(runtimeAssets).map((path, index) => ({ path: path.slice(basePath.length), bytes: body(`public runtime ${index}`).length, sha256: sha(`public runtime ${index}`) }));
  const runtime = { format: 'phabricator.transcription-runtime.v1', files: runtimeFiles };
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const replies = new Map<string, string>([[`${scope}transcription-model/manifest.json`, manifestText], [`${scope}transcription-runtime.json`, JSON.stringify(runtime)]]);
  for (const file of tinyFiles) replies.set(`${scope}transcription-model/${model.id}/${file.path}`, file.data);
  runtimeFiles.forEach((file, index) => replies.set(`${scope}${file.path}?transcription-install=1`, `public runtime ${index}`));
  let intercept: ((url: string) => Promise<void>) | undefined;
  const fetcher: typeof fetch = async (input, init) => { const url = String(input); requests.push({ url, init }); await intercept?.(url); const value = replies.get(url); return value === undefined ? new Response('missing', { status: 404 }) : new Response(value); };
  const options = { basePath, origin: 'https://example.test', runtimeAssets, model, modelSha256, cacheStorage: platform.cache as unknown as CacheStorage, locks: platform.locks as unknown as LockManager, fetch: fetcher, controlled: () => true };
  return { client: createTranscriptionModelCache(options), options, platform, requests, replies, runtime, scope, intercept: (value: typeof intercept) => { intercept = value; } };
}

test('compiled model manifest pins exact revision, files, license and SHA-256', () => {
  assert.equal(sha(transcriptionModelManifestText()), TRANSCRIPTION_MODEL_SHA256);
  assert.equal(TRANSCRIPTION_MODEL.revision, '2575352d61be1bf7225cf8f8b268a4678025fc58');
  assert.ok(TRANSCRIPTION_MODEL.files.some(file => file.path === 'LICENSE')); assert.ok(TRANSCRIPTION_MODEL.files.some(file => file.path === 'README.md'));
  assert.equal(TRANSCRIPTION_MODEL.files.reduce((sum, file) => sum + file.bytes, 0), 43_537_974);
});

test('only explicit installation downloads public pinned assets; verified inference reads are offline', async () => {
  const f = fixture('/workspace/'); assert.equal((await f.client.status()).status, 'missing'); assert.equal(f.requests.length, 0);
  const progress: number[] = []; assert.equal((await f.client.install({ onProgress: value => progress.push(value.loaded) })).status, 'ready');
  assert.equal(f.requests.length, 7); assert.ok(f.requests.every(item => item.url.startsWith(f.scope) && item.init?.credentials === 'omit' && item.init.redirect === 'error' && item.init.cache === 'no-store'));
  assert.equal(f.requests.filter(item => item.url.endsWith('?transcription-install=1')).length, 3); assert.ok(progress.at(-1)! > 0);
  f.intercept(async () => { throw new Error('Network disabled'); });
  const installed = await f.client.read(); assert.equal(installed.manifestId, modelSha256); assert.equal(new TextDecoder().decode(installed.files.get('config.json')), tinyFiles[0]!.data);
  assert.equal(new TextDecoder().decode(installed.runtime.wasm), 'public runtime 2'); assert.equal((await f.client.status()).status, 'ready'); assert.equal(f.requests.length, 7);
  await f.client.remove(); assert.equal((await f.client.status()).status, 'missing');
});

test('corrupt model bytes, changed build, missing assets and tampered markers are never ready', async () => {
  for (const damage of ['bytes', 'missing', 'marker', 'runtime', 'build']) {
    const f = fixture(); await f.client.install(); const cache = await f.platform.cache.open(transcriptionCacheName(f.scope));
    if (damage === 'bytes') cache.rows.set(`${f.scope}transcription-model/${model.id}/config.json`, new Response('changed'));
    if (damage === 'missing') cache.rows.delete(`${f.scope}transcription-model/${model.id}/onnx/test.onnx`);
    if (damage === 'marker') cache.rows.set(`${f.scope}transcription-model/installed.json`, new Response('{}'));
    if (damage === 'runtime') cache.rows.set(`${f.scope}assets/transcription-runtime-unit.wasm`, new Response('corrupt runtime'));
    const client = damage === 'build' ? createTranscriptionModelCache({ ...f.options, runtimeAssets: { ...f.options.runtimeAssets, worker: '/assets/transcription-worker-next.js' } }) : f.client;
    const status = await client.status(); assert.notEqual(status.status, 'ready', damage); await assert.rejects(client.read()); assert.equal(f.requests.length, 7);
  }
});

test('bad manifests, oversized content and interrupted or quota-limited installs leave no completed cache', async () => {
  for (const failure of ['manifest', 'runtime-set', 'oversized', 'abort', 'quota']) {
    const f = fixture(), controller = new AbortController();
    if (failure === 'manifest') f.replies.set(`${f.scope}transcription-model/manifest.json`, '{}');
    if (failure === 'runtime-set') f.replies.set(`${f.scope}transcription-runtime.json`, JSON.stringify({ ...f.runtime, files: [...f.runtime.files, f.runtime.files[0]] }));
    if (failure === 'oversized') f.replies.set(`${f.scope}transcription-model/${model.id}/config.json`, 'x'.repeat(100));
    if (failure === 'abort') f.intercept(async url => { if (url.endsWith('/config.json')) controller.abort(); });
    if (failure === 'quota') f.platform.cache.failPut = true;
    await assert.rejects(f.client.install({ signal: controller.signal })); assert.equal(await f.platform.cache.has(transcriptionCacheName(f.scope)), false, failure); assert.equal((await f.client.status()).status, 'missing');
  }
});

test('removal and concurrent installation serialize across instances and preserve sibling mount data', async () => {
  const first = fixture(), second = fixture('/', first.platform), sibling = fixture('/sibling/', first.platform); await sibling.client.install();
  let release!: () => void, entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  first.intercept(async url => { if (url.endsWith('/config.json')) { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
  const installation = first.client.install(); await waiting; let removed = false; const removal = second.client.remove().then(() => { removed = true; });
  await Promise.resolve(); assert.equal(removed, false); release(); await installation; await removal;
  assert.equal((await first.client.status()).status, 'missing'); assert.equal((await sibling.client.status()).status, 'ready');
});

test('public mount-scoped storage notices retire tabs when channels are blocked and report completed removal', async () => {
  const originals = Object.fromEntries(['window', 'location', 'BroadcastChannel'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const target = new EventTarget(), stored = new Map<string, string>(); let denyStorage = false;
  Object.assign(target, { localStorage: { setItem: (key: string, value: string) => { if (denyStorage) throw new DOMException('Denied', 'SecurityError'); stored.set(key, value); } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://example.test' } });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: class { constructor() { throw new DOMException('Denied', 'SecurityError'); } } });
  const f = fixture(), states: boolean[] = []; let siblingNotices = 0;
  const stop = onTranscriptionModelInvalidated(() => states.push(f.platform.cache.caches.has(transcriptionCacheName(f.scope))), '/');
  const stopSibling = onTranscriptionModelInvalidated(() => { siblingNotices++; }, '/sibling/');
  try {
    let release!: () => void, entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.intercept(async url => { if (url.endsWith('/config.json')) { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
    const install = f.client.install(); await waiting; const remove = f.client.remove(); release(); await install; await remove;
    assert.deepEqual(states, [false, true, true, false]); assert.equal((await f.client.status()).status, 'missing'); assert.equal(siblingNotices, 0);
    const key = `${transcriptionCacheName(f.scope)}:invalidation`; assert.deepEqual([...stored.keys()], [key]); assert.match(stored.get(key)!, /^[0-9a-f-]{36}$/);
    const storageEvent = (nonce: string) => { const event = new Event('storage'); Object.defineProperties(event, { key: { value: key }, newValue: { value: nonce } }); target.dispatchEvent(event); };
    storageEvent(stored.get(key)!); assert.equal(states.length, 4, 'same notification is deduplicated across transports');
    storageEvent(crypto.randomUUID()); assert.equal(states.length, 5, 'another tab storage event is received');
    denyStorage = true; const requests = f.requests.length; await assert.rejects(f.client.install(), /cannot notify other tabs/); await assert.rejects(f.client.remove(), /cannot notify other tabs/); assert.equal(f.requests.length, requests); assert.equal((await f.client.status()).status, 'missing');
  } finally {
    stop(); stopSibling();
    for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('runtime allowlist rejects unknown paths, duplicates, unbounded bytes and mismatched builds', () => {
  const f = fixture(), expected = f.runtime.files.map(file => file.path);
  assert.doesNotThrow(() => validateTranscriptionRuntimeManifest(f.runtime, expected));
  for (const value of [{ ...f.runtime, extra: true }, { ...f.runtime, files: [f.runtime.files[0], f.runtime.files[0], f.runtime.files[2]] }, { ...f.runtime, files: f.runtime.files.map(file => ({ ...file, bytes: Infinity })) }, { ...f.runtime, files: f.runtime.files.map(file => ({ ...file, path: '../api/private' })) }]) assert.throws(() => validateTranscriptionRuntimeManifest(value, expected));
  assert.throws(() => createTranscriptionModelCache({ ...f.options, runtimeAssets: { ...f.options.runtimeAssets, worker: 'https://other.test/assets/transcription-worker-unit.js' } }));
});

test('model installation requires a controlling worker and supported storage locks', async () => {
  const f = fixture(); const unavailable = createTranscriptionModelCache({ ...f.options, controlled: () => false }); await assert.rejects(unavailable.install(), /service worker/); assert.equal(f.requests.length, 0);
});

test('operator staging verifies every byte, preserves a prior destination, and cleans failed releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-model-stage-')), target = join(root, 'release');
  const fetcher: typeof fetch = async input => { const file = tinyFiles.find(file => String(input).endsWith(file.path)); return new Response(file!.data); };
  try {
    await prepareTranscriptionModel(target, { fetch: fetcher, model }); assert.equal(await readFile(join(target, 'manifest.json'), 'utf8'), manifestText);
    await assert.rejects(prepareTranscriptionModel(target, { fetch: fetcher, model }), /already exists/); assert.equal(await readFile(join(target, 'config.json'), 'utf8'), tinyFiles[0]!.data);
    const empty = join(root, 'empty'); await mkdir(empty); await assert.rejects(prepareTranscriptionModel(empty, { fetch: fetcher, model }), /already exists/); assert.deepEqual(await readdir(empty), []);
    const bad = join(root, 'bad'); await assert.rejects(prepareTranscriptionModel(bad, { model, fetch: async () => new Response('bad bytes') }), /mismatch/); await assert.rejects(readFile(join(bad, 'manifest.json')));
    const controller = new AbortController(); controller.abort(); await assert.rejects(prepareTranscriptionModel(join(root, 'cancel'), { model, fetch: fetcher, signal: controller.signal }), /canceled/);
    const streaming = new AbortController(); let canceled = false;
    await assert.rejects(prepareTranscriptionModel(join(root, 'stream-cancel'), { model, signal: streaming.signal, fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(body('{')); streaming.abort(); }, cancel() { canceled = true; } })) }), /canceled/);
    assert.equal(canceled, true); assert.ok((await readdir(root)).every(name => !name.includes('.staging-')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public model delivery only serves verified allowlisted bytes and rejects symlinks or corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-model-http-')), target = join(root, 'release');
  await prepareTranscriptionModel(target, { model, fetch: async input => new Response(tinyFiles.find(file => String(input).endsWith(file.path))!.data) });
  const server = createServer((req, res) => { void serveTranscriptionModel(req, res, req.url!, target, model, modelSha256).catch(error => { res.statusCode = error.status ?? 500; res.end('unavailable'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const good = await fetch(`${base}/transcription-model/${model.id}/config.json`); assert.equal(good.status, 200); assert.equal(await good.text(), tinyFiles[0]!.data); assert.equal(good.headers.get('cache-control'), 'no-store');
    const head = await fetch(`${base}/transcription-model/manifest.json`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await fetch(`${base}/transcription-model/operator-secret`)).status, 404);
    await writeFile(join(target, 'config.json'), 'corruption'); assert.equal((await fetch(`${base}/transcription-model/${model.id}/config.json`)).status, 503);
    await rm(join(target, 'config.json')); await writeFile(join(root, 'secret.json'), tinyFiles[0]!.data); await symlink(join(root, 'secret.json'), join(target, 'config.json')); assert.equal((await fetch(`${base}/transcription-model/${model.id}/config.json`)).status, 503);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('app model capability is mount-scoped, public in password mode, and never creates auth cookies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phab-model-app-')); await writeFile(join(root, 'manifest.json'), transcriptionModelManifestText());
  const store = createStore({ path: ':memory:' });
  await createAuth({ database: store.database, mode: 'local', basePath: '/', provisioning: true }).createAccount({ username: 'model-test', displayName: 'Model route test', password: 'test-only-model-password-2026' });
  const app = createApp({ store, seed: false, authMode: 'password', basePath: '/workspace/', transcriptionModelDirectory: root });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/workspace/transcription-model/manifest.json`); assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null); assert.equal(await response.text(), transcriptionModelManifestText());
    assert.equal((await fetch(`${base}/transcription-model/manifest.json`)).status, 404); assert.equal((await fetch(`${base}/workspace/transcription-model/manifest.json?x=1`)).status, 400);
    assert.equal((await fetch(`${base}/workspace/api/state`)).status, 401); assert.throws(() => transcriptionModelDirectory(' '), /APP_TRANSCRIPTION_MODEL_DIR/);
  } finally { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
