import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOfficialAlarms, resetPushSgpaCache } from '../../netlify/lib/push-sgpa.mjs';

const env = {
  SOLINF_USER: 'fixture-user',
  SOLINF_PASS: 'fixture-pass',
  CLIENT_OWNER: 'fixture_owner',
  CLIENT_NAME: 'fixture-client',
  AUTH_API: 'https://auth.fixture.invalid/v2',
  SGPA_API: 'https://sgpa.fixture.invalid/slf03',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('reutiliza token em memória entre ciclos do cron e descobre cdUnidade dinamicamente', async () => {
  resetPushSgpaCache();
  let authCalls = 0;
  let unitCalls = 0;
  const alarmUrls = [];
  let savedSession = null;

  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/auth-sgpa/create')) {
      authCalls++;
      return jsonResponse({ token: `jwt-token-${authCalls}` });
    }
    if (u.endsWith('/unidade')) {
      unitCalls++;
      return jsonResponse([{ cdUnidade: 42 }]);
    }
    if (u.includes('/alarmeOnline?')) {
      alarmUrls.push(u);
      return jsonResponse([{ cdEquipamento: '8833', cdTpAlarme: 5, fgOnline: true }]);
    }
    throw new Error('URL inesperada: ' + u);
  };

  await fetchOfficialAlarms({ env, fetchImpl, onSessionRefreshed: async (s) => { savedSession = s; } });
  await fetchOfficialAlarms({ env, fetchImpl });
  await fetchOfficialAlarms({ env, fetchImpl });

  assert.equal(authCalls, 1, 'deve autenticar apenas uma vez nos 3 ciclos');
  assert.equal(unitCalls, 1, 'deve consultar /unidade apenas na criação da sessão');
  assert.equal(alarmUrls.length, 3);
  assert.ok(alarmUrls.every((u) => u.includes('buId=42')), 'deve usar a unidade descoberta');
  assert.equal(savedSession.token, 'jwt-token-1');
  assert.equal(savedSession.unitId, '42');
});

test('cold start reutiliza sessão persistida no banco sem chamar /auth-sgpa/create', async () => {
  resetPushSgpaCache();
  let authCalls = 0;
  const fetchImpl = async (url, options) => {
    const u = String(url);
    if (u.endsWith('/auth-sgpa/create')) {
      authCalls++;
      return jsonResponse({ token: 'novo-token' });
    }
    if (u.includes('/alarmeOnline?')) {
      assert.equal(options.headers['X-Auth-Token'], 'token-persistido-vault');
      assert.ok(u.includes('buId=7'));
      return jsonResponse([]);
    }
    throw new Error('URL inesperada: ' + u);
  };

  const rows = await fetchOfficialAlarms({
    env,
    fetchImpl,
    persistedSession: {
      token: 'token-persistido-vault',
      unitId: '7',
      expiresAt: Date.now() + 3600_000,
    },
  });
  assert.deepEqual(rows, []);
  assert.equal(authCalls, 0);
});

test('renova automaticamente uma única vez quando o SGPA responde HTTP 401', async () => {
  resetPushSgpaCache();
  let authCalls = 0;
  let alarmAttempts = 0;
  const fetchImpl = async (url, options) => {
    const u = String(url);
    if (u.endsWith('/auth-sgpa/create')) {
      authCalls++;
      return jsonResponse({ token: `renovado-${authCalls}` });
    }
    if (u.endsWith('/unidade')) return jsonResponse([{ cdUnidade: 1 }]);
    if (u.includes('/alarmeOnline?')) {
      alarmAttempts++;
      if (options.headers['X-Auth-Token'] === 'expirado') return jsonResponse({ error: 'expired' }, 401);
      return jsonResponse([{ cdEquipamento: '4462', cdTpAlarme: 2203, fgOnline: true }]);
    }
    throw new Error('URL inesperada: ' + u);
  };

  const rows = await fetchOfficialAlarms({
    env,
    fetchImpl,
    persistedSession: { token: 'expirado', unitId: '1', expiresAt: Date.now() + 3600_000 },
  });
  assert.equal(rows.length, 1);
  assert.equal(authCalls, 1);
  assert.equal(alarmAttempts, 2);
});
