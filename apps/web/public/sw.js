// Employee PWA service worker (V1) — installable shell, offline roster viewing.
// Clock-ins made offline are queued in localStorage by the app and synced via
// POST /api/attendance/offline-queue when back online. Payroll calculation
// stays server-side only. This is a PWA, NOT a native iOS app: a native iOS
// build needs an Apple Developer account + Xcode build (non-code blocker).
const CACHE = 'hr-payroll-pwa-v1';
const CORE = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Network-first for API calls (never serve stale pay/attendance data from
// cache); cache-first for the app shell so the roster page loads offline.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // let the app handle offline queueing
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => undefined);
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/index.html'))),
  );
});
