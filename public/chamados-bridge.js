/* Ponte de integração bidirecional: Monitoramento BP (COA & FLOW) <-> Sistema de Chamados Branco Peres */
(function () {
  'use strict';

  var KEY_DRAFT = 'chamados-flow.draft.novo';
  var KEY_ALERTA_ATIVO = 'bperes.chamados.alertaAtivo.v1';
  var CANAL_SYNC = 'bperes-chamados-sync';

  var params = new URLSearchParams(window.location.search);
  var emIframe = false;
  try {
    emIframe = window.self !== window.top;
  } catch (e) {
    emIframe = true;
  }

  var modoTeste = params.get('modoTeste') === '1';
  if (!modoTeste && emIframe) {
    try {
      modoTeste = Boolean(window.parent && window.parent.__CHAMADOS_TEST_MODE__ === true);
    } catch (e) { /* cross-origin seguro */ }
  }

  // Isolamento 100% fixture durante testes automatizados (nunca afeta produção)
  if (modoTeste && typeof window.fetch === 'function') {
    var fetchOriginal = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\.supabase\.co\b/i.test(url)) {
        var metodo = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (metodo === 'HEAD') {
          return Promise.resolve(new Response('', {
            status: 200,
            headers: { 'content-range': '0-0/1', 'content-type': 'application/json' }
          }));
        }
        if (metodo === 'POST' || metodo === 'PATCH' || metodo === 'PUT') {
          var enviado = {};
          try {
            var bruto = JSON.parse(String((init && init.body) || '{}'));
            enviado = Array.isArray(bruto) ? (bruto[0] || {}) : (bruto || {});
          } catch (e) { /* ignora */ }
          var gravado = Object.assign({ id: 900001, criado_em: new Date().toISOString() }, enviado);
          return Promise.resolve(new Response(JSON.stringify([gravado]), {
            status: 201,
            headers: { 'content-type': 'application/json' }
          }));
        }
        return Promise.resolve(new Response('[]', {
          status: 200,
          headers: { 'content-range': '0-0/0', 'content-type': 'application/json' }
        }));
      }
      return fetchOriginal(input, init);
    };
  }

  // Sincroniza rota inicial (?rota=/novo, /chamados, /kpi, etc.) antes do BrowserRouter iniciar
  var rotaInicial = params.get('rota');
  if (rotaInicial && rotaInicial.charAt(0) === '/' && rotaInicial.charAt(1) !== '/') {
    try {
      window.history.replaceState(null, '', rotaInicial);
    } catch (e) { /* ignora */ }
  }

  function lerAlertaAtivo() {
    try {
      var raw = localStorage.getItem(KEY_ALERTA_ATIVO);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function notificarMonitoramento(payload) {
    try {
      if (emIframe && window.parent && window.parent !== window) {
        window.parent.postMessage(payload, window.location.origin);
      }
    } catch (e) { /* ignora */ }
    try {
      if (typeof BroadcastChannel === 'function') {
        var bc = new BroadcastChannel(CANAL_SYNC);
        bc.postMessage(payload);
        bc.close();
      }
    } catch (e) { /* ignora */ }
  }

  // Detecta quando o operador conclui e salva o chamado no formulário React (/novo)
  try {
    var setItemOriginal = Storage.prototype.setItem;
    var ultimoSessionIdNotificado = '';
    Storage.prototype.setItem = function (chave, valor) {
      setItemOriginal.call(this, chave, valor);
      if (this === window.localStorage && typeof chave === 'string' && chave.indexOf('chamados-flow.session.recent.') === 0) {
        try {
          var lista = JSON.parse(String(valor || '[]'));
          var maisNovo = Array.isArray(lista) && lista.length ? lista[0] : null;
          if (maisNovo && maisNovo._sessionId && maisNovo._sessionId !== ultimoSessionIdNotificado) {
            ultimoSessionIdNotificado = String(maisNovo._sessionId);
            var meta = lerAlertaAtivo();
            try { localStorage.removeItem(KEY_ALERTA_ATIVO); } catch (e2) { /* ignora */ }
            var banner = document.getElementById('bp-alerta-prefill-bar');
            if (banner) banner.remove();
            notificarMonitoramento({
              type: 'bp-chamado-registrado',
              chamado: {
                frota: String(maisNovo.FROTA || ''),
                frente: String(maisNovo.FRENTE || ''),
                codigo: String(maisNovo.CODIGO || ''),
                descricao: String(maisNovo.DESCRICAO || ''),
                observacoes: String(maisNovo.OBSERVACOES || ''),
                operador: String(maisNovo.OPERADOR || ''),
                lider: String(maisNovo.LIDER || ''),
                turno: String(maisNovo.TURNO || '')
              },
              alertaMeta: meta
            });
          }
        } catch (e) { /* ignora */ }
      }
    };
  } catch (e) { /* ignora */ }

  // Recebe comandos diretos do modal integrado no Monitoramento BP
  window.addEventListener('message', function (ev) {
    if (ev.origin !== window.location.origin || !ev.data || typeof ev.data !== 'object') return;
    if (ev.data.type === 'bp-abrir-novo-chamado' && ev.data.draft) {
      try {
        localStorage.setItem(KEY_DRAFT, JSON.stringify(ev.data.draft));
        if (ev.data.alertaMeta) localStorage.setItem(KEY_ALERTA_ATIVO, JSON.stringify(ev.data.alertaMeta));
      } catch (e) { /* ignora */ }
      var sufixoTeste = modoTeste ? '&modoTeste=1' : '';
      window.location.replace('/chamados-app.html?rota=/novo&ts=' + Date.now() + sufixoTeste);
    } else if (ev.data.type === 'bp-navegar-chamados' && typeof ev.data.rota === 'string') {
      var r = ev.data.rota.charAt(0) === '/' ? ev.data.rota : '/novo';
      var sufixo = modoTeste ? '&modoTeste=1' : '';
      window.location.replace('/chamados-app.html?rota=' + encodeURIComponent(r) + '&ts=' + Date.now() + sufixo);
    }
  });

  function montarBarrasIntegracao() {
    if (!document.body) return;

    // Se aberto em aba inteira fora do modal, exibe botão rápido para voltar ao Mapa / Monitoramento BP
    if (!emIframe && !document.getElementById('bp-voltar-monitoramento-bar')) {
      var topBar = document.createElement('div');
      topBar.id = 'bp-voltar-monitoramento-bar';
      topBar.className = 'no-print';
      topBar.style.cssText = 'position:sticky;top:0;z-index:9995;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 14px;background:linear-gradient(90deg,#071f15,#0c3b27);border-bottom:1px solid rgba(16,185,129,0.4);color:#ecfdf5;font:600 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
      topBar.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<a href="/" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:6px;background:rgba(16,185,129,0.2);border:1px solid rgba(52,211,153,0.5);color:#ecfdf5;text-decoration:none;font-weight:700">← Voltar ao Mapa · Monitoramento BP</a>' +
          '<span style="opacity:0.85;font-weight:500">Sistema Integrado COA &amp; FLOW · Branco Peres</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
          '<a href="/chamados-app.html?rota=/novo" style="padding:4px 9px;border-radius:6px;background:rgba(255,255,255,0.1);color:#fff;text-decoration:none;font-size:11px">➕ Novo Chamado</a>' +
          '<a href="/chamados-app.html?rota=/chamados" style="padding:4px 9px;border-radius:6px;background:rgba(255,255,255,0.1);color:#fff;text-decoration:none;font-size:11px">📋 Chamados</a>' +
        '</div>';
      document.body.prepend(topBar);
    }

    var meta = lerAlertaAtivo();
    if (meta && window.location.pathname === '/novo' && !document.getElementById('bp-alerta-prefill-bar')) {
      var bar = document.createElement('div');
      bar.id = 'bp-alerta-prefill-bar';
      bar.className = 'no-print';
      bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 14px;background:linear-gradient(90deg,rgba(16,185,129,0.18),rgba(245,158,11,0.16));border-bottom:1px solid rgba(16,185,129,0.45);color:#f8fafc;font:600 12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background-color:#0b2419;';
      var setorBadge = meta.setor === 'FLOW' ? '🚛 FLOW' : '🚜 COA';
      var tituloTxt = (meta.classe ? meta.classe + ' ' : '') + (meta.numero || '') + (meta.nome ? ' — ' + meta.nome : '');
      var spanInfo = document.createElement('div');
      spanInfo.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;';
      spanInfo.innerHTML = '<span style="padding:2px 8px;border-radius:999px;background:#10b981;color:#042f1e;font-weight:800;font-size:11px">' + setorBadge + ' · Alerta Preenchido</span>';
      var strongEl = document.createElement('span');
      strongEl.textContent = tituloTxt + ' · Confira/complemente os campos abaixo e clique em Registrar Chamado.';
      spanInfo.appendChild(strongEl);

      var btnFechar = document.createElement('button');
      btnFechar.type = 'button';
      btnFechar.textContent = '✕';
      btnFechar.title = 'Ocultar faixa';
      btnFechar.style.cssText = 'background:transparent;border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;';
      btnFechar.onclick = function () {
        try { localStorage.removeItem(KEY_ALERTA_ATIVO); } catch (e) { /* ignora */ }
        bar.remove();
      };
      bar.appendChild(spanInfo);
      bar.appendChild(btnFechar);
      var ref = document.getElementById('bp-voltar-monitoramento-bar');
      if (ref && ref.nextSibling) document.body.insertBefore(bar, ref.nextSibling);
      else document.body.prepend(bar);

      // Posiciona o cursor no final das Observações assim que o formulário React terminar de renderizar
      var tentativas = 0;
      var focarObs = setInterval(function () {
        tentativas += 1;
        var obs = document.querySelector('[data-testid="input-observacoes"]');
        if (obs) {
          clearInterval(focarObs);
          try {
            obs.focus({ preventScroll: true });
            var comp = obs.value.length;
            obs.setSelectionRange(comp, comp);
          } catch (e) { /* ignora */ }
        } else if (tentativas > 25) {
          clearInterval(focarObs);
        }
      }, 160);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', montarBarrasIntegracao);
  } else {
    montarBarrasIntegracao();
  }
})();
