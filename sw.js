/* Aslan Lessons — service worker (offline shell) */
const CACHE = 'aslan-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                         // API (POST) — şəbəkə, keşlənmir
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;               // xarici (fontlar, Apps Script) — default
  if (req.mode === 'navigate') {                            // səhifə: əvvəl şəbəkə, offline-da keş
    e.respondWith(
      fetch(req).then(r => { const cc = r.clone(); caches.open(CACHE).then(c => c.put(req, cc)); return r; })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }
  e.respondWith(                                            // statik: əvvəl keş
    caches.match(req).then(r => r || fetch(req).then(resp => {
      if (resp && resp.ok) { const cc = resp.clone(); caches.open(CACHE).then(c => c.put(req, cc)); }
      return resp;
    }).catch(() => r))
  );
});
