const CACHE_NAME = 'playtogether-v6';

const ASSETS = [
  '/',
  '/css/style.css',
  '/js/ws.js',
  '/js/board.js',
  '/js/chat.js',
  '/js/voice.js',
  '/js/away.js',
  '/js/game.js',
  '/js/app.js',
  '/manifest.json'
];

// Install — pre-cache all static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('push', event => {
  let data;
  try { data = event.data.json(); } catch (_) { return; }
  if (!/^[A-Z]{4}$/.test(data.code)) return;
  event.waitUntil(self.registration.showNotification('PlayTogether', {
    body: String(data.body || 'Your table has an update.').slice(0, 160),
    tag: String(data.tag || 'playtogether').slice(0, 80),
    data: { code: data.code }, renotify: false
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const code = event.notification.data?.code;
  if (!/^[A-Z]{4}$/.test(code)) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus(); client.postMessage({ type: 'resume_table', code }); return;
      }
    }
    return self.clients.openWindow('/?room=' + code + '&resume=1');
  })());
});

// Activate — purge old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key.startsWith('playtogether-') && key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch — network-first, fall back to cache. Skip WebSocket requests.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.includes(url.pathname) || url.search) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful GET responses
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => (await caches.match(event.request)) || Response.error())
  );
});
