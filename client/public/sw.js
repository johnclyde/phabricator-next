/* Cache only this installation's static shell. API snapshots live in the client. */
const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname;
const SHELL = SCOPE.href;
const CACHE_PREFIX = `phabricator-next-shell:${encodeURIComponent(SHELL)}:`;
const CACHE = `${CACHE_PREFIX}v2`;
const STATIC = new Set([new URL('icon.svg', SCOPE).href, new URL('manifest.webmanifest', SCOPE).href]);
const MODEL_CACHE = `phabricator-next-transcription:${encodeURIComponent(SCOPE.href)}:v1`;
const MODEL_MARKER = new URL('transcription-model/installed.json', SCOPE).href;
const RUNTIME_MANIFEST = new URL('transcription-runtime.json', SCOPE).href;
const isTranscriptionRuntime = url => url.pathname.startsWith(`${BASE}assets/`) &&
  /^transcription-(?:worker|runtime)-[A-Za-z0-9_-]+\.(?:js|mjs|wasm)$/.test(url.pathname.slice(`${BASE}assets/`.length));

async function verifiedRuntime(request) {
  const unavailable = () => new Response('The verified offline transcription runtime is unavailable. Reinstall the model.', { status: 503, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  if (!self.navigator.locks) return unavailable();
  return self.navigator.locks.request(MODEL_CACHE, { mode: 'shared' }, async () => {
    try {
      if (!await caches.has(MODEL_CACHE)) return unavailable();
      const cache = await caches.open(MODEL_CACHE);
      const bounded = async (response, maximum) => {
        if (!response || response.status !== 200) throw new Error('missing asset');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > maximum) { await reader.cancel(); throw new Error('oversized asset'); } chunks.push(next.value); } } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
      };
      const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      const marker = JSON.parse(new TextDecoder().decode(await bounded(await cache.match(MODEL_MARKER), 65536)));
      if (!marker || Object.keys(marker).sort().join(',') !== 'format,modelManifestSha256,runtimeManifestSha256' || marker.format !== 'phabricator.transcription-install.v1' || !/^[0-9a-f]{64}$/.test(marker.modelManifestSha256) || !/^[0-9a-f]{64}$/.test(marker.runtimeManifestSha256)) return unavailable();
      const manifestBytes = await bounded(await cache.match(RUNTIME_MANIFEST), 65536);
      if (await hash(manifestBytes) !== marker.runtimeManifestSha256) return unavailable();
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
      if (!manifest || Object.keys(manifest).sort().join(',') !== 'files,format' || manifest.format !== 'phabricator.transcription-runtime.v1' || !Array.isArray(manifest.files) || manifest.files.length !== 3) return unavailable();
      const seen = new Set(); let total = 0;
      for (const file of manifest.files) {
        if (!file || Object.keys(file).sort().join(',') !== 'bytes,path,sha256' || typeof file.path !== 'string' || !/^assets\/transcription-(?:worker|runtime)-[A-Za-z0-9_-]+\.(?:js|mjs|wasm)$/.test(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 67108864 || !/^[0-9a-f]{64}$/.test(file.sha256)) return unavailable();
        seen.add(file.path); total += file.bytes;
      }
      if (total > 134217728) return unavailable();
      const file = manifest.files.find(file => new URL(file.path, SCOPE).href === request.url);
      if (!file) return unavailable();
      const bytes = await bounded(await cache.match(request.url), file.bytes);
      if (bytes.byteLength !== file.bytes || await hash(bytes) !== file.sha256) return unavailable();
      return new Response(bytes, { status: 200, headers: { 'Content-Type': file.path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'none'; object-src 'none'" } });
    } catch { return unavailable(); }
  });
}

function isBuiltAsset(url) {
  return url.origin === SCOPE.origin && url.pathname.startsWith(`${BASE}assets/`) && !url.search &&
    /^[A-Za-z0-9_.-]+\.(?:js|css)$/.test(url.pathname.slice(`${BASE}assets/`.length));
}

async function cacheShell(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Could not cache app shell');
  const html = await response.clone().text();
  const declaredBase = html.match(/<meta\b[^>]*\bname=["']application-base["'][^>]*\bcontent=["']([^"']+)["']/i)?.[1];
  if (declaredBase !== BASE) throw new Error('App shell mount does not match service worker');
  const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)]
    .map(match => new URL(match[1], SCOPE)).filter(isBuiltAsset).map(url => url.href);
  const cache = await caches.open(CACHE);
  // Save the new shell only after every asset it needs is available offline.
  await cache.addAll([...STATIC, ...new Set(assets)].map(url => new Request(url, { cache: 'reload' })));
  await cache.put(SHELL, response);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await cacheShell(await fetch(SHELL, { cache: 'reload' }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => (key.startsWith(CACHE_PREFIX) && key !== CACHE) ||
      (BASE === '/' && key === 'phabricator-next-shell-v1')).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin || url.search) return;
  if (isTranscriptionRuntime(url)) { event.respondWith(verifiedRuntime(request)); return; }
  const isShell = url.pathname === BASE || url.pathname === `${BASE}index.html`;
  if (request.mode === 'navigate' && isShell) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) event.waitUntil(cacheShell(response.clone()).catch(() => { /* Retain the last complete shell if a release cannot be cached. */ }));
      return response;
    }).catch(async () => {
      const cached = await (await caches.open(CACHE)).match(SHELL);
      if (!cached) throw new Error('No offline shell is available');
      return cached;
    }));
  } else if (STATIC.has(url.href) || isBuiltAsset(url)) {
    // Never populate caches from arbitrary requests, including API/auth routes or sibling sites.
    event.respondWith(caches.open(CACHE).then(async cache => await cache.match(request) || fetch(request)));
  }
});
