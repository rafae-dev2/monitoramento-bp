export function createPushStore({ supabaseUrl, anonKey, rpcSecret, fetchImpl = fetch } = {}) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const key = String(anonKey || '');
  const secret = String(rpcSecret || '');
  if (!base || !key || !secret) throw new Error('Push database configuration is incomplete');

  return {
    async call(action, data = {}) {
      const headers = {
        apikey: key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (!key.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${key}`;

      let response;
      try {
        response = await fetchImpl(`${base}/rest/v1/rpc/pwa_push_rpc`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ p_secret: secret, p_action: action, p_data: data }),
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined,
        });
      } catch {
        throw new Error('Push database RPC is temporarily unavailable');
      }

      if (!response.ok) throw new Error(`Push database RPC failed (${response.status})`);
      try {
        return await response.json();
      } catch {
        throw new Error('Push database RPC returned invalid JSON');
      }
    },
  };
}
