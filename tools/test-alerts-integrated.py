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
  let falasCapturadas = [];
  const falarReal = falar;
  const chamarReal = chamar;
  const avaliarFrotaReal = avaliarFrota;
  window.__test = {
    aplicarTelemetria, atualizarFrentesInferidas, avaliarFrota, tique, processarQuadros, espelharAlarmes, regraAguardandoCaminhao, regraParada, regraFrenteDividida, regrasFrente, registrarNoServidor, enviarAudit, ciclo, chamar, abrirNoMapa, timestampEquipamento,
    frota: () => [...frota.values()],
    setCtx: (v) => { ctx = Object.assign(ctx, v); },
    setChamar: (fn) => { chamar = fn; },
    setPrazoRequisicao: (ms) => { prazoRequisicaoMs = ms; },
    setPausaAudit: (ms) => { auditPausaAte = ms; },
    fontes: () => JSON.parse(JSON.stringify(estado.fontes)),
    status: () => ({ erros: estado.erros, proximoErro: estado.proximoErro }),
    setEvaluationLogger: (sink) => { avaliarFrota = sink ? ((ts, mode) => { sink(ts, mode); return avaliarFrotaReal(ts, mode); }) : avaliarFrotaReal; },
    capturarFalas: () => { falasCapturadas = []; falar = (texto) => falasCapturadas.push(String(texto)); },
    restaurarFalas: () => { falar = falarReal; },
    falasCapturadas: () => falasCapturadas.slice(),
    reset: () => {
      chamar = chamarReal; avaliarFrota = avaliarFrotaReal;
      clearTimeout(timer); timer = null; clearTimeout(auditTimer); auditTimer = null;
      correndo = false; nCiclo = 0; sequenciaObservacao = 0; sequenciaStreamObservacao = 0;
      prazoRequisicaoMs = 15000; auditPausaAte = 0; auditEnviando = false;
      auditStorageError = ''; auditRemoteError = '';
      frota.clear(); estados.clear(); ativos.clear(); hist = []; filaAudit.length = 0;
      gestaoUltimoDisparo.clear();
      paradaAtual.clear();
      cfg = policy.normalizeCfg(JSON.parse(JSON.stringify(PADRAO)));
      cfg.popup = false; cfg.som = false; cfg.voz = false; cfg.vibrar = false; cfg.usarStream = false; cfg.notificacao = false;
      rajada = {ts: 0, voz: 0};
      estado.erros = 0; estado.proximoErro = ''; estado.backoff = 0; estado.monitorados = 0;
      estado.fontes = { telemetria: {status:'aguardando',ultimaSucesso:0,erro:''}, alarmes: {status:'aguardando',ultimaSucesso:0,erro:''} };
      ctx.audit = false;
      localStorage.removeItem(KEY_AUDIT_QUEUE);
      buscaCentral = '';
      if (el.busca) el.busca.value = '';
      if (el.buscaLimpar) el.buscaLimpar.classList.add('hide');
      if (el.toasts) { el.toasts.innerHTML = ''; el.toasts.scrollTop = 0; }
    },
    filaAudit: () => filaAudit.length,
    estados: () => [...estados.values()],
    historico: () => hist.slice(),
  };
"""
source = source.replace('  window.MonitoramentoAlertas = {', hooks + '\n  window.MonitoramentoAlertas = {')
requests = []
speed_requests = []
missing_requests = []
errors = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 412, 'height': 915}, locale='pt-BR', timezone_id='America/Los_Angeles', service_workers='block')
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
    page.add_style_tag(content=(ROOT/'public/styles.css').read_text())
    page.add_style_tag(content=(ROOT/'public/alerts.css').read_text())
    page.evaluate("""() => {
      window.__systemNotifications = [];
      class NotificationFixture {
        static permission = 'granted';
        static requestPermission = () => Promise.resolve('granted');
        constructor(title, options) { window.__systemNotifications.push({title, options}); }
      }
      window.Notification = NotificationFixture;
      try {
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: {getRegistration: () => Promise.resolve(null), addEventListener: () => {}}
        });
      } catch (_) {}
      window.__webVoiceList = [];
      window.__webSpoken = [];
      window.__voiceChanged = null;
      const synthesisFixture = {
        getVoices: () => window.__webVoiceList,
        addEventListener: (name, fn) => { if (name === 'voiceschanged') window.__voiceChanged = fn; },
        cancel: () => {},
        speak: (utterance) => {
          window.__webSpoken.push({text: utterance.text, voice: utterance.voice && utterance.voice.name});
          setTimeout(() => utterance.onend && utterance.onend(), 0);
        },
        speaking: false,
        pending: false
      };
      Object.defineProperty(window, 'speechSynthesis', {configurable: true, value: synthesisFixture});
      window.SpeechSynthesisUtterance = function(text) { this.text = text; };
      window.__nativeVoices = [];
      window.__nativeSpoken = [];
      window.__nativePending = [];
      window.__voiceManageCount = 0;
      window.__androidReady = false;
      window.AndroidTTS = {
        temVoz: () => window.__androidReady,
        falar: () => {},
        falarComVoz: (text, volume, rate, name) => {
          const item = {text, name};
          if (window.__androidReady) window.__nativeSpoken.push(item);
          else window.__nativePending.push(item);
        },
        gerenciarVozes: () => { window.__voiceManageCount += 1; },
        vozes: () => JSON.stringify(window.__nativeVoices),
        parar: () => {},
        vibrar: () => {}
      };
      window.__dispatchVoicesChanged = () => window.__voiceChanged && window.__voiceChanged();
      window.__flushAndroidVoice = () => {
        window.__androidReady = true;
        window.__nativeSpoken.push(...window.__nativePending.splice(0));
      };
    }""")
    page.evaluate("localStorage.setItem('bperes.alertas.hist.v2', JSON.stringify([{ts: 1, regra:'velocidade', equipamento:'TESTE', texto:'histórico fixture'}]))")
    page.add_style_tag(path=str(ROOT/'public/styles.css'))
    page.add_style_tag(path=str(ROOT/'public/alerts.css'))
    page.add_script_tag(path=str(ROOT/'public/alerts-policy.js'))
    page.add_script_tag(content=source)
    assert page.evaluate('Array.isArray(MonitoramentoAlertas.historico()) && MonitoramentoAlertas.historico().length === 1'), 'Histórico salvo deve continuar array'
    page.evaluate("MonitoramentoAlertas.abrirPainel(); __test.reset(); __test.setCtx({api:'https://fixture.invalid', buId:1, proxy:false, audit:false});")
    result = page.evaluate("""async () => {
      const checks = [];
      const ok = (v, name) => { if (!v) throw new Error(name); checks.push(name); };
      const api = MonitoramentoAlertas, t = __test;
      const encodeGeohash = (latitude, longitude, precision=8) => {
        const alphabet='0123456789bcdefghjkmnpqrstuvwxyz';
        const lat=[-90,90], lon=[-180,180];
        let longitudeNext=true, bits=0, value=0, result='';
        while (result.length < precision) {
          const range=longitudeNext ? lon : lat;
          const coordinate=longitudeNext ? longitude : latitude;
          const middle=(range[0]+range[1])/2;
          value=(value<<1) | (coordinate>=middle ? 1 : 0);
          if (coordinate>=middle) range[0]=middle; else range[1]=middle;
          longitudeNext=!longitudeNext;
          if (++bits===5) { result+=alphabet[value]; bits=0; value=0; }
        }
        return result;
      };
      const row = {cdEquipamento:'TESTE-01', descEquipamento:'0083 - Trator fixture', descTpEquipamento:'TRATOR', descFrente:'Frente fixture', descGrupoEquipamento:'Frente fixture', descOperacao:'Operação fixture', vlVelocidade:85, vlParametro4:0, vlEd1:'0', vlTempoSemComunicacao:'0 DIA(S) 00:00:00', fgMonitoramentoAtivo:'T', dtHrLocal:new Date().toISOString()};
      const instanteTenant=Date.now();
      const parteTenant=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instanteTenant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
      const arrayTenant=[parteTenant.year,parteTenant.month,parteTenant.day,parteTenant.hour,parteTenant.minute,parteTenant.second].map(Number);
      const localBrasileiro=`${parteTenant.day}/${parteTenant.month}/${parteTenant.year} ${parteTenant.hour}:${parteTenant.minute}:${parteTenant.second}`;
      const isoSemFuso=`${parteTenant.year}-${parteTenant.month}-${parteTenant.day}T${parteTenant.hour}:${parteTenant.minute}:${parteTenant.second}`;
      ok(Math.abs(t.timestampEquipamento(arrayTenant)-instanteTenant)<120_000,'dtHrLocal em array é interpretado no fuso São Paulo, não no fuso Los Angeles do navegador');
      ok(Math.abs(t.timestampEquipamento(localBrasileiro)-instanteTenant)<120_000,'dtHrLocal dd/mm/aaaa usa o fuso do tenant');
      ok(Math.abs(t.timestampEquipamento(isoSemFuso)-instanteTenant)<120_000,'ISO sem offset usa o fuso do tenant, não o do dispositivo');
      let feedTimestamp = Date.now();
      const feed = (r) => {
        feedTimestamp += 1000;
        t.aplicarTelemetria([{...r,dtHrLocal:new Date(feedTimestamp).toISOString()}]);
        t.avaliarFrota(Date.now(),'lotes');
      };
      const aguardarJanela905 = (id) => t.regraAguardandoCaminhao(t.frota().find(e=>e.id===id),Date.now()+3000);
      feed(row);
      ok(!api.ativos().some(a => a.regra==='velocidade'), 'telemetria a 85 não produz velocidade local');
      const a = {cdEquipamento:row.cdEquipamento, cdId:'EPISODIO-1', cdTpAlarme:5, descTpAlarme:'VELOCIDADE', vlAlarme:85, fgOnline:true};
      t.espelharAlarmes([a]);
      ok(api.ativos().length===1 && api.ativos()[0].fonte==='portal', 'alarme oficial gera alerta');
      ok(api.ativos()[0].fala==='Trator zero zero oito três excedeu a velocidade a 85 quilômetros por hora. Verificar.', 'fala oficial usa a classe Trator e preserva zeros e valor normal');
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
      aguardarJanela905('TESTE-01');
      const wait = api.ativos()[0];
      ok(wait && wait.regra==='aguardandoCaminhao' && wait.texto.includes('Frente fixture'), 'espera gera alerta com frente mesmo com cálculo local desligado');
      const wn = api.historico().length;
      feed({...row,descOperacao:'Aguardando Caminhão'});
      ok(api.historico().length===wn, 'espera persistente respeita cooldown');
      feed({...row,descOperacao:'Aguardando Carregamento'});
      t.tique(); t.tique();
      ok(api.ativos().some(a=>a.regra==='aguardandoCaminhao'), 'tiques temporizados não contam novamente a mesma leitura negativa');
      feed({...row,descOperacao:'Aguardando Carregamento'});
      ok(api.ativos().length===0, 'duas leituras negativas encerram espera sem equivaler carregamento');
      feed({...row,descOperacao:'Aguardando Caminhão'});
      aguardarJanela905('TESTE-01');
      ok(api.historico().length===wn+1, 'novo episódio de espera notifica novamente');
      t.reset(); api.configurar({amostras:3});
      feed({...row,descOperacao:'905 - AGUARDANDO CAMINHAO'});
      ok(api.ativos().length===0,'905 aguarda somente a janela curta para reconciliar quadros do stream');
      aguardarJanela905('TESTE-01');
      ok(api.ativos().length===1 && api.ativos()[0].regra==='aguardandoCaminhao','sem caminhão correspondente, 905 dispara após a janela curta, sem esperar a tolerância de parada');
      t.reset(); t.aplicarTelemetria([{...row,cdEquipamento:'COL-905',cdOperacao:905,descOperacao:'Aguardando Caminhão Colheita'}]); t.avaliarFrota(Date.now(),'lotes');
      t.regraAguardandoCaminhao(t.frota().find(e=>e.id==='COL-905'),Date.now()+3000);
      ok(api.ativos().some(x=>x.e.id==='COL-905' && x.regra==='aguardandoCaminhao'),'código 905 reconhecido pelo código da operação');

      t.reset(); t.capturarFalas(); window.__systemNotifications.length=0;
      api.configurar({voz:true,notificacao:true,popup:false,cooldownMin:10,amostras:3});
      const frenteDivididaStream={cdEquipamento:'FD-8833',descEquipamento:'8833 - Trator fixture',descTpEquipamento:'TRATOR',descFullTpEquipamento:'Trator agrícola',descFrente:'Frente Norte',cdOperacao:991,descOperacao:'991 - Frente Dividida',fgMonitoramentoAtivo:'T',dtHrLocal:new Date().toISOString()};
      t.processarQuadros([frenteDivididaStream]);
      const fdStream=api.ativos().find(a=>a.e.id==='FD-8833' && a.regra==='frenteDividida');
      ok(!!fdStream && fdStream.fonte==='app' && fdStream.notificar && fdStream.numero==='8833' && fdStream.texto.includes('Frente Norte'),'primeiro quadro de Frente dividida no stream gera alerta local imediato com veículo e frente');
      ok(fdStream.fala.includes('Atenção COA') && fdStream.fala.includes('Frente dividida') && fdStream.fala.includes('sistema FUT') && fdStream.detalhe.includes('não foram alteradas'),'fala orienta validar a chamada no FUT sem atribuir intenção ou alterar operação/fila');
      const estadoFdStream=()=>t.estados().find(s=>s.id==='FD-8833' && s.regra==='frenteDividida');
      ok(estadoFdStream().consec===1,'primeiro quadro do equipamento conta uma única observação positiva');
      await new Promise(resolve=>setTimeout(resolve,5));
      t.processarQuadros([{...frenteDivididaStream,cdEquipamento:'FD-NAO-RELACIONADO',descEquipamento:'9911 - Trator fixture',descOperacao:'Operação fixture'}]);
      ok(estadoFdStream().consec===1,'quadro de outro equipamento não cria nova confirmação para o alvo em cache');
      const historicoFd=api.historico().filter(a=>a.regra==='frenteDividida').length;
      t.processarQuadros([frenteDivididaStream]);
      await new Promise(resolve=>setTimeout(resolve,30));
      ok(estadoFdStream().consec===1 && historicoFd===1 && api.historico().filter(a=>a.regra==='frenteDividida').length===1 && t.falasCapturadas().length===1 && window.__systemNotifications.length===1,'quadros repetidos respeitam identidade de observação, cooldown e não duplicam fala/notificação');

      t.reset(); t.capturarFalas();
      api.configurar({calcularLocal:false,voz:true,notificacao:true,notificarCategorias:{frenteDividida:false}});
      const fdSilenciado={...row,cdEquipamento:'FD-OFF',descEquipamento:'8834 - Transbordo fixture',descTpEquipamento:'TRANSBORDO',descGrupoEquipamento:'Frente Sul',descOperacao:'009 - FRENTE DIVIDIDA'};
      feed(fdSilenciado);
      const fdOff=api.ativos().find(a=>a.e.id==='FD-OFF' && a.regra==='frenteDividida');
      ok(!!fdOff && fdOff.notificar===false && api.historico().length===1 && t.falasCapturadas().length===0,'chave desligada mantém o alerta na central/histórico sem fala/notificação');

      t.reset();
      const caminhaoFrenteDividida={...row,cdEquipamento:'FD-TRUCK',descEquipamento:'4451 - Caminhão fixture',descTpEquipamento:'CAMINHÃO CANAVIEIRO',descOperacao:'Frente dividida'};
      feed(caminhaoFrenteDividida);
      ok(!api.ativos().some(a=>a.regra==='frenteDividida'),'Frente dividida em caminhão não entra na regra de trator/transbordo');

      t.reset();
      const truckSpeech={...row,cdEquipamento:'TRUCK-SPEECH-4426',descEquipamento:'4426 - Caminhão Canavieiro',descTpEquipamento:'CAMINHÕES CANAVIEIRO TERC',descFrente:'Frente 1',descGrupoEquipamento:'Caminhões Canavieiro Terc',cdOperacao:908,descOperacao:'908 - Aguardando Carregamento'};
      t.aplicarTelemetria([truckSpeech]);
      const truckSpeechRow=t.frota().find(e=>e.id==='TRUCK-SPEECH-4426');
      ok(truckSpeechRow.frente==='Frente 1' && truckSpeechRow.grupoEquipamento==='Caminhões Canavieiro Terc','descFrente real fica separado do grupo cadastral do caminhão');
      const inicioParadaCaminhao=Date.now();
      t.regraParada(truckSpeechRow,inicioParadaCaminhao);
      t.regraParada(truckSpeechRow,inicioParadaCaminhao+31*60_000);
      const falaCaminhaoCarregamento=api.ativos().find(a=>a.regra==='paradaImprodutiva' && a.e.id==='TRUCK-SPEECH-4426');
      ok(!!falaCaminhaoCarregamento && falaCaminhaoCarregamento.fala==='Caminhão quatro quatro dois seis aguardando carregamento há 31 minutos, se encontra na Frente 1. Verificar.','fala do caminhão 4426 pronuncia a frente de colheita real e não o grupo');
      t.reset();
      const truckSpeechFazenda={...truckSpeech,cdEquipamento:'TRUCK-SPEECH-FUNDO-25',descFrente:'Fazenda Fundo 25'};
      t.aplicarTelemetria([truckSpeechFazenda]);
      const truckSpeechFazendaRow=t.frota().find(e=>e.id==='TRUCK-SPEECH-FUNDO-25');
      const inicioParadaFazenda=Date.now();
      t.regraParada(truckSpeechFazendaRow,inicioParadaFazenda);
      t.regraParada(truckSpeechFazendaRow,inicioParadaFazenda+31*60_000);
      const falaFazenda=api.ativos().find(a=>a.regra==='paradaImprodutiva' && a.e.id==='TRUCK-SPEECH-FUNDO-25');
      ok(!!falaFazenda && falaFazenda.fala.includes('na Fazenda Fundo 25') && !falaFazenda.fala.toLowerCase().includes('dentro da usina'),'fala do caminhão informa Fazenda Fundo 25 em vez de dizer dentro da usina');

      t.reset();
      const geoNow=new Date().toISOString(), geoLat=-21.2, geoLon=-48.0;
      const frenteGeo=(id,tipo,frente,lat=geoLat,lon=geoLon,dtHrLocal=geoNow)=>({
        ...row,cdEquipamento:id,descEquipamento:id+' - '+tipo,descTpEquipamento:tipo,descFullTpEquipamento:tipo,
        descFrente:'',descGrupoEquipamento:frente,descOperacao:'Operação fixture',geohash:encodeGeohash(lat,lon),dtHrLocal,
        vlTempoSemComunicacao:'0 DIA(S) 00:00:00',fgMonitoramentoAtivo:'T'
      });
      const caminhao4468={...truckSpeech,cdEquipamento:'4468',descEquipamento:'4468 - Caminhão canavieiro terceiro',descTpEquipamento:'CAMINHAO CANAVIEIRO',descFullTpEquipamento:'Caminhão canavieiro',descFrente:'',descGrupoEquipamento:'Caminhões Canavieiro Terc',cdOperacao:908,descOperacao:'908 - Aguardando Carregamento',geohash:encodeGeohash(geoLat,geoLon),dtHrLocal:geoNow,vlTempoSemComunicacao:'0 DIA(S) 00:00:00'};
      const refsFrente3=[frenteGeo('REF-3-COL','COLHEDORA','Frente 3',geoLat+0.0001,geoLon),frenteGeo('REF-3-TRANS','TRANSBORDO','Frente 3',geoLat,geoLon+0.0001),frenteGeo('REF-3-TRATOR','TRATOR','Frente 3',geoLat-0.0001,geoLon)];
      const refFrente2=frenteGeo('REF-2-TRATOR','TRATOR','Frente 2',geoLat,geoLon-0.0001);
      const caminhaoFundoGeo={...caminhao4468,cdEquipamento:'4468-FUNDO-25',descFrente:'Fazenda Fundo 25'};
      t.aplicarTelemetria([caminhao4468,caminhaoFundoGeo,...refsFrente3,refFrente2]);
      const consolidado4468=t.frota().find(e=>e.id==='4468');
      const consolidadoFundoGeo=t.frota().find(e=>e.id==='4468-FUNDO-25');
      ok(consolidado4468.tipo==='CAMINHAO CANAVIEIRO' && consolidado4468.grupoEquipamento==='Caminhões Canavieiro Terc' && consolidado4468.frente==='' && consolidado4468.frenteInferida==='Frente 3' && consolidado4468.frenteInferidaReferencias===3,'4468 usa tipo/grupo cadastral reais e consenso 3:1 para inferir Frente 3 sem sobrescrever a frente direta ou o grupo');
      ok(consolidadoFundoGeo.frente==='Fazenda Fundo 25' && !consolidadoFundoGeo.frenteInferida,'Fazenda Fundo 25 como frente direta nunca é substituída pela inferência espacial');

      t.reset();
      const streamCaminhao4468={...caminhao4468,cdEquipamento:'4468-STREAM'};
      t.processarQuadros([streamCaminhao4468,...refsFrente3]);
      ok(t.frota().find(e=>e.id==='4468-STREAM').frenteInferida==='Frente 3','quadros do stream guardam geohash/horário e são consolidados antes de inferir a frente');

      t.reset();
      const truckWithoutLocation={...caminhao4468,cdEquipamento:'4468-SEM-POS',geohash:''};
      t.aplicarTelemetria([truckWithoutLocation]);
      ok(!t.frota().find(e=>e.id==='4468-SEM-POS').frenteInferida,'sem geohash/posição atual a localização permanece não informada');

      t.reset();
      const truckLowPrecision={...caminhao4468,cdEquipamento:'4468-GEO-5',geohash:'ezs42'};
      t.aplicarTelemetria([truckLowPrecision,...refsFrente3]);
      ok(!t.frota().find(e=>e.id==='4468-GEO-5').frenteInferida,'geohash com menos de sete caracteres não participa da inferência');

      t.reset();
      const posicaoAntiga=new Date(Date.now()-6*60_000).toISOString();
      const truckOldPosition={...caminhao4468,cdEquipamento:'4468-POS-ANTIGA',dtHrLocal:posicaoAntiga};
      t.aplicarTelemetria([truckOldPosition,...refsFrente3]);
      ok(!t.frota().find(e=>e.id==='4468-POS-ANTIGA').frenteInferida,'posição do caminhão com mais de cinco minutos não pode inferir uma frente');

      t.reset();
      const refsAntigas=refsFrente3.map(e=>({...e,dtHrLocal:posicaoAntiga}));
      t.aplicarTelemetria([{...caminhao4468,cdEquipamento:'4468-REF-ANTIGA'},...refsAntigas]);
      ok(!t.frota().find(e=>e.id==='4468-REF-ANTIGA').frenteInferida,'referências com posição antiga não podem votar na inferência');

      t.reset();
      const refsConflitantes=[...refsFrente3.slice(0,2),frenteGeo('REF-3-TRATOR-2','TRATOR','Frente 3'),frenteGeo('REF-2-TRATOR-1','TRATOR','Frente 2'),frenteGeo('REF-2-COL','COLHEDORA','Frente 2')];
      t.aplicarTelemetria([{...caminhao4468,cdEquipamento:'4468-AMBIGUA'},...refsConflitantes]);
      ok(!t.frota().find(e=>e.id==='4468-AMBIGUA').frenteInferida,'posições concorrentes sem consenso de 75% mantêm a frente não informada');

      t.reset();
      t.aplicarTelemetria([{...caminhao4468,cdEquipamento:'4468-SO-DOIS'},...refsFrente3.slice(0,2)]);
      ok(!t.frota().find(e=>e.id==='4468-SO-DOIS').frenteInferida,'duas referências não atendem ao mínimo conservador de três equipamentos');

      t.reset();
      const refsExcluidas=['CAMINHÕES CAÇAMBAS','CAMINHÕES MUNCK','CAMINHÕES BOMBEIROS'].map((tipo,i)=>frenteGeo('REF-EXCLUIDA-'+i,tipo,'Frente 3'));
      t.aplicarTelemetria([{...caminhao4468,cdEquipamento:'4468-SEM-REF-VALIDA'},...refsExcluidas]);
      ok(!t.frota().find(e=>e.id==='4468-SEM-REF-VALIDA').frenteInferida,'Caçamba, Munck e Bombeiro não contam como referências de frente');

      t.reset(); t.capturarFalas();
      api.configurar({calcularLocal:false,voz:true,notificacao:false,popup:false,som:false,vibrar:false});
      const truckActive={...caminhao4468,cdEquipamento:'4468-ALERTA-ATIVO',geohash:''};
      t.aplicarTelemetria([truckActive]);
      const truckActiveRow=t.frota().find(e=>e.id==='4468-ALERTA-ATIVO'), inicioAlertaAtivo=Date.now();
      t.regraParada(truckActiveRow,inicioAlertaAtivo);
      t.regraParada(truckActiveRow,inicioAlertaAtivo+31*60_000);
      const alertaSemFrenteAtivo=api.ativos().find(a=>a.e.id==='4468-ALERTA-ATIVO');
      const falaAntesFrenteInferida=alertaSemFrenteAtivo && alertaSemFrenteAtivo.fala;
      const historicoAntesFrenteInferida=api.historico().length;
      t.aplicarTelemetria([{...truckActive,geohash:encodeGeohash(geoLat,geoLon),dtHrLocal:new Date().toISOString()},...refsFrente3,refFrente2]);
      t.atualizarFrentesInferidas(Date.now());
      const alertaFrenteAtualizada=api.ativos().find(a=>a.e.id==='4468-ALERTA-ATIVO');
      api.abrirPainel();
      ok(!!alertaSemFrenteAtivo && falaAntesFrenteInferida.includes('frente de colheita não informada') && !!alertaFrenteAtualizada && alertaFrenteAtualizada.fala.includes('na Frente 3') && alertaFrenteAtualizada.texto.includes('frente inferida: Frente 3'),'a frente descoberta após o alerta ativo atualiza texto e fala sem alterar descFrente');
      ok(api.historico().length===historicoAntesFrenteInferida && api.historico()[0].frente==='' && api.historico()[0].frenteInferida==='Frente 3','a inferência atualiza a linha existente do histórico sem criar outra nem sobrescrever a frente direta');
      ok(t.falasCapturadas().length===2 && t.falasCapturadas()[1].includes('na Frente 3'),'uma única atualização de localização pode falar a frente sem repetir a notificação a cada recálculo');
      const chipAtivo=[...document.querySelectorAll('#lista-ativos .a-chip')].some(c=>c.textContent==='Frente inferida: Frente 3');
      document.querySelector('.aba[data-aba="historico"]').click();
      const chipHistorico=[...document.querySelectorAll('#lista-historico .a-chip')].some(c=>c.textContent==='Frente inferida: Frente 3');
      document.querySelector('.aba[data-aba="ativos"]').click();
      ok(chipAtivo && chipHistorico,'alerta ativo e histórico identificam explicitamente a localização como Frente inferida');

      t.reset();
      const grupoSemFrente={...truckSpeech,cdEquipamento:'TRUCK-GROUP-FRONT',descGrupoEquipamento:'Frente 3'};
      delete grupoSemFrente.descFrente;
      t.aplicarTelemetria([grupoSemFrente]);
      const caminhaoSemFrente=t.frota().find(e=>e.id==='TRUCK-GROUP-FRONT');
      ok(caminhaoSemFrente.frente==='' && caminhaoSemFrente.grupoEquipamento==='Frente 3','grupo cadastral chamado Frente 3 não substitui o campo descFrente ausente');
      const inicioSemFrente=Date.now();
      t.regraParada(caminhaoSemFrente,inicioSemFrente); t.regraParada(caminhaoSemFrente,inicioSemFrente+31*60_000);
      const falaSemFrente=api.ativos().find(a=>a.regra==='paradaImprodutiva' && a.e.id==='TRUCK-GROUP-FRONT');
      ok(!!falaSemFrente && falaSemFrente.fala.includes('frente de colheita não informada') && !falaSemFrente.fala.includes('Frente 3'),'fala não trata o nome de grupo Frente 3 como frente de colheita');
      t.reset();
      const frenteCana='Frente 2', grupoCaminhoes='Caminhões Canavieiro Terc';
      const caminhaoFila={...row,cdEquipamento:'TRUCK-4451',descEquipamento:'4451 - Caminhão Canavieiro',descTpEquipamento:'CAMINHÕES CANAVIEIRO TERC',descFrente:frenteCana,descGrupoEquipamento:grupoCaminhoes,cdOperacao:908,descOperacao:'908 - Aguardando Carregamento'};
      const trator905={...row,cdEquipamento:'TRACTOR-8833',descEquipamento:'8833 - Trator fixture',descTpEquipamento:'TRATOR',descFrente:frenteCana,descGrupoEquipamento:'Tratores Transbordos',cdOperacao:905,descOperacao:'905 - Aguardando Caminhão'};
      t.aplicarTelemetria([caminhaoFila,trator905]);
      const tratorConsolidado=t.frota().find(e=>e.id==='TRACTOR-8833'), inicioCorrelacao=Date.now();
      const caminhaoConsolidado=t.frota().find(e=>e.id==='TRUCK-4451');
      ok(caminhaoConsolidado.frente==='Frente 2' && caminhaoConsolidado.grupoEquipamento===grupoCaminhoes,'caminhão conserva frente de colheita e grupo em campos distintos');
      t.regraAguardandoCaminhao(tratorConsolidado,inicioCorrelacao);
      ok(!api.ativos().some(a=>a.regra==='aguardandoCaminhao'),'caminhão em Aguardando Carregamento na mesma frente suprime o falso 905');
      ok(!api.ativos().some(a=>a.regra==='aguardandoBasculamento'),'basculamento inferido respeita tolerância de 15 minutos');
      t.regraAguardandoCaminhao(tratorConsolidado,inicioCorrelacao+16*60_000);
      const basculamento=api.ativos().find(a=>a.regra==='aguardandoBasculamento');
      ok(!!basculamento && basculamento.notificar && basculamento.texto.includes('inferido pelo app') && basculamento.detalhe.includes('905') && basculamento.detalhe.includes('nenhum apontamento foi alterado'),'correlação gera alerta de basculamento inferido sem alterar o SGPA');
      ok(basculamento.fala.includes('caminhão quatro quatro cinco um') && basculamento.fala.includes('Frente/grupo Frente 2') && basculamento.fala.includes('permanece Aguardando Caminhão'),'fala cita caminhão, Frente 2 e o apontamento original');
      t.reset();
      api.configurar({gestaoFrenteAtiva:true,filaMaxFrente:3,minutosFrenteSemColhedora:0,transbordosAguardandoMax:0});
      const caminhoesForaColheita=['CAMINHÕES CAÇAMBAS','CAMINHÕES MUNCK','CAMINHÕES BOMBEIROS'].map((tipo,i)=>({
        ...row,cdEquipamento:'NON-CANE-'+i,descEquipamento:(7100+i)+' - '+tipo,descTpEquipamento:tipo,descFullTpEquipamento:tipo,
        descFrente:frenteCana,descGrupoEquipamento:tipo,cdOperacao:i===0?920:908,descOperacao:i===0?'920 - Fila única':'908 - Aguardando Carregamento',
        dtHrLocal:new Date().toISOString(),vlTempoSemComunicacao:'0 DIA(S) 00:00:00'
      }));
      const tratorSemCaminhaoCanavieiro={...trator905,cdEquipamento:'TRACTOR-NON-CANE-905'};
      t.aplicarTelemetria([...caminhoesForaColheita,tratorSemCaminhaoCanavieiro]);
      t.regrasFrente(Date.now());
      ok(!api.ativos().some(a=>a.regra==='gestaoFrente'),'caçamba, Munck e bombeiro não contam na fila de gestão da frente de colheita');
      const tratorSemCanavieiro=t.frota().find(e=>e.id==='TRACTOR-NON-CANE-905');
      t.regraAguardandoCaminhao(tratorSemCanavieiro,Date.now());
      t.regraAguardandoCaminhao(tratorSemCanavieiro,Date.now()+3000);
      ok(api.ativos().some(a=>a.e.id==='TRACTOR-NON-CANE-905' && a.regra==='aguardandoCaminhao') && !api.ativos().some(a=>a.regra==='aguardandoBasculamento'),'caçamba, Munck e bombeiro não suprimem o alerta 905 nem geram basculamento inferido');
      t.reset();
      const streamTrator905={...trator905,cdEquipamento:'STREAM-TRACTOR',descFrente:frenteCana};
      const streamCaminhaoFila={...caminhaoFila,cdEquipamento:'STREAM-TRUCK',descFrente:frenteCana};
      t.processarQuadros([streamTrator905,streamCaminhaoFila]);
      ok(!api.ativos().some(a=>a.regra==='aguardandoCaminhao'),'o lote do stream consolida caminhão e trator antes de decidir o 905');
      t.reset();
      const streamTratorSeparado={...streamTrator905,cdEquipamento:'STREAM-TRACTOR-SEPARADO'};
      const streamCaminhaoSeparado={...streamCaminhaoFila,cdEquipamento:'STREAM-TRUCK-SEPARADO'};
      t.processarQuadros([streamTratorSeparado]);
      ok(!api.ativos().some(a=>a.regra==='aguardandoCaminhao'),'905 não é emitido durante a janela de reconciliação do primeiro lote');
      t.processarQuadros([streamCaminhaoSeparado]);
      ok(!api.ativos().some(a=>a.regra==='aguardandoCaminhao') && !api.ativos().some(a=>a.regra==='aguardandoBasculamento'),'caminhão recebido em lote posterior e na mesma frente suprime o 905 falso');
      t.reset();
      const caminhaoOutraFrente={...caminhaoFila,descFrente:'Frente 3'};
      t.aplicarTelemetria([caminhaoOutraFrente,trator905]);
      const tratorOutraFrente=t.frota().find(e=>e.id==='TRACTOR-8833');
      t.regraAguardandoCaminhao(tratorOutraFrente,Date.now()-10_000);
      t.regraAguardandoCaminhao(tratorOutraFrente,Date.now());
      ok(!api.ativos().some(a=>a.regra==='aguardandoCaminhao'),'a consulta REST lenta não consome a janela antes de observar o 905');
      t.regraAguardandoCaminhao(t.frota().find(e=>e.id==='TRACTOR-8833'),Date.now()+3000);
      ok(api.ativos().some(a=>a.regra==='aguardandoCaminhao'),'sem caminhão correspondente na mesma frente, 905 continua quase imediato');
      t.reset();
      api.configurar({espelharServidor:false,usarStream:false});
      const inicioCicloLento=Date.now(); let avaliacaoCicloLento=0;
      t.setEvaluationLogger((ts,mode)=>{if(mode==='lotes')avaliacaoCicloLento=ts;});
      t.setChamar(async()=>{await new Promise(resolve=>setTimeout(resolve,3200));return [{...trator905,cdEquipamento:'REST-LENTO-905',dtHrLocal:new Date().toISOString()}];});
      await t.ciclo();
      ok(avaliacaoCicloLento>=inicioCicloLento+3000,'ciclo REST avalia a frota no horário da resposta, não no início da requisição');
      ok(!api.ativos().some(a=>a.regra==='aguardandoCaminhao'),'consulta REST lenta não emite 905 antes de completar a janela após sua resposta');
      t.regraAguardandoCaminhao(t.frota().find(e=>e.id==='REST-LENTO-905'),Date.now()+3000);
      ok(api.ativos().some(a=>a.regra==='aguardandoCaminhao'),'sem caminhão correspondente, 905 dispara após a janela contada da observação');
      t.reset();
      const caminhaoAntigo={...caminhaoFila,cdEquipamento:'TRUCK-ANTIGO',dtHrLocal:new Date(Date.now()-6*60_000).toISOString(),vlTempoSemComunicacao:'0 DIA(S) 00:00:00'};
      t.aplicarTelemetria([caminhaoAntigo,trator905]);
      const tratorAtual=t.frota().find(e=>e.id==='TRACTOR-8833');
      t.processarQuadros([{cdEquipamento:'TRUCK-ANTIGO',descFrente:frenteCana,descTpEquipamento:'CAMINHÕES CANAVAREIRO TERC',cdOperacao:908,descOperacao:'908 - Aguardando Carregamento',fgMonitoramentoAtivo:'T'}]);
      t.regraAguardandoCaminhao(tratorAtual,Date.now());
      t.regraAguardandoCaminhao(tratorAtual,Date.now()+3000);
      ok(api.ativos().some(a=>a.regra==='aguardandoCaminhao') && !api.ativos().some(a=>a.regra==='aguardandoBasculamento'),'quadro recente do stream sem dtHrLocal não renova telemetria antiga do caminhão');
      t.reset();
      const caminhaoAtrasado={...caminhaoFila,cdEquipamento:'TRUCK-ATRASADO',dtHrLocal:new Date().toISOString(),vlTempoSemComunicacao:'0 DIA(S) 00:06:00'};
      t.aplicarTelemetria([caminhaoAtrasado,trator905]);
      const tratorComCaminhaoAtrasado=t.frota().find(e=>e.id==='TRACTOR-8833');
      t.regraAguardandoCaminhao(tratorComCaminhaoAtrasado,Date.now());
      t.regraAguardandoCaminhao(tratorComCaminhaoAtrasado,Date.now()+3000);
      ok(api.ativos().some(a=>a.regra==='aguardandoCaminhao') && !api.ativos().some(a=>a.regra==='aguardandoBasculamento'),'vlTempoSemComunicacao antigo impede inferir caminhão disponível mesmo com dtHrLocal recente');
      t.reset();
      api.configurar({calcularLocal:false,gestaoFrenteAtiva:true,filaMaxFrente:4,minutosFrenteSemColhedora:0,transbordosAguardandoMax:0,cooldownMin:10,popup:true});
      const filaGestao=Array.from({length:4},(_,i)=>({...caminhaoFila,cdEquipamento:'FILA-'+i,descEquipamento:(4451+i)+' - Caminhão Canavieiro'}));
      const inicioGestao=Date.now();
      t.aplicarTelemetria(filaGestao); t.regrasFrente(inicioGestao);
      const historicoGestao=()=>api.historico().filter(a=>a.regra==='gestaoFrente').length;
      const toastsGestao=()=>[...document.querySelectorAll('.toast[data-chave]')].filter(c=>c.dataset.chave.includes('|gestao:')).length;
      const alertaGestao=api.ativos().find(a=>a.regra==='gestaoFrente');
      ok(historicoGestao()===1 && !!alertaGestao && alertaGestao.fala.includes('Frente 2') && !alertaGestao.fala.includes('Caminhões Canavieiro Terceiro') && toastsGestao()===1,'Atenção gestão usa a frente de colheita, não o grupo cadastral, e abre um pop-up');
      t.regrasFrente(inicioGestao+15_000);
      ok(historicoGestao()===1,'cooldown de gestão impede repetição em leituras seguidas');
      t.aplicarTelemetria([{...filaGestao[0],descOperacao:'Transporte de cana'}]);
      t.regrasFrente(inicioGestao+16_000); t.regrasFrente(inicioGestao+17_000);
      t.aplicarTelemetria(filaGestao); t.regrasFrente(inicioGestao+18_000);
      ok(historicoGestao()===1,'oscilações na contagem não reiniciam o cooldown estável por frente/regra');
      t.regrasFrente(inicioGestao+11*60_000);
      const historicoAntesDesligar=api.historico().length;
      ok(historicoGestao()===2 && api.ativos().some(a=>a.regra==='gestaoFrente'),'a mesma gestão só volta a emitir depois do cooldown');
      api.configurar({gestaoFrenteAtiva:false});
      t.regrasFrente(inicioGestao+11*60_000+1);
      ok(!api.ativos().some(a=>a.regra==='gestaoFrente') && toastsGestao()===0 && api.historico().length===historicoAntesDesligar,'desligar gestão remove ativos/pop-ups e bloqueia novos alertas sem apagar histórico');
      t.reset(); api.configurar({calcularLocal:false});
      const leve = {...row,descFrente:'',cdEquipamento:'LEVE-6614',descEquipamento:'6614 - VEICULO LEVE - IVECO',descTpEquipamento:'VEICULO LEVE',descGrupoEquipamento:'VEICULO LEVE',descOperacao:'953 - Sem Apontamento',vlVelocidade:0};
      feed(leve);
      ok(!api.ativos().some(x=>x.regra==='semApontamento'),'sem apontamento respeita tolerância de 5 minutos');
      t.avaliarFrota(Date.now()+4*60_000,'tempo');
      ok(!api.ativos().some(x=>x.regra==='semApontamento'),'sem apontamento não alerta antes de 5 minutos');
      t.avaliarFrota(Date.now()+6*60_000,'tempo');
      const sp = api.ativos().find(x=>x.regra==='semApontamento');
      ok(sp && sp.notificar===true && sp.fonte==='app' && /sem apontamento há \\d+ minutos\\. Frente\\/grupo VEICULO LEVE/.test(sp.fala), 'sem apontamento após 5 min gera alerta com fala e notificação local: ' + (sp && sp.fala));
      t.reset(); api.configurar({calcularLocal:false,notificarCategorias:{semApontamento:false}});
      feed(leve); t.avaliarFrota(Date.now()+6*60_000,'tempo');
      const spOff = api.ativos().find(x=>x.regra==='semApontamento');
      ok(spOff && spOff.notificar===false, 'chave desligada mantém sem apontamento só na central');
      api.configurar({notificarCategorias:{semApontamento:true}});
      t.reset(); api.configurar({calcularLocal:false,refeicaoGrupos:{'APOIO':30,'LINHA AMARELA':60},refeicaoEquipamentos:'7001=45'});
      const apoio = {...row,descFrente:'',cdEquipamento:'AP-1',descEquipamento:'5001 - Caminhão apoio',descTpEquipamento:'CAMINHAO',descGrupoEquipamento:'APOIO',descOperacao:'820 - REFEIÇÃO',vlVelocidade:0};
      const amarela = {...apoio,cdEquipamento:'LA-1',descEquipamento:'6001 - Pá carregadeira',descGrupoEquipamento:'LINHA AMARELA',descOperacao:'REFEIÇÃO (1 HORA)'};
      const excecao = {...amarela,cdEquipamento:'LA-2',descEquipamento:'7001 - Escavadeira'};
      const livre = {...apoio,cdEquipamento:'OUT-1',descEquipamento:'8001 - Outro',descGrupoEquipamento:'SEM CONTROLE'};
      t.aplicarTelemetria([apoio,amarela,excecao,livre]); t.avaliarFrota(Date.now(),'lotes');
      t.avaliarFrota(Date.now()+29*60_000,'tempo');
      ok(!api.ativos().some(x=>x.regra==='refeicao'),'refeição dentro do limite não alarma');
      t.avaliarFrota(Date.now()+31*60_000,'tempo');
      let ref = api.ativos().filter(x=>x.regra==='refeicao');
      ok(ref.length===1 && ref[0].e.id==='AP-1' && ref[0].limite===30 && ref[0].notificar===true, 'apoio excede 30 min e gera alarme');
      t.avaliarFrota(Date.now()+46*60_000,'tempo');
      ref = api.ativos().filter(x=>x.regra==='refeicao');
      ok(ref.some(x=>x.e.id==='LA-2' && x.limite===45) && !ref.some(x=>x.e.id==='LA-1'), 'limite por equipamento prevalece sobre o grupo');
      t.avaliarFrota(Date.now()+61*60_000,'tempo');
      ref = api.ativos().filter(x=>x.regra==='refeicao');
      ok(ref.some(x=>x.e.id==='LA-1' && x.limite===60) && !ref.some(x=>x.e.id==='OUT-1'), 'linha amarela 1 hora; grupo sem configuração é ignorado');
      ok(/excedeu o tempo de refeição: \d+ minutos, limite de 30 minutos\. Frente\/grupo APOIO/.test(ref.find(x=>x.e.id==='AP-1').fala), 'fala da refeição excedida');
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
      t.reset(); api.configurar({calcularLocal:true,limiteRpm:2000,amostras:3}); feed({...row,vlParametro4:2100});
      const estadoRpm = () => t.estados().find(s=>s.regra==='rpm');
      t.tique(); t.tique();
      ok(estadoRpm().consec===1 && !api.ativos().some(a=>a.regra==='rpm'), 'tiques não multiplicam amostras positivas repetidas');
      feed({...row,vlParametro4:2100});
      ok(estadoRpm().consec===2 && !api.ativos().some(a=>a.regra==='rpm'), 'segunda observação distinta conta uma confirmação, sem disparar antes da terceira');
      feed({...row,vlParametro4:2100});
      ok(api.ativos().some(a=>a.regra==='rpm'), 'RPM local complementar é preservada após três observações distintas');
      t.reset(); t.capturarFalas();
      api.configurar({voz:true,popup:false,som:false,vibrar:false,notificarCategorias:{generico:false},tiposNotificacao:{11500:true}});
      t.espelharAlarmes([{cdEquipamento:'TESTE-INDIVIDUAL',cdId:'TIPO-SELECIONADO',cdTpAlarme:11500,descTpAlarme:'ABAST_INS_DESLIGAR_MOTOR_TPL',fgOnline:true}]);
      const selecionado = api.ativos().find(x=>x.tipoAlarme==='11500');
      ok(!!selecionado && selecionado.notificar, 'tipo explicitamente selecionado prevalece sobre categoria geral desligada');
      ok(t.falasCapturadas().length===1 && t.falasCapturadas()[0]===selecionado.fala, 'alarme oficial de tipo individual selecionado é falado');

      t.reset(); window.__systemNotifications.length=0;
      api.configurar({frentes:['Frente Norte'],popup:false,notificacao:false});
      const alertaSul = {cdEquipamento:'EQ-SUL',cdId:'SUL-1',cdTpAlarme:5,descTpAlarme:'VELOCIDADE',descEquipamento:'0083 - Trator fixture',descGrupoEquipamento:'Frente Sul',vlAlarme:80,fgOnline:true};
      t.espelharAlarmes([alertaSul]);
      t.processarQuadros([{type:'alarme',cdEquipamento:'EQ-STREAM-SUL',cdTpAlarme:5,descAlarme:'VELOCIDADE',descFrente:'Frente Sul',vlAlarme:80,fgOnline:true}]);
      ok(api.ativos().length===0 && api.historico().length===0, 'grupo selecionado bloqueia alarmes REST e stream de fora do escopo');
      const alertaNorte = {...alertaSul,cdEquipamento:'EQ-NORTE',cdId:'NORTE-1',descGrupoEquipamento:'Frente Norte'};
      t.espelharAlarmes([alertaNorte]);
      ok(api.ativos().length===1 && api.historico().length===1, 'grupo escolhido cria alerta oficial ativo');
      const historicoAntesEscopo = api.historico().length;
      api.configurar({frentes:['Frente Sul']});
      ok(api.ativos().length===0 && api.historico().length===historicoAntesEscopo, 'trocar grupo remove ativos de fora sem apagar histórico');
      t.espelharAlarmes([{...alertaSul,cdEquipamento:'EQ-SUL-2',cdId:'SUL-2'}]);
      ok(api.ativos().some(a=>a.e.id==='EQ-SUL-2'), 'equipamento do novo grupo entra no escopo');
      api.configurar({frentes:[]});
      t.espelharAlarmes([{cdEquipamento:'EQ-SEM-GRUPO',cdId:'SEM-GRUPO-1',cdTpAlarme:12480,descTpAlarme:'Alarme geral fixture',fgOnline:true}]);
      ok(api.ativos().some(a=>a.e.id==='EQ-SEM-GRUPO'), 'sem grupo selecionado, o escopo volta à unidade toda');
      t.reset();
      t.espelharAlarmes([{cdEquipamento:'GROUP-FRONT-ALARM',cdId:'GROUP-FRONT-1',cdTpAlarme:12480,descTpAlarme:'Alarme geral fixture',descGrupoEquipamento:'Frente 3',fgOnline:true}]);
      const alertaGrupoFrente=api.ativos().find(a=>a.e.id==='GROUP-FRONT-ALARM');
      ok(!!alertaGrupoFrente && alertaGrupoFrente.e.frente==='' && alertaGrupoFrente.e.grupoEquipamento==='Frente 3','alarme oficial não converte grupo cadastral Frente 3 em frente de colheita');

      t.reset(); t.capturarFalas(); window.__systemNotifications.length=0;
      api.configurar({calcularLocal:true,limiteRpm:1500,voz:true,notificacao:true,popup:false,som:false,vibrar:false});
      feed({...row,vlParametro4:1800});
      const localRpm = api.ativos().find(a=>a.regra==='rpm');
      ok(!!localRpm && localRpm.fonte==='app' && localRpm.notificar===false && api.historico().length===1, 'alerta local permanece na central/histórico, mas não é notificável');
      ok(t.falasCapturadas().length===0 && window.__systemNotifications.length===0, 'alerta local não gera fala nem notificação do sistema');
      const historicoAntesAmostra = api.historico().length;
      api.testar();
      const amostra = api.ativos().find(a=>a.fonte==='teste');
      ok(!!amostra && amostra.notificar===false && t.falasCapturadas().includes(amostra.fala), 'amostra manual pode testar a voz e fica marcada sem notificação do sistema');
      ok(api.historico().length===historicoAntesAmostra && window.__systemNotifications.length===0, 'amostra manual não grava histórico nem envia notificação de produção');
      api.abrirPainel();
      ok([...document.querySelectorAll('#lista-ativos .a-chip')].some(c=>c.textContent==='AMOSTRA MANUAL'), 'a amostra de teste fica identificada visualmente como manual');

      t.reset(); t.capturarFalas(); window.__systemNotifications.length=0;
      api.configurar({calcularLocal:true,minutosOcioso:1,rpmOcioso:900,voz:true,notificacao:true,popup:false,som:false,vibrar:false});
      const ociosoSemPonto = {...row,cdEquipamento:'IDLE-NO-POINT',descOperacao:'3484 - SEM APONTAMENTO',vlVelocidade:0,vlParametro4:650,vlEd1:'1'};
      feed(ociosoSemPonto);
      t.avaliarFrota(Date.now()+61_000,'tempo');
      const alertaSemPonto = api.ativos().find(a=>a.e.id==='IDLE-NO-POINT');
      ok(!!alertaSemPonto && alertaSemPonto.regra==='ociosoSemApontamento' && alertaSemPonto.texto.includes('motor ocioso e sem apontamento'), 'motor ligado ocioso com operação Sem Apontamento gera alerta combinado após o tempo configurado');
      ok(alertaSemPonto.fonte==='app' && alertaSemPonto.notificar===false && api.historico().length===1 && t.falasCapturadas().length===1 && /sem apontamento/.test(t.falasCapturadas()[0]) && window.__systemNotifications.length===0, 'alerta local confirmado pode falar como exceção, sem notificação do sistema');

      t.reset();
      api.configurar({calcularLocal:true,minutosOcioso:1,rpmOcioso:900,popup:false,som:false,vibrar:false});
      feed({...ociosoSemPonto,cdEquipamento:'IDLE-WITH-POINT',descOperacao:'801 - Operação apontada'});
      t.avaliarFrota(Date.now()+61_000,'tempo');
      ok(api.ativos().some(a=>a.e.id==='IDLE-WITH-POINT' && a.regra==='ocioso') && !api.ativos().some(a=>a.regra==='ociosoSemApontamento'), 'motor ocioso com operação apontada não recebe a classificação sem apontamento');

      t.reset();
      api.configurar({calcularLocal:true,minutosOcioso:1,rpmOcioso:900,popup:false,som:false,vibrar:false});
      const operacaoAntiga = {...ociosoSemPonto,cdEquipamento:'IDLE-UNKNOWN-OP'};
      feed(operacaoAntiga);
      feed({...operacaoAntiga,descOperacao:undefined});
      t.avaliarFrota(Date.now()+61_000,'tempo');
      ok(api.ativos().some(a=>a.e.id==='IDLE-UNKNOWN-OP' && a.regra==='ocioso') && !api.ativos().some(a=>a.e.id==='IDLE-UNKNOWN-OP' && a.regra==='ociosoSemApontamento'), 'operação ausente na leitura atual não reutiliza rótulo antigo para afirmar sem apontamento');

      t.reset(); t.capturarFalas();
      api.configurar({calcularLocal:true,minutosOcioso:1,rpmOcioso:900,voz:true,notificacao:false,popup:false,som:false,vibrar:false});
      const meiaChave = {...row,cdEquipamento:'IDLE-HALF-KEY',descOperacao:'801 - Operação apontada',vlVelocidade:0,vlParametro4:0,vlEd1:'1'};
      feed(meiaChave);
      t.avaliarFrota(Date.now()+61_000,'tempo');
      ok(!api.ativos().some(a=>a.e.id==='IDLE-HALF-KEY' && a.regra==='ociosoSemApontamento'), 'meia-chave com RPM zero não cria alerta local combinado');
      t.espelharAlarmes([{cdEquipamento:'IDLE-HALF-KEY',cdId:'HALF-KEY-OFFICIAL',cdTpAlarme:11,descTpAlarme:'MOTOR OCIOSO',descOperacao:'801 - Operação apontada',fgOnline:true}]);
      const ociosoOficialMeiaChave = api.ativos().find(a=>a.e.id==='IDLE-HALF-KEY' && a.regra==='ocioso');
      ok(!!ociosoOficialMeiaChave && !/sem apontamento/i.test(ociosoOficialMeiaChave.fala) && t.falasCapturadas().length===1, 'alarme oficial Motor Ocioso da meia-chave continua distinto do sem apontamento');

      t.reset(); t.capturarFalas();
      api.configurar({voz:true,maxPorCiclo:1,notificacao:false,popup:false});
      t.espelharAlarmes(Array.from({length:7},(_,i)=>({cdEquipamento:'RAJADA-'+i,cdId:'RAJADA-'+i,cdTpAlarme:5,descTpAlarme:'VELOCIDADE',vlAlarme:80+i,fgOnline:true})));
      ok(api.ativos().length===7 && t.falasCapturadas().length===7, 'alarmes oficiais ultrapassam a limitação de rajada sem descarte');

      t.reset(); t.capturarFalas();
      t.setCtx({api:'https://immediate.fixture.invalid',buId:1,proxy:false,audit:false});
      api.configurar({voz:true,amostras:5,maxPorCiclo:1,notificacao:false,popup:false});
      t.espelharAlarmes([{cdEquipamento:'SPEED-IMMEDIATE',cdId:'IMMEDIATE-1',cdTpAlarme:5,descTpAlarme:'VELOCIDADE',fgOnline:true}]);
      const semMedicao = api.ativos().find(a=>a.e.id==='SPEED-IMMEDIATE');
      ok(!!semMedicao && semMedicao.valor===null && t.falasCapturadas().length===1 && /alarme oficial de velocidade excedida/.test(semMedicao.fala), 'alarme oficial fala imediatamente sem esperar medição complementar');
      await new Promise(resolve=>setTimeout(resolve,30));
      ok(t.falasCapturadas().length===1, 'medição complementar tardia não gera segunda fala');

      t.reset();
      t.setChamar(async caminho => caminho.includes('/estatistica/') ? Promise.reject(new Error('timeout telemetria fixture')) : []);
      await t.ciclo();
      let fontes = t.fontes();
      ok(fontes.telemetria.status==='falha' && fontes.alarmes.status==='ok' && t.status().erros>0 && /telemetria/.test(t.status().proximoErro), 'sucesso dos alarmes oficiais não mascara falha de telemetria');
      t.reset();
      t.setChamar(async caminho => caminho.includes('/alarmeOnline?') ? Promise.reject(new Error('indisponível alarmes fixture')) : []);
      await t.ciclo();
      fontes = t.fontes();
      ok(fontes.telemetria.status==='ok' && fontes.alarmes.status==='falha' && t.status().erros>0 && /alarmes oficiais/.test(t.status().proximoErro), 'sucesso da telemetria não mascara falha de alarmes oficiais');

      t.reset();
      t.setCtx({api:'https://fixture.invalid',token:'fixture-token',proxy:false});
      t.setPrazoRequisicao(30);
      const fetchOriginal = window.fetch;
      window.fetch = (_url,opcoes) => new Promise((_,reject) => opcoes.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));
      let timeoutDetectado = false;
      try { await t.chamar('/estatistica/monitoramento'); }
      catch (e) { timeoutDetectado = e.code==='ETIMEDOUT' && /resposta em/.test(e.message); }
      finally { window.fetch = fetchOriginal; }
      ok(timeoutDetectado, 'consulta REST que não responde termina por timeout em vez de travar o ciclo');

      t.reset();
      t.setCtx({audit:true,unidade:'Fixture',usuario:'Operador fixture'});
      const alertaAudit = (chave) => ({chave,regra:'velocidade',severidade:3,numero:'8833',descricao:'Trator fixture',operador:'',valor:85,limite:50,texto:'alerta fixture',detalhe:'',fonte:'portal',fala:'fala fixture',inicio:Date.now(),ts:Date.now()});
      t.registrarNoServidor(alertaAudit('AUDIT-1'));
      t.registrarNoServidor(alertaAudit('AUDIT-2'));
      const itensAudit = JSON.parse(localStorage.getItem('bperes.alertas.audit-queue.v1'));
      ok(t.filaAudit()===2 && itensAudit.length===2 && itensAudit.every(item=>item.eventId), 'fila de auditoria é persistida com identidade por evento antes do envio');
      const fetchAuditOriginal = window.fetch;
      try {
        window.fetch = async (_url,opcoes) => {
          const corpo = JSON.parse(opcoes.body);
          return new Response(JSON.stringify({ok:false,resultados:corpo.alertas.map((item,i)=>({eventId:item.eventId,ok:i===0}))}),{status:207,headers:{'content-type':'application/json'}});
        };
        await t.enviarAudit();
        const restante = JSON.parse(localStorage.getItem('bperes.alertas.audit-queue.v1'));
        ok(t.filaAudit()===1 && restante.length===1 && restante[0].eventId===itensAudit[1].eventId, 'confirmação parcial remove só o registro aceito e mantém a falha na fila');
        t.setPausaAudit(0);
        window.fetch = async (_url,opcoes) => {
          const corpo = JSON.parse(opcoes.body);
          return new Response(JSON.stringify({ok:true,resultados:corpo.alertas.map(item=>({eventId:item.eventId,ok:true}))}),{status:202,headers:{'content-type':'application/json'}});
        };
        await t.enviarAudit();
        ok(t.filaAudit()===0 && JSON.parse(localStorage.getItem('bperes.alertas.audit-queue.v1')).length===0, 'fila persistente só é esvaziada após confirmação de gravação do servidor');
      } finally { window.fetch = fetchAuditOriginal; }
      t.reset();
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
        'fala': 'Trator zero zero sete sete excedeu a velocidade a 77 quilômetros por hora. Verificar.'
    }, local_measure
    print('OK: alarme oficial sem valor usa apenas a telemetria SGPA recente')

    page.evaluate("""() => {
      const frame = document.getElementById('map');
      window.__mapReceived = null;
      window.__mapArgs = null;
      window.__windowOpenCount = 0;
      window.open = () => { window.__windowOpenCount += 1; return null; };
      frame.onload = () => frame.contentWindow.addEventListener('message', ev => { window.__mapReceived = ev.data; });
      frame.setAttribute('src','https://fixture.invalid/portal/analytic-map-v4?tab=equipment');
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
        mapUrl:'',
        props:{rastroBI:{equipment:'anterior',scope:'preservar',start:1680000000,end:1680003600}}
      });
      const alerta = MonitoramentoAlertas.ativos()[0];
      __test.abrirNoMapa({...alerta,e:{...alerta.e,id:40451},numero:'8833'});
    }""")
    page.wait_for_function("window.__mapReceived && window.__mapReceived.type === 'props' && window.__mapReceived.data.rastroBI.equipment === '40451' && typeof window.__mapReceived.data.rastroBI.equipment === 'string'")
    assert page.evaluate("window.__mapArgs.targetOrigin === 'https://fixture.invalid' && window.__mapArgs.data.data.rastroBI.scope === 'preservar' && !Object.prototype.hasOwnProperty.call(window.__mapArgs.data.data.rastroBI,'start') && !Object.prototype.hasOwnProperty.call(window.__mapArgs.data.data.rastroBI,'end') && window.__windowOpenCount === 0 && document.getElementById('alertas').classList.contains('hide')"), 'Ver no mapa deve enviar cdEquipamento em modo de localização atual, preservando as props e sem abrir links externos'
    app_source = (ROOT / 'public/app.js').read_text()
    assert 'mapUrl: session.mapUrl' in app_source, 'app.js deve encaminhar a URL do iframe ao motor de alertas'
    print('OK: inicialização da central encaminha a URL do mapa atual')
    page.evaluate("__test.setCtx({mapUrl:'',props:null}); __test.abrirNoMapa(MonitoramentoAlertas.ativos()[0]);")
    assert page.evaluate('window.__windowOpenCount === 0'), 'Mapa indisponível deve continuar sem window.open'
    print('OK: “Ver no mapa” envia cdEquipamento sem período; o contrato do mapa aplica flyTo/zoom/popup e não abre URL externa')

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
    page.evaluate("MonitoramentoAlertas.configurar({notificarCategorias:{generico:false},tiposNotificacao:{12480:true},gestaoFrenteAtiva:true});")
    page.evaluate('MonitoramentoAlertas.abrirPainel()')
    page.click('#btn-cfg')
    assert page.locator('#cfg-fechar-x').is_visible(), 'Preferências devem exibir X para fechar'
    page.click('#cfg-fechar-x')
    assert page.locator('#cfg-alertas').evaluate("el => el.classList.contains('hide')"), 'O X deve fechar as preferências'
    assert page.evaluate('document.activeElement.id === "btn-cfg"'), 'Ao fechar, o foco deve voltar ao controle de configurações visível'
    page.click('#btn-cfg')
    page.wait_for_function("document.querySelectorAll('#cfg-categorias input[role=switch]').length === 13")
    page.wait_for_function("document.querySelector('#cfg-catalogo-status').textContent.includes('2972')")
    assert page.locator('#cfg-categorias input[aria-label="Notificar: Frente dividida (validar FUT)"]').is_checked(), 'Frente dividida deve aparecer ligada por padrão nas preferências'
    assert page.locator('#cfg-gestao-frente').is_checked(), 'Atenção gestão deve ter opção mestre ligada por padrão'
    assert page.locator('#cfg-glossario').get_attribute('autocomplete') == 'off', 'textarea do glossário precisa ter atributo autocomplete válido'
    assert 'AG=Aguardando' in page.locator('#cfg-glossario').get_attribute('placeholder'), 'placeholder do glossário deve permanecer acessível'
    page.locator('#cfg-gestao-frente').uncheck()
    page.click('#cfg-salvar')
    assert page.evaluate('MonitoramentoAlertas.config().gestaoFrenteAtiva === false'), 'toggle de gestão deve salvar desligado'
    page.click('#btn-cfg')
    assert not page.locator('#cfg-gestao-frente').is_checked(), 'toggle mestre deve persistir após reabrir preferências'
    page.locator('#cfg-gestao-frente').check()
    page.click('#cfg-salvar')
    assert page.evaluate('MonitoramentoAlertas.config().gestaoFrenteAtiva === true'), 'toggle de gestão deve poder ser religado'
    page.click('#btn-cfg')
    sample = page.locator('#cfg-glossario-previa').text_content()
    assert 'Aguardando colhedora parada rápida' in sample, sample
    assert page.evaluate("AlertasPolicy.aplicarGlossario('AG. SEQUENC. DE TRABALHO')") == 'Aguardando sequência DE TRABALHO'
    assert page.evaluate("AlertasPolicy.aplicarGlossario('MAGRO AGRO')") == 'MAGRO AGRO'
    page.fill('#cfg-glossario', 'AG=Esperando\nCOLH=colhedora')
    page.fill('#cfg-glossario-teste', 'AG COLH parada rápida')
    sample = page.locator('#cfg-glossario-previa').text_content()
    assert 'Esperando colhedora parada rápida' in sample, sample
    page.click('#cfg-salvar')
    assert page.evaluate("MonitoramentoAlertas.config().glossarioFala") == 'AG=Esperando\nCOLH=colhedora'
    page.click('#btn-cfg')
    assert page.locator('#cfg-glossario').input_value() == 'AG=Esperando\nCOLH=colhedora', 'glossário persiste após fechar e reabrir'
    page.click('#cfg-fechar-x')
    page.click('#btn-cfg')
    print('OK: expansão de AG/COLH, prévia, substituição personalizada e persistência do glossário')
    page.fill('#cfg-busca-categoria', 'fila')
    vis = page.evaluate("[...document.querySelectorAll('#cfg-categorias > *')].filter(x => !x.classList.contains('hide')).length")
    assert 1 <= vis < 13, f'busca de categorias deve filtrar ({vis})'
    page.fill('#cfg-busca-categoria', 'xyzinexistente')
    assert page.locator('#cfg-categorias-vazio').is_visible(), 'mensagem de nenhum alerta'
    page.fill('#cfg-busca-categoria', '')
    page.evaluate("document.querySelectorAll('details.catalogo-detalhes').forEach(d => d.open = true)")
    page.fill('#cfg-busca-regra', 'velocidade')
    txt = page.locator('#cfg-regras-contagem').text_content()
    assert txt.startswith('Mostrando'), txt
    page.screenshot(path='/tmp/busca.png')
    page.fill('#cfg-busca-regra', '')
    page.evaluate("document.querySelectorAll('details.catalogo-detalhes').forEach(d => d.open = false)")
    print('OK: barras de pesquisa em Quais alertas devem notificar e Regras auditadas:', txt)
    page.locator('.catalogo-detalhes').first.locator('summary').click()
    page.fill('#cfg-busca-tipo','12480')
    assert page.locator('#cfg-tipos input[role=switch]').count()==1
    assert page.locator('#cfg-tipos input[role=switch]').is_checked(), 'Tipo marcado individualmente deve permanecer ligado com categoria genérica desligada'
    page.locator('#cfg-tipos input[role=switch]').uncheck()
    assert page.evaluate("MonitoramentoAlertas.config().tiposNotificacao['12480'] === false")
    assert page.evaluate("JSON.parse(localStorage.getItem('bperes.alertas.cfg.v2')).tiposNotificacao['12480'] === false")
    page.locator('#cfg-categorias input[aria-label="Notificar: Aguardando caminhão"]').uncheck()
    assert page.evaluate('MonitoramentoAlertas.config().notificarCategorias.aguardandoCaminhao === false')
    assert page.locator('#cfg-vel').count()==0
    assert page.locator('#cfg-velcan').count()==0
    responsive_sizes = [(320, 640), (412, 915), (768, 1024), (1280, 900)]
    for width, height in responsive_sizes:
        page.set_viewport_size({'width': width, 'height': height})
        bounds = page.evaluate("""() => {
          const overlay = document.querySelector('#cfg-alertas').getBoundingClientRect();
          const card = document.querySelector('.card.cfg');
          const rect = card.getBoundingClientRect();
          return {overlay:{left:overlay.left,top:overlay.top,right:overlay.right,bottom:overlay.bottom},
            card:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},
            scroll:card.scrollWidth,client:card.clientWidth};
        }""")
        assert bounds['card']['left'] >= bounds['overlay']['left'] - 1 and bounds['card']['right'] <= bounds['overlay']['right'] + 1, (width, bounds)
        assert bounds['card']['top'] >= bounds['overlay']['top'] - 1 and bounds['card']['bottom'] <= bounds['overlay']['bottom'] + 1, (width, bounds)
        assert bounds['scroll'] <= bounds['client'] + 1, (width, bounds)
        assert page.locator('#cfg-fechar-x').is_visible(), f'X precisa continuar visível em {width}px'

    page.evaluate("""() => {
      const list = document.querySelector('#lista-ativos');
      list.innerHTML = '';
      for (let i = 0; i < 10; i++) {
        const card = document.createElement('div');
        card.className = 'alerta';
        card.innerHTML = `<div class="a-top"><strong class="a-eq">Trator de teste ${i} — equipamento com identificação longa</strong><span class="a-chip">Alarme oficial de operação</span><span class="a-hora">13:15</span></div><p class="a-txt">Mensagem longa para verificar que a descrição do alerta quebra linha sem encobrir o próximo cartão em telas estreitas.</p><p class="a-meta">Frente de teste · operação com descrição extensa para avaliar quebra de linha entre celular, tablet e computador.</p><div class="a-acoes"><button>▶ ouvir</button><button>📍 ver no mapa</button></div>`;
        list.appendChild(card);
      }
    }""")
    page.wait_for_timeout(260)
    for width, height in responsive_sizes:
        page.set_viewport_size({'width': width, 'height': height})
        layout = page.evaluate("""() => {
          const list = document.querySelector('#lista-ativos');
          const cards = [...list.children].map(x => { const r=x.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,width:r.width,scroll:x.scrollWidth,client:x.clientWidth}; });
          return {listHeight:list.clientHeight,listScroll:list.scrollHeight,listWidth:list.clientWidth,listScrollWidth:list.scrollWidth,cards};
        }""")
        assert len(layout['cards']) == 10 and layout['listHeight'] > 0, (width, layout)
        assert layout['listScroll'] > layout['listHeight'], (width, layout)
        assert layout['listScrollWidth'] <= layout['listWidth'] + 1, (width, layout)
        assert all(card['scroll'] <= card['client'] + 1 for card in layout['cards']), (width, layout)
        assert all(layout['cards'][i+1]['top'] >= layout['cards'][i]['bottom'] - 1 for i in range(9)), (width, layout['cards'])
    page.set_viewport_size({'width': 412, 'height': 915})
    page.locator('#cfg-fechar-x').click()
    page.evaluate('MonitoramentoAlertas.abrirPainel()')

    page.set_viewport_size({'width': 652, 'height': 1050})
    page.evaluate("""() => {
      __test.reset();
      __test.setCtx({api:'https://fixture.invalid',buId:1,proxy:false,audit:false});
      MonitoramentoAlertas.configurar({popup:true,notificacao:false,voz:false,som:false,vibrar:false});
      __test.espelharAlarmes(Array.from({length:7},(_,i)=>({
        cdEquipamento:`TOAST-${i}`, cdId:`TOAST-EVENT-${i}`, cdTpAlarme:12480,
        descTpAlarme:'Alerta oficial de teste com texto longo',
        descEquipamento:`${8000+i} - Equipamento de teste de pop-up ${i}`,
        nomeOperador:'Operador de teste', descGrupoEquipamento:'Frente de teste', fgOnline:true
      })));
    }""")
    page.wait_for_function("""() => {
      const box = document.querySelector('#toasts');
      return box && box.scrollHeight > box.clientHeight && box.scrollTop < 0;
    }""", timeout=3000)
    toast_layout = page.evaluate("""() => {
      const box = document.querySelector('#toasts');
      const r = box.getBoundingClientRect();
      const newest = box.querySelector('.toast:last-child').getBoundingClientRect();
      return {count:box.querySelectorAll('.toast').length,top:r.top,bottom:r.bottom,left:r.left,right:r.right,
        scrollHeight:box.scrollHeight,clientHeight:box.clientHeight,scrollTop:box.scrollTop,
        newestTop:newest.top,newestBottom:newest.bottom,active:MonitoramentoAlertas.ativos().length,history:__test.historico().length};
    }""")
    assert toast_layout['count'] == 7 and toast_layout['active'] == 7 and toast_layout['history'] == 7, toast_layout
    assert toast_layout['scrollHeight'] > toast_layout['clientHeight'] and toast_layout['scrollTop'] < 0, toast_layout
    assert toast_layout['top'] >= 0 and toast_layout['bottom'] <= 1050, toast_layout
    assert toast_layout['left'] >= 0 and toast_layout['right'] <= 652, toast_layout
    assert toast_layout['newestTop'] >= toast_layout['top'] - 1 and toast_layout['newestBottom'] <= toast_layout['bottom'] + 1, toast_layout
    print('OK: toasts ampliados na tela de 652×1050; o mais novo permanece visível e os sete alertas continuam ativos')
    page.set_viewport_size({'width': 412, 'height': 915})
    mobile_toasts = page.evaluate('''() => {
      const box = document.querySelector('#toasts');
      const r = box.getBoundingClientRect();
      return {height:box.clientHeight,scrollHeight:box.scrollHeight,top:r.top,bottom:r.bottom,vh:innerHeight};
    }''')
    assert mobile_toasts['top'] <= 80 and mobile_toasts['height'] >= mobile_toasts['vh'] * 0.88, mobile_toasts
    assert mobile_toasts['scrollHeight'] > mobile_toasts['height'] and mobile_toasts['top'] >= 0 and mobile_toasts['bottom'] <= mobile_toasts['vh'], mobile_toasts
    page.set_viewport_size({'width': 1280, 'height': 900})
    desktop_toasts = page.evaluate('''() => {
      const box = document.querySelector('#toasts');
      const r = box.getBoundingClientRect();
      return {height:box.clientHeight,scrollHeight:box.scrollHeight,top:r.top,bottom:r.bottom,vh:innerHeight};
    }''')
    assert desktop_toasts['top'] <= 75 and desktop_toasts['height'] >= desktop_toasts['vh'] * 0.88, desktop_toasts
    assert desktop_toasts['scrollHeight'] > desktop_toasts['height'] and desktop_toasts['top'] >= 0 and desktop_toasts['bottom'] <= desktop_toasts['vh'], desktop_toasts
    print('OK: área das notificações chega perto do cabeçalho em celular e computador:', mobile_toasts['height'], desktop_toasts['height'])
    assert page.locator('#btn-limpar-toasts').is_visible(), 'botão Limpar tudo deve aparecer com notificações'
    assert page.locator('#toasts .toast').first.locator('.barra').count() == 1, 'timer visual de desaparecimento automático permanece'
    page.evaluate('MonitoramentoAlertas.fecharPainel()')
    page.click('#btn-limpar-toasts')
    assert page.locator('#toasts .toast, #toasts .aviso').count() == 0, 'Limpar tudo remove apenas cartões flutuantes'
    assert page.locator('#btn-limpar-toasts').evaluate("el => el.classList.contains('hide')"), 'botão some quando não há pop-ups'
    assert page.evaluate('MonitoramentoAlertas.ativos().length') == 7, 'alertas continuam ativos na Central'
    assert len(page.evaluate('__test.historico()')) == 7, 'histórico não é removido'
    print('OK: Limpar tudo remove só os pop-ups; alertas ativos e histórico permanecem, timer automático inalterado')

    page.set_viewport_size({'width': 412, 'height': 915})
    page.evaluate("""() => {
      __test.reset();
      __test.setCtx({api:'https://fixture.invalid',buId:1,proxy:false,audit:false});
      MonitoramentoAlertas.configurar({popup:false,notificacao:false,voz:false,som:false,vibrar:false});
      __test.espelharAlarmes([
        {cdEquipamento:'BP-8833',cdId:'SEARCH-SPEED',cdTpAlarme:5,descTpAlarme:'VELOCIDADE EXCEDIDA',descEquipamento:'8833 - Transbordo BP 8833',nomeOperador:'Cristiano Ferreira',descGrupoEquipamento:'Frente Norte',vlAlarme:85,fgOnline:true},
        {cdEquipamento:'BP-2211',cdId:'SEARCH-RPM',cdTpAlarme:4,descTpAlarme:'RPM MÁXIMA MOTOR',descEquipamento:'2211 - Trator BP 2211',nomeOperador:'Maria Silva',descGrupoEquipamento:'Frente Sul',vlAlarme:2100,fgOnline:true}
      ]);
      MonitoramentoAlertas.abrirPainel();
    }""")
    assert page.locator('#alertas-busca').get_attribute('aria-label') == 'Buscar por frota, alerta ou operador'
    page.fill('#alertas-busca', 'cristiano')
    assert page.locator('#lista-ativos .alerta').count() == 1
    assert '8833' in page.locator('#lista-ativos').inner_text()
    page.fill('#alertas-busca', 'rpm maxima')
    assert page.locator('#lista-ativos .alerta').count() == 1
    page.fill('#alertas-busca', '8833')
    assert page.locator('#lista-ativos .alerta').count() == 1
    assert page.locator('#cont-ativos').inner_text() == '2', 'A busca não deve reduzir o contador total de ativos'
    assert page.locator('#cont-hist').inner_text() == '2', 'A busca não deve reduzir o contador total do histórico'
    page.locator('.aba[data-aba="historico"]').click()
    page.fill('#alertas-busca', 'maria silva')
    assert page.locator('#lista-historico .alerta').count() == 1
    assert 'Maria Silva' in page.locator('#lista-historico').inner_text()
    page.fill('#alertas-busca', '2.100 rpm')
    assert page.locator('#lista-historico .alerta').count() == 1, 'A busca deve incluir texto/valor do alerta no histórico'
    page.click('#alertas-busca-limpar')
    assert page.locator('#lista-historico .alerta').count() == 2, 'Limpar a busca deve restaurar todo o histórico exibido'
    assert page.evaluate('document.activeElement.id') == 'alertas-busca'
    page.locator('.aba[data-aba="ativos"]').click()
    assert page.locator('#lista-ativos .alerta').count() == 2
    print('OK: busca da Central filtra frota, alarme, texto e operador em Ativos/Histórico, sem alterar contagens nem registros')

    print('OK: chaves por categoria/tipo, busca, persistência, X e cartões roláveis sem sobreposição em celular, tablet e computador')

    page.evaluate("""() => {
      __test.reset();
      __test.setCtx({api:'https://fixture.invalid',buId:1,proxy:false,audit:false});
      MonitoramentoAlertas.configurar({notificacao:true,notificarCategorias:{generico:true},tiposNotificacao:{12480:true},popup:false,voz:false});
      __test.espelharAlarmes([{cdEquipamento:'PUSH-OFICIAL',cdId:'PUSH-1',cdTpAlarme:12480,descTpAlarme:'Alarme oficial fixture',fgOnline:true}]);
    }""")
    page.wait_for_function('window.__systemNotifications.length === 1', timeout=2000)
    assert page.evaluate("window.__systemNotifications[0].title.includes('PUSH-OFICIAL')"), 'Apenas o alarme real do SGPA deve chegar à notificação do sistema'
    print('OK: um alarme oficial selecionado produz a notificação de sistema esperada')

    page.evaluate("""() => {
      __test.reset();
      __test.setCtx({api:'https://fixture.invalid',buId:1,proxy:false,audit:false});
      window.__webVoiceList = [];
      window.__nativeVoices = [];
      window.__androidReady = false;
      MonitoramentoAlertas.abrirPainel();
      document.getElementById('btn-cfg').click();
      MonitoramentoAlertas.iniciar({
        modo:'local',
        props:{token:'voice-fixture',urlSgpa:'https://fixture.invalid',cdUnidadeRegional:[1],cdCliente:204},
        mapUrl:'https://fixture.invalid'
      });
    }""")
    page.wait_for_function('typeof window.__voiceChanged === "function"', timeout=2000)
    assert page.locator('#cfg-gerenciar-vozes').is_visible(), 'O APK deve oferecer acesso ao gerenciador de vozes Android'
    page.click('#cfg-gerenciar-vozes')
    assert page.evaluate('window.__voiceManageCount === 1'), 'O botão deve chamar a ponte nativa para instalar/gerenciar vozes'
    page.evaluate("""() => {
      window.__webVoiceList = [
        {name:'Web PT-BR A',lang:'pt-BR',voiceURI:'web-ptbr-a'},
        {name:'Web PT-BR B',lang:'pt-BR',voiceURI:'web-ptbr-b'},
        {name:'Web English',lang:'en-US',voiceURI:'web-en'}
      ];
      window.__nativeVoices = [
        {id:'android-ptbr-a',name:'Android PT-BR A',lang:'pt-BR'},
        {id:'android-ptbr-b',name:'Android PT-BR B',lang:'pt-BR'}
      ];
      window.__dispatchVoicesChanged();
    }""")
    page.wait_for_function("document.querySelectorAll('#cfg-vozel option').length >= 5", timeout=2000)
    assert page.evaluate("[...document.querySelectorAll('#cfg-vozel option')].some(o=>o.textContent.includes('Android PT-BR A')) && [...document.querySelectorAll('#cfg-vozel option')].some(o=>o.textContent.includes('Web PT-BR B'))"), 'A lista deve combinar vozes nativas e vozes do navegador após o evento assíncrono'
    page.evaluate("""() => {
      const sel = document.getElementById('cfg-vozel');
      const op = [...sel.options].find(o=>o.value.startsWith('web:') && o.textContent.includes('Web PT-BR B'));
      sel.value = op.value;
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      MonitoramentoAlertas.configurar({voz:true,notificacao:false});
      MonitoramentoAlertas.falar('Teste da voz Web PT-BR B',{oficial:true});
    }""")
    page.wait_for_function("window.__webSpoken.some(x=>x.text==='Teste da voz Web PT-BR B')", timeout=2000)
    assert page.evaluate("window.__webSpoken.some(x=>x.text==='Teste da voz Web PT-BR B' && x.voice==='Web PT-BR B') && JSON.parse(localStorage.getItem('bperes.alertas.cfg.v2')).vozURI.startsWith('web:')"), 'A escolha Web precisa ser aplicada à fala e persistida'
    page.evaluate("""() => {
      const sel = document.getElementById('cfg-vozel');
      const op = [...sel.options].find(o=>o.value==='android:Android PT-BR A');
      sel.value = op.value;
      sel.dispatchEvent(new Event('change',{bubbles:true}));
      MonitoramentoAlertas.falar('Teste da voz Android pendente',{oficial:true});
    }""")
    page.wait_for_function("window.__nativePending.some(x=>x.text==='Teste da voz Android pendente')", timeout=3000)
    page.evaluate('window.__flushAndroidVoice()')
    assert page.evaluate("window.__nativeSpoken.some(x=>x.text==='Teste da voz Android pendente' && x.name==='Android PT-BR A') && JSON.parse(localStorage.getItem('bperes.alertas.cfg.v2')).vozURI==='android:Android PT-BR A'"), 'A voz Android escolhida deve usar a ponte nativa, aguardar a inicialização e persistir a preferência'
    print('OK: vozes Web/Android assíncronas, escolha aplicada e persistida; fala nativa aguarda prontidão')
    page.wait_for_timeout(3000)
    page.evaluate("""() => {
      __test.restaurarFalas();
      window.__nativeSpoken.length = 0;
      Object.defineProperty(window,'speechSynthesis',{configurable:true,value:null});
      MonitoramentoAlertas.configurar({vozURI:'',vozNome:''});
      MonitoramentoAlertas.falar('Voz Android padrão do APK');
    }""")
    page.wait_for_function("window.__nativeSpoken.some(x=>x.text==='Voz Android padrão do APK' && x.name==='')", timeout=3000)
    print('OK: APK usa voz Android padrão mesmo antes de uma preferência explícita quando não há speechSynthesis Web')
    assert not errors, errors
    assert not any(m=='POST' for m,u in requests), 'Teste tentou POST'
    assert not any('sgpa-solinftec' in u or 'supabase' in u or 'netlify' in u for m,u in requests), 'Teste tentou rede produção'
    print('OK: zero erros JavaScript, nenhuma rede ou escrita de produção')
    browser.close()
    print(f'Testes integrados passaram: {len(result)+11} grupos de verificações.')
