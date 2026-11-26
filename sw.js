// sw.js — versioned cache-first app shell. Gemini requests are never cached.
const VERSION = 'v2';
const CACHE = `hanashi-nikki-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './js/app.js',
  './js/db.js',
  './js/util.js',
  './js/srs.js',
  './js/prompts.js',
  './js/reminders.js',
  './js/charts.js',
  './js/recorder.js',
  './js/wav.js',
  './js/audio-analysis.js',
  './js/ai.js',
  './js/views/icons.js',
  './js/views/common.js',
  './js/views/today.js',
  './js/views/entry.js',
  './js/views/calendar.js',
  './js/views/review.js',
  './js/views/trends.js',
  './js/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Add individually so one missing file doesn't abort the whole install.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch((e) => console.warn('[sw] cache miss', url, e))));
    // First install: activate immediately. Updates wait for the page to send SKIP_WAITING.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('hanashi-nikki-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('google.com')) return; // network-only
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = (await cache.match('./index.html')) || (await cache.match('./'));
      if (hit) return hit;
      try { return await fetch(req); } catch { return new Response('Offline', { status: 503 }); }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (e) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './#/today', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        try { await c.navigate(target); } catch { /* cross-state */ }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
