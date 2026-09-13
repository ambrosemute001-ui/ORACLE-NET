// Oracle Net service worker — app-shell caching only.
// Bump CACHE_NAME on every deploy so old clients pick up the new shell.
const CACHE_NAME = 'oracle-net-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only ever handle same-origin GET requests for the app shell itself.
  // Everything else (Supabase auth/rest/realtime, CDN scripts, images) is
  // left completely alone — never intercepted, never cached — so data is
  // always fresh and auth/session behavior is never affected by this worker.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // Network-first for the HTML shell so a deploy is picked up immediately
  // when online; falls back to the cached copy when offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Cache-first for the static shell assets (icons, manifest).
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
