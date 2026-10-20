// Service worker de Faro: carcasa en caché y avisos push. Nunca toca /api.
const CACHE = 'faro-v1';
const SHELL = ['/', '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png', '/apple-touch-icon.png'];

// Solo URLs del mismo origen; cualquier otra cosa (otro origen, javascript:, basura) cae en '/'.
function safeUrl(url) {
  if (typeof url !== 'string' || !url) return '/';
  try {
    const u = new URL(url, self.location.origin);
    if (u.origin !== self.location.origin) return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy))); }
        return res;
      })),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok && url.pathname === '/') { const copy = res.clone(); event.waitUntil(caches.open(CACHE).then((c) => c.put('/', copy))); }
        return res;
      }).catch(() => caches.match('/').then((hit) => hit || Response.error())),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Faro';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    data: { url: safeUrl(data.url) },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins[0];
      if (win) return win.focus().then((c) => (c && 'navigate' in c ? c.navigate(url) : undefined)).catch(() => {});
      return self.clients.openWindow(url);
    }),
  );
});
