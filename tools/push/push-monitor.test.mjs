import test from 'node:test';
import assert from 'node:assert/strict';
import { runPushMonitor } from '../../netlify/functions/push-monitor.mjs';
import { normalizeAlertResponse, toDatabaseAlarm } from '../../netlify/functions/push-core.mjs';

const env = {
  SOLINF_USER: 'fixture-user',
  SOLINF_PASS: 'fixture-password',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'fixture-anon',
  PUSH_DB_SECRET: 'fixture-rpc-secret',
  VAPID_PUBLIC_KEY: 'fixture-vapid-public',
  VAPID_PRIVATE_KEY: 'fixture-vapid-private',
};
const fixtureAlarm = {
  cdId: 4674575,
  dtHrUTC: 1795426792,
  cdEquipamento: '8833',
  descEquipamento: '8833 - Caminhão canavieiro',
  cdTpAlarme: 2203,
  descTpAlarme: 'VELOCIDADE EXCEDIDA',
  fgOnline: true,
  vlAlarme: '85',
  descGrupoEquipamento: 'Frente 4',
};
const alarm = normalizeAlertResponse([fixtureAlarm])[0];

function makeStore({ initialBaseline = false, claimed = true, hasSubscriptions = true, pendingDeliveries = null } = {}) {
  const calls = [];
  return {
    calls,
    async call(action, data) {
      calls.push({ action, data });
      if (action === 'has_subscriptions') return { ok: true, hasSubscriptions };
      if (action === 'synchronize_alarms') {
        const padrao = {
          occurrenceId: 'occ-1',
          deviceId: '00000000-0000-4000-8000-000000000001',
          endpoint: 'https://fcm.googleapis.com/fcm/send/fixture',
          p256dh: 'fixture-p256dh',
          auth: 'fixture-auth',
          preferences: {
            notificarCategorias: { velocidade: true },
            tiposNotificacao: {},
            frentes: [],
            equipamentos: '',
            seguirSelecaoMapa: false,
            selecaoMapa: [],
          },
          payload: alarm.payload,
        };
        return { initialBaseline, pendingDeliveries: initialBaseline ? [] : (pendingDeliveries || [padrao]) };
      }
      if (action === 'claim_delivery') return { claimed };
      return { ok: true };
    },
  };
}

function makeDelivery(index, selected) {
  const suffix = String(index).padStart(12, '0');
  return {
    occurrenceId: `00000000-0000-4000-8000-${suffix}`,
    deviceId: `10000000-0000-4000-8000-${suffix}`,
    endpoint: `https://fcm.googleapis.com/fcm/send/fixture-${index}`,
    p256dh: 'fixture-p256dh',
    auth: 'fixture-auth',
    preferences: {
      notificarCategorias: { velocidade: selected },
      tiposNotificacao: {},
      frentes: [],
      equipamentos: '',
      seguirSelecaoMapa: false,
      selecaoMapa: [],
    },
    payload: alarm.payload,
  };
}

function makePush({ failureStatus = 0 } = {}) {
  const sent = [];
  return {
    sent,
    setVapidDetails() {},
    async sendNotification(subscription, payload, options) {
      sent.push({ subscription, payload: JSON.parse(payload), options });
      if (failureStatus) throw Object.assign(new Error('fixture provider failure'), { statusCode: failureStatus });
      return { statusCode: 201 };
    },
  };
}

test('primeira execução grava baseline e não envia Push em massa', async () => {
  const store = makeStore({ initialBaseline: true });
  const push = makePush();
  const result = await runPushMonitor({
    env,
    fetchOfficialAlarms: async () => [alarm],
    store,
    webPush: push,
    skipVapidSetup: true,
  });
  assert.equal(result.baseline, true);
  assert.equal(result.sent, 0);
  assert.equal(push.sent.length, 0);
  assert.equal(store.calls[0].action, 'has_subscriptions');
  assert.equal(store.calls[1].action, 'synchronize_alarms');
  assert.deepEqual(store.calls[1].data.alarms, [toDatabaseAlarm(alarm)]);
});

test('sem dispositivos inscritos, não chama autenticação ou endpoint SGPA', async () => {
  const store = makeStore({ hasSubscriptions: false });
  const push = makePush();
  let sgpaCalls = 0;
  const result = await runPushMonitor({
    env,
    fetchOfficialAlarms: async () => { sgpaCalls++; return [alarm]; },
    store,
    webPush: push,
    skipVapidSetup: true,
  });
  assert.equal(result.idle, true);
  assert.equal(result.reason, 'no-subscriptions');
  assert.equal(sgpaCalls, 0);
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].action, 'has_subscriptions');
  assert.equal(push.sent.length, 0);
});

test('alarme selecionado dispara uma única entrega simulada e registra sent no RPC', async () => {
  const store = makeStore();
  const push = makePush();
  const result = await runPushMonitor({
    env,
    fetchOfficialAlarms: async () => [alarm],
    store,
    webPush: push,
    skipVapidSetup: true,
  });
  assert.equal(result.sent, 1);
  assert.equal(push.sent.length, 1);
  assert.equal(push.sent[0].subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/fixture');
  assert.equal(push.sent[0].payload.data.equipmentId, '8833');
  assert.equal(push.sent[0].payload.data.occurrenceId, 'occ-1');
  assert.ok(store.calls.some((call) => call.action === 'claim_delivery'));
  assert.ok(store.calls.some((call) => call.action === 'complete_delivery' && call.data.status === 'sent'));
});

test('a trava de idempotência impede entrega duplicada', async () => {
  const store = makeStore({ claimed: false });
  const push = makePush();
  const result = await runPushMonitor({
    env,
    fetchOfficialAlarms: async () => [alarm],
    store,
    webPush: push,
    skipVapidSetup: true,
  });
  assert.equal(result.sent, 0);
  assert.equal(push.sent.length, 0);
});

test('preferências por dispositivo filtram sem enviar e registram o estado filtered', async () => {
  const store = makeStore();
  const originalCall = store.call.bind(store);
  store.call = async (action, data) => {
    if (action === 'synchronize_alarms') {
      const result = await originalCall(action, data);
      result.pendingDeliveries[0].preferences.notificarCategorias.velocidade = false;
      return result;
    }
    return originalCall(action, data);
  };
  const push = makePush();
  const result = await runPushMonitor({
    env,
    fetchOfficialAlarms: async () => [alarm],
    store,
    webPush: push,
    skipVapidSetup: true,
  });
  assert.equal(result.filtered, 1);
  assert.equal(push.sent.length, 0);
  assert.ok(store.calls.some((call) => call.action === 'complete_delivery' && call.data.status === 'filtered'));
});

test('20 itens filtered são reivindicados e concluídos, liberando o 21º item elegível na próxima execução', async () => {
  const deliveries = Array.from({ length: 20 }, (_, i) => makeDelivery(i + 1, false));
  deliveries.push(makeDelivery(21, true));
  const claimed = new Set();
  const completed = new Set();
  const calls = [];
  const store = {
    calls,
    async call(action, data) {
      calls.push({ action, data });
      if (action === 'has_subscriptions') return { ok: true, hasSubscriptions: true };
      if (action === 'synchronize_alarms') return {
        initialBaseline: false,
        pendingDeliveries: deliveries.filter((item) => !completed.has(item.occurrenceId)),
      };
      if (action === 'claim_delivery') {
        claimed.add(data.occurrenceId);
        return { ok: true, claimed: true };
      }
      if (action === 'complete_delivery') {
        if (!claimed.has(data.occurrenceId)) return { ok: true, updated: false };
        completed.add(data.occurrenceId);
        return { ok: true, updated: true };
      }
      return { ok: true };
    },
  };
  const push = makePush();
  const first = await runPushMonitor({ env, fetchOfficialAlarms: async () => [alarm], store, webPush: push, skipVapidSetup: true });
  assert.equal(first.filtered, 20);
  assert.equal(first.deferred, 1);
  assert.equal(push.sent.length, 0);
  assert.equal(completed.size, 20);
  const second = await runPushMonitor({ env, fetchOfficialAlarms: async () => [alarm], store, webPush: push, skipVapidSetup: true });
  assert.equal(second.sent, 1);
  assert.equal(push.sent.length, 1);
  assert.equal(completed.size, 21);
});

test('HTTP 410 remove subscription expirada sem persistir endpoint no log', async () => {
  const store = makeStore();
  const push = makePush({ failureStatus: 410 });
  const result = await runPushMonitor({
    env,
    fetchOfficialAlarms: async () => [alarm],
    store,
    webPush: push,
    skipVapidSetup: true,
  });
  assert.equal(result.expired, 1);
  assert.ok(store.calls.some((call) => call.action === 'remove_subscription'));
  assert.ok(!store.calls.some((call) => call.action === 'complete_delivery' && call.data.status === 'failed'));
});

test('resposta SGPA inválida falha antes de sincronizar e nunca envia Push', async () => {
  const store = makeStore();
  const push = makePush();
  await assert.rejects(runPushMonitor({
    env,
    fetchOfficialAlarms: async () => ({ unexpected: true }),
    store,
    webPush: push,
    skipVapidSetup: true,
  }), /unexpected active alarm response/);
  assert.equal(store.calls.some((call) => call.action === 'synchronize_alarms'), false);
  assert.equal(push.sent.length, 0);
});
