export async function fetchOfficialAlarms({ env, fetchImpl = fetch } = {}) {
  const user = String(env && env.SOLINF_USER || '');
  const password = String(env && env.SOLINF_PASS || '');
  if (!user || !password) throw new Error('SGPA monitor credentials are not configured');

  const owner = String(env.CLIENT_OWNER || 'branco_peres_cana');
  const clientName = String(env.CLIENT_NAME || 'branco-peres-cana');
  const authApi = String(env.AUTH_API || 'https://auth-api.saas-solinftec.com/auth-api-03/v2').replace(/\/+$/, '');
  const sgpaApi = String(env.SGPA_API || 'https://sgpa-api-br.saas-solinftec.com/slf03').replace(/\/+$/, '');
  const unitId = String(env.PUSH_SGPA_UNIT_ID || '1');
  if (!/^\d{1,12}$/.test(unitId)) throw new Error('SGPA monitor unit configuration is invalid');

  const portalOrigin = `https://${clientName}.saas-solinftec.com`;
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (compatible; MonitoramentoBP-PWA/1.2.6)',
    Origin: portalOrigin,
    'request-origin': `sgpa-front-${owner}`,
  };

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

  const query = new URLSearchParams({ idioma: '1', ativo: 'true', buId: unitId, language: 'pt-br' });
  const alarmResponse = await fetchWithTimeout(fetchImpl, `${sgpaApi}/alarmeOnline?${query}`, {
    method: 'GET',
    headers: { ...commonHeaders, 'X-Auth-Token': token, locale: '1' },
  });
  if (!alarmResponse.ok) throw new Error(`SGPA active alarms request failed (${alarmResponse.status})`);
  return readJson(alarmResponse, 'SGPA active alarms');
}

async function fetchWithTimeout(fetchImpl, url, options) {
  const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
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
