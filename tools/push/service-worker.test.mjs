import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

function loadWorker({ windows = [], openWindow } = {}) {
  const handlers = new Map();
  const notifications = [];
  const opened = [];
  const self = {
    location: { origin: 'https://monitor.fixture.invalid' },
    registration: {
      async showNotification(title, options) {
        notifications.push({ title, options });
      },
    },
    clients: {
      async matchAll() { return windows; },
      async openWindow(url) {
        opened.push(url);
        return typeof openWindow === 'function' ? openWindow(url) : null;
      },
    },
    addEventListener(name, handler) { handlers.set(name, handler); },
    async skipWaiting() {},
  };
  vm.runInNewContext(source, {
    self,
    URL,
    URLSearchParams,
    Promise,
    setTimeout,
    clearTimeout,
    caches: { async keys() { return []; }, async open() { return { async addAll() {}, async put() {} }; } },
    fetch: async () => new Response('', { status: 200 }),
    Response,
  }, { filename: 'public/sw.js' });
  return { handlers, notifications, opened };
}

function runEvent(handler, event) {
  let pending;
  handler({ ...event, waitUntil(promise) { pending = promise; } });
  return pending;
}

test('push exibe alarme oficial e mantém os identificadores no notification.data consumido pelo clique', async () => {
  const worker = loadWorker();
  const payload = {
    title: 'Alarme oficial SGPA',
    body: 'Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.',
    tag: 'sgpa-occurrence-1',
    data: { equipmentId: '8833', occurrenceId: 'occurrence-1', typeId: '2203' },
  };
  await runEvent(worker.handlers.get('push'), { data: { json: () => payload } });
  assert.equal(worker.notifications.length, 1);
  assert.equal(worker.notifications[0].title, 'Alarme oficial SGPA');
  assert.equal(worker.notifications[0].options.data.equipmentId, '8833');
  assert.equal(worker.notifications[0].options.data.occurrenceId, 'occurrence-1');
  assert.equal(worker.notifications[0].options.actions[0].action, 'ver-no-mapa');
});

test('clique com app aberto foca a janela existente e envia o equipamento para navegação interna', async () => {
  let focused = false;
  const messages = [];
  const app = {
    url: 'https://monitor.fixture.invalid/',
    async focus() { focused = true; },
    postMessage(message) { messages.push(message); },
  };
  const worker = loadWorker({ windows: [app] });
  await runEvent(worker.handlers.get('notificationclick'), {
    notification: { data: { equipmentId: '8833' }, close() {} },
  });
  assert.equal(focused, true);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ type: 'alerta-notificacao', equipamento: '8833' }]);
  assert.equal(worker.opened.length, 0);
});

test('clique sem app aberto usa somente a origem do PWA e preserva o foco na URL até o mapa iniciar', async () => {
  let openedClientUrl = '';
  const worker = loadWorker({
    openWindow(url) {
      openedClientUrl = url;
      return { url, postMessage() {} };
    },
  });
  await runEvent(worker.handlers.get('notificationclick'), {
    notification: { data: { equipmentId: '8833' }, close() {} },
  });
  assert.equal(worker.opened.length, 1);
  const url = new URL(openedClientUrl);
  assert.equal(url.origin, 'https://monitor.fixture.invalid');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('focusEquipment'), '8833');
});

test('payload malformado não abre pop-up do sistema', async () => {
  const worker = loadWorker();
  const event = { data: { json: () => [] } };
  await runEvent(worker.handlers.get('push'), event);
  assert.equal(worker.notifications.length, 0);
});
