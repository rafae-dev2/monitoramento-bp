import { sendNotification, setVapidDetails } from 'web-push';
import { acceptsDeviceAlarm, buildPushPayload, normalizeAlertResponse, toDatabaseAlarm } from '../lib/push-core.mjs';
import { createPushStore } from '../lib/push-store.mjs';
import { fetchOfficialAlarms } from '../lib/push-sgpa.mjs';
import { readRuntimeEnv } from '../lib/push-runtime.mjs';

const ENV_NAMES = [
  'SOLINF_USER', 'SOLINF_PASS', 'CLIENT_OWNER', 'CLIENT_NAME', 'AUTH_API', 'SGPA_API',
  'PUSH_SGPA_UNIT_ID', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PUSH_DB_SECRET',
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
];
const MAX_DELIVERIES_PER_RUN = 20;
const SEND_CONCURRENCY = 4;
const PUSH_TIMEOUT_MS = 4000;
const VAPID_SUBJECT = 'https://sgpa-solinftec-bpa.netlify.app/';

export async function runPushMonitor(dependencies = {}) {
  const env = dependencies.env || readRuntimeEnv(ENV_NAMES);
  const required = [
    'SOLINF_USER', 'SOLINF_PASS', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
    'PUSH_DB_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) return { ok: false, configured: false, missing };

  const fetchImpl = dependencies.fetchImpl || fetch;
  const store = dependencies.store || createPushStore({
    supabaseUrl: env.SUPABASE_URL,
    anonKey: env.SUPABASE_ANON_KEY,
    rpcSecret: env.PUSH_DB_SECRET,
    fetchImpl,
  });
  const registrationState = await store.call('has_subscriptions', {});
  if (!registrationState || registrationState.ok !== true) throw new Error('Push subscription state could not be read');
  if (registrationState.hasSubscriptions !== true) {
    return { ok: true, configured: true, idle: true, reason: 'no-subscriptions', active: 0, pending: 0, sent: 0 };
  }

  const persistedSession = registrationState.cachedToken
    ? {
        token: String(registrationState.cachedToken),
        unitId: registrationState.cachedUnitId ? String(registrationState.cachedUnitId) : '',
        expiresAt: registrationState.tokenExpiresAt ? Date.parse(String(registrationState.tokenExpiresAt)) || 0 : 0,
      }
    : null;

  const rawAlarms = await (dependencies.fetchOfficialAlarms || fetchOfficialAlarms)({
    env,
    fetchImpl,
    persistedSession,
    onSessionRefreshed: dependencies.fetchOfficialAlarms
      ? null
      : async (session) => {
          try {
            await store.call('save_monitor_session', session);
          } catch {
            /* compatível com projetos que ainda não aplicaram a migration opcional de sessão */
          }
        },
  });
  const alarms = normalizeAlarmSource(rawAlarms);
  const pushClient = dependencies.webPush || { sendNotification, setVapidDetails };
  if (!dependencies.skipVapidSetup) pushClient.setVapidDetails(VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

  const sync = await store.call('synchronize_alarms', { alarms: alarms.map(toDatabaseAlarm) });
  const initialBaseline = !!(sync && sync.initialBaseline);
  const pending = Array.isArray(sync && sync.pendingDeliveries) ? sync.pendingDeliveries : [];
  if (initialBaseline) {
    return { ok: true, configured: true, baseline: true, active: alarms.length, pending: 0, sent: 0 };
  }

  let cursor = 0;
  let sent = 0;
  let filtered = 0;
  let failed = 0;
  let expired = 0;
  const queue = pending.slice(0, MAX_DELIVERIES_PER_RUN);

  async function worker() {
    while (cursor < queue.length) {
      const current = queue[cursor++];
      try {
        const deviceId = String(current.deviceId || '');
        const occurrenceId = String(current.occurrenceId || '');
        const payload = current.payload && typeof current.payload === 'object' ? current.payload : {};
        if (!deviceId || !occurrenceId) {
          failed++;
          continue;
        }

        // complete_delivery só transiciona linhas em estado sending. Reivindicar
        // antes de filtrar impede que itens filtered reapareçam no início da fila.
        const claim = await store.call('claim_delivery', { occurrenceId, deviceId });
        if (!claim || claim.claimed !== true) continue;

        if (!current.endpoint || !current.p256dh || !current.auth) {
          failed++;
          await finishQuietly(store, occurrenceId, deviceId, 'failed', 'invalid-subscription');
          continue;
        }

        if (!acceptsDeviceAlarm(current.preferences, payload)) {
          try {
            const result = await store.call('complete_delivery', {
              occurrenceId,
              deviceId,
              status: 'filtered',
              error: null,
            });
            if (!result || result.ok !== true || result.updated === false) throw new Error('filtered state was not persisted');
            filtered++;
          } catch {
            failed++;
            await finishQuietly(store, occurrenceId, deviceId, 'failed', 'filter-state-not-updated');
          }
          continue;
        }

        const notification = buildPushPayload(payload, occurrenceId, current.preferences);
        try {
          await pushClient.sendNotification(
            { endpoint: current.endpoint, keys: { p256dh: current.p256dh, auth: current.auth } },
            JSON.stringify(notification),
            {
              TTL: 120,
              urgency: 'high',
              timeout: PUSH_TIMEOUT_MS,
              topic: String(occurrenceId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
            },
          );
          await store.call('complete_delivery', { occurrenceId, deviceId, status: 'sent', error: null });
          sent++;
        } catch (error) {
          const status = Number((error && (error.statusCode || error.status)) || 0);
          if (status === 404 || status === 410) {
            await store.call('remove_subscription', { deviceId });
            expired++;
          } else {
            await finishQuietly(store, occurrenceId, deviceId, 'failed', status ? `provider-${status}` : 'provider-error');
            failed++;
          }
        }
      } catch {
        failed++;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, queue.length) }, () => worker()));
  return {
    ok: true,
    configured: true,
    baseline: false,
    active: alarms.length,
    pending: pending.length,
    deferred: Math.max(0, pending.length - queue.length),
    sent,
    filtered,
    failed,
    expired,
  };
}

function normalizeAlarmSource(raw) {
  if (Array.isArray(raw) && raw.every((row) => row && typeof row.alarmKey === 'string' && row.payload)) return raw;
  return normalizeAlertResponse(raw);
}

async function finishQuietly(store, occurrenceId, deviceId, status, error) {
  if (!occurrenceId || !deviceId) return;
  try {
    await store.call('complete_delivery', { occurrenceId, deviceId, status, error });
  } catch {
    // A próxima execução tentará de novo a partir do estado persistido.
  }
}

export default async function handler() {
  try {
    const result = await runPushMonitor();
    console.log('[push-monitor]', JSON.stringify(result));
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[push-monitor] execution failed:', error && error.message ? error.message : 'unknown error');
    return new Response(JSON.stringify({ ok: false, error: 'monitor-failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}

export const config = { schedule: '* * * * *' };
