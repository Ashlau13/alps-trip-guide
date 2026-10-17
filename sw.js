/* Offline-first service worker: precaches every app file and all content. Bump CACHE_VERSION after editing data. */
const CACHE_VERSION = 'alps-v16-apples';
const PRECACHE = [
  './', 'index.html', 'manifest.json', 'css/app.css', 'js/lock.js', 'js/app.js', 'js/chat.js',
  'js/vendor/qrcode.min.js', 'js/vendor/jsQR.min.js',
  'data/pois.json', 'data/itinerary.json', 'data/lock.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/icon.svg'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(PRECACHE.map(u => new Request(u, {cache: 'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter(k => k !== CACHE_VERSION);
    for (const k of old) await caches.delete(k);
    await self.clients.claim();
    const c = await caches.open(CACHE_VERSION); const n = (await c.keys()).length;
    for (const cl of await self.clients.matchAll({includeUncontrolled: true})) cl.postMessage({type: 'precached', count: n, version: CACHE_VERSION});
    // upgrade from an older version: reload open windows once so they show the new content immediately
    // (not awaited: navigation fetches can only be served once activation has finished)
    if (old.length) for (const cl of await self.clients.matchAll({type: 'window'})) cl.navigate(cl.url).catch(() => {});
  })());
});
self.addEventListener('message', async e => {
  if (e.data === 'status') { const c = await caches.open(CACHE_VERSION); e.source.postMessage({type: 'precached', count: (await c.keys()).length, version: CACHE_VERSION}); }
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // ntfy.sh etc. go straight to network
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then(r => r || fetch(req)).catch(() => caches.match('./')));
    return;
  }
  if (url.pathname.endsWith('.json') && url.pathname.includes('/data/')) {
    // stale-while-revalidate so edited itinerary/POI files reach phones on the next launch
    e.respondWith(caches.open(CACHE_VERSION).then(async c => {
      const hit = await c.match(req, {ignoreSearch: true});
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  e.respondWith(caches.match(req, {ignoreSearch: true}).then(r => r || fetch(req).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE_VERSION).then(c => c.put(req, cp)); }
    return res;
  })));
});
