/* Monitoramento BP — service worker
 * Só cacheamos o casco do app (HTML/CSS/JS/ícones). Sessão e dados do portal
 * passam sempre pela rede e NUNCA entram no cache.
 */
const SHELL = 'bperes-shell-v14';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/local.js',
  '/styles.css',
  '/alerts.js',
  '/alerts.css',
  '/alerts-stream.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
  '/icons/favicon-48.png',
  '/icons/logo-mark.png',
  '/icons/logo.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // nada de cache para função/serverless, POST, ou anything fora da nossa origem
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.netlify/')) return;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // rede primeiro, cache como fallback (app continua instalável/offline do casco)
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
