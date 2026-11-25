/**
 * session.mjs — Netlify Function (Node 22, fetch nativo)
 *
 * O que ela faz:
 *   1. faz o login NO SERVIDOR no endpoint do próprio portal (/auth-sgpa/create),
 *      com usuário/senha vindos de variáveis de ambiente. A senha nunca vai para o front.
 *   2. consulta o cdGrupo e a unidade ativa do usuário (mesmas rotas que o portal usa);
 *   3. devolve o payload ("props") que o micro-frontend do mapa aceita por postMessage —
 *      exatamente o mesmo payload que o shell Angular do portal monta em
 *      app.details.analytic-map-v4.
 *
 * Cache: o token tem TTL de 7 dias (time=604800). Cacheamos 5 dias por instância.
 *
 * VARIAVEIS DE AMBIENTE (Netlify → Site settings → Environment variables):
 *   SOLINF_USER     login do portal                       (obrigatório)
 *   SOLINF_PASS     senha do portal                       (obrigatório)
 *   CLIENT_OWNER    dono do tenant, ex.: branco_peres_cana (obrigatório)
 *   CLIENT_NAME     hostname do tenant, ex.: branco-peres-cana (obrigatório)
 *   AUTH_API        base de auth (default já apontado)
 *   SGPA_API        API cadastral (default já apontado)
 *   SERVICE_API / TILE_API / INTERP_API   serviços do map-v4
 *   MAP_URL         URL do micro-frontend do mapa
 *   PORTAL_URL      URL do portal (fallback "abrir no portal")
 *   CD_CLIENT       id do cliente (default 204)
 *   APP_KEY         opcional: exige header x-app-key
 *   PROPS_TTL_SECONDS  opcional: tempo de cache (default 432000 = 5 dias)
 */

const AUTH_API = process.env.AUTH_API || 'https://auth-api.saas-solinftec.com/auth-api-03/v2';
const SGPA_API = process.env.SGPA_API || 'https://sgpa-api-br.saas-solinftec.com/slf03';
const SERVICE_API = process.env.SERVICE_API || 'https://api-br.saas-solinftec.com/mapv4/service-7';
const TILE_API = process.env.TILE_API || 'https://api-br.saas-solinftec.com/mapv4/tile-service-7';
const INTERP_API =
  process.env.INTERP_API || 'https://api-br.saas-solinftec.com/mapv4/interpolation-service-7';
const MAP_URL =
  process.env.MAP_URL ||
  'https://solinftec-frontends.saas-solinftec.com/solinftec-pwa-mapv4-prod/index.html';
const PORTAL_URL = process.env.PORTAL_URL || 'https://branco-peres-cana.saas-solinftec.com';
const CLIENT_OWNER = process.env.CLIENT_OWNER || 'branco_peres_cana';
const CLIENT_NAME = process.env.CLIENT_NAME || 'branco-peres-cana';
const CD_CLIENT = Number(process.env.CD_CLIENT || 204);
const PROPS_TTL = Number(process.env.PROPS_TTL_SECONDS || 432_000);

const PORTAL_ORIGIN = `https://${CLIENT_NAME}.saas-solinftec.com`;
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MonitoramentoBP-PWA/1.0)',
  Origin: PORTAL_ORIGIN,
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': PORTAL_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type, x-app-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/* ------------------------------------------------------------------ */
/* cache + proteção básica                                            */
/* ------------------------------------------------------------------ */

let cache = { props: null, expiresAt: 0 };
let propsPending = null;
let propsPendingForce = false;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const window = 60_000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < window);
  if (arr.length >= 40) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return false;
}

/* ------------------------------------------------------------------ */
/* chamada ao portal                                                  */
/* ------------------------------------------------------------------ */

async function portalFetch(url, { method = 'GET', token, body } = {}) {
  const headers = { ...COMMON_HEADERS, 'request-origin': `sgpa-front-${CLIENT_OWNER}` };
  if (token) {
    headers['X-Auth-Token'] = token;
  }
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} em ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    err.status = res.status;
    err.detail = text.slice(0, 240);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`resposta não é JSON: ${url}`);
    err.detail = text.slice(0, 240);
    throw err;
  }
}

async function createToken(user, password) {
  const data = await portalFetch(`${AUTH_API}/auth-sgpa/create`, {
    method: 'POST',
    body: {
      language: 'pt-br',
      login: user,
      password,
      owner: CLIENT_OWNER,
      time: 604_800, // 7 dias, mesmo valor usado pelo portal
      environment: 'BROWSER',
    },
  });
  if (!data || typeof data.token !== 'string') throw new Error('login não devolveu token');
  return data.token;
}

async function buildProps() {
  const user = process.env.SOLINF_USER;
  const password = process.env.SOLINF_PASS;
  if (!user || !password) {
    const faltando = [!user && 'SOLINF_USER', !password && 'SOLINF_PASS'].filter(Boolean);
    const err = new Error('faltam as variáveis ' + faltando.join(' e ') + ' no Netlify');
    err.status = 501;
    err.config = true;
    err.faltando = faltando;
    throw err;
  }

  const token = await createToken(user, password);

  // dados do usuário (cdGrupo) e da unidade ativa — as mesmas rotas do portal
  let cdGrupo = 0;
  let unidadeId = 1;
  let descUnidade = '';
  let timeZone = 'America/Sao_Paulo';
  try {
    const u = await portalFetch(`${SGPA_API}/user/byUsername/${encodeURIComponent(user)}`, { token });
    cdGrupo = Number(u.cdGrupo || 0);
  } catch (e) {
    console.warn('cdGrupo indisponível:', e.message);
  }
  try {
    const unidades = await portalFetch(`${SGPA_API}/unidade`, { token });
    const un = Array.isArray(unidades) && unidades.length ? unidades[0] : null;
    if (un) {
      unidadeId = Number(un.cdUnidade || 1);
      descUnidade = un.descUnidade || un.cdAbreviacao || '';
      timeZone = (un.regional && un.regional.timeZone) || timeZone;
    }
  } catch (e) {
    console.warn('unidade indisponível:', e.message);
  }

  // payload idêntico ao que o shell do portal entrega ao iframe #map-v4-iframe
  const props = {
    locale: 'pt-br',
    token,
    urlSgp: '',
    urlSgpa: SGPA_API,
    cdCliente: CD_CLIENT,
    cdUnidadeRegional: [unidadeId],
    showEquipmentId: true,
    offsetHeight: '0px',
    grupo: 0,
    environmentStage: CD_CLIENT > 100_000 ? 'H' : 'P',
    user,
    userGroupId: cdGrupo,
    rastroBI: null,
    urlTileServiceGo: TILE_API,
    urlServiceGo: SERVICE_API,
    urlInterpolationServiceGo: INTERP_API,
    apiRobot: '',
    apiRobotMap: '',
    apiRobotCommandOnline: '',
    apiRobotProcessingPhyton: '',
    apiRobotStream: '',
    apiRobotMissionProcessing: '',
    apiRobotHandlerKijo: '',
    apiMapEditor: '',
    apiBoundariesService: '',
    descUnidade,
    environmentType: '',
    timeZone,
    isAdmin: false,
  };
  return props;
}

function props(force = false) {
  if (propsPending) {
    if (propsPendingForce || !force) return propsPending;
    return propsPending.catch(() => {}).then(() => props(true));
  }
  if (!force && cache.props && cache.expiresAt > Date.now()) return Promise.resolve(cache.props);
  propsPendingForce = !!force;
  const pending = buildProps()
    .then((p) => {
      cache = { props: p, expiresAt: Date.now() + PROPS_TTL * 1000 };
      return p;
    })
    .finally(() => {
      if (propsPending === pending) {
        propsPending = null;
        propsPendingForce = false;
      }
    });
  propsPending = pending;
  return pending;
}

/**
 * Auditoria opcional no Supabase (ver supabase/schema.sql).
 * Só roda se SUPABASE_URL + SUPABASE_KEY estiverem definidos; nunca grava senha nem token.
 */
async function registrarAcesso(ip, usuario, unidade, cliente, resultado, detalhe) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!base || !key) return;
  try {
    await fetch(`${base}/rest/v1/pwa_acessos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        usuario,
        unidade,
        cliente,
        tela: 'analytic-map-v4',
        origem_ip: ip && ip !== 'anon' ? ip : null,
        resultado,
        detalhe: detalhe ? String(detalhe).slice(0, 200) : null,
      }),
    });
  } catch (e) {
    console.warn('auditoria falhou (seguindo assim):', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* rotas de telemetria liberadas para o proxy (fallback do navegador)  */
/* ------------------------------------------------------------------ */

const ROTAS_DADOS = [
  '/estatistica/monitoramento',
  '/alarmeOnline',
  '/tipo-alarme',
  '/alarmeOnline/alarme-filtros',
  '/alarmeTempoEquipamento',
  '/canbusOnline',
  '/patrimonioOnline',
  '/regra-expressao',
];

async function dadosDaRota(rota) {
  const alvo = String(rota || '');
  const caminho = alvo.split('?')[0];
  if (!alvo.startsWith('/') || caminho.includes('..') || !ROTAS_DADOS.includes(caminho)) {
    const err = new Error('rota não liberada');
    err.status = 403;
    throw err;
  }
  let p = await props();
  const urlPara = (sessao) => `${SGPA_API}${alvo}${alvo.includes('?') ? '&' : '?'}buId=${(sessao.cdUnidadeRegional || [1])[0]}&language=pt-br`;
  const consultar = (sessao) => fetch(urlPara(sessao), {
    headers: { ...COMMON_HEADERS, 'request-origin': `sgpa-front-${CLIENT_OWNER}`, 'X-Auth-Token': sessao.token, locale: '1' },
    method: 'GET',
  });
  let res = await consultar(p);
  if (res.status === 401) {
    const renovada = cache.props && cache.expiresAt > Date.now() && cache.props.token !== p.token
      ? cache.props
      : await props(true);
    p = renovada;
    res = await consultar(p); // no máximo uma repetição com sessão nova
  }
  const texto = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status} em ${caminho}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(texto);
  } catch {
    const err = new Error('resposta do portal não é JSON');
    err.status = 502;
    throw err;
  }
}

/* grava o alerta no Supabase, quando configurado (auditoria/history) */
async function gravarAlerta(dados) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!base || !key) return false;
  const linha = {
    chave: String(dados.chave || '').slice(0, 64),
    regra: String(dados.regra || '').slice(0, 24),
    severidade: String(dados.severidade || '').slice(0, 16),
    equipamento: String(dados.equipamento ?? '').slice(0, 24),
    descricao: String(dados.descricao || '').slice(0, 160),
    operador: String(dados.operador || '').slice(0, 120),
    valor: dados.valor == null ? null : String(dados.valor).slice(0, 40),
    limite: dados.limite == null ? null : String(dados.limite).slice(0, 40),
    texto: String(dados.texto || '').slice(0, 400),
    detalhe: String(dados.detalhe || '').slice(0, 400),
    fonte: String(dados.fonte || '').slice(0, 16),
    fala: String(dados.fala || '').slice(0, 400),
    usuario: String(dados.usuario || '').slice(0, 60),
    unidade: String(dados.unidade || '').slice(0, 60),
    inicio: dados.inicio || new Date().toISOString(),
    quando: dados.quando || new Date().toISOString(),
  };
  try {
    const res = await fetch(`${base}/rest/v1/pwa_alertas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(linha),
    });
    return res.ok;
  } catch (e) {
    console.warn('gravação do alerta falhou:', e.message);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* handler                                                            */
/* ------------------------------------------------------------------ */

export default async function handler(req, ctx) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

  const url = new URL(req.url);
  const acao = url.searchParams.get('acao');

  // POST ?acao=alerta → grava o alerta disparado no aparelho (auditoria)
  if (acao === 'alerta' && req.method === 'POST') {
    const corpo = await req.json().catch(() => null);
    if (!corpo || typeof corpo !== 'object') {
      return new Response(JSON.stringify({ erro: 'corpo inválido' }), { status: 400, headers: JSON_HEADERS });
    }
    const ip = (req.headers.get('x-forwarded-for') || 'anon').split(',')[0].trim();
    if (rateLimited(ip)) {
      return new Response(JSON.stringify({ erro: 'muitas requisições' }), { status: 429, headers: JSON_HEADERS });
    }
    // o app manda em lote: {alertas:[...]} — confirma cada registro individualmente
    const lista = Array.isArray(corpo.alertas) ? corpo.alertas : [corpo];
    if (lista.length > 40) {
      return new Response(JSON.stringify({ erro: 'lote excede o limite de 40 alertas' }), { status: 413, headers: JSON_HEADERS });
    }
    const resultados = [];
    for (let i = 0; i < lista.length; i++) {
      const item = lista[i] && typeof lista[i] === 'object' ? lista[i] : {};
      const eventId = String(item.eventId || `legado-${i}`).slice(0, 128);
      const ok = await gravarAlerta(Object.assign({ unidade: corpo.unidade, usuario: corpo.usuario }, item));
      resultados.push({ eventId, ok });
    }
    const gravados = resultados.filter((resultado) => resultado.ok).length;
    const ok = gravados === lista.length;
    return new Response(JSON.stringify({ ok, recebidos: lista.length, gravados, falhas: lista.length - gravados, resultados }), {
      status: ok ? 202 : 207,
      headers: JSON_HEADERS,
    });
  }

  // GET ?acao=dados&rota=/estatistica/monitoramento?... → fallback de CORS/rede
  if (acao === 'dados' && req.method === 'GET') {
    const ip = (req.headers.get('x-forwarded-for') || 'anon').split(',')[0].trim();
    if (rateLimited(ip)) {
      return new Response(JSON.stringify({ erro: 'muitas requisições, aguarde' }), { status: 429, headers: JSON_HEADERS });
    }
    try {
      const dados = await dadosDaRota(url.searchParams.get('rota'));
      return new Response(JSON.stringify({ dados }), { status: 200, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ erro: e.message || 'falha no proxy' }), {
        status: e.status && e.status !== 501 ? e.status : 502,
        headers: JSON_HEADERS,
      });
    }
  }

  const force = url.searchParams.get('fresh') === '1';

  const ip = (req.headers.get('x-forwarded-for') || 'anon').split(',')[0].trim();
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'muitas requisições, aguarde' }), {
      status: 429,
      headers: JSON_HEADERS,
    });
  }

  if (process.env.APP_KEY && req.headers.get('x-app-key') !== process.env.APP_KEY) {
    return new Response(JSON.stringify({ error: 'chave do app ausente ou inválida' }), {
      status: 403,
      headers: JSON_HEADERS,
    });
  }

  try {
    const p = await props(force);
    registrarAcesso(ip, p.user, p.descUnidade, p.cdCliente, 'sucesso');
    // deep-link de fallback: abre o portal oficial autenticado, direto na tela pedida
    const portalLogin = `${PORTAL_URL}/#!/login/${encodeURIComponent(
      JSON.stringify({ token: p.token, user: p.user }),
    )}`;
    const portalMap = `${PORTAL_URL}/#!/details/analytic-map-v4`;
    // Monit+ é aberto pelo portal com a sessão na query string; montamos igual.
    const monitplus =
      `https://monitplus.saas-solinftec.com/?token=${encodeURIComponent(p.token)}` +
      `&locale=pt-br&unitSGPA=${encodeURIComponent((p.cdUnidadeRegional || [1])[0])}` +
      `&descUnitSGPA=${encodeURIComponent(p.descUnidade || '')}` +
      `&authAPI=${encodeURIComponent(AUTH_API)}&clientOwner=${encodeURIComponent(CLIENT_OWNER)}`;
    return new Response(
      JSON.stringify({
        props: p,
        mapUrl: MAP_URL,
        portalLogin,
        portalMap,
        monitplusUrl: monitplus,
        cached: true,
        who: { usuario: p.user, unidade: p.descUnidade, cliente: p.cdCliente },
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (e) {
    registrarAcesso(ip, process.env.SOLINF_USER, null, null, 'falha_login', e.message);
    if (e.config) {
      return new Response(
        JSON.stringify({
          error: 'configuracao_incompleta',
          faltando: e.faltando,
          detalhe: e.message,
          guia: [
            'Netlify → Site configuration → Environment secrets → Add a new environment secret',
            'Crie SOLINF_USER com o login do portal e SOLINF_PASS com a senha',
            'Depois: Deploys → Options (⋯) → Redeploy — a função só vê a variável em um deploy novo',
          ],
        }),
        { status: 501, headers: JSON_HEADERS },
      );
    }
    const status = e.status && e.status !== 501 ? 502 : e.status || 500;
    return new Response(
      JSON.stringify({
        error: 'não foi possível obter a sessão do portal',
        detalhe: e.message,
        dica:
          e.status === 401 || /401/.test(e.message)
            ? 'usuário ou senha incorretos — confira SOLINF_USER/SOLINF_PASS'
            : 'confira CLIENT_OWNER, CLIENT_NAME e as URLs nas variáveis de ambiente',
      }),
      { status, headers: JSON_HEADERS },
    );
  }
}
