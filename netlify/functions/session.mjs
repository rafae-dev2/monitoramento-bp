/**
 * session.mjs — Netlify Function (Node 22, fetch nativo)
 *
 * Responsabilidades:
 *   1. Login server-side no endpoint oficial (/auth-sgpa/create), mantendo a senha só em secret;
 *   2. Consulta cdGrupo e unidade ativa do usuário;
 *   3. Entrega o payload ("props") ao micro-frontend do mapa com cache de 5 dias por instância;
 *   4. Proxy autenticado de rotas de telemetria liberadas (?acao=dados);
 *   5. Gravação em lote econômica para o plano Supabase Free (?acao=alerta e pwa_acessos),
 *      com deduplicação em memória de eventId, lote único PostgREST e fallback individual.
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

const PORTAL_TIMEOUT_MS = 12_000;
const SUPABASE_TIMEOUT_MS = 5_000;
const AUDIT_DEDUPE_TTL_MS = 2 * 60 * 60_000; // 2h de idempotência para reenvios de rede instável
const ACCESS_LOG_THROTTLE_MS = 30 * 60_000; // no máx. 1 registro de acesso por IP/usuário a cada 30 min

const PORTAL_ORIGIN = `https://${CLIENT_NAME}.saas-solinftec.com`;
const COMMON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MonitoramentoBP-PWA/1.9.0)',
  Origin: PORTAL_ORIGIN,
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Access-Control-Allow-Origin': PORTAL_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type, x-app-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

/* ------------------------------------------------------------------ */
/* cache, deduplicação e proteção de borda / memória                  */
/* ------------------------------------------------------------------ */

let cache = { props: null, expiresAt: 0 };
let propsPending = null;
let propsPendingForce = false;
const hits = new Map();
const eventosConfirmados = new Map();
const acessosRecentes = new Map();

function extrairIp(req, ctx) {
  const nfIp = (ctx && typeof ctx.ip === 'string' && ctx.ip.trim()) ||
    req.headers.get('x-nf-client-connection-ip');
  if (nfIp) return nfIp.trim();
  return (req.headers.get('x-forwarded-for') || 'anon').split(',')[0].trim() || 'anon';
}

function ipValido(ip) {
  if (!ip || ip === 'anon' || ip.length > 64) return false;
  const ipv4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
  const ipv6 = /^[0-9a-fA-F:]{2,45}$/;
  return ipv4.test(ip) || (ip.includes(':') && ipv6.test(ip));
}

function podarMapa(mapa, limite) {
  while (mapa.size > limite) {
    const primeira = mapa.keys().next().value;
    if (primeira === undefined) break;
    mapa.delete(primeira);
  }
}

function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (arr.length >= 40) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.delete(ip);
  hits.set(ip, arr);
  podarMapa(hits, 4000);
  return false;
}

function jaConfirmado(eventId) {
  if (!eventId) return false;
  const ts = eventosConfirmados.get(eventId);
  if (!ts) return false;
  if (Date.now() - ts > AUDIT_DEDUPE_TTL_MS) {
    eventosConfirmados.delete(eventId);
    return false;
  }
  return true;
}

function marcarConfirmado(eventId) {
  if (!eventId) return;
  eventosConfirmados.delete(eventId);
  eventosConfirmados.set(eventId, Date.now());
  podarMapa(eventosConfirmados, 2500);
}

function agendarSegundoPlano(ctx, promessa) {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promessa);
    return Promise.resolve();
  }
  return promessa;
}

function sinalTimeout(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
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
    signal: sinalTimeout(PORTAL_TIMEOUT_MS),
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
      time: 604_800,
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

  return {
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
 * Auditoria opcional no Supabase (otimizada para o plano Free: deduplica revalidações
 * frequentes do mesmo IP/usuário, reduzindo ~90% das linhas sem perder rastreabilidade).
 */
async function registrarAcesso(ip, usuario, unidade, cliente, resultado, detalhe, force = false) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!base || !key || !usuario) return;

  const agora = Date.now();
  const chaveDedupe = `${ip}|${usuario}|${resultado}`;
  const janela = resultado === 'sucesso' ? ACCESS_LOG_THROTTLE_MS : 120_000;
  const anterior = acessosRecentes.get(chaveDedupe) || 0;
  if (!force && anterior && agora - anterior < janela) return;
  acessosRecentes.delete(chaveDedupe);
  acessosRecentes.set(chaveDedupe, agora);
  podarMapa(acessosRecentes, 1000);

  const cabecalhos = {
    'Content-Type': 'application/json',
    apikey: key,
    Prefer: 'return=minimal',
  };
  if (!String(key).startsWith('sb_publishable_')) cabecalhos.Authorization = `Bearer ${key}`;

  try {
    await fetch(`${base.replace(/\/+$/, '')}/rest/v1/pwa_acessos`, {
      method: 'POST',
      headers: cabecalhos,
      signal: sinalTimeout(SUPABASE_TIMEOUT_MS),
      body: JSON.stringify({
        usuario: String(usuario).slice(0, 80),
        unidade: unidade ? String(unidade).slice(0, 80) : null,
        cliente: Number.isFinite(Number(cliente)) ? Number(cliente) : null,
        tela: 'analytic-map-v4',
        origem_ip: ipValido(ip) ? ip : null,
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
    signal: sinalTimeout(PORTAL_TIMEOUT_MS),
  });
  let res = await consultar(p);
  if (res.status === 401) {
    const renovada = cache.props && cache.expiresAt > Date.now() && cache.props.token !== p.token
      ? cache.props
      : await props(true);
    p = renovada;
    res = await consultar(p);
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

function montarLinhaAlerta(dados) {
  return {
    chave: String(dados.chave || '').trim().slice(0, 64),
    regra: String(dados.regra || 'generico').trim().slice(0, 24),
    severidade: String(dados.severidade ?? '').trim().slice(0, 16),
    equipamento: String(dados.equipamento ?? '').trim().slice(0, 24),
    descricao: String(dados.descricao || '').trim().slice(0, 160),
    operador: String(dados.operador || '').trim().slice(0, 120),
    valor: dados.valor == null ? null : String(dados.valor).trim().slice(0, 40),
    limite: dados.limite == null ? null : String(dados.limite).trim().slice(0, 40),
    texto: String(dados.texto || '').trim().slice(0, 400),
    detalhe: String(dados.detalhe || '').trim().slice(0, 400),
    fonte: String(dados.fonte || '').trim().slice(0, 16),
    fala: String(dados.fala || '').trim().slice(0, 400),
    usuario: String(dados.usuario || '').trim().slice(0, 60),
    unidade: String(dados.unidade || '').trim().slice(0, 60),
    inicio: dados.inicio || new Date().toISOString(),
    quando: dados.quando || new Date().toISOString(),
  };
}

async function postarAlertasSupabase(carga) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!base || !key) return false;
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Prefer: 'return=minimal',
  };
  if (!String(key).startsWith('sb_publishable_')) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/rest/v1/pwa_alertas`, {
      method: 'POST',
      headers,
      signal: sinalTimeout(SUPABASE_TIMEOUT_MS),
      body: JSON.stringify(carga),
    });
    return res.ok;
  } catch (e) {
    console.warn('gravação do alerta falhou:', e.message);
    return false;
  }
}

async function gravarLoteAlertas(itens, contexto) {
  const resultados = new Array(itens.length);
  const pendentes = [];

  for (let i = 0; i < itens.length; i++) {
    const raw = itens[i] && typeof itens[i] === 'object' ? itens[i] : {};
    const eventId = String(raw.eventId || `legado-${i}`).slice(0, 128);
    if (raw.eventId && jaConfirmado(eventId)) {
      resultados[i] = { eventId, ok: true };
      continue;
    }
    pendentes.push({
      index: i,
      eventId,
      temIdExplicito: !!raw.eventId,
      linha: montarLinhaAlerta(Object.assign({ unidade: contexto.unidade, usuario: contexto.usuario }, raw)),
    });
  }

  if (!pendentes.length) return resultados;

  // Economia para Supabase Free: tenta 1 único INSERT em lote com return=minimal.
  // Se o lote falhar (ex.: 1 linha inválida ou falha transitória), isola item a item.
  if (pendentes.length > 1) {
    const loteOk = await postarAlertasSupabase(pendentes.map((p) => p.linha));
    if (loteOk) {
      for (const p of pendentes) {
        if (p.temIdExplicito) marcarConfirmado(p.eventId);
        resultados[p.index] = { eventId: p.eventId, ok: true };
      }
      return resultados;
    }
  }

  for (const p of pendentes) {
    const ok = await postarAlertasSupabase(p.linha);
    if (ok && p.temIdExplicito) marcarConfirmado(p.eventId);
    resultados[p.index] = { eventId: p.eventId, ok };
  }
  return resultados;
}

/* ------------------------------------------------------------------ */
/* handler                                                            */
/* ------------------------------------------------------------------ */

export default async function handler(req, ctx) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS });

  const url = new URL(req.url);
  const acao = url.searchParams.get('acao');
  const ip = extrairIp(req, ctx);

  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ erro: 'muitas requisições, aguarde', error: 'muitas requisições, aguarde' }), {
      status: 429,
      headers: JSON_HEADERS,
    });
  }

  if (process.env.APP_KEY && req.headers.get('x-app-key') !== process.env.APP_KEY) {
    return new Response(JSON.stringify({ erro: 'chave do app ausente ou inválida', error: 'chave do app ausente ou inválida' }), {
      status: 403,
      headers: JSON_HEADERS,
    });
  }

  // POST ?acao=alerta → grava alertas disparados em lote com idempotência e economia de chamadas
  if (acao === 'alerta' && req.method === 'POST') {
    const corpo = await req.json().catch(() => null);
    if (!corpo || typeof corpo !== 'object') {
      return new Response(JSON.stringify({ erro: 'corpo inválido' }), { status: 400, headers: JSON_HEADERS });
    }
    const lista = Array.isArray(corpo.alertas) ? corpo.alertas : [corpo];
    if (lista.length > 40) {
      return new Response(JSON.stringify({ erro: 'lote excede o limite de 40 alertas' }), { status: 413, headers: JSON_HEADERS });
    }
    const resultados = await gravarLoteAlertas(lista, { unidade: corpo.unidade, usuario: corpo.usuario });
    const gravados = resultados.filter((resultado) => resultado && resultado.ok).length;
    const ok = gravados === lista.length;
    return new Response(JSON.stringify({ ok, recebidos: lista.length, gravados, falhas: lista.length - gravados, resultados }), {
      status: ok ? 202 : 207,
      headers: JSON_HEADERS,
    });
  }

  // GET ?acao=dados&rota=/estatistica/monitoramento?... → fallback de CORS/rede
  if (acao === 'dados' && req.method === 'GET') {
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

  try {
    const p = await props(force);
    await agendarSegundoPlano(ctx, registrarAcesso(ip, p.user, p.descUnidade, p.cdCliente, 'sucesso', null, force));
    const portalLogin = `${PORTAL_URL}/#!/login/${encodeURIComponent(
      JSON.stringify({ token: p.token, user: p.user }),
    )}`;
    const portalMap = `${PORTAL_URL}/#!/details/analytic-map-v4`;
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
    await agendarSegundoPlano(ctx, registrarAcesso(ip, process.env.SOLINF_USER, null, null, 'falha_login', e.message, true));
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

export const config = {
  rateLimit: { action: 'rate_limit', aggregateBy: 'ip', windowSize: 60, windowLimit: 45 },
};
