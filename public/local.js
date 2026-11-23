/* Modo local — sessão obtida direto do navegador.
 *
 * Existe para o caso de a Netlify Function ainda não ter as credenciais nas
 * variáveis de ambiente (erro 501). O próprio portal Solinftec libera chamada
 * cross-origin para esses endpoints (Access-Control-Allow-Origin: *), então a
 * mesma troca que a função faz pode acontecer no aparelho do usuário.
 *
 * Regras de segurança deste módulo:
 *   - a senha só sai daqui rumo ao endpoint oficial de auth do portal;
 *   - nada é enviado para a Netlify no modo local;
 *   - o armazenamento só acontece se o usuário marcar "lembrar neste aparelho";
 *   - há um botão para apagar tudo ("esquecer este aparelho").
 */

(() => {
  'use strict';

  const CFG = {
    AUTH_API: 'https://auth-api.saas-solinftec.com/auth-api-03/v2',
    SGPA_API: 'https://sgpa-api-br.saas-solinftec.com/slf03',
    SERVICE_API: 'https://api-br.saas-solinftec.com/mapv4/service-7',
    TILE_API: 'https://api-br.saas-solinftec.com/mapv4/tile-service-7',
    INTERP_API: 'https://api-br.saas-solinftec.com/mapv4/interpolation-service-7',
    MAP_URL:
      'https://solinftec-frontends.saas-solinftec.com/solinftec-pwa-mapv4-prod/index.html',
    PORTAL_URL: 'https://branco-peres-cana.saas-solinftec.com',
    CLIENT_OWNER: 'branco_peres_cana',
    CD_CLIENT: 204,
  };

  const CRED_KEY = 'bperes.cred.v1';
  const CACHE_KEY = 'bperes.session.v1';
  const CACHE_TTL = 5 * 24 * 60 * 60 * 1000; // token do portal dura 7 dias

  const store = { remember: true };

  function storage() {
    try {
      return store.remember ? localStorage : sessionStorage;
    } catch {
      return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    }
  }

  /* Ler window.localStorage já lança exceção quando o navegador esta em modo privado,
     com storage bloqueado, ou quando a página roda dentro de iframe de terceiros. O
     helper devolve um depósito em memória no lugar, para o app nunca quebrar por isto. */
  const MEMORIA = {};
  function par(tipo) {
    try {
      return tipo === 's' ? sessionStorage : localStorage;
    } catch {
      return {
        getItem: (k) => (k in MEMORIA ? MEMORIA[k] : null),
        setItem: (k, v) => { MEMORIA[k] = String(v); },
        removeItem: (k) => { delete MEMORIA[k]; },
      };
    }
  }

  function lerCredencial() {
    try {
      const raw = par('l').getItem(CRED_KEY) || par('s').getItem(CRED_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function salvarCredencial(user, password, remember) {
    store.remember = !!remember;
    const alvo = par(remember ? 'l' : 's');
    const outro = par(remember ? 's' : 'l');
    try {
      outro.removeItem(CRED_KEY);
      outro.removeItem(CACHE_KEY);
      alvo.setItem(CRED_KEY, JSON.stringify({ user, password }));
    } catch {
      /* storage recusando ate a escrita em memoria nao e opcao: segue sem lembrar */
      store.remember = false;
    }
  }

  function esquecer() {
    for (const s of [par('l'), par('s')]) {
      try {
        s.removeItem(CRED_KEY);
        s.removeItem(CACHE_KEY);
      } catch {
        /* modo privado: nada a limpar */
      }
    }
  }

  /* Atenção ao CORS: a API de auth aceita o header "request-origin", mas a API
     cadastral (sgpa) NÃO lista esse header no acesso. O header extra é liberado
     apenas quando chamado, senão o navegador bloqueia na fase de preflight. */
  async function api(url, { method = 'GET', token, body, headers = {}, comRequestOrigin = false } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (comRequestOrigin) h['request-origin'] = 'sgpa-front-' + CFG.CLIENT_OWNER;
    if (token) h['X-Auth-Token'] = token;
    if (body) h['content-type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      const e = new Error(
        res.status === 401 || res.status === 403
          ? 'usuário ou senha não aceitos pelo portal'
          : res.status + ' ao falar com o portal',
      );
      e.status = res.status;
      e.senhaRuim = res.status === 401 || res.status === 403;
      e.detail = text.slice(0, 200);
      throw e;
    }
    try {
      return JSON.parse(text);
    } catch {
      const e = new Error('o portal devolveu uma resposta inesperada');
      e.senhaRuim = true;
      throw e;
    }
  }

  async function novoToken(user, password) {
    const data = await api(CFG.AUTH_API + '/auth-sgpa/create', {
      method: 'POST',
      comRequestOrigin: true,
      body: {
        language: 'pt-br',
        login: user,
        password,
        owner: CFG.CLIENT_OWNER,
        time: 604800,
        environment: 'BROWSER',
      },
    });
    const token = data && (data.token || (data.data && data.data.token));
    if (typeof token !== 'string' || !token) {
      const e = new Error('o portal não devolveu um token para este usuário');
      e.senhaRuim = true;
      throw e;
    }
    return token;
  }

  async function montarSessao(user, password) {
    const token = await novoToken(user, password);

    let cdGrupo = 0;
    let unidadeId = 1;
    let descUnidade = '';
    let timeZone = 'America/Sao_Paulo';

    try {
      const u = await api(
        CFG.SGPA_API + '/user/byUsername/' + encodeURIComponent(user),
        { token },
      );
      cdGrupo = Number((u && u.cdGrupo) || 0);
    } catch {
      /* segue com padrão: o mapa também funciona sem o grupo */
    }
    try {
      const unidades = await api(CFG.SGPA_API + '/unidade', { token });
      const un = Array.isArray(unidades) && unidades.length ? unidades[0] : null;
      if (un) {
        unidadeId = Number(un.cdUnidade || 1);
        descUnidade = un.descUnidade || un.cdAbreviacao || '';
        timeZone = (un.regional && un.regional.timeZone) || timeZone;
      }
    } catch {
      descUnidade = 'BRANCO PERES';
    }

    const props = {
      locale: 'pt-br',
      token,
      urlSgp: '',
      urlSgpa: CFG.SGPA_API,
      cdCliente: CFG.CD_CLIENT,
      cdUnidadeRegional: [unidadeId],
      showEquipmentId: true,
      offsetHeight: '0px',
      grupo: 0,
      environmentStage: CFG.CD_CLIENT > 100000 ? 'H' : 'P',
      user,
      userGroupId: cdGrupo,
      rastroBI: null,
      urlTileServiceGo: CFG.TILE_API,
      urlServiceGo: CFG.SERVICE_API,
      urlInterpolationServiceGo: CFG.INTERP_API,
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

    return {
      props,
      mapUrl: CFG.MAP_URL,
      portalMap: CFG.PORTAL_URL + '/#!/details/analytic-map-v4',
      portalLogin:
        CFG.PORTAL_URL +
        '/#!/login/' +
        encodeURIComponent(JSON.stringify({ token, user })),
      monitplusUrl:
        'https://monitplus.saas-solinftec.com/?token=' + encodeURIComponent(token) +
        '&locale=pt-br&unitSGPA=' + encodeURIComponent(unidadeId) +
        '&descUnitSGPA=' + encodeURIComponent(descUnidade) +
        '&authAPI=' + encodeURIComponent(CFG.AUTH_API) +
        '&clientOwner=' + encodeURIComponent(CFG.CLIENT_OWNER),
      who: { usuario: user, unidade: descUnidade, cliente: CFG.CD_CLIENT },
      modo: 'local',
    };
  }

  /**
   * Devolve a sessão pronta para o mapa. Usa o cache quando possível e
   * refaz o login quando o token vence ou quando force=true.
   */
  async function sessaoLocal(forcar) {
    const cred = lerCredencial();
    if (!cred || !cred.user || !cred.password) {
      const e = new Error('sem credenciais neste aparelho');
      e.code = 'sem_credencial';
      throw e;
    }
    store.remember = !!par('l').getItem(CRED_KEY);

    if (!forcar) {
      try {
        const hit = JSON.parse(storage().getItem(CACHE_KEY) || 'null');
        if (hit && hit.expiresAt > Date.now() && hit.session && hit.session.props) {
          return hit.session;
        }
      } catch {
        /* cache corrompido: refaz */
      }
    }

    const session = await montarSessao(cred.user, cred.password);
    try {
      storage().setItem(CACHE_KEY, JSON.stringify({ session, expiresAt: Date.now() + CACHE_TTL }));
    } catch {
      /* sem storage: segue em memória */
    }
    return session;
  }

  window.MonitoramentoLocal = {
    sessaoLocal,
    salvarCredencial,
    lerCredencial,
    esquecer,
    temCredencial: () => !!lerCredencial(),
  };
})();
