const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 dias (o JWT SGPA tem validade de 7 dias)

let memorySession = {
  cacheKey: '',
  token: '',
  unitId: '',
  expiresAt: 0,
};
let pendingSession = null;

export function resetPushSgpaCache() {
  memorySession = { cacheKey: '', token: '', unitId: '', expiresAt: 0 };
  pendingSession = null;
}

export async function fetchOfficialAlarms({
  env,
  fetchImpl = fetch,
  persistedSession = null,
  onSessionRefreshed = null,
  now = () => Date.now(),
} = {}) {
  const user = String((env && env.SOLINF_USER) || '');
  const password = String((env && env.SOLINF_PASS) || '');
  if (!user || !password) throw new Error('SGPA monitor credentials are not configured');

  const owner = String(env.CLIENT_OWNER || 'branco_peres_cana');
  const clientName = String(env.CLIENT_NAME || 'branco-peres-cana');
  const authApi = String(env.AUTH_API || 'https://auth-api.saas-solinftec.com/auth-api-03/v2').replace(/\/+$/, '');
  const sgpaApi = String(env.SGPA_API || 'https://sgpa-api-br.saas-solinftec.com/slf03').replace(/\/+$/, '');
  const explicitUnit = String(env.PUSH_SGPA_UNIT_ID || '').trim();
  if (explicitUnit && !/^\d{1,12}$/.test(explicitUnit)) {
    throw new Error('SGPA monitor unit configuration is invalid');
  }

  const portalOrigin = `https://${clientName}.saas-solinftec.com`;
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; MonitoramentoBP-PWA/1.9.0)',
    Origin: portalOrigin,
    'request-origin': `sgpa-front-${owner}`,
  };
  const cacheKey = `${user}|${owner}|${authApi}|${sgpaApi}|${explicitUnit}`;

  async function resolveSession(forceRefresh = false) {
    const currentMs = now();
    if (!forceRefresh && memorySession.cacheKey === cacheKey && memorySession.token && memorySession.expiresAt > currentMs) {
      return memorySession;
    }

    if (!forceRefresh && persistedSession && typeof persistedSession.token === 'string' && persistedSession.token) {
      const persistedExp = Number(persistedSession.expiresAt || 0);
      if (!persistedExp || persistedExp > currentMs + 60_000) {
        const unit = explicitUnit || validUnitId(persistedSession.unitId) || '1';
        memorySession = {
          cacheKey,
          token: persistedSession.token,
          unitId: unit,
          expiresAt: persistedExp || currentMs + SESSION_TTL_MS,
        };
        return memorySession;
      }
    }

    if (pendingSession && !forceRefresh) return pendingSession;

    const promise = (async () => {
      const authResponse = await fetchWithTimeout(fetchImpl, `${authApi}/auth-sgpa/create`, {
        method: 'POST',
        headers: { ...commonHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'pt-br',
          login: user,
          password,
          owner,
          time: 604800,
          environment: 'BROWSER',
        }),
      });
      if (!authResponse.ok) throw new Error(`SGPA authentication failed (${authResponse.status})`);
      const auth = await readJson(authResponse, 'SGPA authentication');
      const token = auth && typeof auth.token === 'string' ? auth.token : '';
      if (!token) throw new Error('SGPA authentication returned no token');

      let unitId = explicitUnit || '1';
      if (!explicitUnit) {
        try {
          const unitRes = await fetchWithTimeout(fetchImpl, `${sgpaApi}/unidade`, {
            method: 'GET',
            headers: { ...commonHeaders, 'X-Auth-Token': token },
          }, 5000);
          if (unitRes && unitRes.ok) {
            const units = await unitRes.json().catch(() => null);
            const first = Array.isArray(units) && units.length ? units[0] : null;
            const discovered = first && validUnitId(first.cdUnidade);
            if (discovered) unitId = discovered;
          }
        } catch {
          /* mantém fallback 1 se /unidade não responder */
        }
      }

      const fresh = {
        cacheKey,
        token,
        unitId,
        expiresAt: now() + SESSION_TTL_MS,
      };
      memorySession = fresh;
      if (typeof onSessionRefreshed === 'function') {
        try {
          await onSessionRefreshed({
            token: fresh.token,
            unitId: fresh.unitId,
            expiresAt: new Date(fresh.expiresAt).toISOString(),
          });
        } catch {
          /* persistência auxiliar não bloqueia a leitura de alarmes */
        }
      }
      return fresh;
    })().finally(() => {
      if (pendingSession === promise) pendingSession = null;
    });

    pendingSession = promise;
    return promise;
  }

  let session = await resolveSession(false);
  let alarmResponse = await queryActiveAlarms(fetchImpl, sgpaApi, commonHeaders, session);

  if (alarmResponse.status === 401) {
    session = await resolveSession(true);
    alarmResponse = await queryActiveAlarms(fetchImpl, sgpaApi, commonHeaders, session);
  }

  if (!alarmResponse.ok) throw new Error(`SGPA active alarms request failed (${alarmResponse.status})`);
  return readJson(alarmResponse, 'SGPA active alarms');
}

function queryActiveAlarms(fetchImpl, sgpaApi, commonHeaders, session) {
  const query = new URLSearchParams({
    idioma: '1',
    ativo: 'true',
    buId: session.unitId || '1',
    language: 'pt-br',
  });
  return fetchWithTimeout(fetchImpl, `${sgpaApi}/alarmeOnline?${query}`, {
    method: 'GET',
    headers: { ...commonHeaders, 'X-Auth-Token': session.token, locale: '1' },
  });
}

function validUnitId(value) {
  const text = String(value == null ? '' : value).trim();
  return /^\d{1,12}$/.test(text) && text !== '0' ? text : '';
}

async function fetchWithTimeout(fetchImpl, url, options, ms = 10000) {
  const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  try {
    return await fetchImpl(url, { ...options, signal: timeout });
  } catch {
    throw new Error('SGPA request timed out or failed');
  }
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}
