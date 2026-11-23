#!/usr/bin/env python3
"""Regressão isolada: fixtures de teste, nenhuma chamada SGPA/Supabase/Netlify.
Executar: python3 tools/test-alerts-integrated.py
"""
from pathlib import Path
from datetime import datetime, timezone
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = '<!doctype html><html lang="pt-br"><head></head><body><main id="stage"><iframe id="map"></iframe></main><button id="btn-alertas"></button><span id="alert-badge"></span></body></html>'
source = (ROOT / 'public/alerts.js').read_text()
hooks = """
  window.__test = {
    aplicarTelemetria, avaliarFrota, processarQuadros, espelharAlarmes, regraAguardandoCaminhao, enviarAudit, ciclo, abrirNoMapa,
    setCtx: (v) => { ctx = Object.assign(ctx, v); },
    reset: () => {
      frota.clear(); estados.clear(); ativos.clear(); hist = []; filaAudit.length = 0;
      cfg = policy.normalizeCfg(JSON.parse(JSON.stringify(PADRAO)));
      cfg.popup = false; cfg.som = false; cfg.voz = false; cfg.vibrar = false; cfg.usarStream = false;
      rajada = {ts: 0, voz: 0};
      ctx.audit = false;
      if (el.toasts) el.toasts.innerHTML = '';
    },
    filaAudit: () => filaAudit.length,
    estados: () => [...estados.values()],
  };
"""
source = source.replace('  window.MonitoramentoAlertas = {', hooks + '\n  window.MonitoramentoAlertas = {')
requests = []
speed_requests = []
missing_requests = []
errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 412, 'height': 915}, locale='pt-BR', service_workers='block')
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    def route(r):
        requests.append((r.request.method, r.request.url))
        url = r.request.url
        if r.request.method != 'GET':
            r.abort()
        elif url.endswith('/sgpa-alert-catalog.json'):
            r.fulfill(status=200, content_type='application/json', body=(ROOT/'public/sgpa-alert-catalog.json').read_text())
        elif url == 'https://fixture.invalid/':
            r.fulfill(status=200, content_type='text/html', body=HTML)
        elif '/estatistica/monitoramento' in url:
            if 'speed.fixture.invalid' in url:
                speed_requests.append(url)
                row = {
                    'cdEquipamento': 'SPEED-01', 'descEquipamento': '0093 - Trator fixture',
                    'descTpEquipamento': 'TRATOR', 'descGrupoEquipamento': 'Frente speed fixture',
                    'descOperacao': 'Operação fixture', 'vlVelocidade': 93, 'vlParametro4': 0,
                    'vlEd1': '0', 'vlTempoSemComunicacao': '0 DIA(S) 00:00:00',
                    'fgMonitoramentoAtivo': 'T', 'dtHrLocal': datetime.now(timezone.utc).isoformat(),
                }
                r.fulfill(status=200, content_type='application/json', body=json.dumps([row]))
            elif 'missing.fixture.invalid' in url:
                missing_requests.append(url)
                r.fulfill(status=503, content_type='application/json', body='{}')
            else:
                r.fulfill(status=503, content_type='application/json', body='{}')
        elif '/alarmeOnline?' in url:
            r.fulfill(status=200, content_type='application/json', body=json.dumps([{'cdEquipamento':'TESTE-API','cdTpAlarme':5,'descTpAlarme':'VELOCIDADE','vlAlarme':85,'fgOnline':True}]))
        elif '/alarmeTempoEquipamento' in url:
            r.fulfill(status=200, content_type='application/json', body='[]')
        else:
            r.fulfill(status=200, content_type='image/png', body=b'')
    context.route('**/*', route)
    page.goto('https://fixture.invalid/')
    page.evaluate("localStorage.setItem('bperes.alertas.hist.v2', JSON.stringify([{ts: 1, regra:'velocidade', equipamento:'TESTE', texto:'histórico fixture'}]))")
    page.add_style_tag(path=str(ROOT/'public/styles.css'))
    page.add_style_tag(path=str(ROOT/'public/alerts.css'))
    page.add_script_tag(path=str(ROOT/'public/alerts-policy.js'))
    page.add_script_tag(content=source)
    assert page.evaluate('Array.isArray(MonitoramentoAlertas.historico()) && MonitoramentoAlertas.historico().length === 1'), 'Histórico salvo deve continuar array'
    page.evaluate("MonitoramentoAlertas.abrirPainel(); __test.reset(); __test.setCtx({api:'https://fixture.invalid', buId:1, proxy:false, audit:false});")
    result = page.evaluate("""() => {
      const checks = [];
      const ok = (v, name) => { if (!v) throw new Error(name); checks.push(name); };
      const api = MonitoramentoAlertas, t = __test;
      const row = {cdEquipamento:'TESTE-01', descEquipamento:'0083 - Trator fixture', descTpEquipamento:'TRATOR', descGrupoEquipamento:'Frente fixture', descOperacao:'Operação fixture', vlVelocidade:85, vlParametro4:0, vlEd1:'0', vlTempoSemComunicacao:'0 DIA(S) 00:00:00', fgMonitoramentoAtivo:'T'};
      const feed = (r) => { t.aplicarTelemetria([r]); t.avaliarFrota(Date.now(),'lotes'); };
      feed(row);
      ok(!api.ativos().some(a => a.regra==='velocidade'), 'telemetria a 85 não produz velocidade local');
      const a = {cdEquipamento:row.cdEquipamento, cdId:'EPISODIO-1', cdTpAlarme:5, descTpAlarme:'VELOCIDADE', vlAlarme:85, fgOnline:true};
      t.espelharAlarmes([a]);
      ok(api.ativos().length===1 && api.ativos()[0].fonte==='portal', 'alarme oficial gera alerta');
      ok(api.ativos()[0].fala==='Veículo zero zero oito três excedeu a velocidade a 85 quilômetros por hora. Verificar.', 'fala oficial preserva zeros e valor normal');
      const n = api.historico().length;
      t.processarQuadros([{type:'alarme',cdEquipamento:row.cdEquipamento,cdTpAlarme:5,descAlarme:'VELOCIDADE',fgOnline:true}]);
      ok(api.historico().length===n && api.ativos()[0].valor===85, 'stream e REST não duplicam nem apagam medição');
      ok(api.ativos()[0].numero==='0083', 'stream sem descrição preserva número consolidado');
      t.espelharAlarmes([a,{...a,cdTpAlarme:2203,descTpAlarme:'VELOCIDADE EXCEDIDA',cdId:'EPISODIO-2'}]);
      ok(api.ativos().length===2, 'tipos distintos do mesmo equipamento não se suprimem');
      api.configurar({tiposNotificacao:{12480:false}});
      t.espelharAlarmes([{...a,cdTpAlarme:12480,descTpAlarme:'Desvio de Rota',cdId:'EPISODIO-3'}]);
      const generic = api.ativos().find(a => a.tipoAlarme==='12480');
      ok(!!generic && generic.notificar===false && api.historico()[0].notificacaoSelecionada===false, 'tipo silenciado permanece central e histórico');
      api.configurar({notificarCategorias:{rpm:false}});
      t.espelharAlarmes([{...a,cdTpAlarme:4,descTpAlarme:'RPM MAXIMA MOTOR',cdId:'EPISODIO-4',vlAlarme:2100}]);
      ok(api.ativos().find(a=>a.tipoAlarme==='4').notificar===false, 'categoria silencia caminho oficial');
      const old = api.historico().length;
      api.configurar({espelharServidor:false});
      t.processarQuadros([{type:'alarme',cdEquipamento:'TESTE-NOVO',cdTpAlarme:5,fgOnline:true}]);
      ok(api.historico().length===old, 'espelho desligado bloqueia stream oficial');
      api.configurar({ativo:false,espelharServidor:true});
      t.espelharAlarmes([{...a,cdEquipamento:'TESTE-NOVO'}]);
      t.processarQuadros([{type:'alarme',cdEquipamento:'TESTE-NOVO',cdTpAlarme:5,fgOnline:true}]);
      ok(api.historico().length===old, 'central desligada bloqueia REST e stream');
      t.reset(); api.configurar({calcularLocal:false});
      feed({...row,descOperacao:'999 - Aguardando Caminhão - HD'});
      const wait = api.ativos()[0];
      ok(wait && wait.regra==='aguardandoCaminhao' && wait.texto.includes('Frente fixture'), 'espera gera alerta com frente mesmo com cálculo local desligado');
      const wn = api.historico().length;
      feed({...row,descOperacao:'Aguardando Caminhão'});
      ok(api.historico().length===wn, 'espera persistente respeita cooldown');
      feed({...row,descOperacao:'Aguardando Carregamento'});
      feed({...row,descOperacao:'Aguardando Carregamento'});
      ok(api.ativos().length===0, 'duas leituras negativas encerram espera sem equivaler carregamento');
      feed({...row,descOperacao:'Aguardando Caminhão'});
      ok(api.historico().length===wn+1, 'novo episódio de espera notifica novamente');
      t.reset(); api.configurar({amostras:2});
      feed({...row,descOperacao:'Aguardando Caminhão'});
      ok(api.ativos().length===0,'espera respeita duas amostras positivas');
      feed({...row,descOperacao:'Aguardando Caminhão'});
      ok(api.ativos().length===1,'segunda amostra confirma espera');
      t.reset(); api.configurar({amostras:5}); t.espelharAlarmes([a]);
      ok(api.ativos().length===1,'alarme oficial já confirmado não aguarda amostras locais');
      t.processarQuadros([{type:'alarme',cdEquipamento:row.cdEquipamento,cdTpAlarme:5,fgOnline:'F'}]);
      ok(api.ativos().length===0,'fechamento oficial via stream remove ativo');
      const beforeReplay = api.historico().length;
      t.espelharAlarmes([a]);
      ok(api.historico().length===beforeReplay && api.ativos().length===1,'replay da ocorrência encerrada restaura central sem novo histórico ou aviso');
      t.espelharAlarmes([{...a,cdId:'EPISODIO-NOVO'}]);
      ok(api.historico().length===beforeReplay+1,'ocorrência oficial distinta emite novo alerta');
      t.reset(); const count = api.frota().length; api.testar();
      ok(api.frota().length===count && t.filaAudit()===0, 'exemplo não modifica frota nem grava produção');
      t.reset(); api.configurar({calcularLocal:true,limiteRpm:2000}); feed({...row,vlParametro4:2100});
      ok(api.ativos().some(a=>a.regra==='rpm'), 'RPM local complementar preservada');
      return checks;
    }""")
    for name in result:
        print('OK:',name)
    local_measure = page.evaluate("""() => {
      __test.reset();
      __test.aplicarTelemetria([{
        cdEquipamento:'TESTE-LOCAL', descEquipamento:'0077 - Trator fixture',
        descTpEquipamento:'TRATOR', descGrupoEquipamento:'Frente local fixture',
        descOperacao:'Operação fixture', vlVelocidade:77, vlParametro4:0,
        vlEd1:'0', vlTempoSemComunicacao:'0 DIA(S) 00:00:00',
        fgMonitoramentoAtivo:'T', dtHrLocal:new Date().toISOString()
      }]);
      __test.espelharAlarmes([{
        cdEquipamento:'TESTE-LOCAL', cdId:'SPEED-LOCAL', cdTpAlarme:5,
        descTpAlarme:'VELOCIDADE', fgOnline:true
      }]);
      const a = MonitoramentoAlertas.ativos()[0];
      return {valor:a && a.valor, fonte:a && a.fonteVelocidade, fala:a && a.fala};
    }""")
    assert local_measure == {
        'valor': 77, 'fonte': 'telemetria SGPA',
        'fala': 'Veículo zero zero sete sete excedeu a velocidade a 77 quilômetros por hora. Verificar.'
    }, local_measure
    print('OK: alarme oficial sem valor usa apenas a telemetria SGPA recente')

    page.evaluate("""() => {
      const frame = document.getElementById('map');
      window.__mapReceived = null;
      window.__mapArgs = null;
      window.__windowOpenCount = 0;
      window.open = () => { window.__windowOpenCount += 1; return null; };
      frame.onload = () => frame.contentWindow.addEventListener('message', ev => { window.__mapReceived = ev.data; });
      frame.srcdoc = '<!doctype html><html><body>mapa fixture</body></html>';
    }""")
    page.wait_for_function("document.getElementById('map').contentDocument && document.getElementById('map').contentDocument.readyState === 'complete'")
    page.evaluate("""() => {
      const frame = document.getElementById('map');
      const post = frame.contentWindow.postMessage.bind(frame.contentWindow);
      frame.contentWindow.postMessage = (data, targetOrigin) => {
        window.__mapArgs = {data, targetOrigin};
        return post(data, targetOrigin);
      };
      __test.setCtx({
        mapUrl:'https://fixture.invalid/portal/analytic-map-v4?tab=equipment',
        props:{rastroBI:{equipment:'anterior',scope:'preservar'}}
      });
      __test.abrirNoMapa(MonitoramentoAlertas.ativos()[0]);
    }""")
    page.wait_for_function("window.__mapReceived && window.__mapReceived.type === 'props' && window.__mapReceived.data.rastroBI.equipment === 'TESTE-LOCAL'")
    assert page.evaluate("window.__mapArgs.targetOrigin === 'https://fixture.invalid' && window.__mapArgs.data.data.rastroBI.scope === 'preservar' && window.__windowOpenCount === 0 && document.getElementById('alertas').classList.contains('hide')"), 'Ver no mapa deve enviar props para a origem incorporada, fechar o painel e não abrir links externos'
    page.evaluate("__test.setCtx({mapUrl:'',props:null}); __test.abrirNoMapa(MonitoramentoAlertas.ativos()[0]);")
    assert page.evaluate('window.__windowOpenCount === 0'), 'Mapa indisponível deve continuar sem window.open'
    print('OK: “Ver no mapa” envia o equipamento ao iframe e nunca abre URL externa')

    page.evaluate("""() => {
      __test.reset();
      __test.setCtx({api:'https://speed.fixture.invalid',buId:1,proxy:false,audit:false});
      __test.espelharAlarmes([{
        cdEquipamento:'SPEED-01', cdId:'SPEED-FETCH', cdTpAlarme:5,
        descTpAlarme:'VELOCIDADE', fgOnline:true
      }]);
    }""")
    page.wait_for_function("MonitoramentoAlertas.ativos().some(a => a.e.id === 'SPEED-01' && a.valor === 93)", timeout=10000)
    fetched = page.evaluate("""() => {
      const a = MonitoramentoAlertas.ativos().find(x => x.e.id === 'SPEED-01');
      return {valor:a.valor, fonte:a.fonteVelocidade, fala:a.fala, detalhe:a.detalhe};
    }""")
    assert fetched['valor'] == 93 and fetched['fonte'] == 'telemetria SGPA', fetched
    assert 'a 93 quilômetros por hora' in fetched['fala'] and 'telemetria SGPA' in fetched['detalhe'], fetched
    assert len(speed_requests) == 1, f'Fallback deve compartilhar uma única consulta de telemetria: {speed_requests}'
    print('OK: valor ausente no evento oficial dispara uma única consulta agrupada à telemetria SGPA')

    page.evaluate("""() => {
      __test.reset();
      __test.setCtx({api:'https://missing.fixture.invalid',buId:1,proxy:false,audit:false});
      __test.espelharAlarmes([{
        cdEquipamento:'SPEED-MISSING', cdId:'SPEED-NO-MEASURE', cdTpAlarme:5,
        descTpAlarme:'VELOCIDADE', fgOnline:true
      }]);
    }""")
    page.wait_for_function("MonitoramentoAlertas.ativos().some(a => a.e.id === 'SPEED-MISSING' && a.valor === null)", timeout=10000)
    missing = page.evaluate("""() => {
      const a = MonitoramentoAlertas.ativos().find(x => x.e.id === 'SPEED-MISSING');
      return {valor:a.valor, texto:a.texto, fala:a.fala};
    }""")
    assert missing['valor'] is None and 'medição não informada' in missing['texto'], missing
    assert 'quilômetros por hora' not in missing['fala'] and 'alarme oficial de velocidade excedida' in missing['fala'], missing
    assert len(missing_requests) == 1, f'Esperava somente uma tentativa complementar: {missing_requests}'
    print('OK: sem medição válida, mantém o alarme oficial sem inventar valor')

    page.evaluate("__test.reset(); __test.setCtx({api:'https://fixture.invalid',buId:1,proxy:false,audit:false});")
    page.evaluate('() => __test.ciclo()')
    assert page.evaluate("MonitoramentoAlertas.ativos().some(a=>a.e.id==='TESTE-API')"), 'Falha da telemetria não deve bloquear espelho oficial'
    print('OK: espelho oficial independe da falha da telemetria')
    page.evaluate('MonitoramentoAlertas.abrirPainel()')
    page.click('#btn-cfg')
    page.wait_for_function("document.querySelectorAll('#cfg-categorias input[role=switch]').length === 7")
    page.wait_for_function("document.querySelector('#cfg-catalogo-status').textContent.includes('2972')")
    page.locator('.catalogo-detalhes').first.locator('summary').click()
    page.fill('#cfg-busca-tipo','12480')
    assert page.locator('#cfg-tipos input[role=switch]').count()==1
    page.locator('#cfg-tipos input[role=switch]').uncheck()
    assert page.evaluate("MonitoramentoAlertas.config().tiposNotificacao['12480'] === false")
    assert page.evaluate("JSON.parse(localStorage.getItem('bperes.alertas.cfg.v2')).tiposNotificacao['12480'] === false")
    page.locator('#cfg-categorias input[aria-label="Notificar: Aguardando caminhão"]').uncheck()
    assert page.evaluate('MonitoramentoAlertas.config().notificarCategorias.aguardandoCaminhao === false')
    assert page.locator('#cfg-vel').count()==0
    assert page.locator('#cfg-velcan').count()==0
    assert page.evaluate('document.querySelector(".card.cfg").scrollWidth <= document.querySelector(".card.cfg").clientWidth + 1')
    print('OK: chaves por categoria/tipo, busca, persistência e layout sem overflow móvel')
    assert not errors, errors
    assert not any(m=='POST' for m,u in requests), 'Teste tentou POST'
    assert not any('sgpa-solinftec' in u or 'supabase' in u or 'netlify' in u for m,u in requests), 'Teste tentou rede produção'
    print('OK: zero erros JavaScript, nenhuma rede ou escrita de produção')
    browser.close()
    print(f'Testes integrados passaram: {len(result)+8} grupos de verificações.')
