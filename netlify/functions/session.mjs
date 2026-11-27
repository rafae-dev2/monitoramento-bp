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

import {
  VOZES_GEMINI_BR,
  sanitizarApiKeyGemini,
  sintetizarVozGemini,
  raciocinarComGemini,
  gerarLocucaoInteligenteAlerta,
} from '../lib/gemini-coa.mjs';

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
/* cofre de presets COA & FLOW no banco Supabase + cache de borda     */
/* ------------------------------------------------------------------ */

const presetsNuvemMemoria = new Map();

function normalizarCodigoPresetSrv(bruto) {
  return String(bruto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function sanitizarConfigPresetSrv(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  const limpo = { ...cfg };
  for (const proibido of ['geminiKey', 'apiKey', 'token', 'password', 'senha', 'secret']) {
    delete limpo[proibido];
  }
  const serial = JSON.stringify(limpo);
  if (serial.length > 96_000) return null;
  return limpo;
}

async function chamarRpcPresetsSupabase(action, data) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '').trim();
  if (!base || !key) return { disponivel: false, motivo: 'sem_credenciais_supabase' };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    apikey: key,
  };
  if (!key.startsWith('sb_publishable_')) headers.Authorization = `Bearer ${key}`;

  try {
    const res = await fetch(`${base}/rest/v1/rpc/pwa_presets_rpc`, {
      method: 'POST',
      headers,
      signal: sinalTimeout(SUPABASE_TIMEOUT_MS),
      body: JSON.stringify({ p_action: action, p_data: data }),
    });
    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json && json.ok) return { disponivel: true, via: 'supabase_rpc', dados: json };
      if (json && json.error === 'not_found') return { disponivel: true, via: 'supabase_rpc', naoEncontrado: true };
    }
    // Fallback automático para tabela pwa_config caso a chave possua permissão direta e a migração RPC ainda não tenha sido colada
    const chaveAlt = String(process.env.SUPABASE_KEY || '').trim();
    if (chaveAlt) {
      const hdrCfg = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        apikey: chaveAlt,
      };
      if (!chaveAlt.startsWith('sb_publishable_')) hdrCfg.Authorization = `Bearer ${chaveAlt}`;
      if (action === 'salvar') {
        const chaveLinha = `preset:${data.codigo}`;
        const valorObj = {
          codigo: data.codigo,
          nome: data.nome,
          setor: data.setor,
          autor: data.autor || null,
          unidade: data.unidade || null,
          versaoApp: data.versaoApp || null,
          checksum: data.checksum || null,
          temaVisual: data.tema || null,
          painelFixo: Boolean(data.painelFixo),
          resumo: data.resumo || {},
          config: data.config,
          atualizadoEm: new Date().toISOString(),
        };
        const rUp = await fetch(`${base}/rest/v1/pwa_config?on_conflict=chave`, {
          method: 'POST',
          headers: { ...hdrCfg, Prefer: 'resolution=merge-duplicates,return=minimal' },
          signal: sinalTimeout(SUPABASE_TIMEOUT_MS),
          body: JSON.stringify({ chave: chaveLinha, valor: valorObj, atualizado_em: valorObj.atualizadoEm }),
        });
        if (rUp.ok) {
          return {
            disponivel: true,
            via: 'supabase_pwa_config',
            dados: { ok: true, codigo: data.codigo, nome: data.nome, setor: data.setor, atualizadoEm: valorObj.atualizadoEm },
          };
        }
      } else if (action === 'carregar') {
        const chaveLinha = encodeURIComponent(`eq.preset:${data.codigo}`);
        const rGet = await fetch(`${base}/rest/v1/pwa_config?chave=${chaveLinha}&select=valor,atualizado_em&limit=1`, {
          method: 'GET',
          headers: hdrCfg,
          signal: sinalTimeout(SUPABASE_TIMEOUT_MS),
        });
        if (rGet.ok) {
          const arr = await rGet.json().catch(() => []);
          if (Array.isArray(arr) && arr.length && arr[0] && arr[0].valor) {
            return { disponivel: true, via: 'supabase_pwa_config', dados: { ok: true, preset: arr[0].valor } };
          }
          return { disponivel: true, via: 'supabase_pwa_config', naoEncontrado: true };
        }
      } else if (action === 'listar') {
        const rList = await fetch(`${base}/rest/v1/pwa_config?chave=like.preset:*&select=valor,atualizado_em&order=atualizado_em.desc&limit=40`, {
          method: 'GET',
          headers: hdrCfg,
          signal: sinalTimeout(SUPABASE_TIMEOUT_MS),
        });
        if (rList.ok) {
          const arr = await rList.json().catch(() => []);
          const presets = (Array.isArray(arr) ? arr : [])
            .map((x) => x && x.valor)
            .filter((v) => v && v.codigo)
            .map((v) => ({
              codigo: v.codigo,
              nome: v.nome,
              setor: v.setor || 'todos',
              autor: v.autor || null,
              temaVisual: v.temaVisual || null,
              resumo: v.resumo || {},
              atualizadoEm: v.atualizadoEm || null,
            }));
          return { disponivel: true, via: 'supabase_pwa_config', dados: { ok: true, presets } };
        }
      } else if (action === 'excluir') {
        const chaveLinha = encodeURIComponent(`eq.preset:${data.codigo}`);
        const rDel = await fetch(`${base}/rest/v1/pwa_config?chave=${chaveLinha}`, {
          method: 'DELETE',
          headers: hdrCfg,
          signal: sinalTimeout(SUPABASE_TIMEOUT_MS),
        });
        if (rDel.ok) return { disponivel: true, via: 'supabase_pwa_config', dados: { ok: true, codigo: data.codigo } };
      }
    }
    return { disponivel: false, motivo: `supabase_http_${res.status}` };
  } catch (e) {
    return { disponivel: false, motivo: e.message || 'erro_rede_supabase' };
  }
}

async function operarPresetNuvem(subacao, corpo) {
  if (subacao === 'salvar') {
    const codigo = normalizarCodigoPresetSrv(corpo.codigo);
    const nome = String(corpo.nome || '').trim().slice(0, 120);
    const setorBruto = String(corpo.setor || 'todos').toUpperCase();
    const setor = setorBruto === 'COA' || setorBruto === 'FLOW' ? setorBruto : 'todos';
    const config = sanitizarConfigPresetSrv(corpo.config);
    if (codigo.length < 2 || !nome || !config) {
      return { status: 400, body: { ok: false, erro: 'Informe um código (mín. 2 letras/números), nome e configuração válida.' } };
    }
    const registro = {
      codigo,
      nome,
      setor,
      autor: String(corpo.autor || '').trim().slice(0, 80) || null,
      unidade: String(corpo.unidade || '').trim().slice(0, 80) || null,
      versaoApp: String(corpo.versaoApp || '').trim().slice(0, 24) || null,
      checksum: String(corpo.checksum || '').trim().slice(0, 64) || null,
      tema: String(corpo.temaVisual || corpo.tema || '').trim().slice(0, 24) || null,
      painelFixo: Boolean(corpo.painelFixo),
      resumo: corpo.resumo && typeof corpo.resumo === 'object' ? corpo.resumo : {},
      config,
      atualizadoEm: new Date().toISOString(),
    };
    presetsNuvemMemoria.delete(codigo);
    presetsNuvemMemoria.set(codigo, {
      ...registro,
      temaVisual: registro.tema,
    });
    podarMapa(presetsNuvemMemoria, 80);

    const db = await chamarRpcPresetsSupabase('salvar', registro);
    return {
      status: 200,
      body: {
        ok: true,
        codigo,
        nome,
        setor,
        persistidoBanco: Boolean(db.disponivel),
        armazenamento: db.disponivel ? db.via : 'memoria_borda',
        avisoBanco: db.disponivel
          ? null
          : 'Salvo na sessão de borda e no cofre local. Para persistência permanente no Supabase, execute supabase/migrations/20261127140000_pwa_presets_cloud.sql no SQL Editor.',
        atualizadoEm: (db.dados && db.dados.atualizadoEm) || registro.atualizadoEm,
      },
    };
  }

  if (subacao === 'carregar') {
    const codigo = normalizarCodigoPresetSrv(corpo.codigo);
    if (codigo.length < 2) {
      return { status: 400, body: { ok: false, erro: 'Informe um código de perfil válido.' } };
    }
    const db = await chamarRpcPresetsSupabase('carregar', { codigo });
    if (db.disponivel && db.dados && db.dados.preset) {
      presetsNuvemMemoria.set(codigo, db.dados.preset);
      podarMapa(presetsNuvemMemoria, 80);
      return { status: 200, body: { ok: true, origem: db.via, preset: db.dados.preset } };
    }
    if (presetsNuvemMemoria.has(codigo)) {
      return { status: 200, body: { ok: true, origem: 'memoria_borda', preset: presetsNuvemMemoria.get(codigo) } };
    }
    return { status: 404, body: { ok: false, erro: `Nenhum preset encontrado para o código "${codigo}".` } };
  }

  if (subacao === 'listar') {
    const db = await chamarRpcPresetsSupabase('listar', {});
    const mapa = new Map();
    if (db.disponivel && db.dados && Array.isArray(db.dados.presets)) {
      for (const item of db.dados.presets) {
        if (item && item.codigo) mapa.set(item.codigo, item);
      }
    }
    for (const [cod, item] of presetsNuvemMemoria.entries()) {
      if (!mapa.has(cod)) {
        mapa.set(cod, {
          codigo: item.codigo,
          nome: item.nome,
          setor: item.setor || 'todos',
          autor: item.autor || null,
          temaVisual: item.temaVisual || item.tema || null,
          resumo: item.resumo || {},
          atualizadoEm: item.atualizadoEm || null,
        });
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        bancoConectado: Boolean(db.disponivel),
        presets: [...mapa.values()].slice(0, 40),
      },
    };
  }

  if (subacao === 'excluir') {
    const codigo = normalizarCodigoPresetSrv(corpo.codigo);
    if (codigo.length < 2) return { status: 400, body: { ok: false, erro: 'Código inválido.' } };
    presetsNuvemMemoria.delete(codigo);
    const db = await chamarRpcPresetsSupabase('excluir', { codigo });
    return { status: 200, body: { ok: true, codigo, removidoBanco: Boolean(db.disponivel) } };
  }

  return { status: 400, body: { ok: false, erro: 'Subação de preset desconhecida.' } };
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

  // GET ?acao=ia_status → informa se há GEMINI_API_KEY configurada no servidor (sem jamais expor o segredo) e lista as vozes Gemini Brasil
  if (acao === 'ia_status' && req.method === 'GET') {
    const chaveSrv = sanitizarApiKeyGemini(process.env.GEMINI_API_KEY) || sanitizarApiKeyGemini(process.env.GOOGLE_API_KEY);
    return new Response(
      JSON.stringify({
        ok: true,
        servidorConfigurado: Boolean(chaveSrv),
        formatoChave: chaveSrv ? (chaveSrv.startsWith('AQ.') ? 'AQ' : 'AIza') : null,
        modeloTexto: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        modeloVoz: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
        vozes: VOZES_GEMINI_BR,
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  }

  // POST ?acao=ia_voz → síntese neural nas novas vozes brasileiras do Google Gemini
  if (acao === 'ia_voz' && req.method === 'POST') {
    const corpo = await req.json().catch(() => null);
    if (!corpo || typeof corpo !== 'object') {
      return new Response(JSON.stringify({ ok: false, erro: 'corpo inválido' }), { status: 400, headers: JSON_HEADERS });
    }
    try {
      const resultado = await sintetizarVozGemini(corpo);
      return new Response(JSON.stringify(resultado), { status: 200, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, semChave: !!e.semChave, erro: e.message || 'falha ao sintetizar voz Gemini' }),
        { status: e.status || 502, headers: JSON_HEADERS },
      );
    }
  }

  // POST ?acao=ia_raciocinio → raciocínio operacional COA/FLOW com Google Gemini 2.5 Flash Thinking
  if (acao === 'ia_raciocinio' && req.method === 'POST') {
    const corpo = await req.json().catch(() => null);
    if (!corpo || typeof corpo !== 'object') {
      return new Response(JSON.stringify({ ok: false, erro: 'corpo inválido' }), { status: 400, headers: JSON_HEADERS });
    }
    try {
      const resultado = await raciocinarComGemini(corpo);
      return new Response(JSON.stringify(resultado), { status: 200, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, semChave: !!e.semChave, erro: e.message || 'falha ao executar raciocínio IA' }),
        { status: e.status || 502, headers: JSON_HEADERS },
      );
    }
  }

  // POST ?acao=ia_locucao_alerta → analisa alerta com raciocínio Gemini + contexto da frente e já sintetiza áudio WAV pt-BR
  if (acao === 'ia_locucao_alerta' && req.method === 'POST') {
    const corpo = await req.json().catch(() => null);
    if (!corpo || typeof corpo !== 'object') {
      return new Response(JSON.stringify({ ok: false, erro: 'corpo inválido' }), { status: 400, headers: JSON_HEADERS });
    }
    try {
      const resultado = await gerarLocucaoInteligenteAlerta(corpo);
      return new Response(JSON.stringify(resultado), { status: 200, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, semChave: !!e.semChave, erro: e.message || 'falha ao gerar locução inteligente Gemini' }),
        { status: e.status || 502, headers: JSON_HEADERS },
      );
    }
  }

  // GET / POST ?acao=preset_nuvem → salva, carrega, lista ou exclui presets COA/FLOW no banco Supabase
  if (acao === 'preset_nuvem') {
    if (req.method === 'GET') {
      const codigo = url.searchParams.get('codigo');
      const resOp = await operarPresetNuvem(codigo ? 'carregar' : 'listar', { codigo });
      return new Response(JSON.stringify(resOp.body), { status: resOp.status, headers: JSON_HEADERS });
    }
    if (req.method === 'POST') {
      const text = await req.text().catch(() => '');
      if (text.length > 120_000) {
        return new Response(JSON.stringify({ ok: false, erro: 'preset excede o tamanho máximo permitido' }), {
          status: 413,
          headers: JSON_HEADERS,
        });
      }
      let corpo = null;
      try {
        corpo = JSON.parse(text);
      } catch {
        return new Response(JSON.stringify({ ok: false, erro: 'JSON inválido' }), { status: 400, headers: JSON_HEADERS });
      }
      if (!corpo || typeof corpo !== 'object') {
        return new Response(JSON.stringify({ ok: false, erro: 'corpo inválido' }), { status: 400, headers: JSON_HEADERS });
      }
      const resOp = await operarPresetNuvem(String(corpo.subacao || corpo.operacao || 'salvar').toLowerCase(), corpo);
      return new Response(JSON.stringify(resOp.body), { status: resOp.status, headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify({ ok: false, erro: 'método não permitido' }), { status: 405, headers: JSON_HEADERS });
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
