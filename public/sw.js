/* Monitoramento BP — service worker
 * Só cacheamos o casco do app (HTML/CSS/JS/ícones). Sessão e dados do portal
 * passam sempre pela rede e NUNCA entram no cache.
 */
const SHELL = 'bperes-shell-v25';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/local.js',
  '/styles.css',
  '/alerts-policy.js',
  '/sgpa-alert-catalog.json',
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

self.addEventListener('push', (e) => {
  if (!e.data) return;
  let payload;
  try {
    payload = e.data.json();
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const texto = (valor, padrao, limite) => typeof valor === 'string' && valor.trim()
    ? valor.trim().slice(0, limite)
    : padrao;
  const idString = (valor) => typeof valor === 'string' || typeof valor === 'number'
    ? String(valor).trim().slice(0, 160)
    : '';
  const dados = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
  const opcoes = {
    body: texto(payload.body, 'Um alarme oficial SGPA selecionado requer atenção.', 500),
    tag: texto(payload.tag, 'alerta-sgpa', 128),
    icon: '/icons/icon-192.png',
    badge: '/icons/favicon-32.png',
    actions: [{ action: 'ver-no-mapa', title: 'Ver no mapa' }],
    data: {
      equipmentId: idString(dados.equipmentId),
      occurrenceId: idString(dados.occurrenceId),
    },
  };
  e.waitUntil(self.registration.showNotification(texto(payload.title, 'Alerta oficial SGPA', 120), opcoes));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const dados = e.notification && e.notification.data && typeof e.notification.data === 'object'
    ? e.notification.data
    : {};
  // `equipamento` preserva os avisos locais existentes; Push usa `equipmentId`.
  const equipamento = typeof dados.equipmentId === 'string'
    ? dados.equipmentId
    : typeof dados.equipamento === 'string' ? dados.equipamento : '';
  const mensagem = { type: 'alerta-notificacao', equipamento };
  e.waitUntil((async () => {
    const lista = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const origem = self.location.origin;
    const destino = new URL('/', origem);
    if (/^[A-Za-z0-9_-]{1,64}$/.test(equipamento)) destino.searchParams.set('focusEquipment', equipamento);
    const app = lista.find((c) => {
      try { return new URL(c.url).origin === origem; } catch { return false; }
    });
    if (app) {
      await app.focus();
      app.postMessage(mensagem);
      return;
    }
    const aberto = await self.clients.openWindow(destino.href);
    if (aberto) {
      try {
        if (new URL(aberto.url).origin === origem) aberto.postMessage(mensagem);
      } catch {
        /* a raiz já foi aberta; não encaminha mensagem fora da origem do app */
      }
    }
  })());
});
