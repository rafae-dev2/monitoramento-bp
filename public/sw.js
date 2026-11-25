/* Monitoramento BP — service worker
 * Só cacheamos o casco do app (HTML/CSS/JS/ícones). Sessão, APIs e dados do portal
 * passam sempre pela rede e NUNCA entram no cache.
 */
const SHELL = 'bperes-shell-v48';
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
    caches.open(SHELL).then(async (c) => {
      // Baixa cada arquivo ignorando o cache HTTP do navegador. Se a rede 3G/4G
      // falhar no meio, rejeita a instalação para preservar o Service Worker anterior
      // e não apagar o cache íntegro no activate.
      if (typeof Request === 'function' && typeof c.put === 'function') {
        await Promise.all(
          ASSETS.map(async (asset) => {
            const req = new Request(new URL(asset, self.location.origin).href, { cache: 'reload' });
            const res = await fetch(req);
            if (!res || !res.ok) throw new Error('Falha ao atualizar ' + asset);
            await c.put(asset, res);
          }),
        );
      } else {
        await c.addAll(ASSETS);
      }
      await self.skipWaiting();
    }),
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

  // Nada de cache para funções serverless, APIs (/api/push), POST ou origens externas.
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/.netlify/') || url.pathname.startsWith('/api/')) return;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
          }
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
  const texto = (valor, padrao, limite) =>
    typeof valor === 'string' && valor.trim() ? valor.trim().slice(0, limite) : padrao;
  const idString = (valor) =>
    typeof valor === 'string' || typeof valor === 'number' ? String(valor).trim().slice(0, 160) : '';
  const dados =
    payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};

  e.waitUntil(
    (async () => {
      // Se o operador já está com o painel visível e em foco nesta origem, a Central ao vivo
      // já anuncia voz/pop-up; evita empilhar notificação duplicada do sistema.
      const janelas =
        self.clients && typeof self.clients.matchAll === 'function'
          ? await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
          : [];
      const origem = self.location.origin;
      const visivel = janelas.find((c) => {
        try {
          return (
            new URL(c.url).origin === origem &&
            (c.focused === true || c.visibilityState === 'visible')
          );
        } catch {
          return false;
        }
      });
      if (visivel && typeof visivel.postMessage === 'function') {
        visivel.postMessage({
          type: 'alerta-push-visivel',
          equipmentId: idString(dados.equipmentId),
          occurrenceId: idString(dados.occurrenceId),
        });
        return;
      }

      const opcoes = {
        body: texto(payload.body, 'Um alarme oficial SGPA selecionado requer atenção.', 500),
        tag: texto(payload.tag, idString(dados.alertKey) || 'alerta-sgpa', 128),
        icon: '/icons/icon-192.png',
        badge: '/icons/favicon-32.png',
        actions: [{ action: 'ver-no-mapa', title: 'Ver no mapa' }],
        data: {
          equipmentId: idString(dados.equipmentId),
          occurrenceId: idString(dados.occurrenceId),
          typeId: idString(dados.typeId),
        },
      };
      await self.registration.showNotification(texto(payload.title, 'Alerta oficial SGPA', 120), opcoes);
    })(),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const dados =
    e.notification && e.notification.data && typeof e.notification.data === 'object'
      ? e.notification.data
      : {};
  const equipamento =
    typeof dados.equipmentId === 'string'
      ? dados.equipmentId
      : typeof dados.equipamento === 'string'
        ? dados.equipamento
        : '';
  const mensagem = { type: 'alerta-notificacao', equipamento };
  e.waitUntil(
    (async () => {
      const lista = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const origem = self.location.origin;
      const destino = new URL('/', origem);
      if (/^[A-Za-z0-9_-]{1,64}$/.test(equipamento)) destino.searchParams.set('focusEquipment', equipamento);
      const app = lista.find((c) => {
        try {
          return new URL(c.url).origin === origem;
        } catch {
          return false;
        }
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
    })(),
  );
});
