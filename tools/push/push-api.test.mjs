import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePushRequest } from '../../netlify/functions/push-api.mjs';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'fixture-anon',
  PUSH_DB_SECRET: 'fixture-secret',
  VAPID_PUBLIC_KEY: 'fixture-vapid-public',
};
const deviceId = '00000000-0000-4000-8000-000000000001';

function request(method, body) {
  return new Request('https://example.test/api/push', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function fakeStore() {
  const calls = [];
  return {
    calls,
    async call(action, data) { calls.push({ action, data }); return { ok: true }; },
  };
}

async function jsonResponse(response) {
  return { status: response.status, body: await response.json() };
}

test('GET devolve só a chave pública VAPID', async () => {
  const result = await jsonResponse(await handlePushRequest(request('GET'), { env }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, vapidPublicKey: env.VAPID_PUBLIC_KEY });
});

test('subscribe persiste apenas a inscrição e preferências sanitizadas via RPC', async () => {
  const store = fakeStore();
  const result = await jsonResponse(await handlePushRequest(request('POST', {
    action: 'subscribe',
    deviceId,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/fixture-token',
      keys: { p256dh: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF', auth: 'abcdefghijklmnopQRSTUV' },
    },
    preferences: {
      notificarCategorias: { velocidade: false },
      tiposNotificacao: { '2203': true },
      frentes: ['Frente 4'],
      equipamentos: '8833',
      seguirSelecaoMapa: true,
      selecaoMapa: ['8833'],
    },
  }), { env, store }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].action, 'upsert_subscription');
  assert.equal(store.calls[0].data.deviceId, deviceId);
  assert.equal(store.calls[0].data.prefs.tiposNotificacao['2203'], true);
  assert.equal(store.calls[0].data.prefs.selecaoMapa[0], '8833');
});

test('sync e unsubscribe aceitam somente ações explicitamente permitidas', async () => {
  const store = fakeStore();
  const sync = await jsonResponse(await handlePushRequest(request('POST', { action: 'sync', deviceId, preferences: {} }), { env, store }));
  const unsubscribe = await jsonResponse(await handlePushRequest(request('POST', { action: 'unsubscribe', deviceId }), { env, store }));
  assert.equal(sync.status, 200);
  assert.equal(unsubscribe.status, 200);
  assert.deepEqual(store.calls.map((call) => call.action), ['update_preferences', 'delete_subscription']);
});

test('rejeita endpoint fora dos provedores Push suportados e deviceId inválido', async () => {
  const store = fakeStore();
  const badEndpoint = await jsonResponse(await handlePushRequest(request('POST', {
    action: 'subscribe',
    deviceId,
    subscription: { endpoint: 'https://127.0.0.1/private', keys: { p256dh: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF', auth: 'abcdefghijklmnopQRSTUV' } },
    preferences: {},
  }), { env, store }));
  const badDevice = await jsonResponse(await handlePushRequest(request('POST', { action: 'unsubscribe', deviceId: 'not-a-uuid' }), { env, store }));
  assert.equal(badEndpoint.status, 400);
  assert.equal(badDevice.status, 400);
  assert.equal(store.calls.length, 0);
});

test('rejeita body muito grande e método não autorizado', async () => {
  const large = new Request('https://example.test/api/push', { method: 'POST', body: 'x'.repeat(24001) });
  const tooLarge = await jsonResponse(await handlePushRequest(large, { env, store: fakeStore() }));
  const method = await jsonResponse(await handlePushRequest(request('DELETE'), { env }));
  assert.equal(tooLarge.status, 413);
  assert.equal(method.status, 405);
});
