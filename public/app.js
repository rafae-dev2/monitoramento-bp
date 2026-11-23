/* Monitoramento BP — PWA shell
 *
 * Fluxo: pede a sessão à Netlify Function -> recebe as "props" do mapa ->
 * carrega o micro-frontend oficial do mapa num iframe e entrega as props por
 * postMessage, do mesmo jeito que o shell Angular do portal faz.
 */

(() => {
  'use strict';

  const ENDPOINT = '/.netlify/functions/session';
  const REPOST_MS = 1000 * 60 * 60 * 4; // reenvia as props a cada 4h
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
    bar: $('bar'),
    stage: $('stage'),
  };

  let session = null;
  let repostTimer = null;
  let alertasLigados = false;
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

  /* --------------------------- sessão/mapa -------------------------- */
  async function fetchSession(force) {
    const res = await fetch(ENDPOINT + (force ? '?fresh=1' : ''), {
      method: 'GET',
      headers: { accept: 'application/json' },
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

  function sendProps() {
    if (!session) return;
    try {
      el.map.contentWindow.postMessage({ type: 'props', data: session.props }, session.mapUrl);
    } catch (e) {
      console.warn('postMessage falhou', e);
    }
  }

  async function openEmbeddedMap(force) {
    boot('Validando sua sessão no portal…', 'tela: mapa analítico v4 (analytic-map-v4)');
    try {
      session = await obterSessao(force);
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
    const w = session.who || {};
    el.who.textContent = [w.usuario, w.unidade].filter(Boolean).join(' · ') +
      (session.modo === 'local' ? ' · local' : '');

    el.map.onload = () => {
      // o portal também envia mais de uma vez; isso cobre a ordem de boot do Vue
      sendProps();
      setTimeout(sendProps, 700);
      setTimeout(sendProps, 2200);
      setTimeout(sendProps, 4200);
      setTimeout(() => hide(el.boot), 2500);
      // o motor de alertas começa junto com o mapa (mesma sessão, mesmo token)
      setTimeout(ligarAlertas, 1200);
      clearInterval(repostTimer);
      repostTimer = setInterval(sendProps, REPOST_MS);
    };

    boot('Carregando o mapa…', 'unidade ' + (w.unidade || '—'));
    el.map.src = session.mapUrl;
  }

  /* ------------------------- central de alertas ------------------------- */
  // A sessão é a mesma do mapa: o motor só troca o token pela URL da API do tenant.
  function ligarAlertas() {
    if (!ALERTAS_ON) return;
    try {
      MonitoramentoAlertas.iniciar({
        props: session.props,
        renovar: () => obterSessao(true),
      });
      alertasLigados = true;
    } catch (e) {
      console.warn('central de alertas não iniciou', e);
    }
  }

  $('btn-alertas').addEventListener('click', () => {
    if (!ALERTAS_ON) return;
    if (!alertasLigados) {
      if (session) ligarAlertas();
      else return;
    }
    MonitoramentoAlertas.abrirPainel();
  });

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
      'Fica salvo apenas neste aparelho e só é enviado para o servidor de login da Solinftec. ' +
      'Para usar em vários aparelhos, o ideal é cadastrar SOLINF_USER e SOLINF_PASS no Netlify.';
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

  el.menu.addEventListener('click', (ev) => {
    const act = ev.target && ev.target.dataset && ev.target.dataset.act;
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
      MonitoramentoAlertas.abrirPainel();
    }
    if (act === 'regras' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      MonitoramentoAlertas.abrirPainel();
      MonitoramentoAlertas.configurar({});
      const cfgBtn = document.getElementById('btn-cfg');
      if (cfgBtn) cfgBtn.click();
    }
    if (act === 'teste' && ALERTAS_ON) {
      if (!alertasLigados && session) ligarAlertas();
      MonitoramentoAlertas.testar();
    }
  });

  el.about.addEventListener('click', (ev) => {
    if (ev.target && ev.target.dataset && ev.target.dataset.act === 'close-about') hide(el.about);
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
    }
  });

  // ao voltar para a aba, revalida a sessão e reenvia as props (token pode ter expirado)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !EMBEDAVEL.has(TELA)) return;
    fetchSession(false)
      .then((d) => {
        session = d;
        sendProps();
        if (ALERTAS_ON && alertasLigados) MonitoramentoAlertas.atualizarSessao(d);
      })
      .catch(() => {});
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
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  /* ------------------------------ boot ------------------------------ */
  if (EMBEDAVEL.has(TELA)) openEmbeddedMap(false);
  else openInPortal(TELA);
})();
