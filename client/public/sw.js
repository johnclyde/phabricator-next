/* Cache only the static shell. API snapshots are managed explicitly by the client. */
const CACHE = 'phabricator-next-shell-v1';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const response = await fetch('/');
    if (!response.ok) throw new Error('Could not cache app shell');
    const html = await response.clone().text();
    const assets = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)].map(match => match[1]);
    await cache.put('/', response);
    await cache.addAll(['/icon.svg', '/manifest.webmanifest', ...assets]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => { event.waitUntil((async () => { const keys = await caches.keys(); await Promise.all(keys.filter(key => key.startsWith('phabricator-next-shell-') && key !== CACHE).map(key => caches.delete(key))); await self.clients.claim(); })()); });
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => { if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put('/', copy))); } return response; }).catch(() => caches.match('/')));
  } else {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => { if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy))); } return response; })));
  }
});
