import test from 'node:test';
import assert from 'node:assert/strict';
import { createPushStore } from '../../netlify/lib/push-store.mjs';

test('RPC usa chave anon e segredo apenas no corpo server-side, sem service_role', async () => {
  let request;
  const store = createPushStore({
    supabaseUrl: 'https://example.supabase.co/',
    anonKey: 'eyJhbGciOiJIUzI1NiJ9.anon',
    rpcSecret: 'fixture-only-secret',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  const result = await store.call('update_preferences', { deviceId: '00000000-0000-4000-8000-000000000001' });
  assert.deepEqual(result, { ok: true });
  assert.equal(request.url, 'https://example.supabase.co/rest/v1/rpc/pwa_push_rpc');
  assert.equal(request.options.headers.apikey, 'eyJhbGciOiJIUzI1NiJ9.anon');
  assert.equal(request.options.headers.Authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.anon');
  const body = JSON.parse(request.options.body);
  assert.equal(body.p_secret, 'fixture-only-secret');
  assert.equal(body.p_action, 'update_preferences');
});

test('chave sb_publishable usa somente header apikey', async () => {
  let headers;
  const store = createPushStore({
    supabaseUrl: 'https://example.supabase.co',
    anonKey: 'sb_publishable_fixture',
    rpcSecret: 'fixture-only-secret',
    fetchImpl: async (_url, options) => {
      headers = options.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });
  await store.call('list_subscriptions', {});
  assert.equal(headers.apikey, 'sb_publishable_fixture');
  assert.equal(headers.Authorization, undefined);
});
