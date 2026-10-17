const V = 'app-v2';
const SHELL = ['./', 'index.html', 'core.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V && k !== 'cdn-v1').map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    if (u.pathname.startsWith('/api/')) return;
    // Jaringan dulu agar pembaruan cepat sampai; cache sebagai cadangan saat offline.
    e.respondWith(
      fetch(r).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(V).then(c => c.put(r, copy)); }
        return res;
      }).catch(() => caches.match(r, { ignoreSearch: true }).then(m =>
        m || (r.mode === 'navigate' ? caches.match('index.html') : Response.error())))
    );
  } else if (u.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open('cdn-v1').then(c => c.match(r).then(m => m ||
      fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }))));
  }
});

