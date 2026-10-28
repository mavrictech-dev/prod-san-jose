// No se cachean API, tokens, páginas autenticadas ni datos fiscales.
const CACHE = 'factuez-static-p1-v1';
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/offline.html', '/brand/estaciones-san-jose.webp'])));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('factuez-static-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request; const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') { event.respondWith(fetch(request).catch(() => caches.match('/offline.html'))); return; }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request); if (cached) return cached;
      const response = await fetch(request); if (response.ok && response.type === 'basic') await cache.put(request, response.clone()); return response;
    }));
  }
});
