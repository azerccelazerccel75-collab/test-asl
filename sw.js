const CACHE = 'aslan-v9-0';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable.png', '404.html'];
let freshAt = 0;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => {
  if (e.data && e.data.t === 'ask' && freshAt && Date.now() - freshAt < 600000 && e.source) e.source.postMessage({ t: 'fresh' });
});
function tell(){
  freshAt = Date.now();
  self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => c.postMessage({ t: 'fresh' })));
}
function isApp(url){
  const scope = new URL(self.registration.scope);
  const p = url.pathname;
  return p === scope.pathname || p === scope.pathname + 'index.html';
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    if (!isApp(url)) {
      e.respondWith(fetch(req).catch(() => caches.match('404.html').then(r => r || caches.match('index.html'))));
      return;
    }
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('index.html');
      const net = fetch(url.pathname.endsWith('index.html') ? req.url : new URL('index.html', self.registration.scope).href, { cache: 'no-store' }).then(async r => {
        if (r && r.ok) {
          const txt = await r.clone().text();
          const old = cached ? await cached.clone().text() : null;
          await cache.put('index.html', r.clone());
          if (old !== null && old !== txt) tell();
        }
        return r;
      });
      if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
      return net.catch(() => caches.match('./'));
    })());
    return;
  }
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(resp => {
      if (resp && resp.ok) { const cc = resp.clone(); caches.open(CACHE).then(c => c.put(req, cc)); }
      return resp;
    }).catch(() => r))
  );
});
