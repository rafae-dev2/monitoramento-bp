/* Monitoramento BP — PWA shell
 *
 * Fluxo: pede a sessão à Netlify Function -> recebe as "props" do mapa ->
 * carrega o micro-frontend oficial do mapa num iframe e entrega as props por
 * postMessage, do mesmo jeito que o shell Angular do portal faz.
 */

(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/session';
  const REPOST_MS = 1000 * 60 * 60 * 4; // revalida a sessão e sincroniza as props a cada 4h
  const FORCE_RENEW_MS = 1000 * 60 * 60 * 24; // renova antes do prazo de cache de 5 dias
  const RESUME_RENEW_MS = 1000 * 60 * 10; // retomada após suspensão prolongada
  const $ = (id) => document.getElementById(id);

  const el = {
    map: $('map'),
    boot: $('boot'),
    bootMsg: $('boot-msg'),
    bootSub: $('boot-sub'),
    error: $('error'),
    errMsg: $('err-msg'),
    errTip: $('err-tip'),
    errGuide: $('err-guide'),
    menu: $('menu'),
    login: $('login'),
    loginUser: $('login-user'),
    loginPass: $('login-pass'),
    loginRemember: $('login-remember'),
    loginError: $('login-error'),
    loginNote: $('login-note'),
    about: $('about'),
    who: $('who'),
    sessionStatus: $('session-status'),
    bar: $('bar'),
    stage: $('stage'),
  };

  let session = null;
  let repostTimer = null;
  let sessionRetryTimer = null;
  let sessionSyncPending = null;
  let sessionSyncWasForced = false;
  let lastSessionRenewalAt = 0;
  let hiddenSince = 0;
  let lastOnlineRecoveryAt = 0;
  let lastResumeSyncAt = 0;
  let serviceWorkerRegistration = null;
  let sessionRetryDelay = 30_000;
  let alertasLigados = false;
  let pendingEquipmentFocus = normalizarFocoEquipamento(new URLSearchParams(location.search).get('focusEquipment'));
  let focusHandshakeUntil = 0;
  let focusRevision = 0;
  const ALERTAS_ON =
    new URLSearchParams(location.search).get('alertas') !== '0' &&
    typeof window !== 'undefined' &&
    !!window.MonitoramentoAlertas;

  /* -------------------------- rotas de tela -------------------------- */
  // Só o mapa analítico v4 tem micro-frontend embedável. As demais telas
  // vivem dentro do shell do portal (que bloqueia iframe), então abrem lá.
  const TELA = (new URLSearchParams(location.search).get('tela') || 'analytic-map-v4').trim();
  const EMBEDAVEL = new Set(['analytic-map-v4', 'mapa', 'map-v4']);

  /* ------------------------------ ui ------------------------------- */
  const show = (node) => node && node.classList.remove('hide');
  const hide = (node) => node && node.classList.add('hide');

  function boot(msg, sub) {
    el.bootMsg.textContent = msg;
    if (sub) el.bootSub.textContent = sub;
    show(el.boot);
    hide(el.error);
  }

  function fail(title, tip, guia) {
    hide(el.boot);
    hide(el.login);
    el.errMsg.textContent = title;
    el.errTip.textContent = tip || '';
    el.errGuide.textContent = '';
    if (Array.isArray(guia) && guia.length) {
      for (const item of guia) {
        const li = document.createElement('li');
        li.textContent = item;
        el.errGuide.appendChild(li);
      }
      show(el.errGuide);
    } else {
      hide(el.errGuide);
    }
    show(el.error);
  }

  function statusSessao(mensagem, erro) {
    if (!el.sessionStatus) return;
    el.sessionStatus.textContent = mensagem || '';
    el.sessionStatus.classList.toggle('erro', !!erro && !!mensagem);
    if (mensagem) show(el.sessionStatus);
    else hide(el.sessionStatus);
  }

  /* --------------------------- sessão/mapa -------------------------- */
  async function fetchSession(force) {
    const headers = { accept: 'application/json' };
    if (typeof window !== 'undefined' && window.__APP_KEY) headers['x-app-key'] = String(window.__APP_KEY);
    const res = await fetch(ENDPOINT + (force ? '?fresh=1' : ''), {
      method: 'GET',
      headers,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.props) {
      const e = new Error(data.detalhe || data.error || 'HTTP ' + res.status);
      e.tip = data.dica;
      e.guia = data.guia;
      e.config = data.error === 'configuracao_incompleta';
      e.status = res.status;
      throw e;
    }
    return data;
  }

  /* Ordem de obtenção da sessão:
     1) Netlify Function (senha fica no servidor — caminho recomendado);
     2) modo local, se o usuário já salvou as credenciais neste aparelho;
     3) pedir as credenciais na tela. */
  async function obterSessao(force) {
    let erroServidor = null;
    try {
      return await fetchSession(force);
    } catch (e) {
      erroServidor = e;
    }

    const L = window.MonitoramentoLocal;
    if (L && L.temCredencial()) {
      try {
        return await L.sessaoLocal(force);
      } catch (e) {
        L.esquecer();
        e.pedeCredencial = true;
        e.guia = erroServidor && erroServidor.guia;
        throw e;
      }
    }

    if (erroServidor && erroServidor.config) {
      const e = new Error('entre com seu usuário e senha do portal');
      e.pedeCredencial = true;
      e.guia = erroServidor.guia;
      throw e;
    }
    throw erroServidor;
  }

  function sincronizarSessao(forcar) {
    if (!session) return Promise.resolve(null);
    if (sessionSyncPending) {
      if (!forcar || sessionSyncWasForced) return sessionSyncPending;
      // Uma recuperação forçada por 401 tem precedência sobre uma checagem de cache em andamento.
      return sessionSyncPending.catch(() => {}).then(() => sincronizarSessao(true));
    }
    sessionSyncWasForced = !!forcar;
    sessionSyncPending = (async () => {
      const atualizada = await obterSessao(!!forcar);
      session = atualizada;
      statusSessao('');
      if (forcar || !lastSessionRenewalAt) lastSessionRenewalAt = Date.now();
      clearTimeout(sessionRetryTimer);
      sessionRetryTimer = null;
      sessionRetryDelay = 30_000;
      sendProps();
      const w = session.who || {};
      el.who.textContent = [w.usuario, w.unidade].filter(Boolean).join(' · ') +
        (session.modo === 'local' ? ' · local' : '');
      if (ALERTAS_ON && alertasLigados) MonitoramentoAlertas.atualizarSessao(session);
      return session;
    })().catch((erro) => {
      const mensagem = erro && erro.message ? erro.message : 'falha ao renovar a sessão';
      statusSessao(
        'Sessão SGPA indisponível. O app tentará renovar automaticamente; se persistir, abra ⚙ e escolha “Nova sessão” ou “Entrar com minha senha neste aparelho”.',
        true,
      );
      if (ALERTAS_ON && alertasLigados) MonitoramentoAlertas.atualizarSessao({ erro: mensagem });
      console.warn('Sessão SGPA indisponível; o aplicativo tentará novamente:', mensagem);
      if (!sessionRetryTimer) {
        const espera = sessionRetryDelay;
        sessionRetryDelay = Math.min(15 * 60_000, sessionRetryDelay * 2);
        sessionRetryTimer = setTimeout(() => {
          sessionRetryTimer = null;
          sincronizarSessao(true).catch(() => {});
        }, espera);
      }
      throw erro;
    }).finally(() => {
      sessionSyncPending = null;
      sessionSyncWasForced = false;
    });
    return sessionSyncPending;
  }

  function iniciarVigiaSessao() {
    clearInterval(repostTimer);
    repostTimer = setInterval(() => {
      const forcar = !lastSessionRenewalAt || Date.now() - lastSessionRenewalAt >= FORCE_RENEW_MS;
      sincronizarSessao(forcar).catch(() => {});
    }, REPOST_MS);
  }

  function sendProps() {
    if (!session) return;
    try {
      const origin = new URL(session.mapUrl, location.href).origin;
      const props = JSON.parse(JSON.stringify(session.props));
      const equipamento = normalizarFocoEquipamento(pendingEquipmentFocus);
      if (equipamento) {
        const rastroBI = Object.assign({}, props.rastroBI || {}, { equipment: equipamento });
        delete rastroBI.start;
        delete rastroBI.end;
        props.rastroBI = rastroBI;
      }
      el.map.contentWindow.postMessage({ type: 'props', data: props }, origin);
    } catch (e) {
      console.warn('postMessage falhou', e);
    }
  }

  function normalizarFocoEquipamento(value) {
    const id = String(value || '').trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '';
  }

  function limparFocoPendente(id) {
    if (pendingEquipmentFocus === id) {
      pendingEquipmentFocus = '';
      focusRevision++;
    }
    try {
      const url = new URL(location.href);
      if (url.searchParams.get('focusEquipment') !== id) return;
      url.searchParams.delete('focusEquipment');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch {
      /* o foco já foi aplicado; a URL pode permanecer se o History API estiver indisponível */
    }
  }

  function focarEquipamentoNotificado(value) {
    const id = normalizarFocoEquipamento(value);
    if (!id) {
      if (ALERTAS_ON && alertasLigados && window.MonitoramentoAlertas) MonitoramentoAlertas.abrirPainel();
      return;
    }
    pendingEquipmentFocus = id;
    const revision = ++focusRevision;
    if (!session) return; // a sessão/mapa aplicará o foco quando terminar de carregar
    sendProps();
    if (Date.now() < focusHandshakeUntil) return; // os reenvios iniciais já carregam o foco
    let tentativas = 0;
    const reenviar = () => {
      if (revision !== focusRevision) return;
      if (session) sendProps();
      tentativas++;
      if (tentativas >= 6) limparFocoPendente(id);
      else setTimeout(reenviar, 600);
    };
    setTimeout(reenviar, 600);
  }

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (!ev.data) return;
      if (ev.data.type === 'alerta-push-visivel') {
        if (ALERTAS_ON && alertasLigados && window.MonitoramentoAlertas && typeof window.MonitoramentoAlertas.ciclo === 'function') {
          window.MonitoramentoAlertas.ciclo();
        }
        return;
      }
      if (ev.data.type !== 'alerta-notificacao') return;
      focarEquipamentoNotificado(ev.data.equipamento);
    });
  }

  async function openEmbeddedMap(force) {
    boot('Validando sua sessão no portal…', 'tela: mapa analítico v4 (analytic-map-v4)');
    try {
      session = await obterSessao(force);
      statusSessao('');
      if (force || !lastSessionRenewalAt) lastSessionRenewalAt = Date.now();
    } catch (e) {
      if (e.pedeCredencial) {
        abrirLogin(e.guia, e.message);
        return;
      }
      fail(
        'Sessão automática indisponível: ' + e.message,
        e.guia
          ? 'O app está publicado corretamente — falta apenas informar o login e a senha do portal no Netlify (uma vez só).'
          : (e.tip || '') + ' Se você é o dono do app, confira as variáveis do Netlify.',
        e.guia,
      );
      return;
    }
    iniciarMapa();
  }

  function iniciarMapa() {
    hide(el.login);
    statusSessao('');
    const w = session.who || {};
    el.who.textContent = [w.usuario, w.unidade].filter(Boolean).join(' · ') +
      (session.modo === 'local' ? ' · local' : '');

    focusHandshakeUntil = Date.now() + 4100;
    el.map.onload = () => {
      // o portal também envia mais de uma vez; isso cobre a ordem de boot do Vue
      sendProps();
      setTimeout(sendProps, 700);
      setTimeout(sendProps, 2200);
      setTimeout(() => {
        sendProps();
        const equipamento = pendingEquipmentFocus;
        if (equipamento) limparFocoPendente(equipamento);
      }, 4200);
      setTimeout(() => hide(el.boot), 2500);
      // o motor de alertas começa junto com o mapa (mesma sessão, mesmo token)
      setTimeout(ligarAlertas, 1200);
      iniciarVigiaSessao();
    };

    boot('Carregando o mapa…', 'unidade ' + (w.unidade || '—'));
    el.map.src = session.mapUrl;
  }

  /* ------------------------- central de alertas ------------------------- */
  // A central compartilha a sessão e o iframe do mapa para localizar alertas no mapa atual.
  function ligarAlertas() {
    if (!ALERTAS_ON) return;
    try {
      MonitoramentoAlertas.iniciar({
        props: session.props,
        mapUrl: session.mapUrl,
        renovar: () => sincronizarSessao(true),
      });
      alertasLigados = true;
    } catch (e) {
      console.warn('central de alertas não iniciou', e);
    }
  }

  function abrirCentralSegura() {
    if (!ALERTAS_ON) return;
    if (!alertasLigados) {
      if (session) ligarAlertas();
      else return;
    }
    if (typeof MonitoramentoAlertas.abrirPainel === 'function') MonitoramentoAlertas.abrirPainel();
  }

  $('btn-alertas').addEventListener('click', abrirCentralSegura);
  if ($('coa-live')) $('coa-live').addEventListener('click', abrirCentralSegura);
  if ($('coa-sev')) $('coa-sev').addEventListener('click', abrirCentralSegura);

  if ($('btn-voz-bar')) {
    $('btn-voz-bar').addEventListener('click', () => {
      if (!ALERTAS_ON) return;
      if (!alertasLigados && session) ligarAlertas();
      if (typeof MonitoramentoAlertas.alternarVoz === 'function') {
        MonitoramentoAlertas.alternarVoz();
      }
    });
  }

  function acionarPipCoa() {
    if (!ALERTAS_ON) return;
    if (!alertasLigados && session) ligarAlertas();
    if (typeof MonitoramentoAlertas.alternarJanelaFlutuante === 'function') {
      MonitoramentoAlertas.alternarJanelaFlutuante();
    }
  }

  if ($('btn-pip')) $('btn-pip').addEventListener('click', acionarPipCoa);

  if ($('btn-mic-bar')) {
    $('btn-mic-bar').addEventListener('click', () => {
      if (!ALERTAS_ON) return;
      if (!alertasLigados && session) ligarAlertas();
      if (typeof MonitoramentoAlertas.ouvirComandoVoz === 'function') {
        MonitoramentoAlertas.ouvirComandoVoz();
      } else if (typeof MonitoramentoAlertas.abrirPainel === 'function') {
        MonitoramentoAlertas.abrirPainel('comboio');
      }
    });
  }

  const elClock = $('coa-clock');
  if (elClock) {
    const atualizarRelogioCoa = () => {
      try {
        elClock.textContent = new Date().toLocaleTimeString('pt-BR', { hour12: false });
      } catch {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        elClock.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      }
    };
    atualizarRelogioCoa();
    setInterval(atualizarRelogioCoa, 1000);
  }

  /* ---------------------------- fallback ---------------------------- */
  async function openInPortal(which) {
    boot('Abrindo a tela no portal…', which);
    try {
      session = session || (await obterSessao(false));
    } catch (e) {
      if (e.pedeCredencial) {
        abrirLogin(e.guia, e.message);
        return;
      }
      fail('Sessão automática indisponível: ' + e.message, e.tip || '');
      return;
    }
    const alvo =
      which === 'monitplus' ? session.monitplusUrl : session.portalMap;
    window.open(alvo, which === 'portal' ? '_self' : '_blank', 'noopener');
    hide(el.boot);
  }

  /* ---------------------------- controles --------------------------- */
  $('btn-reload').addEventListener('click', () => {
    hide(el.error);
    openEmbeddedMap(false);
  });
  $('btn-retry').addEventListener('click', () => {
    hide(el.error);
    openEmbeddedMap(true);
  });

  /* --------------------------- tela de login -------------------------- */
  function abrirLogin(guia, motivo) {
    hide(el.boot);
    hide(el.error);
    const ruím = motivo && motivo.indexOf('entre com seu usuário') !== 0;
    el.loginError.textContent = ruím ? motivo : '';
    el.loginNote.textContent =
      'A senha fica somente na memória enquanto esta aba estiver aberta. Se marcar abaixo, apenas o usuário será lembrado; senha e token SGPA não são gravados no armazenamento do navegador. ' +
      'Para login automático, mantenha SOLINF_USER e SOLINF_PASS como secrets no Netlify.';
    const cred = window.MonitoramentoLocal && MonitoramentoLocal.lerCredencial();
    if (cred && cred.user) el.loginUser.value = cred.user;
    show(el.login);
    setTimeout(() => (cred && cred.user ? el.loginPass : el.loginUser).focus(), 60);
  }

  $('btn-entrar').addEventListener('click', entrar);
  el.loginPass.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') entrar();
  });

  async function entrar() {
    const user = el.loginUser.value.trim();
    const pass = el.loginPass.value;
    if (!user || !pass) {
      el.loginError.textContent = 'preencha usuário e senha';
      return;
    }
    el.loginError.textContent = 'entrando…';
    try {
      MonitoramentoLocal.salvarCredencial(user, pass, el.loginRemember.checked);
      session = await MonitoramentoLocal.sessaoLocal(true);
    } catch (e) {
      MonitoramentoLocal.esquecer();
      el.loginError.textContent = e.message || 'não foi possível entrar';
      return;
    }
    el.loginError.textContent = '';
    hide(el.login);
    iniciarMapa();
  }

  $('btn-login-cancelar').addEventListener('click', () => {
    hide(el.login);
    fail('Sem sessão automática', 'Cadastre as credenciais no Netlify ou use "Entrar com minha senha".');
  });

  $('btn-menu').addEventListener('click', () => (el.menu.classList.contains('hide') ? show(el.menu) : hide(el.menu)));
  $('btn-portal').addEventListener('click', () => {});
  if ($('btn-chamados-bar')) {
    $('btn-chamados-bar').addEventListener('click', () => {
      if (ALERTAS_ON && !alertasLigados && session) ligarAlertas();
      if (window.MonitoramentoAlertas && typeof window.MonitoramentoAlertas.abrirSistemaChamados === 'function') {
        window.MonitoramentoAlertas.abrirSistemaChamados('/novo');
      } else {
        window.open('/chamados-app.html?rota=/novo', '_blank', 'noopener');
      }
    });
  }

  const CORES_TEMA_SHELL = { vidro: '#080e14', escuro: '#0b1017', claro: '#eef2f6', esmeralda: '#06140f', black: '#000000' };
  function normalizarTemaShell(valor) {
    if (valor === 'black' || valor === 'solido') return 'black';
    if (valor === 'claro' || valor === 'light') return 'claro';
    if (valor === 'escuro' || valor === 'dark') return 'escuro';
    if (valor === 'esmeralda' || valor === 'safra') return 'esmeralda';
    return 'vidro';
  }
  function aplicarTemaShell(valor, persistir) {
    if (window.MonitoramentoAlertas && typeof window.MonitoramentoAlertas.aplicarTema === 'function') {
      return window.MonitoramentoAlertas.aplicarTema(valor, persistir);
    }
    const v = normalizarTemaShell(valor);
    const modo = v === 'claro' ? 'light' : 'dark';
    const root = document.documentElement;
    const trocou = root.dataset.acabamento && root.dataset.acabamento !== v;
    if (trocou) root.dataset.trocandoTema = '1';
    root.dataset.acabamento = v;
    root.style.colorScheme = modo;
    const metaCor = document.getElementById('meta-theme-color') || document.querySelector('meta[name="theme-color"]');
    if (metaCor && CORES_TEMA_SHELL[v]) metaCor.setAttribute('content', CORES_TEMA_SHELL[v]);
    for (const btn of document.querySelectorAll('[data-tema]')) {
      btn.setAttribute('aria-pressed', btn.dataset.tema === v ? 'true' : 'false');
    }
    if (trocou) {
      const limpar = () => { delete root.dataset.trocandoTema; };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(limpar));
      else setTimeout(limpar, 0);
    }
    if (persistir) {
      try {
        localStorage.setItem('bperes.visual.acabamento.v1', v);
        localStorage.setItem('bp_theme_preference_v1', modo);
      } catch { /* sem storage */ }
    }
    return v;
  }
  {
    let inicial = document.documentElement.dataset.acabamento || 'vidro';
    try {
      const salvo = localStorage.getItem('bperes.visual.acabamento.v1');
      if (salvo) inicial = salvo;
    } catch { /* sem storage */ }
    aplicarTemaShell(inicial, false);
  }

  el.menu.addEventListener('click', (ev) => {
    if (ev.target === el.menu) {
      hide(el.menu);
      return;
    }
    const btnTema = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-tema]') : null;
    if (btnTema) {
      aplicarTemaShell(btnTema.dataset.tema, true);
      return;
    }
    const alvo = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-act]') : ev.target;
    const act = alvo && alvo.dataset && alvo.dataset.act;
    if (!act) return;
    hide(el.menu);
    if (act === 'reload') openEmbeddedMap(false);
    if (act === 'fresh') openEmbeddedMap(true);
    if (act === 'portal') openInPortal('portal');
    if (act === 'monitplus') openInPortal('monitplus');
    if (act === 'fullscreen') toggleFullscreen();
    if (act === 'credencial') abrirLogin();
    if (act === 'esquecer') {
      MonitoramentoLocal.esquecer();
      session = null;
      el.map.removeAttribute('src');
      openEmbeddedMap(true);
    }
    if (act === 'about') showAbout();
    if (act === 'alertas' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      MonitoramentoAlertas.abrirPainel('ativos');
    }
    if (act === 'chamados') {
      if (ALERTAS_ON && !alertasLigados && session) ligarAlertas();
      if (window.MonitoramentoAlertas && typeof window.MonitoramentoAlertas.abrirSistemaChamados === 'function') {
        window.MonitoramentoAlertas.abrirSistemaChamados('/novo');
      } else {
        window.open('/chamados-app.html?rota=/novo', '_blank', 'noopener');
      }
    }
    if (act === 'fixar-painel' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      if (typeof MonitoramentoAlertas.alternarPainelFixo === 'function') {
        MonitoramentoAlertas.alternarPainelFixo();
      } else {
        MonitoramentoAlertas.abrirPainel('ativos');
      }
    }
    if (act === 'frentes' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      MonitoramentoAlertas.abrirPainel('frentes');
    }
    if (act === 'comboio' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      MonitoramentoAlertas.abrirPainel('comboio');
    }
    if (act === 'alocoa' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      if (typeof MonitoramentoAlertas.abrirAssistenteCoa === 'function') {
        MonitoramentoAlertas.abrirAssistenteCoa();
      } else {
        MonitoramentoAlertas.abrirPainel('comboio');
      }
    }
    if (act === 'passagem' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      if (typeof MonitoramentoAlertas.abrirPassagemTurno === 'function') MonitoramentoAlertas.abrirPassagemTurno();
    }
    if (act === 'telao') {
      if (window.MonitoramentoAlertas && typeof window.MonitoramentoAlertas.alternarTelao === 'function') {
        window.MonitoramentoAlertas.alternarTelao();
      } else {
        const ativo = document.documentElement.dataset.telao === '1';
        document.documentElement.dataset.telao = ativo ? '0' : '1';
      }
    }
    if (act === 'regras' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      MonitoramentoAlertas.abrirPainel();
      MonitoramentoAlertas.configurar({});
      const cfgBtn = document.getElementById('btn-cfg');
      if (cfgBtn) cfgBtn.click();
    }
    if (act === 'pip') acionarPipCoa();
    if (act === 'teste' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      if (typeof MonitoramentoAlertas.testar === 'function') MonitoramentoAlertas.testar();
    }
  });

  el.about.addEventListener('click', (ev) => {
    if (ev.target === el.about) {
      hide(el.about);
      return;
    }
    const alvo = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-act]') : ev.target;
    if (alvo && alvo.dataset && alvo.dataset.act === 'close-about') hide(el.about);
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }

  function showAbout() {
    const w = (session && session.who) || {};
    $('about-meta').textContent =
      'tela: ' + TELA + ' · usuário: ' + (w.usuario || '—') + ' · unidade: ' + (w.unidade || '—') +
      ' · cliente: ' + (w.cliente || '—');
    show(el.about);
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'F5' || (ev.ctrlKey && ev.key === 'r')) {
      ev.preventDefault();
      openEmbeddedMap(false);
    }
    if (ev.key === 'Escape') {
      hide(el.menu);
      hide(el.about);
      if (document.documentElement.dataset.telao === '1' && window.MonitoramentoAlertas && typeof window.MonitoramentoAlertas.alternarTelao === 'function') {
        window.MonitoramentoAlertas.alternarTelao(false);
      }
    }
  });

  function verificarAtualizacaoServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const registro = serviceWorkerRegistration
      ? Promise.resolve(serviceWorkerRegistration)
      : navigator.serviceWorker.getRegistration();
    registro.then((r) => {
      if (!r || typeof r.update !== 'function') return;
      serviceWorkerRegistration = r;
      return r.update();
    }).catch(() => {});
  }

  function sincronizarAoRetomar(forcar, ignorarCooldown) {
    verificarAtualizacaoServiceWorker();
    if (!EMBEDAVEL.has(TELA) || !session) return;
    const agora = Date.now();
    if (!ignorarCooldown && agora - lastResumeSyncAt < 5000) return;
    lastResumeSyncAt = agora;
    const suspensa = hiddenSince > 0 && agora - hiddenSince >= RESUME_RENEW_MS;
    hiddenSince = 0;
    const renovar = !!forcar || suspensa || !lastSessionRenewalAt || agora - lastSessionRenewalAt >= FORCE_RENEW_MS;
    sincronizarSessao(renovar).then(() => {
      if (ALERTAS_ON && alertasLigados && window.MonitoramentoAlertas &&
          typeof window.MonitoramentoAlertas.ciclo === 'function') {
        return Promise.resolve(window.MonitoramentoAlertas.ciclo()).catch(() => {});
      }
    }).catch(() => {});
  }

  // Ao voltar de suspensão, bfcache ou rede, revalida a sessão e sincroniza os alertas.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      hiddenSince = Date.now();
      return;
    }
    sincronizarAoRetomar(false, false);
  });

  window.addEventListener('pageshow', (ev) => {
    if (ev.persisted) sincronizarAoRetomar(true, true);
  });

  window.addEventListener('online', () => {
    if (!EMBEDAVEL.has(TELA) || !session || Date.now() - lastOnlineRecoveryAt < 5000) return;
    lastOnlineRecoveryAt = Date.now();
    sincronizarAoRetomar(true, true);
  });

  /* --------------------------- instalação --------------------------- */
  let deferred = null;
  const btnInstall = $('btn-install');
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferred = ev;
    show(btnInstall);
  });
  btnInstall.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    hide(btnInstall);
  });
  window.addEventListener('appinstalled', () => hide(btnInstall));

  if ('serviceWorker' in navigator) {
    let jaControlado = !!navigator.serviceWorker.controller;
    let recarregamentoPendente = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!jaControlado) {
        jaControlado = true;
        return;
      }
      if (recarregamentoPendente) return;
      recarregamentoPendente = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('/sw.js').then((registro) => {
      serviceWorkerRegistration = registro;
      if (typeof registro.update === 'function') registro.update().catch(() => {});
    }).catch(() => {});
  }

  /* ------------------------------ boot ------------------------------ */
  if (EMBEDAVEL.has(TELA)) openEmbeddedMap(false);
  else openInPortal(TELA);
})();
