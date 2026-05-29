// The Good Egg — service worker
// Version is replaced at deploy time by the build workflow with the
// commit SHA. A new SHA produces a new cache name, which triggers the
// browser to install this script as a fresh service worker.
const VERSION    = '63ea32d92d58428390ddbf1a64f19ba7a22e367a';
const CACHE_NAME = 'good-egg-' + VERSION;
const PRECACHE   = ['./', './index.html', './logo.jpg'];

// ── INSTALL — precache the app shell.
// We intentionally do NOT call skipWaiting() here. The page decides when
// to switch over (either auto, or in response to the user tapping the
// update banner). That lets people finish whatever they're typing before
// a reload.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
});

// ── ACTIVATE — drop any older Good Egg caches.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k.startsWith('good-egg-') && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ── MESSAGE — page asks us to take over now.
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── FETCH — routing strategy:
//   - Apps Script / Google APIs:  always network, never cached (live data)
//   - Same-origin navigations:    network-first, cache fallback (offline)
//   - Same-origin static assets:  cache-first (fast, offline)
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept Apps Script — must always be fresh.
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') {
    return;
  }
  // Don't try to cache cross-origin font/CDN requests either; let them
  // hit the network and benefit from their own HTTP cache headers.
  if (url.origin !== self.location.origin) {
    return;
  }

  // HTML / navigations → network-first, cache as fallback.
  const isHtml = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHtml) {
    event.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() =>
          caches.match(req).then(r => r || caches.match('./index.html'))
        )
    );
    return;
  }

  // Everything else (logo, sw.js, anything in PRECACHE) → cache-first.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }))
  );
});
