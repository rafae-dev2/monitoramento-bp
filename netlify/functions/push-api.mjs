import { normalizePushPreferences } from './push-core.mjs';
import { createPushStore } from './push-store.mjs';
import { readRuntimeEnv } from './push-runtime.mjs';

const API_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUSH_DB_SECRET', 'VAPID_PUBLIC_KEY'];
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handlePushRequest(request, dependencies = {}) {
  const env = dependencies.env || readRuntimeEnv(API_ENV);
  if (request.method === 'GET') {
    if (!env.VAPID_PUBLIC_KEY) return json({ ok: false, error: 'push-not-configured' }, 503);
    return json({ ok: true, vapidPublicKey: env.VAPID_PUBLIC_KEY });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405);

  const missing = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUSH_DB_SECRET', 'VAPID_PUBLIC_KEY'].filter((key) => !env[key]);
  if (missing.length) return json({ ok: false, error: 'push-not-configured' }, 503);

  const text = await request.text().catch(() => '');
  if (text.length > 24000) return json({ ok: false, error: 'request-too-large' }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'invalid-json' }, 400);
  }
  if (!isPlainObject(body)) return json({ ok: false, error: 'invalid-request' }, 400);

  const store = dependencies.store || createPushStore({
    supabaseUrl: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    rpcSecret: env.PUSH_DB_SECRET,
    fetchImpl: dependencies.fetchImpl || fetch,
  });

  try {
    if (body.action === 'subscribe') {
      const subscription = body.subscription;
      const deviceId = validDeviceId(body.deviceId);
      if (!deviceId || !validSubscription(subscription)) return json({ ok: false, error: 'invalid-subscription' }, 400);
      const result = await store.call('upsert_subscription', {
        deviceId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        prefs: normalizePushPreferences(body.preferences),
      });
      if (!result || result.ok !== true) return json({ ok: false, error: 'subscription-not-saved' }, 503);
      return json({ ok: true });
    }

    if (body.action === 'sync') {
      const deviceId = validDeviceId(body.deviceId);
      if (!deviceId) return json({ ok: false, error: 'invalid-device' }, 400);
      const result = await store.call('update_preferences', {
        deviceId,
        prefs: normalizePushPreferences(body.preferences),
      });
      if (result && result.ok === false && result.error === 'not_found') return json({ ok: false, error: 'subscription-not-found' }, 404);
      if (!result || result.ok !== true) return json({ ok: false, error: 'push-service-unavailable' }, 503);
      return json({ ok: true });
    }

    if (body.action === 'unsubscribe') {
      const deviceId = validDeviceId(body.deviceId);
      if (!deviceId) return json({ ok: false, error: 'invalid-device' }, 400);
      const result = await store.call('delete_subscription', { deviceId });
      if (!result || result.ok !== true) return json({ ok: false, error: 'push-service-unavailable' }, 503);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'unknown-action' }, 400);
  } catch (error) {
    console.error('[push-api] request failed:', error && error.message ? error.message : 'unknown error');
    return json({ ok: false, error: 'push-service-unavailable' }, 503);
  }
}

export default async function handler(request) {
  return handlePushRequest(request);
}

export const config = {
  path: '/api/push',
  method: ['GET', 'POST'],
  rateLimit: { action: 'rate_limit', aggregateBy: 'ip', windowSize: 60, windowLimit: 30 },
};

export function validDeviceId(value) {
  const id = String(value || '').trim();
  return UUID_RE.test(id) ? id : '';
}

function validSubscription(value) {
  if (!isPlainObject(value) || !isPlainObject(value.keys)) return false;
  const endpoint = String(value.endpoint || '');
  if (endpoint.length < 32 || endpoint.length > 2048) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !allowedPushHost(url.hostname)) return false;
  const p256dh = String(value.keys.p256dh || '');
  const auth = String(value.keys.auth || '');
  return p256dh.length >= 32 && p256dh.length <= 300 && auth.length >= 16 && auth.length <= 200;
}

function allowedPushHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'fcm.googleapis.com'
    || host === 'web.push.apple.com'
    || host.endsWith('.push.services.mozilla.com')
    || host === 'push.services.mozilla.com'
    || host.endsWith('.notify.windows.com');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}
