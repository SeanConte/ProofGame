// Basic cache-first service worker shell.
// NOTE: This file is present but NOT registered by default. To enable, set
// config.pwaEnabled = true and register from production code only.

const CACHE_NAME = 'rules-shell-v1';
const ASSETS = [
  '/rules/index.html', '/rules/styles.css', '/rules/app.js', '/rules/config.js',
  '/assets/icons/app-192.png', '/assets/icons/app-512.png'
];

self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS)));
});

self.addEventListener('fetch', (e)=>{
  // cache-first for shell
  e.respondWith(caches.match(e.request).then(r=>r || fetch(e.request)));
});

// When enabling, consider adding a versioned cache cleanup and offline fallback.
