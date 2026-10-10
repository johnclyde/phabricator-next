/* Cache only this installation's static shell. API snapshots live in the client. */
const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname;
const SHELL = SCOPE.href;
const CACHE_PREFIX = `phabricator-next-shell:${encodeURIComponent(SHELL)}:`;
const CACHE = `${CACHE_PREFIX}v2`;
const STATIC = new Set([new URL('icon.svg', SCOPE).href, new URL('manifest.webmanifest', SCOPE).href]);

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
