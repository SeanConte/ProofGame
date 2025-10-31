// Basic cache-first service worker for your static app.
// NOTE: Only register this in production when you actually want PWA behavior.
// (Register from app.js when config.pwaEnabled === true.)

const CACHE_NAME = 'proof-assistant-shell-v1';

// Files to cache for offline use — match your current layout.
const ASSETS = [
  '/index.html',
  '/rules/styles.css',
  '/rules/app.js',
  '/rules/config.js',
  // If/when you add real icons, un-comment and ensure the files exist:
  // '/assets/icons/app-192.png',
  // '/assets/icons/app-512.png',
];

// Install: pre-cache the app shell.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches if the name changed.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => {
        if (key !== CACHE_NAME) return caches.delete(key);
      }))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first for known assets; fall back to network.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
