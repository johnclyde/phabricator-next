import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transcriptionCacheName } from '../client/transcription-model.ts';
import { TRANSCRIPTION_MODEL_SHA256 } from '../shared/transcription-model.ts';

const source = readFileSync(new URL('../client/public/sw.js', import.meta.url), 'utf8');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type FetchEvent = { request: Request; respondWith: (value: Promise<Response>) => void };
function worker(base = '/workspace/', supported = true) {
  const scope = `https://example.test${base}`, name = transcriptionCacheName(scope);
  const rows = new Map<string, Response>(), locks: { name: string; mode: string }[] = [], network: string[] = [];
  let fetchHandler!: (event: FetchEvent) => void;
  const modelMarker = `${scope}transcription-model/installed.json`, runtimeManifest = `${scope}transcription-runtime.json`;
  const files = ['transcription-worker-test.js', 'transcription-runtime-test.mjs', 'transcription-runtime-test.wasm'].map((path, index) => ({ path: `assets/${path}`, bytes: 14, sha256: hash(`public bytes ${index}`) }));
  const manifest = { format: 'phabricator.transcription-runtime.v1', files };
  const putManifest = (value: unknown = manifest) => {
    const text = JSON.stringify(value); rows.set(runtimeManifest, new Response(text));
    rows.set(modelMarker, new Response(JSON.stringify({ format: 'phabricator.transcription-install.v1', modelManifestSha256: TRANSCRIPTION_MODEL_SHA256, runtimeManifestSha256: hash(text) })));
  };
  const cache = { match: async (url: string | Request) => {
    const response = rows.get(typeof url === 'string' ? url : url.url);
    return response ? new Response(await response.clone().arrayBuffer(), { status: response.status, headers: response.headers }) : undefined;
  } };
  runInNewContext(source, {
    URL, Request, Response, TextDecoder, Uint8Array, crypto,
    self: { registration: { scope }, navigator: supported ? { locks: { request: async (key: string, options: { mode: string }, callback: () => Promise<Response>) => { locks.push({ name: key, mode: options.mode }); return callback(); } } } : {}, addEventListener: (event: string, callback: (event: FetchEvent) => void) => { if (event === 'fetch') fetchHandler = callback; } },
    caches: { has: async (key: string) => key === name && rows.size > 0, open: async (key: string) => { assert.ok(key === name || key.startsWith('phabricator-next-shell:')); return cache; } },
    fetch: async (input: Request | string) => { network.push(typeof input === 'string' ? input : input.url); return new Response('network'); },
  });
  const request = (url: string, method = 'GET') => { let result: Promise<Response> | undefined; fetchHandler({ request: new Request(new URL(url, scope), { method }), respondWith: value => { result = value; } }); return result; };
  const install = () => { putManifest(); files.forEach((file, index) => rows.set(`${scope}${file.path}`, new Response(`public bytes ${index}`))); };
  return { scope, name, rows, locks, network, files, manifest, putManifest, install, request, modelMarker, runtimeManifest };
}

test('bare runtime requests require a complete verified cache and never fall back to the network', async () => {
  const w = worker();
  assert.equal((await w.request(w.files[0]!.path))?.status, 503);
  w.install();
  for (const [index, file] of w.files.entries()) {
    const response = await w.request(file.path); assert.equal(response?.status, 200); assert.equal(await response?.text(), `public bytes ${index}`);
    assert.equal(response?.headers.get('content-type'), index === 2 ? 'application/wasm' : 'text/javascript');
    assert.equal(response?.headers.get('cache-control'), 'no-store');
    assert.match(response!.headers.get('content-security-policy')!, /connect-src 'none'/);
  }
  assert.equal((await w.request('assets/transcription-worker-otherbuild.js'))?.status, 503);
  assert.deepEqual(w.network, []); assert.ok(w.locks.every(lock => lock.name === w.name && lock.mode === 'shared'));
});

test('corrupt, missing, malformed and unbounded public runtime records stay fail closed', async () => {
  for (const failure of ['bytes', 'missing', 'marker', 'manifest-hash', 'extra-field', 'duplicate', 'size', 'path', 'partial']) {
    const w = worker(); w.install(); const file = w.files[0]!;
    if (failure === 'bytes') w.rows.set(`${w.scope}${file.path}`, new Response('private garbage'));
    if (failure === 'missing') w.rows.delete(`${w.scope}${file.path}`);
    if (failure === 'marker') w.rows.set(w.modelMarker, new Response('{}'));
    if (failure === 'manifest-hash') w.rows.set(w.runtimeManifest, new Response('{}'));
    if (failure === 'extra-field') w.putManifest({ ...w.manifest, extra: true });
    if (failure === 'duplicate') w.putManifest({ ...w.manifest, files: [file, file, w.files[2]] });
    if (failure === 'size') w.putManifest({ ...w.manifest, files: w.files.map(item => ({ ...item, bytes: 100_000_000 })) });
    if (failure === 'path') w.putManifest({ ...w.manifest, files: [{ ...file, path: '../api/source' }, ...w.files.slice(1)] });
    if (failure === 'partial') w.putManifest({ ...w.manifest, files: [file] });
    assert.equal((await w.request(file.path))?.status, 503, failure); assert.deepEqual(w.network, [], failure);
  }
  const unsupported = worker('/', false); unsupported.install(); assert.equal((await unsupported.request(unsupported.files[0]!.path))?.status, 503); assert.deepEqual(unsupported.network, []);
});

test('explicit installer queries bypass runtime interception while private data and sibling mounts stay outside it', async () => {
  const w = worker(); w.install();
  for (const path of [`${w.files[0]!.path}?transcription-install=1`, '/assets/transcription-worker-test.js', '/other/assets/transcription-runtime-test.wasm', '/workspace/api/source', '/workspace/auth/session', '/workspace/transcription-model/model/weights.onnx', 'https://another.test/workspace/assets/transcription-worker-test.js']) assert.equal(w.request(path), undefined, path);
  assert.equal(w.request(w.files[0]!.path, 'POST'), undefined); assert.deepEqual(w.network, []);
  // Existing ordinary shell assets retain their independent network fallback.
  const response = await w.request('assets/app-other.js'); assert.equal(await response?.text(), 'network'); assert.deepEqual(w.network, [`${w.scope}assets/app-other.js`]);
});
