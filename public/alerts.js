/* Monitoramento BP — Central de Alertas
 *
 * Motor de alertas em tempo real para a tela de monitoramento (mapa analítico v4)
 * do portal Solinftec. Três fontes, medidas no tenant Branco Peres:
 *
 *   1) STREAM AO VIVO — POST {monitoramento}/v2/subscribe-live (NDJSON, o mesmo
 *      canal que o mapa oficial usa). Chega um quadro a cada mudança de posição,
 *      operação ou operador. Roda em Web Worker, então continua vivo com a aba
 *      em segundo plano. É o que dá a velocidade de reação.
 *   2) TELEMETRIA — GET {sgpa}/estatistica/monitoramento (velocidade, RPM do
 *      motor em vlParametro4, motor ligado em vlEd1, operador, estado).
 *   3) ALARMES OFICIAIS — GET {sgpa}/alarmeOnline?ativo=true (o que o portal já
 *      disparou, com valor medido) e GET {sgpa}/alarmeTempoEquipamento (há quanto
 *      tempo o alarme está ativo, no relógio do servidor).
 *
 * Velocidade é exclusivamente o alarme oficial do SGPA, sem limiar local.
 * RPM, troca de turno e ociosidade mantêm cálculo local opcional. A operação
 * Aguardando Caminhão em tratores/transbordos é rastreada na telemetria.
 * Todos os tipos oficiais entram na central. Alertas oficiais recebem os canais
 * escolhidos pelo usuário. Cálculos locais ficam na central/histórico; só a regra
 * confirmada “Motor ocioso sem apontamento” pode falar, sem os demais canais.
 *
 * Saída: pop-up na tela, som, voz em português (Web Speech API; no APK do Android
 * usa a ponte nativa AndroidTTS), notificação do sistema, vibração e histórico
 * auditável com exportação CSV (+ gravação opcional no Supabase).
 *
 * Segurança: nenhuma senha passa por aqui; usa o token da sessão do app.
 * Limite medido no servidor: 10 requisições/min/IP — o polling respeita isso.
 */

(() => {
  'use strict';

  const VERSAO = '1.5.1';
  const policy = window.AlertasPolicy;
  const KEY_CFG = 'bperes.alertas.cfg.v2';
  const KEY_HIST = 'bperes.alertas.hist.v2';
  const KEY_ACK = 'bperes.alertas.ack.v2';
  const KEY_PUSH_DEVICE = 'bperes.push.deviceId.v1';
  const MAX_HIST = 600;
  const MONITORAMENTO_API = 'https://api-usa.saas-solinftec.com/monitoramento/v2';

  const $ = (id) => document.getElementById(id);
  const agora = () => Date.now();

  /* tipos de alarme oficiais => nossas regras (catálogo /tipo-alarme do tenant) */
  const MAPA_ALARME = {
    2203: 'velocidade', // VELOCIDADE EXCEDIDA
    5: 'velocidade', // VELOCIDADE
    2685: 'velocidade', // Velocidade máxima
    1641: 'velocidade', // VELOCIDADE EM DESLOCAMENTO
    10820: 'velocidade', // Controle_Vel_Canavieiro
    2697: 'motorCondicao', // condição combinada: não interpretar valor como km/h
    2699: 'motorCondicao',
    4: 'rpm', // RPM MAXIMA MOTOR
    6: 'rpm', // RPM MOTOR EM PARADA
    8: 'rpm', // RPM MOTOR EM MANOBRA
    11: 'ocioso', // MOTOR OCIOSO
    2343: 'ocioso', // MOTOR OCIOSO canavieiro
    2207: 'ocioso', // MODO OCIOSO
    2849: 'turno', // Tempo Excedido Troca de Turno - HR
    2851: 'turno', // Alerta Troca de Turno - HR
  };

  const REGRAS = {
    velocidade: { id: 'velocidade', nome: 'Velocidade excedida', icone: '🚨', cor: '#e05252', severidade: 3 },
    rpm: { id: 'rpm', nome: 'RPM máxima do motor', icone: '⚙️', cor: '#ff8f3f', severidade: 3 },
    turno: { id: 'turno', nome: 'Preso em troca de turno', icone: '⏱️', cor: '#f0cc0c', severidade: 2 },
    ocioso: { id: 'ocioso', nome: 'Motor ocioso', icone: '🔌', cor: '#4aa3ff', severidade: 2 },
    ociosoSemApontamento: { id: 'ociosoSemApontamento', nome: 'Motor ocioso sem apontamento', icone: '🔌', cor: '#db9b3b', severidade: 2 },
    motorCondicao: { id: 'motorCondicao', nome: 'Motor ligado — condição combinada', icone: 'M', cor: '#c6a0e8', severidade: 2 },
    aguardandoCaminhao: { id: 'aguardandoCaminhao', nome: 'Aguardando caminhão', icone: 'T', cor: '#e9b457', severidade: 2 },
    refeicao: { id: 'refeicao', nome: 'Refeição excedida', icone: '🍽️', cor: '#d9822b', severidade: 2 },
    semApontamento: { id: 'semApontamento', nome: 'Sem apontamento', icone: '📝', cor: '#e07b39', severidade: 2 },
    paradaImprodutiva: { id: 'paradaImprodutiva', nome: 'Parada improdutiva', icone: '⏸️', cor: '#c96b3b', severidade: 2 },
    gestaoFrente: { id: 'gestaoFrente', nome: 'Gestão da frente', icone: '🚩', cor: '#b5179e', severidade: 3 },
    generico: { id: 'generico', nome: 'Alarme do portal', icone: '⚠️', cor: '#93a4b3', severidade: 1 },
  };

  const PADRAO = {
    ativo: true,
    intervaloSeg: 45, // ciclo de polling (mínimo 30 s; o portal aceita 10 req/min por IP)
    amostras: 1, // 1 = dispara na leitura; 2 = exige duas leituras seguidas (menos falso-positivo, +1 ciclo)
    cooldownMin: 10, // repetição do mesmo alerta ainda ativo
    limiteVelocidade: 51, // km/h — vem da regra do tenant VELOCIDADE_EXCEDIDA_50_VL
    limiteVelocidadeCanavieiro: 0, // 0 = desligado (a regra de 23 km/h da usina é sensível demais)
    limiteRpm: 2000, // piso do cálculo local; o limite correto é por tipo de máquina e vem do espelho oficial
    maxPorCiclo: 4, // no máximo N alertas falam por ciclo (evita "chuva de voz" ao abrir o app)
    rpmOcioso: 900,
    minutosOcioso: 5,
    refeicaoGrupos: {}, // grupo/frente → minutos de refeição (0 = não controlar)
    refeicaoEquipamentos: '', // "6614=30, 8833=60": prevalece sobre o grupo
    escalarUrgenteMin: 10, // minutos após a tolerância: repete como urgente
    escalarLiderMin: 20, // minutos após a tolerância: pede acionar o líder
    lideresFrente: '', // "Frente 1=João; Frente 2=Pedro"
    filaMaxFrente: 4, // caminhões/transbordos em fila/aguardando carregamento na mesma frente (0 = desliga)
    minutosFrenteSemColhedora: 10, // todas as colhedoras da frente paradas (0 = desliga)
    transbordosAguardandoMax: 3, // transbordos aguardando colhedora na mesma frente (0 = desliga)
    paradasLimites: {}, // id da parada → minutos de tolerância (0 = não alertar)
    minutosSemApontamento: 5, // tolerância antes de alertar operação “Sem Apontamento”
    minutosTurno: 4, // pedido do usuário (o portal usa 3)
    maxAtrasoMin: 20, // ignorar equipamento sem sinal há mais que isso
    espelharServidor: true,
    incluirOutros: true, // novas instalações notificam todos; valor legado é preservado
    notificarCategorias: {},
    tiposNotificacao: {},
    calcularLocal: true,
    usarStream: true,
    frentes: [],
    equipamentos: '',
    seguirSelecaoMapa: false,
    selecaoMapa: [],
    popup: true,
    som: true,
    voz: true,
    vozNome: '',
    vozURI: '',
    volume: 1,
    taxa: 1,
    tom: 1,
    vibrar: true,
    notificacao: false,
    repetirVoz: false,
    silencioAte: 0,
  };

  /* ------------------------------------------------------------------ */
  /* estado                                                             */
  /* ------------------------------------------------------------------ */

  let cfg = policy.normalizeCfg(carregar(KEY_CFG, PADRAO));
  let hist = carregar(KEY_HIST, []);
  let acks = carregar(KEY_ACK, {});
  let ctx = { selecao: new Set(Array.isArray(cfg.selecaoMapa) ? cfg.selecaoMapa.map(String) : []), props: null };
  let timer = null;
  let correndo = false;
  let proximo = 0;
  let worker = null;
  let ultimoQuadro = 0;
  let tentativasStream = 0;
  let renovacaoPendente = null;

  const frota = new Map(); // cdEquipamento => leitura consolidada
  const estados = new Map(); // "equipamento|regra" => máquina de estados
  const ativos = new Map(); // chave => alerta exibido
  let el = {};
  let catalogo = { tipos: [], expressoes: [], regras: [] };
  let carregandoCatalogo = null;
  let atualizandoCatalogo = false;
  let atualizacaoVelocidade = null;
  let buscaCentral = '';
  const alarmesVelocidadePendentes = new Map();
  let pushStatusText = 'As notificações Push ainda não foram verificadas neste aparelho.';
  let pushSubscribed = false;
  let pushRegistered = false;
  let pushBusy = false;
  let pushSyncTimer = null;
  let pushSyncRunning = false;
  let pushSyncAgain = false;

  const estado = {
    ligado: false,
    ultimoCiclo: 0,
    erros: 0,
    proximoErro: '',
    sessao: 'ativa',
    monitorados: 0,
    backoff: 0,
    fonte: '—',
    stream: 'desligado',
    quadros: 0,
    frentes: [],
  };

  function carregar(chave, padrao) {
    try {
      const bruto = localStorage.getItem(chave);
      if (!bruto) return JSON.parse(JSON.stringify(padrao));
      const salvo = JSON.parse(bruto);
      if (Array.isArray(padrao)) return Array.isArray(salvo) ? salvo : [];
      return JSON.parse(JSON.stringify(Object.assign({}, padrao, salvo && typeof salvo === 'object' ? salvo : {})));
    } catch {
      return JSON.parse(JSON.stringify(padrao));
    }
  }

  function salvar(chave, valor) {
    try {
      localStorage.setItem(chave, JSON.stringify(valor));
    } catch {
      /* storage cheio ou bloqueado: segue sem persistir */
    }
  }

  function pushSuportado() {
    return typeof window !== 'undefined' && window.isSecureContext !== false &&
      typeof Notification !== 'undefined' && !!navigator.serviceWorker &&
      typeof navigator.serviceWorker.ready !== 'undefined';
  }

  function renderPushStatus() {
    const status = $('push-status');
    const ativar = $('push-ativar');
    const desligar = $('push-desligar');
    if (status) status.textContent = pushStatusText;
    if (ativar) {
      ativar.classList.toggle('hide', pushRegistered);
      ativar.disabled = pushBusy || !pushSuportado() || (typeof Notification !== 'undefined' && Notification.permission === 'denied');
      ativar.textContent = pushBusy ? 'Aguarde…' : 'Ativar notificações Push neste aparelho';
    }
    if (desligar) {
      desligar.classList.toggle('hide', !pushSubscribed && !pushRegistered);
      desligar.disabled = pushBusy;
    }
  }

  function idDispositivoPush() {
    try {
      const salvo = localStorage.getItem(KEY_PUSH_DEVICE);
      if (salvo && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(salvo)) return salvo;
      const cryptoApi = window.crypto;
      let id;
      if (cryptoApi && typeof cryptoApi.randomUUID === 'function') id = cryptoApi.randomUUID();
      else {
        const bytes = new Uint8Array(16);
        if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      localStorage.setItem(KEY_PUSH_DEVICE, id);
      return id;
    } catch {
      throw new Error('Não foi possível preparar este aparelho para Push.');
    }
  }

  function preferenciasPush() {
    const categorias = {};
    const tipos = {};
    for (const [k, v] of Object.entries(cfg.notificarCategorias || {})) categorias[String(k)] = !!v;
    for (const [k, v] of Object.entries(cfg.tiposNotificacao || {})) tipos[String(k)] = !!v;
    const frentes = Array.isArray(cfg.frentes) ? [...new Set(cfg.frentes.map(String))] : [];
    const selecaoMapa = Array.isArray(cfg.selecaoMapa) ? [...new Set(cfg.selecaoMapa.map(String))] : [];
    return {
      notificarCategorias: categorias,
      tiposNotificacao: tipos,
      frentes,
      equipamentos: String(cfg.equipamentos || ''),
      seguirSelecaoMapa: !!cfg.seguirSelecaoMapa,
      selecaoMapa,
    };
  }

  function vapidBytes(chave) {
    const base64 = String(chave || '').replace(/-/g, '+').replace(/_/g, '/');
    const preenchido = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binario = atob(preenchido);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return bytes;
  }

  async function requisitarChavePush() {
    let resposta;
    try {
      resposta = await fetch('/api/push', { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!resposta.ok) throw new Error('indisponível');
      const dados = await resposta.json();
      if (!dados || typeof dados.vapidPublicKey !== 'string' || !dados.vapidPublicKey) throw new Error('indisponível');
      return dados.vapidPublicKey;
    } catch {
      throw new Error('O serviço de notificações Push está indisponível no momento.');
    }
  }

  async function enviarPreferenciaPush(corpo) {
    let resposta;
    let dados;
    try {
      resposta = await fetch('/api/push', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
        cache: 'no-store',
      });
      dados = await resposta.json();
    } catch {
      throw new Error('Não foi possível concluir a operação de Push agora.');
    }
    if (!resposta.ok || !dados || dados.ok !== true) throw new Error('Não foi possível concluir a operação de Push agora.');
    return dados;
  }

  async function registroPush() {
    if (!pushSuportado()) throw new Error('Este navegador ou aparelho não oferece suporte a notificações Push.');
    let registro;
    try {
      registro = await navigator.serviceWorker.ready;
    } catch {
      throw new Error('O serviço de notificações deste aparelho não está disponível.');
    }
    if (!registro || !registro.pushManager) throw new Error('Este navegador ou aparelho não oferece suporte a notificações Push.');
    return registro;
  }

  async function syncPushAgora() {
    if (!pushSubscribed) return;
    if (pushSyncRunning) {
      pushSyncAgain = true;
      return;
    }
    pushSyncRunning = true;
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        pushSubscribed = false;
        pushRegistered = false;
        pushStatusText = typeof Notification !== 'undefined' && Notification.permission === 'denied'
          ? 'A permissão foi bloqueada nas configurações do navegador. O Push não está ativo neste aparelho.'
          : 'O Push não está ativo neste aparelho.';
        return;
      }
      const registro = await registroPush();
      const subscription = await registro.pushManager.getSubscription();
      if (!subscription) {
        pushSubscribed = false;
        pushRegistered = false;
        pushStatusText = 'Não há uma assinatura Push ativa neste aparelho.';
        return;
      }
      pushStatusText = 'Sincronizando as preferências deste aparelho…';
      renderPushStatus();
      await enviarPreferenciaPush({ action: 'sync', deviceId: idDispositivoPush(), preferences: preferenciasPush() });
      pushRegistered = true;
      pushStatusText = 'Push ativo neste aparelho. As preferências foram sincronizadas.';
    } catch {
      pushRegistered = false;
      pushStatusText = 'O Push está autorizado neste aparelho, mas não foi possível sincronizar as preferências. Tente novamente.';
    } finally {
      pushSyncRunning = false;
      renderPushStatus();
      if (pushSyncAgain) {
        pushSyncAgain = false;
        agendarSyncPush(0);
      }
    }
  }

  function agendarSyncPush(atraso = 650) {
    if (!pushSubscribed) return;
    clearTimeout(pushSyncTimer);
    pushSyncTimer = setTimeout(() => { syncPushAgora(); }, atraso);
  }

  async function inicializarPush() {
    if (!pushSuportado()) {
      pushStatusText = 'Notificações Push não estão disponíveis neste navegador ou aparelho.';
      renderPushStatus();
      return;
    }
    pushStatusText = 'Verificando a assinatura Push deste aparelho…';
    renderPushStatus();
    try {
      const registro = await registroPush();
      const subscription = await registro.pushManager.getSubscription();
      pushSubscribed = !!subscription;
      pushRegistered = false;
      if (pushSubscribed) {
        if (Notification.permission === 'granted') {
          pushStatusText = 'Assinatura Push encontrada. Sincronizando as preferências deste aparelho…';
          renderPushStatus();
          await syncPushAgora();
        } else {
          pushStatusText = 'Há uma assinatura local, mas a permissão está bloqueada ou não concedida. Desligue o Push aqui ou ajuste a permissão no navegador.';
        }
      } else {
        pushStatusText = Notification.permission === 'denied'
          ? 'A permissão de notificações está bloqueada no navegador. Altere-a nas configurações para ativar Push.'
          : Notification.permission === 'granted'
            ? 'A permissão está concedida, mas este aparelho ainda não está inscrito no Push.'
            : 'Push desativado. A permissão só será solicitada se você clicar em “Ativar notificações Push neste aparelho”.';
      }
    } catch {
      pushSubscribed = false;
      pushStatusText = 'Não foi possível verificar o Push neste aparelho. Tente novamente mais tarde.';
    }
    renderPushStatus();
  }

  async function ativarPush() {
    if (pushBusy) return;
    if (!pushSuportado()) {
      pushStatusText = 'Notificações Push não estão disponíveis neste navegador ou aparelho.';
      renderPushStatus();
      return;
    }
    pushBusy = true;
    renderPushStatus();
    let assinaturaLocal = null;
    try {
      let permissao = Notification.permission;
      if (permissao === 'default') {
        try {
          // Único ponto que pode solicitar permissão: ação explícita no botão de opt-in.
          permissao = await Notification.requestPermission();
        } catch {
          permissao = 'denied';
        }
      }
      if (permissao !== 'granted') {
        pushSubscribed = false;
        pushRegistered = false;
        pushStatusText = permissao === 'denied'
          ? 'A permissão foi negada. Para ativar Push, altere-a nas configurações do navegador.'
          : 'A permissão não foi concedida; nenhum cadastro Push foi feito.';
        return;
      }
      const registro = await registroPush();
      let subscription = await registro.pushManager.getSubscription();
      if (!subscription) {
        const chave = await requisitarChavePush();
        try {
          subscription = await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(chave) });
        } catch {
          throw new Error('Não foi possível criar uma assinatura Push neste aparelho.');
        }
      }
      assinaturaLocal = subscription;
      pushSubscribed = !!subscription;
      const dadosSubscription = subscription && typeof subscription.toJSON === 'function' ? subscription.toJSON() : null;
      if (!dadosSubscription) throw new Error('Não foi possível preparar a assinatura Push deste aparelho.');
      await enviarPreferenciaPush({
        action: 'subscribe',
        deviceId: idDispositivoPush(),
        subscription: dadosSubscription,
        preferences: preferenciasPush(),
      });
      pushSubscribed = true;
      pushRegistered = true;
      pushStatusText = 'Notificações Push ativadas neste aparelho. Preferências sincronizadas.';
    } catch (erro) {
      pushSubscribed = !!assinaturaLocal && typeof Notification !== 'undefined' && Notification.permission === 'granted';
      pushRegistered = false;
      pushStatusText = erro && erro.message === 'O serviço de notificações Push está indisponível no momento.'
        ? erro.message
        : 'Não foi possível ativar o Push agora. Tente novamente mais tarde.';
    } finally {
      pushBusy = false;
      renderPushStatus();
    }
  }

  async function desligarPush() {
    if (pushBusy) return;
    pushBusy = true;
    renderPushStatus();
    try {
      let subscription = null;
      if (pushSuportado()) {
        const registro = await registroPush();
        subscription = await registro.pushManager.getSubscription();
      }
      await enviarPreferenciaPush({ action: 'unsubscribe', deviceId: idDispositivoPush() });
      if (subscription) {
        try { await subscription.unsubscribe(); } catch { /* o servidor já desativou este aparelho */ }
      }
      pushSubscribed = false;
      pushRegistered = false;
      pushStatusText = 'Notificações Push desligadas neste aparelho.';
    } catch {
      pushStatusText = 'Não foi possível desligar o Push agora. A assinatura deste aparelho não foi alterada.';
    } finally {
      pushBusy = false;
      renderPushStatus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* utilidades de dados                                                */
  /* ------------------------------------------------------------------ */

  function norm(txt) {
    return String(txt || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (v === null || v === undefined || v === '') return 0;
    const s = String(v).trim().replace(/\s/g, '');
    if (/\*NAO_DEFINIDO\*/i.test(s)) return 0;
    if (/,\d{1,3}$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.')) || 0;
    return Number(s) || 0;
  }

  function valorMedido(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!/^\d+(?:[.,]\d+)?$/.test(s)) return null;
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function milhar(v) {
    return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  /* "4462 - Caminhao Transp Edson Jose" => numero 4462; "JOHN DEERE CH570" => usa o cd */
  function partirEquipamento(desc, id) {
    const s = String(desc || '').trim();
    const m = s.match(/^(\d{3,6})\s*[-–]\s*(.*)$/);
    if (m) return { numero: m[1], nome: m[2] || s };
    return { numero: String(id || s), nome: s || String(id || '—') };
  }

  /* "18251 - OPERADOR-90" => "Luiz Augusto de Freitas" */
  function nomeOperador(desc) {
    const s = String(desc || '').trim().replace(/^\d+\s*[-–]\s*/, '');
    if (!s || /desconhecido|indefinido|generic|sem operador|^nao definido/.test(norm(s))) return '';
    return s
      .toLowerCase()
      .replace(/(^|[\s(])([a-zà-ú])/g, (_, sep, c) => sep + c.toUpperCase())
      .replace(/\bDe\b/g, 'de')
      .replace(/\b(Da|Do|Dos|Das)\b/g, (m2) => m2[1] + m2.slice(2).toLowerCase());
  }

  function semOperador(desc) {
    const s = norm(desc);
    return !s || /desconhecido|indefinido|generic|sem operador|\b9999\b/.test(s);
  }

  /* "0 DIA(S)  00: 00: 08" => segundos */
  function segundosAtraso(txt) {
    const s = String(txt || '');
    const d = Number((s.match(/(\d+)\s*DIA/) || [])[1] || 0);
    const hms = s.match(/(\d{1,2}):\s*(\d{1,2}):\s*(\d{1,2})/);
    if (!hms && !d) return null;
    const seg = hms ? Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) : 0;
    return d * 86400 + seg;
  }

  /* "23/11/2026 06:53:46" (dd/mm/aaaa, horário do tenant) => ms */
  function dataHorario(txt) {
    const m = String(txt || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }

  /* [2026,11,23,6,51,14] (array do /alarmeOnline, fuso do tenant) => ms */
  function dataArray(a) {
    if (!Array.isArray(a) || a.length < 3) return null;
    const d = new Date(a[0], (a[1] || 1) - 1, a[2], a[3] || 0, a[4] || 0, a[5] || 0);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }

  /* O que a voz fala antes do número: "Veículo 8833…", "Colhedora 57838…".
     No tenant o descTpEquipamento é cadastro solto (aparece "TRATOR DE PNEU LEVE"
     para um carro), então olhamos primeiro o nome/grupo da máquina. */
  function classeFala(nome, tipo, frente) {
    const n = norm((nome || '') + ' ' + (frente || ''));
    if (/veiculo leve|utilitario|camionete|carro|van |oroche|oroich|automovel|viatura|ambulancia/.test(n)) return 'Veículo';
    if (/quadriciclo|motocicleta|moto /.test(n)) return 'Quadriciclo';
    if (/onibus/.test(n)) return 'Ônibus';
    if (/retroescavadeira|motoniveladora|patrola|escavadeira/.test(n)) return 'Máquina';
    if (/empilhadeira/.test(n)) return 'Empilhadeira';
    if (/torre/.test(n)) return 'Torre';
    if (/vagao|carretaagri/.test(n)) return 'Vagão';
    const t = (norm(tipo) + ' ' + norm(nome)).replace(/[^a-z]/g, '');
    if (t.includes('colhedora')) return 'Colhedora';
    if (t.includes('trator')) return 'Trator';
    if (t.includes('transbordo')) return 'Transbordo';
    if (t.includes('caminhao') || t.includes('truck')) return 'Caminhão';
    if (t.includes('onibus')) return 'Ônibus';
    if (t.includes('utilitario') || t.includes('van')) return 'Utilitário';
    if (t.includes('plantadeira') || t.includes('semeadora')) return 'Plantadeira';
    if (t.includes('pulverizador')) return 'Pulverizador';
    if (t.includes('carreta') || t.includes('bitrem')) return 'Carreta';
    return 'Veículo';
  }

  /* "925 - Troca de Turno - HR" => true */
  function emTrocaDeTurno(desc, cd) {
    const s = norm(desc);
    return /troca.?de.?turno/.test(s) || String(cd || '') === '925';
  }

  function minutosTxt(n) {
    const m = Math.max(0, Math.round(n));
    return m + (m === 1 ? ' minuto' : ' minutos');
  }

  /* ------------------------------------------------------------------ */
  /* chamadas de API                                                    */
  /* ------------------------------------------------------------------ */

  function cabecalhos() {
    return {
      accept: 'application/json',
      locale: '1', // obrigatório no /alarmeOnline: sem ele o servidor responde 500
      'X-Auth-Token': ctx.token || '',
    };
  }

  async function chamar(caminho) {
    if (!ctx.api) throw new Error('sem sessão com o portal');
    const url = ctx.api.replace(/\/$/, '') + caminho;
    let res;
    try {
      res = await fetch(url, { method: 'GET', headers: cabecalhos(), cache: 'no-store' });
    } catch (e) {
      if (ctx.proxy) return chamarProxy(caminho); // rede/CORS contra a API: vai pelo servidor
      throw e;
    }
    if (res.status === 401) {
      await renovarToken();
      const deNovo = await fetch(url, { method: 'GET', headers: cabecalhos(), cache: 'no-store' });
      if (!deNovo.ok) throw new Error('HTTP ' + deNovo.status);
      return deNovo.json();
    }
    if (res.status === 429) {
      estado.backoff = 90_000;
      throw new Error('limite de requisições do portal (10/min) atingido — reduzindo o ritmo');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function chamarProxy(caminho, tentarRenovar = true) {
    const res = await fetch('/.netlify/functions/session?acao=dados&rota=' + encodeURIComponent(caminho), {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && tentarRenovar) {
      await renovarToken();
      return chamarProxy(caminho, false);
    }
    if (!res.ok) throw new Error('proxy HTTP ' + res.status);
    if (json && json.erro) throw new Error(json.erro);
    return json.dados;
  }

  async function renovarToken() {
    if (typeof ctx.renovar !== 'function') throw new Error('renovação da sessão SGPA indisponível');
    if (!renovacaoPendente) {
      renovacaoPendente = Promise.resolve()
        .then(() => ctx.renovar())
        .then((nova) => {
          if (!nova || !nova.props || !nova.props.token) throw new Error('o portal não forneceu uma nova sessão');
          const mudou = atualizarSessao(nova);
          if (!mudou && cfg.usarStream) abrirStream();
          estado.sessao = 'ativa';
          return nova;
        })
        .catch((e) => {
          estado.sessao = 'expirada';
          estado.proximoErro = 'sessão SGPA: ' + ((e && e.message) || 'não foi possível renovar');
          renderCabecalho();
          throw e;
        })
        .finally(() => { renovacaoPendente = null; });
    }
    return renovacaoPendente;
  }

  const rotaTelemetria = () => `/estatistica/monitoramento?buId=${encodeURIComponent(ctx.buId)}&language=pt-br`;
  const rotaAlarmes = () => `/alarmeOnline?ativo=true&idioma=pt-br&buId=${encodeURIComponent(ctx.buId)}&language=pt-br`;
  const rotaTempos = () => `/alarmeTempoEquipamento?buId=${encodeURIComponent(ctx.buId)}&language=pt-br`;

  /* ------------------------------------------------------------------ */
  /* 1) stream ao vivo (subscribe-live) dentro de um Web Worker         */
  /* ------------------------------------------------------------------ */

  function abrirStream() {
    fecharStream();
    if (!cfg.ativo || !cfg.usarStream || typeof Worker === 'undefined' || !ctx.token) {
      estado.stream = !cfg.ativo || !cfg.usarStream ? 'desligado' : 'indisponível';
      renderCabecalho();
      return;
    }
    const corpo = {
      cdCliente: [Number(ctx.cdCliente) || 204],
      cdUnidade: [Number(ctx.buId) || 1],
    };
    const url = MONITORAMENTO_API + '/subscribe-live?buId=' + encodeURIComponent(ctx.buId) + '&language=pt-br';
    try {
      worker = new Worker('/alerts-stream.js');
    } catch {
      estado.stream = 'indisponível';
      return;
    }
    estado.stream = 'conectando';
    worker.onmessage = (ev) => {
      const m = (ev && ev.data) || {};
      if (m.type === 'quadros') {
        ultimoQuadro = agora();
        tentativasStream = 0;
        estado.stream = 'ao vivo';
        processarQuadros(m.itens);
      } else if (m.type === 'estado') {
        estado.stream = m.status;
        if (m.status === 'erro' || m.status === 'fechado') {
          const reconectar = () => {
            const espera = Math.min(60_000, 2000 * 2 ** tentativasStream);
            tentativasStream++;
            setTimeout(() => {
              if (cfg.usarStream && cfg.ativo) abrirStream();
            }, espera);
          };
          if (m.statusCode === 401) renovarToken().catch(reconectar);
          else if (m.statusCode === 403) {
            estado.sessao = 'sem autorização';
            estado.proximoErro = 'o SGPA recusou a autorização do stream (403)';
          } else reconectar();
        }
      } else if (m.type === 'aviso') {
        estado.proximoErro = m.mensagem || m.type;
      }
      renderCabecalho();
    };
    worker.onerror = () => {
      estado.stream = 'erro';
      renderCabecalho();
    };
    worker.postMessage({ type: 'abrir', url, token: ctx.token, corpo });
  }

  function fecharStream() {
    if (worker) {
      try {
        worker.postMessage({ type: 'fechar' });
        worker.terminate();
      } catch {
        /* nada a limpar */
      }
    }
    worker = null;
  }

  function processarQuadros(itens) {
    if (!cfg.ativo) return;
    const lista = Array.isArray(itens) ? itens : [];
    for (const q of lista) {
      if (!q || !q.cdEquipamento) continue;
      if (q.type === 'alarme') {
        quadroAlarme(q);
        continue;
      }
      const id = String(q.cdEquipamento);
      const frenteAtual = q.descFrente || (frota.get(id) || {}).frente || '';
      if (!frenteSelecionada(frenteAtual)) {
        atualizarFrenteAtivos(id, frenteAtual);
        frota.delete(id);
        reconciliarEscopo();
        continue;
      }
      const e = mesclar(id);
      e.frente = q.descFrente || e.frente;
      if (q.descOperacao !== undefined || (q.cdOperacao !== undefined && q.cdOperacao !== null)) {
        const temDescricaoOperacao = q.descOperacao != null && String(q.descOperacao).trim() !== '';
        const novaOperacao = temDescricaoOperacao ? String(q.descOperacao) : '';
        if (norm(novaOperacao) !== norm(e.operacao)) {
          e.operacaoTs = agora(); // acabou de entrar nesta operação
        }
        e.operacao = novaOperacao;
        e.cdOperacao = String(q.cdOperacao || '');
        e.operacaoConfirmada = temDescricaoOperacao;
      }
      if (q.descOperador) {
        if (norm(q.descOperador) !== norm(e.operadorBruto)) e.operadorTs = agora();
        e.operadorBruto = q.descOperador;
        e.operador = nomeOperador(q.descOperador);
        e.cdOperador = String(q.cdOperador || '');
      }
      if (q.cdEstado !== undefined) e.cdEstado = String(q.cdEstado);
      if (q.fgTpAlerta !== undefined) e.fgTpAlerta = String(q.fgTpAlerta);
      if (q.vlDirecao !== undefined) e.direcao = num(q.vlDirecao);
      if (q.horimetro !== undefined) e.horimetro = q.horimetro;
      if (q.descFrente) e.frente = q.descFrente;
      e.ativo = String(q.fgMonitoramentoAtivo || e.ativo || 'T');
      if (q.deleted === true) {
        frota.delete(e.id);
        continue;
      }
      const ts = dataHorario(q.dtHrLocal);
      if (ts) e.tsEquipamento = ts;
      e.vistoEm = agora();
      if (!e.fonte) e.fonte = 'stream';
      if (q.descTpEquipamento) e.tipo = q.descTpEquipamento;
      if (q.descOperacao !== undefined && dentroDoEscopo(e)) {
        regraAguardandoCaminhao(e, agora());
        regraSemApontamento(e, agora());
        regraParada(e, agora());
        regraRefeicao(e, agora());
      }
    }
    estado.quadros += lista.length;
  }

  /* quadro de alarme do stream: é o que desenha o halo pulsante no mapa */
  function quadroAlarme(q) {
    if (!cfg.ativo || !cfg.espelharServidor) return;
    const codigo = String(q.cdTpAlarme || 'desconhecido');
    if (alarmeFechado(q.fgOnline)) {
      fecharOficial(String(q.cdEquipamento), codigo);
      return;
    }
    const e = mesclar(String(q.cdEquipamento));
    e.alarmeOficial = q.descAlarme || e.alarmeOficial;
    e.alarmeOnline = true;
    emitirAlarmeOficial({
      cdEquipamento: q.cdEquipamento,
      cdId: q.cdId,
      descEquipamento: q.descEquipamento,
      descTpAlarme: q.descAlarme || q.descTpAlarme,
      cdTpAlarme: q.cdTpAlarme,
      nomeOperador: q.descOperador || e.operadorBruto,
      descOperacao: q.descOperacao || e.operacao,
      descGrupoEquipamento: q.descFrente || e.frente,
      // vlPeso é peso, não velocidade. Sem medição explícita, não inventar km/h.
      vlAlarme: q.vlAlarme,
      vlAlarmeMaximoAtingido: q.vlAlarmeMaximoAtingido,
      dtHrLocal: dataHorario(q.dtHrLocal),
    }, policy.categoria(q.cdTpAlarme, q.descAlarme || q.descTpAlarme), 'mapa');
  }

  function alarmeFechado(flag) {
    return flag === false || flag === 0 || /^(false|f|0)$/i.test(String(flag));
  }

  function fecharOficial(id, codigo) {
    const chave = id + '|sgpa:' + codigo;
    const st = estados.get(chave);
    if (st && st.ocorrencia) {
      st.ocorrenciasEncerradas = [...new Set([...(st.ocorrenciasEncerradas || []), st.ocorrencia])].slice(-20);
    }
    if (st) Object.assign(st, { firing: false, consec: 0, emitido: false, negados: 0 });
    ativos.delete(chave);
  }

  /* ------------------------------------------------------------------ */
  /* consolidação da frota                                              */
  /* ------------------------------------------------------------------ */

  function mesclar(id) {
    let e = frota.get(id);
    if (!e) {
      const p = partirEquipamento('', id);
      e = {
        id,
        numero: p.numero,
        nome: '',
        tipo: '',
        frente: '',
        operacao: '',
        cdOperacao: '',
        operacaoConfirmada: false,
        operador: '',
        operadorBruto: '',
        estadoTxt: '',
        velocidade: null,
        velocidadeTs: 0,
        rpm: null,
        motor: null,
        atraso: null,
        ativo: 'T',
        tsEquipamento: 0,
        operacaoTs: agora(),
        operadorTs: agora(),
        vistoEm: agora(),
        fonte: '',
      };
      frota.set(id, e);
    }
    return e;
  }

  /* 2) telemetria: é daqui que vêm velocidade e RPM */
  function aplicarTelemetria(linhas) {
    const lista = Array.isArray(linhas) ? linhas : [];
    const vistos = new Set();
    const frentes = new Set(estado.frentes);
    for (const row of lista) {
      const id = String(row.cdEquipamento || '');
      if (!id) continue;
      vistos.add(id);
      if (row.descGrupoEquipamento) frentes.add(row.descGrupoEquipamento);
      const frenteAtual = row.descGrupoEquipamento || (frota.get(id) || {}).frente || '';
      if (!frenteSelecionada(frenteAtual)) {
        atualizarFrenteAtivos(id, frenteAtual);
        frota.delete(id);
        reconciliarEscopo();
        continue;
      }
      const e = mesclar(id);
      const p = partirEquipamento(row.descEquipamento, id);
      e.nome = p.nome || e.nome;
      e.numero = p.numero;
      e.tipo = row.descTpEquipamento || e.tipo;
      e.tipoCompleto = row.descFullTpEquipamento || e.tipoCompleto;
      e.frente = row.descGrupoEquipamento || e.frente;
      const temDescricaoOperacao = row.descOperacao != null && String(row.descOperacao).trim() !== '';
      const novaOperacao = temDescricaoOperacao ? String(row.descOperacao) : '';
      if (norm(novaOperacao) !== norm(e.operacao)) {
        e.operacaoTs = agora();
      }
      e.operacao = novaOperacao;
      e.cdOperacao = String(row.cdOperacao || '');
      e.operacaoConfirmada = temDescricaoOperacao;
      e.estadoTxt = row.descEstado || e.estadoTxt;
      e.grupoOperacao = row.descGrupoOperacao || e.grupoOperacao;
      if (norm(row.descFuncionario) !== norm(e.operadorBruto)) {
        e.operadorTs = agora();
        e.operadorBruto = String(row.descFuncionario || '');
        e.operador = nomeOperador(row.descFuncionario);
      }
      e.velocidade = valorMedido(row.vlVelocidade);
      e.velocidadeTs = e.velocidade === null ? 0 : (dataArray(row.dtHrLocal) || agora());
      e.rpm = num(row.vlParametro4);
      e.motor = String(row.vlEd1 || '0') === '1';
      e.atraso = segundosAtraso(row.vlTempoSemComunicacao);
      e.ativo = row.fgMonitoramentoAtivo || e.ativo;
      e.local = [row.cdFazenda, row.cdZona, row.cdTalhao]
        .map((v) => (v && String(v) !== '0' ? String(v) : ''))
        .filter(Boolean)
        .join(' / ');
      const ts = dataArray(row.dtHrLocal);
      if (ts) e.tsEquipamento = ts;
      e.fonte = 'telemetria';
      e.vistoEm = agora();
    }
    estado.frentes = [...frentes].sort();
    // largura de banda/limite de requisições: só guarda o que a unidade tem hoje
    const corte = agora() - 30 * 60000;
    for (const [id, e] of frota) if (e.vistoEm < corte && !ativos.has(id + '|velocidade')) frota.delete(id);
  }

  function frenteSelecionada(frente) {
    if (!cfg.frentes || !cfg.frentes.length) return true;
    return !!frente && cfg.frentes.some((f) => norm(f) === norm(frente));
  }

  function atualizarFrenteAtivos(id, frente) {
    if (!frente) return;
    const equipamento = String(id);
    const e = frota.get(equipamento);
    if (e) e.frente = frente;
    for (const alerta of ativos.values()) {
      if (alerta.e && String(alerta.e.id) === equipamento) alerta.e.frente = frente;
    }
  }

  function dentroDoEscopo(e) {
    if (String(e.ativo || 'T') === 'F') return false;
    if (e.atraso !== null && e.atraso !== undefined && e.atraso > cfg.maxAtrasoMin * 60) return false;
    if (cfg.seguirSelecaoMapa && ctx.selecao && ctx.selecao.size) {
      if (!ctx.selecao.has(String(e.id)) && !ctx.selecao.has(String(e.numero))) return false;
    }
    if (!frenteSelecionada(e.frente)) return false;
    const lista = (cfg.equipamentos || '')
      .split(/[^0-9A-Za-z]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lista.length) {
      const alvo = ' ' + String(e.numero) + ' ' + String(e.id) + ' ';
      if (!lista.some((f) => alvo.includes(' ' + String(f) + ' '))) return false;
    }
    return true;
  }

  function reconciliarEscopo() {
    for (const [chave, alerta] of ativos) {
      if (dentroDoEscopo(alerta.e)) continue;
      ativos.delete(chave);
      if (alerta.fonte === 'portal') {
        const st = estados.get(chave);
        if (st) st.foraDoEscopo = true;
      }
    }
    for (const [chave, st] of estados) {
      if (String(st.regra).startsWith('sgpa:')) continue;
      const e = frota.get(String(st.id));
      if (e && dentroDoEscopo(e)) continue;
      Object.assign(st, { firing: false, consec: 0, negados: 0, emitido: false, since: 0, ultimo: 0 });
      ativos.delete(chave);
    }
  }

  /* ------------------------------------------------------------------ */
  /* ciclo de coleta                                                    */
  /* ------------------------------------------------------------------ */

  function agendar() {
    const espera = Math.max(5000, cfg.intervaloSeg * 1000 + estado.backoff);
    proximo = agora() + espera;
    timer = setTimeout(ciclo, espera);
  }

  let nCiclo = 0;

  async function ciclo() {
    nCiclo++;
    clearTimeout(timer);
    timer = null;
    if (!cfg.ativo) {
      estado.ligado = false;
      renderCabecalho();
      timer = setTimeout(ciclo, 5000);
      return;
    }
    if (correndo) {
      timer = setTimeout(ciclo, 10_000);
      return;
    }
    correndo = true;
    estado.ligado = true;
    const ts = agora();
    let pegou = false;
    try {
      // Telemetria e espelho independentes: falha de uma fonte não bloqueia a outra.
      const resultados = await Promise.allSettled([
        chamar(rotaTelemetria()),
        cfg.espelharServidor ? chamar(rotaAlarmes()) : Promise.resolve(null),
      ]);
      if (!cfg.ativo) return;
      let telemetriaNova = false;
      if (resultados[0].status === 'fulfilled' && Array.isArray(resultados[0].value)) {
        aplicarTelemetria(resultados[0].value);
        telemetriaNova = true;
        pegou = true;
      }
      if (cfg.espelharServidor && resultados[1].status === 'fulfilled' && Array.isArray(resultados[1].value)) {
        espelharAlarmes(resultados[1].value);
        pegou = true;
      }
      if (!pegou) throw new Error('sem resposta das fontes SGPA');
      if (cfg.espelharServidor && nCiclo % 3 === 2) {
        const d = await chamar(rotaTempos()).catch(() => null);
        if (cfg.ativo && Array.isArray(d)) aplicarTempos(d);
      }
      estado.erros = 0;
      estado.backoff = 0;
      estado.ultimoCiclo = ts;
      estado.fonte = telemetriaNova ? 'telemetria + SGPA oficial' : 'SGPA oficial';
      avaliarFrota(ts, telemetriaNova ? 'lotes' : 'tempo');
      purarResolvidos(ts);
    } catch (e) {
      estado.erros++;
      estado.proximoErro = (e && e.message) || 'falha ao ler o portal';
      estado.backoff = Math.min(5 * 60_000, estado.backoff || 20_000);
    } finally {
      correndo = false;
      renderAtivos();
      renderCabecalho();
      agendar();
    }
  }

  /* relógio fino: avalia troca de turno/ociosidade entre duas leituras */
  function tique() {
    if (!cfg.ativo || !frota.size) return;
    try {
      avaliarFrota(agora(), 'tempo');
      renderCabecalho();
    } catch {
      /* o tique nunca derruba a interface */
    }
  }

  /* ------------------------------------------------------------------ */
  /* máquina de estados + histerese                                     */
  /* ------------------------------------------------------------------ */

  function marcar(id, regra, liga, ts, valor) {
    const chave = id + '|' + regra;
    let st = estados.get(chave);
    if (!st) {
      st = { chave, id, regra, firing: false, since: 0, consec: 0, negados: 0, ultimo: 0, emitido: false, valor: null, nascido: ts };
      estados.set(chave, st);
    }
    if (liga) {
      st.negados = 0;
      if (!st.firing) {
        st.firing = true;
        st.since = ts;
        st.consec = 1;
        st.emitido = false;
      } else {
        st.consec++;
      }
      if (valor !== undefined && valor !== null) st.valor = valor;
    } else if (st.firing) {
      st.negados++;
      if (st.negados >= 2) {
        st.firing = false;
        st.consec = 0;
        st.since = 0;
        st.negados = 0;
        st.emitido = false;
      }
    }
    return st;
  }

  /* dispara na primeira confirmação e depois a cada cooldown enquanto durar */
  function podeDisparar(st, ts) {
    if (!st.firing || st.consec < Math.max(1, cfg.amostras)) return false;
    if (!st.emitido) {
      st.emitido = true;
      st.ultimo = ts;
      return true;
    }
    const cd = Math.max(0, Number(cfg.cooldownMin) || 0) * 60000;
    if (cd && ts - st.ultimo >= cd) {
      st.ultimo = ts;
      return true;
    }
    return false;
  }

  function inicioReal(st, e) {
    // se o servidor já mede a duração do alarme, usamos o relógio dele
    if (st.duracaoServidor) return agora() - st.duracaoServidor * 1000;
    if (e && e.operacaoTs && e.operacaoTs < st.since) return e.operacaoTs;
    return st.since;
  }

  function aplicarTempos(itens) {
    if (!cfg.ativo || !cfg.espelharServidor) return;
    for (const t of itens || []) {
      const chave = String(t.cdEquipamento || '') + '|sgpa:' + String(t.cdTpAlarme || 'desconhecido');
      const st = estados.get(chave);
      if (!st) continue; // duração não é uma ocorrência de alarme
      const m = String(t.tempo || '').match(/(\d{1,3}):(\d{2}):(\d{2})/);
      if (m) st.duracaoServidor = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
  }

  /* Regras locais opcionais e rastreio operacional; velocidade é só SGPA. */

  function avaliarFrota(ts, modo) {
    const lotes = modo !== 'tempo';
    let cont = 0;
    for (const e of frota.values()) {
      if (!dentroDoEscopo(e)) continue;
      cont++;
      if (lotes) {
        regraRpm(e, ts);
        regraAguardandoCaminhao(e, ts);
      }
      regraSemApontamento(e, ts);
      regraParada(e, ts);
      regraRefeicao(e, ts);
      regraTurno(e, ts);
      regraOcioso(e, ts);
    }
    regrasFrente(ts);
    estado.monitorados = cont;
  }

  function regraAguardandoCaminhao(e, ts) {
    const liga = policy.aguardandoCaminhao(e);
    const st = marcar(e.id, 'aguardandoCaminhao', liga, ts, null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!liga) return;
    // Alarme imediato: a primeira leitura com 905 já dispara (ignora “leituras p/ confirmar”).
    if (!st.emitido) { st.emitido = true; st.ultimo = ts; }
    else {
      const cd = Math.max(0, Number(cfg.cooldownMin) || 0) * 60000;
      if (!cd || ts - st.ultimo < cd) return;
      st.ultimo = ts;
    }
    emitir({
      chave: st.chave,
      regra: 'aguardandoCaminhao',
      e,
      texto: `aguardando caminhão · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Rastreio operacional SGPA · ${e.tipo || 'trator/transbordo'} · operação ${e.operacao || '—'}`,
      inicio: st.since,
    });
  }

  /* Operação SGPA “Sem Apontamento” sem alarme oficial: alerta após a tolerância. */
  function regraSemApontamento(e, ts) {
    const liga = e.operacaoConfirmada === true && policy.semApontamento(e);
    const st = marcar(e.id, 'semApontamento', liga, ts, null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!st.firing) return;
    const min = Math.max(1, num(cfg.minutosSemApontamento) || 5);
    const durou = (ts - inicioReal(st, e)) / 60000;
    if (durou < min) return;
    // motor ocioso + sem apontamento já tem alerta combinado próprio: evita fala dupla
    const combinado = estados.get(String(e.id) + '|ociosoSemApontamento');
    if (combinado && combinado.firing && combinado.emitido) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'semApontamento',
      e,
      valor: Math.round(durou),
      limite: Math.round(min),
      texto: `sem apontamento há ${minutosTxt(durou)} · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Operação SGPA ${e.operacao || '—'} · ${e.tipo || 'equipamento'} · tolerância ${minutosTxt(min)}`,
      inicio: inicioReal(st, e),
    });
  }
  /* Paradas improdutivas de maior impacto: alerta após a tolerância de cada uma. */
  function regraParada(e, ts) {
    const p = e.operacaoConfirmada === true ? policy.paradaImprodutiva(e) : null;
    const lim = p ? policy.limiteParada(cfg, p) : 0;
    const anterior = paradaAtual.get(e.id);
    if (anterior && (!p || anterior !== p.id)) {
      const velho = marcar(e.id, 'parada:' + anterior, false, ts, null);
      ativos.delete(velho.chave);
      paradaAtual.delete(e.id);
    }
    if (!p || lim <= 0) return;
    paradaAtual.set(e.id, p.id);
    const st = marcar(e.id, 'parada:' + p.id, true, ts, null);
    if (!st.firing) return;
    const durou = (ts - inicioReal(st, e)) / 60000;
    if (durou < lim) return;
    const e1 = Math.max(0, num(cfg.escalarUrgenteMin) || 0);
    const e2 = Math.max(0, num(cfg.escalarLiderMin) || 0);
    const nivel = e2 && durou >= lim + e2 ? 3 : e1 && durou >= lim + e1 ? 2 : 1;
    const subiu = st.emitido && nivel > (st.nivel || 1);
    if (subiu) { st.ultimo = ts; } else if (!podeDisparar(st, ts)) return;
    st.nivel = Math.max(st.nivel || 1, nivel);
    emitir({
      chave: st.chave,
      regra: 'paradaImprodutiva',
      nivel,
      lider: policy.liderFrente(cfg, e.frente),
      paradaId: p.id,
      paradaNome: p.nome,
      e,
      valor: Math.round(durou),
      limite: Math.round(lim),
      texto: `${nivel >= 3 ? '[ESCALAR LÍDER] ' : nivel === 2 ? '[URGENTE] ' : ''}${p.nome} há ${minutosTxt(durou)} · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Operação SGPA ${e.operacao || '—'} · ${e.tipo || 'equipamento'} · tolerância ${minutosTxt(lim)}`,
      inicio: inicioReal(st, e),
    });
  }
  const paradaAtual = new Map();
  /* Alertas de gestão por frente: problema da frente, não do operador. */
  function regrasFrente(ts) {
    const porFrente = new Map();
    for (const e of frota.values()) {
      if (!dentroDoEscopo(e) || !e.frente) continue;
      let f = porFrente.get(e.frente);
      if (!f) { f = { fila: [], colh: 0, colhParadas: 0, transbAg: [] }; porFrente.set(e.frente, f); }
      const p = e.operacaoConfirmada === true ? policy.paradaImprodutiva(e) : null;
      if (p && (p.id === 'filaUnica' || p.id === 'aguardandoCarregamento')) f.fila.push(e.numero || e.id);
      if (p && (p.id === 'agColhedoraParadaRapida' || p.id === 'aguardandoColhedoraAlocada')) f.transbAg.push(e.numero || e.id);
      const tipo = policy.norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' '));
      if (/colhed/.test(tipo)) {
        f.colh++;
        const op = policy.norm(e.operacao || '');
        if (e.operacaoConfirmada === true && op && !/colheita/.test(op)) f.colhParadas++;
      }
    }
    const checar = (frente, id, liga, minMin, texto, detalhe, valor) => {
      const pe = { id: 'frente:' + frente, numero: frente, nome: 'Frente ' + frente, tipo: 'Frente', frente };
      const st = marcar(pe.id, 'gestao:' + id, liga, ts, null);
      if (!liga && !st.firing) ativos.delete(st.chave);
      if (!st.firing) return;
      if ((ts - st.since) / 60000 < minMin) return;
      if (!podeDisparar(st, ts)) return;
      emitir({ chave: st.chave, regra: 'gestaoFrente', e: pe, valor, lider: policy.liderFrente(cfg, frente),
        texto: texto + ' · frente/grupo: ' + frente, detalhe, inicio: st.since });
    };
    const filaMax = Math.max(0, num(cfg.filaMaxFrente) || 0);
    const semColh = Math.max(0, num(cfg.minutosFrenteSemColhedora) || 0);
    const tbMax = Math.max(0, num(cfg.transbordosAguardandoMax) || 0);
    for (const [frente, f] of porFrente) {
      checar(frente, 'fila', filaMax > 0 && f.fila.length >= filaMax, 0,
        `${f.fila.length} equipamentos em fila aguardando carregamento, segurar o despacho de caminhões`,
        'Fila/aguardando carregamento: ' + f.fila.join(', '), f.fila.length);
      checar(frente, 'semColhedora', semColh > 0 && f.colh > 0 && f.colhParadas === f.colh, semColh,
        `todas as ${f.colh} colhedoras paradas, frente sem colheita`,
        'Nenhuma colhedora em operação de colheita', f.colh);
      checar(frente, 'desequilibrio', tbMax > 0 && f.transbAg.length >= tbMax, 0,
        `${f.transbAg.length} transbordos aguardando colhedora, remanejar a frota`,
        'Transbordos aguardando colhedora: ' + f.transbAg.join(', '), f.transbAg.length);
    }
  }
  /* Controle de refeições: limite por grupo ou equipamento; alarma ao exceder. */
  function regraRefeicao(e, ts) {
    const limite = policy.limiteRefeicao(cfg, e);
    const liga = limite > 0 && e.operacaoConfirmada === true && policy.emRefeicao(e);
    const st = marcar(e.id, 'refeicao', liga, ts, null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!st.firing || limite <= 0) return;
    const durou = (ts - inicioReal(st, e)) / 60000;
    if (durou <= limite) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'refeicao',
      e,
      valor: Math.round(durou),
      limite: Math.round(limite),
      texto: `excedeu a refeição: ${minutosTxt(durou)} (limite ${minutosTxt(limite)}) · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Operação SGPA ${e.operacao || '—'} · ${e.tipo || 'equipamento'} · limite ${minutosTxt(limite)}`,
      inicio: inicioReal(st, e),
    });
  }
  function regraRpm(e, ts) {
    if (!cfg.calcularLocal || e.rpm === null) return;
    const limite = num(cfg.limiteRpm);
    if (limite <= 0) return;
    const st = marcar(e.id, 'rpm', e.rpm >= limite, ts, e.rpm);
    if (!podeDisparar(st, ts)) return;
    const v = Math.round(e.rpm);
    emitir({
      chave: st.chave,
      regra: 'rpm',
      e,
      valor: v,
      limite: Math.round(limite),
      texto: `RPM do motor no máximo: ${milhar(v)} RPM, limite ${milhar(limite)} RPM`,
      detalhe: `${e.nome} · ${e.frente || 'sem frente'} · operação ${e.operacao || '—'} · velocidade ${Math.round(e.velocidade || 0)} km/h`,
      inicio: st.since,
    });
  }

  function regraTurno(e, ts) {
    if (!cfg.calcularLocal) return;
    const liga = emTrocaDeTurno(e.operacao, e.cdOperacao);
    const st = marcar(e.id, 'turno', liga, ts, null);
    if (!st.firing) return;
    const min = Math.max(1, num(cfg.minutosTurno) || 4);
    const durou = (ts - inicioReal(st, e)) / 60000;
    if (durou < min) return;
    if (!podeDisparar(st, ts)) return;
    const semOp = semOperador(e.operadorBruto);
    emitir({
      chave: st.chave,
      regra: 'turno',
      e,
      valor: Math.round(durou),
      limite: Math.round(min),
      texto:
        `preso em troca de turno há ${minutosTxt(durou)}` +
        (semOp ? ', sem operador definido — alguém esqueceu de dar a baixa' : ''),
      detalhe: `${e.nome} · ${e.frente || 'sem frente'} · operação ${e.operacao || '—'} · limiar ${minutosTxt(min)}`,
      inicio: inicioReal(st, e),
    });
  }

  function regraOcioso(e, ts) {
    if (!cfg.calcularLocal) return;
    const rpmMax = num(cfg.rpmOcioso);
    const parado = (e.velocidade === null ? 0 : e.velocidade) <= 1;
    const ligado = e.rpm > 0 && (e.motor === null ? true : e.motor);
    const liga = ligado && parado && (rpmMax === 0 || e.rpm <= rpmMax);
    const semPonto = liga && e.operacaoConfirmada === true && policy.semApontamento(e);
    const regra = semPonto ? 'ociosoSemApontamento' : 'ocioso';
    const outraRegra = semPonto ? 'ocioso' : 'ociosoSemApontamento';
    const chaveOutra = String(e.id) + '|' + outraRegra;
    const stOutra = estados.get(chaveOutra);
    if (stOutra) {
      Object.assign(stOutra, { firing: false, consec: 0, negados: 0, emitido: false, since: 0, ultimo: 0 });
      ativos.delete(chaveOutra);
    }
    const st = marcar(e.id, regra, liga, ts, e.rpm);
    if (!st.firing) return;
    const min = Math.max(1, num(cfg.minutosOcioso) || 5);
    const durou = (ts - inicioReal(st, e)) / 60000;
    if (durou < min) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra,
      e,
      valor: Math.round(durou),
      limite: Math.round(min),
      texto: semPonto
        ? `com motor ocioso e sem apontamento há ${minutosTxt(durou)} (${milhar(e.rpm || 0)} RPM parado)`
        : `com motor ocioso há ${minutosTxt(durou)} (${milhar(e.rpm || 0)} RPM parado)`,
      detalhe: `${e.nome} · ${e.frente || 'sem frente'} · operação ${e.operacao || '—'} · limiar ${minutosTxt(min)}`,
      inicio: inicioReal(st, e),
    });
  }

  function purarResolvidos(ts) {
    for (const [chave, st] of estados) {
      if (st.firing) continue;
      if (ativos.has(chave) && ts - (st.ultimo || 0) > 10 * 60000) ativos.delete(chave);
      if (!st.ultimo && ts - (st.nascido || ts) > 30 * 60000) estados.delete(chave);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3) espelho dos alarmes oficiais do portal                          */
  /* ------------------------------------------------------------------ */

  function espelharAlarmes(itens) {
    if (!cfg.ativo || !cfg.espelharServidor) return;
    const vistos = new Set();
    for (const a of itens || []) {
      const id = String(a.cdEquipamento || '');
      const codigo = String(a.cdTpAlarme || 'desconhecido');
      if (!id) continue;
      if (alarmeFechado(a.fgOnline)) { fecharOficial(id, codigo); continue; }
      vistos.add(id + '|sgpa:' + codigo);
      emitirAlarmeOficial(a, policy.categoria(a.cdTpAlarme, a.descTpAlarme || a.descAlarme), 'portal');
    }
    // Só um snapshot oficial completo pode fechar tipos oficiais ausentes.
    for (const [chave, st] of estados) {
      if (!chave.includes('|sgpa:') || vistos.has(chave)) continue;
      marcar(st.id, st.regra, false, agora(), null);
      if (!st.firing) fecharOficial(st.id, st.regra.replace(/^sgpa:/, ''));
    }
  }

  function solicitarMedicaoVelocidade(a, via) {
    const id = String(a.cdEquipamento || '');
    const codigo = String(a.cdTpAlarme || 'desconhecido');
    const ocorrencia = String(a.cdId || '');
    const pendencia = `${id}|${codigo}|${ocorrencia}`;
    alarmesVelocidadePendentes.set(pendencia, { alarme: Object.assign({}, a), via });
    if (atualizacaoVelocidade) return;

    atualizacaoVelocidade = (async () => {
      try {
        const linhas = await chamar(rotaTelemetria());
        if (Array.isArray(linhas)) aplicarTelemetria(linhas);
      } catch {
        // Sem leitura atual, o aviso final deixa claro que o SGPA não forneceu a medida.
      }
      while (alarmesVelocidadePendentes.size) {
        const lote = [...alarmesVelocidadePendentes.values()];
        alarmesVelocidadePendentes.clear();
        for (const item of lote) {
          const alarm = item.alarme;
          const chave = `${String(alarm.cdEquipamento || '')}|sgpa:${String(alarm.cdTpAlarme || 'desconhecido')}`;
          const st = estados.get(chave);
          if (!cfg.ativo || !cfg.espelharServidor || !st || !st.firing) continue;
          if (alarm.cdId && st.ocorrencia && String(alarm.cdId) !== st.ocorrencia) continue;
          emitirAlarmeOficial(Object.assign({}, alarm, { __medicaoTentada: true }), 'velocidade', item.via);
        }
      }
    })().finally(() => {
      atualizacaoVelocidade = null;
      if (alarmesVelocidadePendentes.size) {
        const proxima = alarmesVelocidadePendentes.values().next().value;
        solicitarMedicaoVelocidade(proxima.alarme, proxima.via);
      }
    });
  }

  function emitirAlarmeOficial(a, regra, via) {
    if (!cfg.ativo || !cfg.espelharServidor) return;
    const id = String(a.cdEquipamento || '');
    if (!id) return;
    const e = mesclar(id);
    if (a.descEquipamento) {
      const p = partirEquipamento(a.descEquipamento, id);
      e.nome = p.nome;
      e.numero = p.numero;
    }
    if (a.nomeOperador) {
      e.operadorBruto = String(a.nomeOperador);
      e.operador = nomeOperador(a.nomeOperador);
    }
    if (a.descGrupoEquipamento) e.frente = a.descGrupoEquipamento;
    if (a.descOperacao) e.operacao = String(a.descOperacao);
    const codigo = String(a.cdTpAlarme || 'desconhecido');
    const nomeAlarme = a.descTpAlarme || a.descAlarme || nomeTipo(codigo);
    registrarTipo(codigo, nomeAlarme);
    const chave = id + '|sgpa:' + codigo;
    const st = marcar(id, 'sgpa:' + codigo, true, agora(), null);
    // Diferentes tipos são independentes. Stream e REST da mesma ocorrência se unem.
    if (a.cdId && st.ocorrencia && String(a.cdId) !== st.ocorrencia) {
      st.emitido = false;
      st.foraDoEscopo = false;
      st.since = agora();
      ativos.delete(chave);
      delete acks[chave];
    }
    if (a.cdId) st.ocorrencia = String(a.cdId);
    st.consec = Math.max(st.consec, Math.max(1, cfg.amostras)); // SGPA já confirmou o alarme
    const estavaForaDoEscopo = !!st.foraDoEscopo;
    if (!dentroDoEscopo(e)) {
      st.foraDoEscopo = true;
      return;
    }
    st.foraDoEscopo = false;
    const replay = estavaForaDoEscopo || (st.ocorrencia && (st.ocorrenciasEncerradas || []).includes(st.ocorrencia));
    const medidaOficial = valorMedido(a.vlAlarme) ?? valorMedido(a.vlAlarmeMaximoAtingido);
    let valor = medidaOficial;
    let fonteVelocidade = regra === 'velocidade' && medidaOficial !== null ? 'alarme oficial SGPA' : '';
    let medicaoPendente = false;
    if (regra === 'velocidade' && valor === null) {
      const idade = agora() - (Number(e.velocidadeTs) || 0);
      if (e.velocidadeTs && idade >= -5000 && idade <= Math.max(90_000, cfg.intervaloSeg * 2000)) {
        valor = valorMedido(e.velocidade);
        if (valor !== null) fonteVelocidade = 'telemetria SGPA';
      }
      if (valor === null && !a.__medicaoTentada) {
        solicitarMedicaoVelocidade(a, via);
        medicaoPendente = true;
      }
    }
    let texto;
    if (regra === 'velocidade') {
      texto = valor !== null ? `excedeu a velocidade a ${Math.round(valor)} km/h` : 'velocidade excedida (alarme oficial do SGPA; medição não informada)';
    } else if (regra === 'rpm') {
      texto = valor !== null ? `RPM do motor: ${milhar(valor)} RPM (alarme oficial do portal)` : 'alarme de RPM do motor (alarme oficial do portal)';
    } else if (regra === 'turno') {
      texto = 'tempo excedido em troca de turno (alarme oficial do portal)';
    } else if (regra === 'ocioso') {
      texto = 'motor ocioso (alarme oficial do portal)';
    } else {
      texto = `${nomeAlarme || 'alarme não classificado'} (alarme oficial do portal)`;
    }
    const alerta = {
      chave, regra, e, valor, fonteVelocidade, tipoAlarme: codigo, nomeAlarme,
      texto,
      detalhe: `Alarme oficial · tipo ${codigo} ${nomeAlarme} · via ${via}` +
        (fonteVelocidade === 'telemetria SGPA' ? ' · velocidade complementada pela telemetria SGPA' : '') +
        ` · frente/grupo ${e.frente || 'não informado'} · operação ${e.operacao || '—'}`,
      inicio: dataArray(a.dtHrLocal) || (typeof a.dtHrLocal === 'number' ? a.dtHrLocal : st.since),
      medicaoPendente,
      servidor: true,
    };
    if (replay) {
      st.emitido = true;
      emitir(Object.assign(alerta, { replay: true }));
      return;
    }
    if (podeDisparar(st, agora())) emitir(alerta);
    else {
      // Melhor medição no REST atualiza a central sem segunda fala/histórico/INSERT.
      const anterior = ativos.get(chave);
      if (anterior) {
        const medida = valor !== null
          ? { valor, texto, fonteVelocidade, medicaoPendente: false }
          : regra === 'velocidade' ? { texto, medicaoPendente: false } : {};
        Object.assign(anterior, medida, { detalhe: alerta.detalhe, e, numero: e.numero, nomeAlarme });
        anterior.fala = montarFala(anterior);
        anterior.notificar = policy.notificar(cfg, anterior);
        const registro = hist.find((h) => h.chave === chave);
        if (registro && valor !== null) {
          Object.assign(registro, { valor, texto, fala: anterior.fala, detalhe: alerta.detalhe, fonteVelocidade });
          salvar(KEY_HIST, hist);
        }
        renderAtivos();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* emissão: pop-up, som, voz, histórico                               */
  /* ------------------------------------------------------------------ */

  function emitir(a) {
    if (!cfg.ativo && !a.simulado) return;
    const ts = agora();
    const regra = REGRAS[a.regra] || REGRAS.generico;
    const chave = a.chave || `${a.e.id}|${a.regra}`;
    const prev = ativos.get(chave);
    const jaReconhecido = acks[chave] && ts - acks[chave] < 2 * 3600_000;
    const classe = classeFala(a.e.nome, a.e.tipo, a.e.frente);

    const alerta = {
      chave,
      ts,
      inicio: a.inicio || ts,
      regra: a.regra,
      nome: a.nomeAlarme || regra.nome,
      tipoAlarme: a.tipoAlarme || null,
      nomeAlarme: a.nomeAlarme || '',
      cor: regra.cor,
      icone: regra.icone,
      severidade: regra.severidade,
      e: a.e,
      numero: a.e.numero || a.e.id,
      descricao: a.e.nome || a.e.id,
      tipo: a.e.tipo,
      classe,
      operador: a.e.operador,
      valor: a.valor,
      fonteVelocidade: a.fonteVelocidade || '',
      limite: a.limite == null ? null : a.limite,
      paradaId: a.paradaId || null,
      paradaNome: a.paradaNome || '',
      nivel: a.nivel || 1,
      lider: a.lider || '',
      texto: a.texto,
      detalhe: a.detalhe || '',
      fonte: a.servidor ? 'portal' : a.simulado ? 'teste' : 'app',
      contagem: (prev && prev.contagem ? prev.contagem : 0) + 1,
      repeticao: !!prev,
    };
    alerta.notificar = (alerta.fonte === 'portal' || localComCanais(alerta)) && policy.notificar(cfg, alerta);
    alerta.fala = montarFala(alerta);
    ativos.set(chave, alerta);
    if (a.replay) {
      renderAtivos();
      renderCabecalho();
      return;
    }

    if (!a.simulado) {
      hist.unshift({
        ts,
        chave,
        regra: alerta.regra,
        tipoAlarme: alerta.tipoAlarme,
        nomeAlarme: alerta.nomeAlarme,
        frente: alerta.e.frente || '',
        notificacaoSelecionada: alerta.notificar,
        equipamento: alerta.numero,
        descricao: alerta.descricao,
        operador: alerta.operador,
        valor: alerta.valor,
        fonteVelocidade: alerta.fonteVelocidade,
        texto: alerta.texto,
        detalhe: alerta.detalhe,
        fonte: alerta.fonte,
        fala: alerta.fala,
        unidade: ctx.unidade || '',
        usuario: ctx.usuario || '',
      });
      if (hist.length > MAX_HIST) hist.length = MAX_HIST;
      salvar(KEY_HIST, hist);
    }
    if (!a.simulado) registrarNoServidor(alerta);
    const vozLocalSemPontoConfirmado = alerta.fonte === 'app' &&
      alerta.regra === 'ociosoSemApontamento' &&
      alerta.e.operacaoConfirmada === true && policy.semApontamento(alerta.e);
    if (!alerta.notificar && !a.simulado && !vozLocalSemPontoConfirmado) {
      renderAtivos();
      renderCabecalho();
      return; // só central/histórico: não consome rajada nem entrega canais
    }

    const silenciado = ts < (Number(cfg.silencioAte) || 0) || jaReconhecido;
    const oficial = alerta.fonte === 'portal';
    const localAberto = localComCanais(alerta) && alerta.notificar;
    // Alarmes oficiais chegam pelo stream e não podem ser suprimidos pela proteção
    // de rajada destinada apenas aos cálculos locais e exemplos.
    let demais = false;
    if (!oficial) {
      if (ts - rajada.ts > 20000) rajada = { ts, voz: 0, aviso: false };
      demais = ++rajada.voz > Math.max(1, Number(cfg.maxPorCiclo) || 4);
    }
    if (cfg.popup && (oficial || localAberto || a.simulado)) mostrarToast(alerta, silenciado || demais);
    if (!silenciado && !demais) {
      if ((oficial || localAberto || a.simulado) && cfg.som) tocar(regra.severidade);
      if (cfg.voz && (oficial || localAberto || a.simulado || vozLocalSemPontoConfirmado) && (!alerta.repeticao || cfg.repetirVoz)) {
        falar(alerta.fala, { oficial });
        faladoEm.set(chave, ts);
      }
      if ((oficial || localAberto || a.simulado) && cfg.vibrar) vibrar(regra.severidade);
      if (oficial || localAberto) notificar(alerta);
    }
    if (demais && rajada.aviso !== true && ts - rajada.ts < 5000) {
      rajada.aviso = true;
      setTimeout(() => {
        mostrarAviso('Vários alertas ao mesmo tempo: a voz avisa os ' + (Number(cfg.maxPorCiclo) || 4) + ' primeiros — veja a central (🔔).', 'info');
      }, 250);
    }
    renderAtivos();
    renderCabecalho();
  }

  /* "Veículo 8833, operador Rafael, excedeu a velocidade. Verificar." */
  function montarFala(a) {
    return policy.montarFala(a);
  }

  /* --------------------------- voz (TTS) --------------------------- */

  let rajada = { ts: 0, voz: 0, aviso: false };
  const faladoEm = new Map();
  let vozBloqueada = false;
  /* Chrome/Safari bloqueiam a voz antes do primeiro toque: guarda a fila e pede um toque. */
  function bloquearVoz(item) {
    vozBloqueada = true;
    falando = false;
    if (item) fila.unshift(item);
    let b = document.getElementById('voz-bloqueada');
    if (!b) {
      b = document.createElement('button');
      b.id = 'voz-bloqueada';
      b.type = 'button';
      b.textContent = '🔊 Toque aqui para ouvir os alertas';
      b.onclick = liberarVoz;
      document.body.appendChild(b);
    }
    b.classList.remove('hide');
  }
  function liberarVoz() {
    const b = document.getElementById('voz-bloqueada');
    if (b) b.classList.add('hide');
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { ac = ac || new AC(); if (ac.state === 'suspended') ac.resume(); }
    } catch { /* sem áudio */ }
    if (!vozBloqueada) return;
    vozBloqueada = false;
    falando = false;
    const s = sintetizador();
    if (s) { try { s.cancel(); s.resume(); } catch { /* nada */ } }
    descargarFila();
  }
  /* Ao entrar no app: abre a central e fala os alertas ativos que importam. */
  let resumoTimer = null;
  function agendarResumoAbertura(atrasoMs) {
    clearTimeout(resumoTimer);
    resumoTimer = setTimeout(falarResumoAbertura, atrasoMs);
  }
  function falarResumoAbertura() {
    if (!cfg.ativo) return;
    const ts = agora();
    const lista = Array.from(ativos.values()).filter((a) =>
      a.notificar && !a.simulado && !(acks[a.chave] && ts - acks[a.chave] < 2 * 3600_000));
    if (!lista.length) return;
    abrirPainel();
    if (!cfg.voz || ts < (Number(cfg.silencioAte) || 0)) return;
    lista.sort((x, y) => (y.severidade || 0) - (x.severidade || 0) || (y.ts || 0) - (x.ts || 0));
    const max = Math.max(1, Number(cfg.maxPorCiclo) || 4);
    const pendentes = lista.filter((a) => !(faladoEm.get(a.chave) > ts - 60000));
    falar(lista.length === 1 ? 'Atenção: um alerta ativo.' : `Atenção: ${lista.length} alertas ativos.`, { oficial: true });
    pendentes.slice(0, max).forEach((a) => { falar(a.fala, { oficial: a.fonte === 'portal' }); faladoEm.set(a.chave, ts); });
    if (pendentes.length > max) falar(`E mais ${pendentes.length - max} alertas na central.`);
  }
  let fila = [];
  let falando = false;
  let vozEscolhida = null;

  const sintetizador = () => (typeof window !== 'undefined' ? window.speechSynthesis : null);

  function ponteNativa() {
    // O WebView do Android não implementa speechSynthesis: usamos a ponte Java do APK
    const p = window.AndroidTTS;
    return p && typeof p.falar === 'function' ? p : null;
  }

  function idVozWeb(v) {
    return 'web:' + String(v.voiceURI || (v.name + '|' + v.lang));
  }

  function vozesNativas() {
    const n = ponteNativa();
    if (!n || typeof n.vozes !== 'function') return [];
    try {
      const lista = n.vozes();
      const itens = typeof lista === 'string' ? JSON.parse(lista) : lista;
      return Array.isArray(itens) ? itens : [];
    } catch {
      return [];
    }
  }

  function escolherVoz() {
    const s = sintetizador();
    if (!s) return;
    const vozes = s.getVoices() || [];
    if (!vozes.length) return;
    let v = cfg.vozURI && String(cfg.vozURI).startsWith('web:')
      ? vozes.find((x) => idVozWeb(x) === cfg.vozURI)
      : null;
    if (!v && cfg.vozURI && !String(cfg.vozURI).startsWith('android:')) {
      v = vozes.find((x) => x.voiceURI === cfg.vozURI);
    }
    if (!v && cfg.vozNome) v = vozes.find((x) => x.name === cfg.vozNome);
    if (!v) v = vozes.find((x) => /pt[-_]br/i.test(x.lang));
    if (!v) v = vozes.find((x) => /^pt/i.test(x.lang));
    if (!v) v = vozes.find((x) => /brazil|brasil/i.test(x.name));
    vozEscolhida = v || null;
  }

  function falar(texto, opcoes) {
    if (!cfg.voz) return;
    const item = { texto: String(texto), oficial: !!(opcoes && opcoes.oficial) };
    if (item.oficial) {
      let inserir = 0;
      while (inserir < fila.length && fila[inserir].oficial) inserir++;
      fila.splice(inserir, 0, item);
    } else {
      const naoOficiais = fila.filter((x) => !x.oficial).length;
      if (naoOficiais >= 8) {
        const antiga = fila.findIndex((x) => !x.oficial);
        if (antiga >= 0) fila.splice(antiga, 1);
        else return;
      }
      fila.push(item);
    }
    descargarFila();
  }

  function descargarFila() {
    if (falando || vozBloqueada || !fila.length) return;
    const item = fila.shift();
    const texto = item.texto;
    const nativa = ponteNativa();
    const s = sintetizador();
    const uriVoz = String(cfg.vozURI || '');
    const androidSelecionado = uriVoz.startsWith('android:');
    if (nativa && (androidSelecionado || !s)) {
      falando = true;
      try {
        const idNativo = uriVoz.startsWith('android:') ? uriVoz.slice('android:'.length) : '';
        if (typeof nativa.falarComVoz === 'function') {
          nativa.falarComVoz(texto, Number(cfg.volume) || 1, Number(cfg.taxa) || 1, idNativo);
        } else nativa.falar(texto, Number(cfg.volume) || 1, Number(cfg.taxa) || 1);
      } catch {
        /* segue sem voz */
      }
      setTimeout(() => {
        falando = false;
        descargarFila();
      }, Math.min(20000, 900 + texto.length * 65));
      return;
    }
    if (!s) {
      tocar(3);
      setTimeout(descargarFila, 200);
      return;
    }
    escolherVoz();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = (vozEscolhida && vozEscolhida.lang) || 'pt-BR';
    if (vozEscolhida) u.voice = vozEscolhida;
    u.volume = Math.max(0, Math.min(1, Number(cfg.volume)));
    u.rate = Math.max(0.5, Math.min(2, Number(cfg.taxa)));
    u.pitch = Math.max(0.5, Math.min(2, Number(cfg.tom)));
    let comecou = false;
    u.onstart = () => { comecou = true; };
    u.onend = () => {
      falando = false;
      setTimeout(descargarFila, 200);
    };
    u.onerror = (ev) => {
      const erro = ev && ev.error;
      if (erro === 'not-allowed' || (!comecou && erro !== 'interrupted' && erro !== 'canceled' && !toquei)) {
        bloquearVoz(item);
        return;
      }
      falando = false;
      setTimeout(descargarFila, 200);
    };
    falando = true;
    try {
      s.speak(u);
      setTimeout(() => {
        if (falando && !s.speaking && !s.pending) {
          const semGesto = !toquei && navigator.userActivation && !navigator.userActivation.hasBeenActive;
          if (!comecou && semGesto) { bloquearVoz(item); return; }
          falando = false;
          descargarFila();
        }
      }, Math.min(30000, 3500 + texto.length * 110));
    } catch {
      falando = false;
    }
  }

  function pararVoz() {
    fila = [];
    falando = false;
    const s = sintetizador();
    if (s) s.cancel();
    const nativa = ponteNativa();
    if (nativa && typeof nativa.parar === 'function') {
      try {
        nativa.parar();
      } catch {
        /* nada a fazer */
      }
    }
  }

  /* --------------------------- som / vibração --------------------------- */

  let ac = null;
  function tocar(severidade) {
    if (!cfg.som) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = ac || new AC();
      if (ac.state === 'suspended') ac.resume();
      const notas = severidade >= 3 ? [[880, 0], [1174, 0.17], [880, 0.34]] : severidade === 2 ? [[698, 0], [880, 0.19]] : [[587, 0]];
      for (const [f, t] of notas) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        const i = ac.currentTime + t;
        g.gain.setValueAtTime(0.0001, i);
        g.gain.exponentialRampToValueAtTime(0.2, i + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, i + 0.16);
        o.connect(g).connect(ac.destination);
        o.start(i);
        o.stop(i + 0.2);
      }
    } catch {
      /* sem WebAudio: a voz e o pop-up continuam */
    }
  }

  let toquei = false;
  let escondidoEm = 0;
  if (typeof window !== 'undefined') {
    const marcarToque = () => { toquei = true; if (vozBloqueada) setTimeout(liberarVoz, 0); };
    addEventListener('pointerdown', marcarToque, { passive: true, capture: true });
    addEventListener('touchstart', marcarToque, { passive: true, capture: true });
    addEventListener('keydown', marcarToque, { capture: true });
  }
  function vibrar(severidade) {
    if (!cfg.vibrar) return;
    try {
      const nativa = ponteNativa();
      if (nativa && nativa.vibrar) nativa.vibrar(severidade >= 3 ? 400 : 180);
      // o navegador só deixa vibrar depois do primeiro toque do usuário: sem isso, enche o console de aviso
      else if (toquei && navigator.vibrate) navigator.vibrate(severidade >= 3 ? [220, 90, 220] : [140]);
    } catch {
      /* aparelho sem vibração */
    }
  }

  /* Exceção pedida pelo usuário: “Sem apontamento” (cálculo do app) usa todos os
     canais, mas só enquanto o app está aberto — nunca passa pelo Web Push. */
  function localComCanais(a) {
    return !!a && a.fonte === 'app' && (a.regra === 'semApontamento' || a.regra === 'refeicao' || a.regra === 'paradaImprodutiva' || a.regra === 'gestaoFrente');
  }
  function canalSistema(a) {
    return !!a && (a.fonte === 'portal' || localComCanais(a));
  }
  function notificar(a) {
    if (!a || !canalSistema(a) || !a.notificar || !cfg.notificacao || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    const titulo = `${a.classe} ${a.numero} — ${a.nome}`;
    const opcoes = {
      body: a.texto,
      tag: a.chave,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      requireInteraction: a.severidade >= 3,
      renotify: true,
      data: { equipamento: String(a.e.id), chave: a.chave },
    };
    // Android/PWA exige showNotification; new Notification pode lançar TypeError.
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then((registro) => {
        if (!cfg.ativo || !canalSistema(a) || !a.notificar || !policy.notificar(cfg, a) || !cfg.notificacao) return;
        if (registro && registro.showNotification) return registro.showNotification(titulo, opcoes);
        notificarDesktop(titulo, opcoes, a);
      }).catch(() => notificarDesktop(titulo, opcoes, a));
      return;
    }
    notificarDesktop(titulo, opcoes, a);
  }

  function notificarDesktop(titulo, opcoes, a) {
    if (!cfg.ativo || !a || !canalSistema(a) || !a.notificar || !cfg.notificacao || !policy.notificar(cfg, a)) return;
    try {
      const n = new Notification(titulo, opcoes);
      n.onclick = () => {
        window.focus();
        abrirNoMapa(a);
      };
    } catch {
      /* WebView nem sempre expõe Notification */
    }
  }

  /* --------------------------- auditoria --------------------------- */

  /* Manda em lote: um disparo pode gerar dezenas de alertas e o limite do
     serverless é 40 requisições/min por IP. */
  const filaAudit = [];
  let auditPausaAte = 0;
  let auditTimer = null;

  function registrarNoServidor(a) {
    if (!ctx.audit) return;
    filaAudit.push({
      chave: a.chave,
      regra: a.regra,
      severidade: a.severidade,
      equipamento: a.numero,
      descricao: a.descricao,
      operador: a.operador,
      valor: a.valor,
      limite: a.limite,
      texto: a.texto,
      detalhe: a.detalhe,
      fonte: a.fonte,
      fala: a.fala,
      inicio: new Date(a.inicio).toISOString(),
      quando: new Date(a.ts).toISOString(),
      unidade: ctx.unidade || '',
      usuario: ctx.usuario || '',
    });
    if (filaAudit.length > 400) filaAudit.splice(0, filaAudit.length - 400);
    if (!auditTimer) auditTimer = setTimeout(enviarAudit, 20000);
  }

  async function enviarAudit() {
    auditTimer = null;
    if (!filaAudit.length || agora() < auditPausaAte) {
      if (filaAudit.length) auditTimer = setTimeout(enviarAudit, 30000);
      return;
    }
    const lote = filaAudit.splice(0, 25);
    try {
      const res = await fetch('/.netlify/functions/session?acao=alerta', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alertas: lote, unidade: ctx.unidade || '', usuario: ctx.usuario || '' }),
      });
      if (res.status === 429) {
        filaAudit.unshift(...lote);
        auditPausaAte = agora() + 120000; // duas varridas sem tentar de novo
      }
    } catch {
      filaAudit.unshift(...lote);
      auditPausaAte = agora() + 60000;
    }
    if (filaAudit.length) auditTimer = setTimeout(enviarAudit, 30000);
  }

  /* ------------------------------------------------------------------ */
  /* interface                                                          */
  /* ------------------------------------------------------------------ */

  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const hora = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function desde(ts) {
    const s = Math.max(0, Math.round((agora() - ts) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'min';
    return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0');
  }

  function montar() {
    const host = document.createElement('div');
    host.innerHTML = `
<div id="alertas" class="hide" role="dialog" aria-label="Central de alertas">
  <div id="alertas-painel">
    <header>
      <div class="titulo">
        <img src="/icons/logo-mark.png" alt="" width="24" height="24" />
        <div><strong>Central de alertas</strong><span id="alertas-status" class="fine"></span></div>
      </div>
      <button id="alertas-fechar" class="icone" title="Fechar" aria-label="Fechar">✕</button>
    </header>
    <div class="ferramentas">
      <div class="abas">
        <button class="aba ativa" data-aba="ativos">Ativos <span id="cont-ativos" class="pill">0</span></button>
        <button class="aba" data-aba="historico">Histórico <span id="cont-hist" class="pill">0</span></button>
      </div>
      <div class="atalhos">
        <button id="btn-som" class="icone" title="Som do alerta">🔊</button>
        <button id="btn-voz" class="icone" title="Fala do alerta">🗣️</button>
        <button id="btn-silencio" class="icone" title="Silenciar por 30 minutos">🤫</button>
        <button id="btn-cfg" class="icone" title="Preferências de alertas">⚙️</button>
      </div>
    </div>
    <div class="busca-central" role="search">
      <input id="alertas-busca" type="search" aria-label="Buscar por frota, alerta ou operador" aria-controls="lista-ativos lista-historico" placeholder="Frota, alerta ou operador" autocomplete="off">
      <button id="alertas-busca-limpar" class="icone hide" type="button" title="Limpar busca" aria-label="Limpar busca">✕</button>
    </div>
    <div class="linha-status">
      <span class="dot" id="dot-ciclo" title="estado da conexão"></span>
      <span id="alertas-proximo">—</span>
      <span class="fine" id="alertas-stream"></span>
      <span class="fine" id="alertas-escopo"></span>
    </div>
    <div id="lista-ativos" class="lista"></div>
    <div id="lista-historico" class="lista hide"></div>
    <footer>
      <button id="btn-limpar">Limpar ativos</button>
      <button id="btn-exportar">Exportar CSV</button>
      <button id="btn-teste" class="primary">Testar pop-up e voz</button>
    </footer>
  </div>
  <div class="veu"></div>
</div>

<div id="toasts" aria-live="assertive" aria-atomic="false"></div>

<div id="cfg-alertas" class="hide" role="dialog" aria-modal="true" aria-labelledby="cfg-titulo">
  <div class="card cfg">
    <div class="cfg-topo">
      <span aria-hidden="true"></span>
      <img class="marca" src="/icons/logo-mark.png" alt="" width="44" height="44" />
      <button id="cfg-fechar-x" class="icone cfg-fechar-x" type="button" title="Fechar preferências" aria-label="Fechar preferências">✕</button>
    </div>
    <h2 id="cfg-titulo">Preferências de alertas</h2>
    <p class="fine">Alertas calculados localmente ficam na central e no histórico. Só “Motor ocioso sem apontamento”, quando confirmado por uma descrição atual do SGPA, pode ser falado como exceção; não gera notificação do sistema. Os demais cálculos locais não são falados nem notificados. A amostra manual do botão de teste não envia notificação do sistema.</p>
    <div class="fonte-oficial"><strong>Velocidade: somente SGPA</strong><span>O app notifica quando o SGPA emitir o alarme. Os limites são os cadastrados no portal, não um cálculo genérico do aplicativo.</span></div>
    <section class="push-optin" aria-labelledby="push-optin-titulo">
      <div class="push-optin-cabecalho"><span class="push-simbolo" aria-hidden="true">◉</span><div><h3 id="push-optin-titulo">Notificações Push neste aparelho</h3><span class="push-dispositivo">Ativação individual, controlada por você</span></div></div>
      <p>O Push envia apenas alarmes oficiais SGPA selecionados — não envia cálculos locais. Categorias e tipos, frentes, equipamentos e o escopo da seleção do mapa se aplicam por dispositivo. A entrega usa polling do backend, com até 1 minuto de intervalo; não é instantânea.</p>
      <p id="push-status" class="push-status" role="status" aria-live="polite">Verificando disponibilidade…</p>
      <div class="push-acoes"><button id="push-ativar" class="primary" type="button">Ativar notificações Push neste aparelho</button><button id="push-desligar" class="push-desligar hide" type="button">Desligar notificações Push neste aparelho</button></div>
    </section>
    <p class="rotulo">Quais alertas devem notificar</p>
    <div class="busca-modulo"><input id="cfg-busca-categoria" type="search" placeholder="Pesquisar alerta (ex.: fila, velocidade, refeição)" aria-label="Pesquisar alertas" autocomplete="off"></div>
    <div id="cfg-categorias" class="alert-switch-list"></div>
    <p id="cfg-categorias-vazio" class="busca-vazia hide">Nenhum alerta encontrado.</p>
    <details class="catalogo-detalhes">
      <summary>Escolher tipos individuais do SGPA</summary>
      <p id="cfg-catalogo-status" class="fine">Carregando catálogo auditado…</p>
      <label class="campo"><span>Buscar por nome ou código oficial</span><input id="cfg-busca-tipo" type="search" placeholder="Pesquisar por nome ou código (ex.: velocidade, 12724)" autocomplete="off"></label>
      <div class="catalogo-filtros"><label class="chk"><input id="cfg-todos-tipos" type="checkbox"><span>Mostrar catálogo geral, não só tipos utilizados/conhecidos</span></label><button id="cfg-atualizar-catalogo" type="button">Atualizar SGPA</button></div>
      <p class="fine">Um tipo marcado individualmente recebe aviso mesmo se a categoria geral estiver desligada; a fala depende da chave “Falar alerta em português”. Desmarque para silenciar o código. O catálogo geral não significa que todos esses alarmes estão configurados para esta unidade.</p>
      <div id="cfg-tipos" class="alert-switch-list catalogo-lista"></div>
      <button id="cfg-mais-tipos" type="button" class="hide">Mostrar mais tipos</button>
    </details>
    <details class="catalogo-detalhes"><summary>Regras auditadas da unidade</summary><p id="cfg-regras-status" class="fine"></p><div class="busca-modulo"><input id="cfg-busca-regra" type="search" placeholder="Pesquisar regra, tipo de equipamento ou condição" aria-label="Pesquisar regras auditadas" autocomplete="off"></div><p id="cfg-regras-contagem" class="busca-contagem"></p><div id="cfg-regras-auditadas" class="regras-auditadas"></div><p class="fine">Inventário para consulta. As expressões permanecem executadas pelo SGPA, sem recriar condições ambíguas no aplicativo.</p></details>
    <h3 class="secao-alertas">Leitura e cálculos complementares</h3>
    <p class="fine">RPM, ociosidade e troca de turno podem ter cálculo local complementar. Se o motor estiver ocioso e a descrição atual da operação SGPA confirmar “Sem Apontamento”, a central registra um alerta local combinado após o tempo configurado. Só esse alerta confirmado pode ser falado; não gera notificação do sistema, som, vibração ou pop-up. Os demais cálculos locais ficam na central/histórico sem fala nem notificação. A espera por caminhão usa a operação da telemetria mesmo com esses cálculos desligados.</p>
    <div class="grade">
      <label class="campo"><span>RPM máxima do motor</span><input id="cfg-rpm" type="number" min="0" step="10" inputmode="numeric"></label>
      <label class="campo"><span>Motor ocioso (min)</span><input id="cfg-ocioso" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Sem apontamento (min)</span><input id="cfg-sem-ponto" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Troca de turno (min)</span><input id="cfg-turno" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Repetir o mesmo alerta a cada (min)</span><input id="cfg-cooldown" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Máx. de alertas falados por ciclo</span><input id="cfg-maxvoz" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Intervalo de leitura (s)</span><input id="cfg-int" type="number" min="30" step="5" inputmode="numeric"></label>
      <label class="campo"><span>Leituras p/ confirmar</span><input id="cfg-amostras" type="number" min="1" max="5" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Ignorar sem sinal há (min)</span><input id="cfg-atraso" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>RPM abaixo disto é ocioso</span><input id="cfg-rpmoci" type="number" min="0" step="10" inputmode="numeric"></label>
    </div>
    <label class="campo"><span>Só estes equipamentos (separados por espaço ou vírgula; vazio = todos)</span>
      <input id="cfg-eq" type="text" placeholder="ex.: 8833 4462 74073" spellcheck="false" autocomplete="off"></label>
    <p class="rotulo">Frentes / grupos monitorados</p>
    <p class="fine">Marque somente os grupos que deseja monitorar. Com um ou mais marcados, alertas fora desses grupos saem dos ativos; sem nenhum marcado, vale a unidade toda.</p>
    <div id="cfg-frentes" class="chips"></div>
    <h3 class="secao-alertas">Controle de refeições</h3>
    <p class="fine">Defina o tempo de refeição de cada grupo. Quando o equipamento ficar na operação de refeição do SGPA além do limite, a central gera o alarme “Refeição excedida” (fala e notificação com o app aberto). Grupos em “Não controlar” são ignorados.</p>
    <div id="cfg-refeicoes" class="refeicao-lista"></div>
    <label class="campo"><span>Por equipamento (prevalece sobre o grupo): número=minutos</span>
      <input id="cfg-refeicao-eq" type="text" placeholder="ex.: 6614=30, 8833=60, 4462=0" spellcheck="false" autocomplete="off"></label>
    <h3 class="secao-alertas">Paradas improdutivas (ranking SGPA)</h3>
    <p class="fine">Códigos que mais tiraram produtividade no último mês. Alerta quando o equipamento fica na operação além da tolerância (minutos). Use 0 para não alertar.</p>
    <div id="cfg-paradas" class="grade"></div>
    <h3 class="secao-alertas">Escalonamento da cobrança</h3>
    <p class="fine">Se a parada continuar depois do primeiro alerta, o app repete como URGENTE e depois pede para acionar o líder da frente. Use 0 para desligar o nível.</p>
    <div class="grade">
      <label class="campo"><span>Urgente após a tolerância (+min)</span><input id="cfg-esc1" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Acionar líder após a tolerância (+min)</span><input id="cfg-esc2" type="number" min="0" step="1" inputmode="numeric"></label>
    </div>
    <label class="campo"><span>Líder de cada frente (frente=nome, separados por ;)</span>
      <input id="cfg-lideres" type="text" placeholder="ex.: Frente 1=João; Frente 2=Pedro" spellcheck="false" autocomplete="off"></label>
    <h3 class="secao-alertas">Gestão por frente</h3>
    <p class="fine">Alertas de equilíbrio da frente (o problema é do despacho, não do operador). Use 0 para desligar.</p>
    <div class="grade">
      <label class="campo"><span>Fila: nº de equipamentos aguardando carregamento</span><input id="cfg-fila-frente" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Todas as colhedoras paradas há (min)</span><input id="cfg-sem-colh" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Transbordos aguardando colhedora (nº)</span><input id="cfg-transb-ag" type="number" min="0" step="1" inputmode="numeric"></label>
    </div>
    <h3 class="secao-alertas">Fontes e canais de aviso</h3>
    <div class="switches">
      <label class="chk"><input id="cfg-liga" type="checkbox"><span>Central de alertas ligada</span></label>
      <label class="chk"><input id="cfg-local" type="checkbox"><span>Cálculo complementar: RPM, motor ocioso e troca de turno</span></label>
      <label class="chk"><input id="cfg-serv" type="checkbox"><span>Receber alarmes oficiais SGPA (stream e consulta)</span></label>
      <label class="chk"><input id="cfg-stream" type="checkbox"><span>Conexão ao vivo (stream de eventos do mapa)</span></label>
      <label class="chk"><input id="cfg-mapa" type="checkbox"><span>Alertar só do que foi clicado no mapa</span></label>
      <label class="chk"><input id="cfg-popup" type="checkbox"><span>Pop-up na tela</span></label>
      <label class="chk"><input id="cfg-som" type="checkbox"><span>Som de aviso</span></label>
      <label class="chk"><input id="cfg-voz" type="checkbox"><span>Falar o alerta em português</span></label>
      <label class="chk"><input id="cfg-notif" type="checkbox"><span>Notificação do sistema (app instalado)</span></label>
      <label class="chk"><input id="cfg-vib" type="checkbox"><span>Vibrar no celular</span></label>
      <label class="chk"><input id="cfg-repete" type="checkbox"><span>Repetir a fala enquanto durar o alerta</span></label>
    </div>
    <div class="grade">
      <label class="campo"><span>Voz</span><select id="cfg-vozel"></select></label>
      <label class="campo"><span>Volume <b id="lb-vol"></b></span><input id="cfg-vol" type="range" min="0" max="1" step="0.05"></label>
      <label class="campo"><span>Ritmo <b id="lb-taxa"></b></span><input id="cfg-taxa" type="range" min="0.6" max="1.6" step="0.05"></label>
      <label class="campo"><span>Tom <b id="lb-tom"></b></span><input id="cfg-tom" type="range" min="0.6" max="1.4" step="0.05"></label>
    </div>
    <div class="voice-actions">
      <button id="cfg-gerenciar-vozes" type="button" class="hide">Instalar ou gerenciar vozes do Android</button>
      <p class="fine">A lista mostra as vozes instaladas e disponibilizadas pelo navegador ou aparelho. Para aparecerem novas vozes, instale pacotes de voz nas configurações do dispositivo. Vozes IA online não estão configuradas; nenhum serviço pago será usado sem sua autorização explícita. A opção gratuita também depende de autorização e credencial segura. Não classificamos vozes locais por IA ou gênero sem informação confiável.</p>
    </div>
    <div class="row">
      <button id="cfg-salvar" class="primary">Salvar preferências</button>
      <button id="cfg-teste2">Ouvir exemplo</button>
      <button id="cfg-fechar">Fechar</button>
    </div>
    <p id="cfg-aviso" class="fine"></p>
  </div>
</div>`;
    // dentro do #stage para a barra do app (com o sino) continuar visível
    const palco = document.getElementById('stage') || document.body;
    while (host.firstChild) palco.appendChild(host.firstChild);

    el = {
      painel: $('alertas'),
      status: $('alertas-status'),
      proximo: $('alertas-proximo'),
      stream: $('alertas-stream'),
      escopo: $('alertas-escopo'),
      ativos: $('lista-ativos'),
      historico: $('lista-historico'),
      busca: $('alertas-busca'),
      buscaLimpar: $('alertas-busca-limpar'),
      contAtivos: $('cont-ativos'),
      contHist: $('cont-hist'),
      dot: $('dot-ciclo'),
      toasts: $('toasts'),
      cfg: $('cfg-alertas'),
      sino: $('btn-alertas'),
      badge: $('alert-badge'),
    };

    const p = el.painel;
    el.busca.addEventListener('input', () => {
      buscaCentral = el.busca.value;
      el.buscaLimpar.classList.toggle('hide', !norm(buscaCentral));
      renderAtivos();
    });
    el.buscaLimpar.onclick = () => {
      el.busca.value = '';
      buscaCentral = '';
      el.buscaLimpar.classList.add('hide');
      renderAtivos();
      el.busca.focus();
    };
    $('alertas-fechar').onclick = fecharPainel;
    p.querySelector('.veu').onclick = fecharPainel;
    for (const b of p.querySelectorAll('.aba')) {
      b.onclick = () => {
        for (const x of p.querySelectorAll('.aba')) x.classList.toggle('ativa', x === b);
        el.ativos.classList.toggle('hide', b.dataset.aba !== 'ativos');
        el.historico.classList.toggle('hide', b.dataset.aba !== 'historico');
        renderAtivos();
      };
    }
    $('btn-som').onclick = () => {
      configurar({ som: !cfg.som });
      if (cfg.som) tocar(3);
    };
    $('btn-voz').onclick = () => {
      configurar({ voz: !cfg.voz });
      if (cfg.voz) falar('Voz ligada.');
      else pararVoz();
    };
    $('btn-silencio').onclick = () => {
      configurar({ silencioAte: agora() + 30 * 60000 });
      mostrarAviso('Alertas silenciados por 30 minutos — o histórico continua.', 'info');
    };
    $('btn-cfg').onclick = abrirConfig;
    $('btn-limpar').onclick = () => {
      ativos.clear();
      for (const st of estados.values()) st.emitido = false;
      renderAtivos();
      renderCabecalho();
    };
    $('btn-exportar').onclick = exportarCsv;
    $('btn-teste').onclick = testar;
    $('cfg-fechar').onclick = fecharConfig;
    $('cfg-fechar-x').onclick = fecharConfig;
    $('cfg-salvar').onclick = lerConfig;
    $('push-ativar').onclick = ativarPush;
    $('push-desligar').onclick = desligarPush;
    $('cfg-vozel').onchange = () => {
      configurar(preferenciaVoz($('cfg-vozel').value));
      escolherVoz();
    };
    $('cfg-gerenciar-vozes').onclick = () => {
      const nativa = ponteNativa();
      if (nativa && typeof nativa.gerenciarVozes === 'function') nativa.gerenciarVozes();
    };
    $('cfg-teste2').onclick = () => falar(policy.montarFala({ regra: 'velocidade', numero: '8833', valor: 85 }));
    $('cfg-busca-tipo').oninput = () => { limiteTipos = 80; renderTipos(); };
    if ($('cfg-busca-categoria')) $('cfg-busca-categoria').oninput = filtrarCategorias;
    if ($('cfg-busca-regra')) $('cfg-busca-regra').oninput = filtrarRegras;
    $('cfg-todos-tipos').onchange = () => { limiteTipos = 80; renderTipos(); };
    $('cfg-mais-tipos').onclick = () => { limiteTipos += 80; renderTipos(); };
    $('cfg-atualizar-catalogo').onclick = atualizarCatalogo;
    el.cfg.addEventListener('click', (ev) => {
      if (ev.target === el.cfg) fecharConfig();
    });
    renderPushStatus();
  }

  function abrirPainel() {
    if (!el.painel) montar();
    el.painel.classList.remove('hide');
    renderAtivos();
    renderCabecalho();
  }
  function fecharPainel() {
    el.painel.classList.add('hide');
  }

  function renderCabecalho() {
    if (!el.painel) return;
    const n = ativos.size;
    const avisaveis = [...ativos.values()].filter((a) => a.fonte === 'portal' && a.notificar).length;
    if (el.badge) {
      el.badge.textContent = n ? String(n) : '';
      el.badge.classList.toggle('hide', !n);
    }
    if (el.sino) el.sino.classList.toggle('alertando', cfg.ativo && avisaveis > 0);
    const s = Math.max(0, Math.round((proximo - agora()) / 1000));
    if (el.proximo) el.proximo.textContent = estado.ligado ? `próxima leitura em ${s}s` : 'central desligada';
    if (el.status) {
      const sessao = estado.sessao === 'ativa' ? 'sessão SGPA ativa' : `sessão SGPA ${estado.sessao}`;
      el.status.textContent = `${n} ativo${n === 1 ? '' : 's'} · ${estado.monitorados} equipamentos vigiados · ${sessao}`;
    }
    if (el.stream) {
      const vivo = estado.stream === 'ao vivo' && agora() - ultimoQuadro < 120000;
      el.stream.textContent = estado.stream === 'ao vivo'
        ? vivo ? 'eventos do mapa: ao vivo' : 'eventos do mapa: parado'
        : 'eventos do mapa: ' + estado.stream;
    }
    if (el.dot) {
      el.dot.classList.toggle('ruim', estado.erros > 0);
      el.dot.title = estado.erros ? 'último erro: ' + estado.proximoErro : 'lendo o portal normalmente';
    }
    if (el.escopo) {
      const pedacos = [];
      if (cfg.frentes.length) pedacos.push(cfg.frentes.length + ' frente(s)');
      if ((cfg.equipamentos || '').trim()) pedacos.push('lista de equipamentos');
      if (cfg.seguirSelecaoMapa) pedacos.push('seleção do mapa');
      el.escopo.textContent = pedacos.length ? 'escopo: ' + pedacos.join(', ') : 'escopo: unidade toda';
    }
    document.title = n ? `(${n}) Monitoramento BP` : 'Monitoramento BP — Branco Peres';
    const bSom = $('btn-som');
    const bVoz = $('btn-voz');
    if (bSom) bSom.classList.toggle('mudo', !cfg.som);
    if (bVoz) bVoz.classList.toggle('mudo', !cfg.voz);
  }

  function card(a, comAccoes) {
    const d = document.createElement('div');
    d.className = 'alerta sev' + a.severidade + (a.fonte === 'portal' ? ' oficial' : '');
    d.style.setProperty('--cor', a.cor);
    const reconhecido = acks[a.chave] && agora() - acks[a.chave] < 2 * 3600_000;
    d.innerHTML = `
      <div class="a-top">
        <span class="a-icone">${a.icone}</span>
        <strong class="a-eq">${esc(a.classe)} ${esc(a.numero)}</strong>
        <span class="a-chip">${esc(a.nome)}</span>
        ${a.fonte === 'portal' ? '<span class="a-chip oficial">SGPA</span>' : ''}
        ${a.fonte === 'teste' ? '<span class="a-chip cinza">AMOSTRA MANUAL</span>' : ''}
        ${!a.notificar ? '<span class="a-chip cinza">sem notificação do sistema</span>' : ''}
        ${a.contagem > 1 ? `<span class="a-chip cinza">×${a.contagem}</span>` : ''}
        <span class="a-hora" title="há ${desde(a.ts)}">${hora(a.ts)}</span>
      </div>
      <p class="a-txt">${esc(a.texto)}</p>
      <p class="a-meta">${esc(a.descricao)}${a.operador ? ' · operador <b>' + esc(a.operador) + '</b>' : ' · <b>sem operador definido</b>'}${a.detalhe ? '<br>' + esc(a.detalhe) : ''}</p>
      <p class="a-fala">🗣️ ${esc(a.fala)}</p>
      <div class="a-acoes">
        <button data-q="ouvir">▶ ouvir</button>
        <button data-q="mapa">📍 ver no mapa</button>
        ${comAccoes ? '<button data-q="snz">🤫 15 min</button>' : ''}
        ${comAccoes && !reconhecido ? '<button data-q="ack">✓ reconhecer</button>' : comAccoes ? '<span class="a-chip verde">reconhecido</span>' : ''}
        <button data-q="fechar" class="fim">✕</button>
      </div>`;
    d.querySelector('[data-q="ouvir"]').onclick = () => falar(a.fala);
    d.querySelector('[data-q="mapa"]').onclick = () => abrirNoMapa(a);
    const snz = d.querySelector('[data-q="snz"]');
    if (snz)
      snz.onclick = () => {
        const st = estados.get(a.chave);
        if (st) st.ultimo = agora() + 15 * 60000;
        mostrarAviso(`${a.classe} ${a.numero}: silêncio por 15 minutos.`, 'info');
        fecharCard(d);
      };
    const ack = d.querySelector('[data-q="ack"]');
    if (ack)
      ack.onclick = () => {
        acks[a.chave] = agora();
        salvar(KEY_ACK, acks);
        renderAtivos();
      };
    d.querySelector('[data-q="fechar"]').onclick = () => {
      ativos.delete(a.chave);
      fecharCard(d);
      renderAtivos();
      renderCabecalho();
    };
    return d;
  }

  function fecharCard(d) {
    d.classList.add('saindo');
    setTimeout(() => d.remove(), 200);
  }

  function correspondeBuscaCentral(campos) {
    const query = norm(buscaCentral);
    if (!query) return true;
    const texto = (Array.isArray(campos) ? campos : [campos])
      .filter((v) => v !== null && v !== undefined)
      .join(' ');
    return norm(texto).includes(query);
  }

  function renderAtivos() {
    if (!el.ativos) return;
    const lista = [...ativos.values()]
      .sort((x, y) => y.severidade - x.severidade || y.ts - x.ts)
      .filter((a) => correspondeBuscaCentral([
        a.numero, a.e && a.e.id, a.e && a.e.nome, a.e && a.e.tipo, a.e && a.e.frente,
        a.operador, a.nomeAlarme, a.tipoAlarme, a.regra, a.texto, a.detalhe,
      ]));
    el.ativos.innerHTML = '';
    if (!lista.length) {
      el.ativos.innerHTML = norm(buscaCentral)
        ? '<div class="vazio">Nenhum alerta ativo corresponde à busca.</div>'
        : '<div class="vazio">Nenhum alerta ativo agora.<br><span class="fine">A central continua lendo o portal a cada ' +
          cfg.intervaloSeg + 's e os eventos do mapa em tempo real.</span></div>';
    }
    for (const a of lista) el.ativos.appendChild(card(a, true));
    el.contAtivos.textContent = String(ativos.size);
    el.contHist.textContent = String(hist.length);

    if (el.historico && !el.historico.classList.contains('hide')) {
      el.historico.innerHTML = '';
      const resultados = hist.filter((h) => correspondeBuscaCentral([
        h.equipamento, h.descricao, h.nomeAlarme, h.tipoAlarme, h.regra,
        h.texto, h.detalhe, h.operador, h.frente,
      ]));
      if (!resultados.length) {
        el.historico.innerHTML = norm(buscaCentral)
          ? '<div class="vazio">Nenhum item no histórico corresponde à busca.</div>'
          : '<div class="vazio">Sem histórico neste aparelho.</div>';
      }
      for (const h of resultados.slice(0, 150)) {
        const r = REGRAS[h.regra] || REGRAS.generico;
        const d = document.createElement('div');
        d.className = 'alerta menor';
        d.style.setProperty('--cor', r.cor);
        d.innerHTML =
          `<div class="a-top"><span class="a-icone">${r.icone}</span><strong class="a-eq">${esc(h.equipamento)}</strong>` +
          `<span class="a-chip">${esc(h.nomeAlarme || r.nome)}</span>${h.notificacaoSelecionada === false ? '<span class="a-chip cinza">sem aviso</span>' : ''}<span class="a-hora">${hora(h.ts)}</span></div>` +
          `<p class="a-txt">${esc(h.texto)}</p>` +
          `<p class="a-meta">${esc(h.descricao || '')}${h.operador ? ' · ' + esc(h.operador) : ''} · fonte ${esc(h.fonte)}</p>`;
        d.onclick = () => falar(h.fala || h.texto);
        el.historico.appendChild(d);
      }
    }
  }

  function mostrarToast(a, silenciado) {
    if (!el.toasts) return;
    const d = card(a, !silenciado);
    d.classList.add('toast');
    if (silenciado) d.classList.add('mudo');
    d.style.setProperty('--tempo', (a.severidade >= 3 ? 26 : 18) + 's');
    el.toasts.appendChild(d);
    const barra = document.createElement('div');
    barra.className = 'barra';
    barra.style.animationDuration = (a.severidade >= 3 ? 26 : 18) + 's';
    d.appendChild(barra);
    const maxVisiveis = innerHeight < 760 ? 3 : 5;   // na tela do celular não cobre o mapa
    while (el.toasts.children.length > maxVisiveis) {
      const alvo = el.toasts.firstElementChild;
      if (alvo.classList.contains('aviso')) break;
      alvo.remove();
    }
    rolarToastMaisNovo();
    const t = setTimeout(() => fecharCard(d), (a.severidade >= 3 ? 26 : 18) * 1000);
    d.addEventListener('mouseenter', () => {
      clearTimeout(t);
      barra.style.animationPlayState = 'paused';
    });
    d.addEventListener('mouseleave', () => {
      setTimeout(() => fecharCard(d), 4000);
    });
  }

  function rolarToastMaisNovo() {
    if (!el.toasts) return;
    requestAnimationFrame(() => {
      if (el.toasts) el.toasts.scrollTop = -el.toasts.scrollHeight;
    });
  }

  function mostrarAviso(txt, tipo) {
    if (!el.toasts) return;
    const d = document.createElement('div');
    d.className = 'aviso ' + (tipo || '');
    d.textContent = txt;
    el.toasts.appendChild(d);
    rolarToastMaisNovo();
    setTimeout(() => fecharCard(d), 4200);
  }

  /* `rastroBI.equipment` sem período aciona no mapa oficial flyTo, zoom e popup do equipamento. */
  function abrirNoMapa(a) {
    const codigo = a && a.e && a.e.cdEquipamento != null
      ? a.e.cdEquipamento
      : a && a.e && a.e.id != null
        ? a.e.id
        : a && a.cdEquipamento;
    const id = codigo == null ? '' : String(codigo).trim();
    if (!id) return;
    const iframe = $('map');
    const iframeUrl = iframe && (iframe.getAttribute('src') || iframe.src);
    const mapUrl = ctx.mapUrl || iframeUrl;
    if (iframe && iframe.contentWindow && mapUrl && ctx.props) {
      try {
        const origin = new URL(mapUrl, window.location.href).origin;
        const iframeOrigin = new URL(iframeUrl || mapUrl, window.location.href).origin;
        if (origin !== iframeOrigin) throw new Error('a origem do mapa incorporado não confere');
        const props = JSON.parse(JSON.stringify(ctx.props));
        const rastroBI = Object.assign({}, props.rastroBI || {}, {
          // O mapa compara cdEquipamento como string; sem datas, seleciona a posição atual.
          equipment: id,
        });
        // Datas herdadas fariam o portal priorizar o rastro e impedir o flyTo atual.
        delete rastroBI.start;
        delete rastroBI.end;
        props.rastroBI = rastroBI;
        iframe.contentWindow.postMessage({ type: 'props', data: props }, origin);
        fecharPainel();
        mostrarAviso(`Centralizando ${a.classe || ''} ${a.numero} no mapa.`, 'info');
        return;
      } catch (erro) {
        console.warn('Não foi possível focar o equipamento no mapa incorporado', erro);
      }
    }
    mostrarAviso('O mapa incorporado não está disponível para localizar este equipamento. Tente novamente quando o mapa estiver carregado.', 'info');
  }

  /* ------------------------------ config ------------------------------ */

  function abrirConfig() {
    if (!el.cfg) montar();
    renderConfig();
    el.cfg.classList.remove('hide');
    $('cfg-fechar-x').focus();
    carregarCatalogo().then(renderSelecao).catch(() => {});
  }
  function fecharConfig() {
    el.cfg.classList.add('hide');
    const gatilho = el.painel && !el.painel.classList.contains('hide') ? $('btn-cfg') : $('btn-alertas');
    if (gatilho) gatilho.focus();
  }

  const DESCRICOES_CATEGORIAS = {
    velocidade: 'Somente alarme oficial de velocidade emitido pelo SGPA.',
    rpm: 'Tipos oficiais de RPM e cálculo complementar, se ativado.',
    ocioso: 'Motor ocioso oficial e cálculo complementar; identifica também o caso sem apontamento SGPA.',
    turno: 'Troca de turno oficial e cálculo complementar, se ativado.',
    motorCondicao: 'Condições combinadas do motor; não são velocidade pura.',
    aguardandoCaminhao: 'Trator/transbordo com a operação Aguardando Caminhão. Informa a frente/grupo.',
    refeicao: 'Refeição acima do tempo configurado por grupo ou equipamento (seção Controle de refeições). Fala e notifica só com o app aberto.',
    semApontamento: 'Equipamento na operação SGPA “Sem Apontamento” por 5 min ou mais (sem alarme do portal). Fala e notifica só com o app aberto.',
    paradaImprodutiva: 'Paradas improdutivas de maior impacto (fila, aguardando carregamento, 983, falta de transbordo etc.) acima da tolerância da seção Paradas improdutivas. Fala e notifica com o app aberto.',
    gestaoFrente: 'Alertas da frente: fila acumulada de caminhões, frente com todas as colhedoras paradas e transbordos demais aguardando colhedora (seção Gestão por frente).',
    generico: 'Demais tipos oficiais, com o nome original do SGPA.',
  };
  let limiteTipos = 80;

  function chaveNotificacao(nome, detalhe, ligada, onChange) {
    const label = document.createElement('label');
    label.className = 'alert-switch';
    const texto = document.createElement('span');
    texto.className = 'alert-switch-text';
    const titulo = document.createElement('strong');
    titulo.textContent = nome;
    const descricao = document.createElement('small');
    descricao.textContent = detalhe;
    texto.append(titulo, descricao);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', 'Notificar: ' + nome);
    input.checked = ligada;
    const track = document.createElement('span');
    track.className = 'alert-switch-track';
    track.setAttribute('aria-hidden', 'true');
    input.onchange = () => onChange(input.checked);
    label.append(texto, input, track);
    return label;
  }

  function renderSelecao() {
    const box = $('cfg-categorias');
    if (!box) return;
    box.innerHTML = '';
    for (const id of Object.keys(DESCRICOES_CATEGORIAS)) {
      const r = REGRAS[id];
      box.appendChild(chaveNotificacao(r.nome, DESCRICOES_CATEGORIAS[id], cfg.notificarCategorias[id] !== false, (ligada) => {
        configurar({ notificarCategorias: { [id]: ligada } });
        renderAtivos();
        renderTipos();
      }));
    }
    filtrarCategorias();
    renderTipos();
    const status = $('cfg-regras-status');
    if (status) status.textContent = `${catalogo.totalRegras || 0} regras e ${catalogo.totalExpressoes || 0} expressões auditadas em ${catalogo.auditadoEm || '23/11/2026'}. Não são o catálogo geral de tipos.`;
    const regras = $('cfg-regras-auditadas');
    if (!regras) return;
    regras.innerHTML = '';
    for (const e of catalogo.expressoes || []) {
      const d = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = e.nome;
      const small = document.createElement('small');
      small.textContent = (e.tiposEquipamento || []).join(' / ') + ((e.condicoesVelocidade || []).length ? ' · ' + e.condicoesVelocidade.join('; ') : '');
      d.append(strong, small);
      regras.appendChild(d);
    }
    filtrarRegras();
  }

  function filtrarLista(box, termo) {
    const q = norm(termo || '').trim();
    let vis = 0;
    if (!box) return { vis, total: 0 };
    const itens = Array.from(box.children);
    for (const it of itens) {
      const ok = !q || q.split(/\s+/).every((p) => norm(it.textContent).includes(p));
      it.classList.toggle('hide', !ok);
      if (ok) vis++;
    }
    return { vis, total: itens.length };
  }
  function filtrarCategorias() {
    const r = filtrarLista($('cfg-categorias'), ($('cfg-busca-categoria') || {}).value);
    const v = $('cfg-categorias-vazio');
    if (v) v.classList.toggle('hide', r.vis > 0 || !r.total);
  }
  function filtrarRegras() {
    const r = filtrarLista($('cfg-regras-auditadas'), ($('cfg-busca-regra') || {}).value);
    const c = $('cfg-regras-contagem');
    if (c) c.textContent = r.total ? `Mostrando ${r.vis} de ${r.total} regras` : '';
  }
  function renderTipos() {
    const box = $('cfg-tipos');
    if (!box) return;
    const busca = norm(($('cfg-busca-tipo') || {}).value);
    const todos = $('cfg-todos-tipos') && $('cfg-todos-tipos').checked;
    const lista = catalogo.tipos.filter((t) => (todos || busca || t.observado || t.conhecido || t.correspondenciaNomeRegra) && (!busca || norm(t.nome + ' ' + t.codigo).includes(busca)))
      .sort((a, b) => Number(!!b.observado) - Number(!!a.observado) || a.nome.localeCompare(b.nome, 'pt-BR') || String(a.codigo).localeCompare(String(b.codigo)));
    box.innerHTML = '';
    for (const t of lista.slice(0, limiteTipos)) {
      const categoria = policy.categoria(t.codigo, t.nome);
      const categoriaLigada = cfg.notificarCategorias[categoria] !== false;
      const valorTipo = Object.prototype.hasOwnProperty.call(cfg.tiposNotificacao, t.codigo)
        ? cfg.tiposNotificacao[t.codigo]
        : undefined;
      const selecionada = valorTipo === true || (valorTipo !== false && categoriaLigada);
      const contexto = t.observado ? 'presente nos filtros/observado' : t.correspondenciaNomeRegra ? 'nome também no inventário de regras' : t.conhecido ? 'tipo conhecido' : 'catálogo geral';
      const efeitoTipo = valorTipo === true && !categoriaLigada
        ? ' · seleção individual ativa'
        : valorTipo === false
          ? ' · silenciado individualmente'
          : !categoriaLigada
            ? ' · categoria silenciada'
            : '';
      const descricao = `Código ${t.codigo} · ${REGRAS[categoria].nome} · ${contexto}${efeitoTipo}`;
      box.appendChild(chaveNotificacao(t.nome, descricao, selecionada, (ligada) => {
        configurar({ tiposNotificacao: { [t.codigo]: ligada } });
        renderAtivos();
      }));
    }
    if (!lista.length) {
      const vazio = document.createElement('p');
      vazio.className = 'fine';
      vazio.textContent = catalogo.tipos.length ? 'Nenhum tipo encontrado. Tente outro nome ou código.' : 'O catálogo ainda está carregando. Alarmes oficiais recebidos continuam entrando na central.';
      box.appendChild(vazio);
    }
    const status = $('cfg-catalogo-status');
    if (status) status.textContent = `${catalogo.tipos.length} tipos no catálogo · ${lista.length} nesta busca · auditoria ${catalogo.auditadoEm || 'indisponível'}. Chaves salvas automaticamente neste aparelho.`;
    const mais = $('cfg-mais-tipos');
    if (mais) mais.classList.toggle('hide', lista.length <= limiteTipos);
  }

  function nomeTipo(codigo) {
    const t = catalogo.tipos.find((r) => String(r.codigo) === String(codigo));
    return t ? t.nome : 'Alarme SGPA ' + codigo;
  }

  function registrarTipo(codigo, nome) {
    let t = catalogo.tipos.find((r) => String(r.codigo) === String(codigo));
    if (!t) {
      t = { codigo: String(codigo), nome: nome || 'Alarme SGPA ' + codigo, observado: true };
      catalogo.tipos.push(t);
    } else if (!t.observado) t.observado = true;
  }

  async function carregarCatalogo() {
    if (carregandoCatalogo) return carregandoCatalogo;
    carregandoCatalogo = fetch('/sgpa-alert-catalog.json', { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error('catálogo indisponível'); return r.json(); })
      .then((j) => {
        if (!Array.isArray(j.tipos)) throw new Error('catálogo inválido');
        const observados = catalogo.tipos.filter((t) => t.observado);
        catalogo = j;
        for (const t of observados) registrarTipo(t.codigo, t.nome);
        renderSelecao();
        return catalogo;
      }).catch((e) => {
        carregandoCatalogo = null;
        renderSelecao();
        return catalogo;
      });
    return carregandoCatalogo;
  }

  async function atualizarCatalogo() {
    if (atualizandoCatalogo) return;
    atualizandoCatalogo = true;
    const botao = $('cfg-atualizar-catalogo');
    if (botao) { botao.disabled = true; botao.textContent = 'Consultando SGPA…'; }
    try {
      await carregarCatalogo();
      const tipos = await chamar('/tipo-alarme?buId=' + encodeURIComponent(ctx.buId) + '&language=pt-br');
      if (!Array.isArray(tipos)) throw new Error('catálogo SGPA inválido');
      const filtros = await chamar('/alarmeOnline/alarme-filtros?buId=' + encodeURIComponent(ctx.buId) + '&language=pt-br').catch(() => null);
      const nomes = new Set((filtros && Array.isArray(filtros.descTpAlarme) ? filtros.descTpAlarme : []).map(norm));
      const anteriores = new Map(catalogo.tipos.map((t) => [String(t.codigo), t]));
      catalogo.tipos = tipos.filter((t) => t.cdTpAlarme != null).map((t) => {
        const codigo = String(t.cdTpAlarme);
        const antigo = anteriores.get(codigo) || {};
        return { codigo, nome: String(t.descTpAlarme || 'Alarme SGPA ' + codigo).trim(), conhecido: !!MAPA_ALARME[codigo], observado: !!antigo.observado || nomes.has(norm(t.descTpAlarme)), correspondenciaNomeRegra: !!antigo.correspondenciaNomeRegra };
      });
      catalogo.auditadoEm = new Date().toLocaleDateString('pt-BR');
      renderSelecao();
    } catch (e) {
      mostrarAviso('Não foi possível atualizar o catálogo agora. A cópia auditada e suas preferências foram mantidas.', 'info');
    } finally {
      atualizandoCatalogo = false;
      if (botao) { botao.disabled = false; botao.textContent = 'Atualizar SGPA'; }
    }
  }


  function preencherVozes() {
    const sel = $('cfg-vozel');
    if (!sel) return;
    const s = sintetizador();
    const vozes = s ? s.getVoices() || [] : [];
    const nativas = vozesNativas();
    sel.innerHTML = '';
    const add = (v, t) => {
      const o = document.createElement('option');
      o.value = v || '';
      o.textContent = t;
      sel.appendChild(o);
    };
    if (nativas.length) {
      for (const v of nativas) {
        const nome = String(v.name || v.id || 'Voz do aparelho');
        add('android:' + nome, `${nome} (Android${v.lang ? ' · ' + v.lang : ''})`);
      }
    } else if (ponteNativa()) add('__nativa__', 'Voz padrão do aparelho (Android)');
    const pt = vozes.filter((v) => /^pt/i.test(v.lang));
    const outras = vozes.filter((v) => !/^pt/i.test(v.lang));
    for (const v of [...pt, ...outras]) add(idVozWeb(v), `${v.name} (${v.lang || 'idioma não informado'})`);
    if (!sel.options.length) add('', 'voz padrão do navegador');

    let escolhida = cfg.vozURI && [...sel.options].some((o) => o.value === cfg.vozURI) ? cfg.vozURI : '';
    if (!escolhida && cfg.vozURI === 'android:') escolhida = '__nativa__';
    if (!escolhida && cfg.vozNome) {
      const web = vozes.find((v) => v.name === cfg.vozNome);
      const nativa = nativas.find((v) => v.name === cfg.vozNome || v.id === cfg.vozNome);
      escolhida = web ? idVozWeb(web) : nativa ? 'android:' + String(nativa.name || nativa.id) : '';
    }
    if (!escolhida) {
      const preferida = pt[0] || vozes[0];
      escolhida = preferida ? idVozWeb(preferida) : sel.options[0].value;
    }
    sel.value = escolhida;
    if (sel.value && typeof sel.onchange === 'function') sel.onchange();
  }

  function preferenciaVoz(value) {
    if (value === '__nativa__') return { vozURI: 'android:', vozNome: '' };
    if (String(value).startsWith('android:')) {
      const id = String(value).slice(8);
      const nativa = vozesNativas().find((v) => String(v.name || v.id) === id);
      return { vozURI: value, vozNome: nativa ? String(nativa.name || nativa.id) : id };
    }
    if (String(value).startsWith('web:')) {
      const s = sintetizador();
      const v = s && (s.getVoices() || []).find((x) => idVozWeb(x) === value);
      return { vozURI: value, vozNome: v ? v.name : '' };
    }
    return { vozURI: '', vozNome: value || '' };
  }

  const OPCOES_REFEICAO = [[0, 'Não controlar'], [30, '30 min'], [45, '45 min'], [60, '1 hora'], [90, '1h30']];
  function renderParadas() {
    const box = $('cfg-paradas');
    if (!box) return;
    box.textContent = '';
    for (const p of policy.PARADAS) {
      const label = document.createElement('label');
      label.className = 'campo';
      const span = document.createElement('span');
      span.textContent = p.nome + ' (min)';
      const input = document.createElement('input');
      input.type = 'number'; input.min = '0'; input.step = '1'; input.inputMode = 'numeric';
      input.dataset.parada = p.id;
      input.value = String(policy.limiteParada(cfg, p));
      label.append(span, input);
      box.appendChild(label);
    }
  }
  function lerParadas() {
    const limites = {};
    document.querySelectorAll('#cfg-paradas input[data-parada]').forEach((i) => {
      const v = Number(i.value);
      if (Number.isFinite(v) && v >= 0) limites[i.dataset.parada] = Math.round(v);
    });
    return { paradasLimites: limites };
  }
  function renderRefeicoes() {
    const box = $('cfg-refeicoes');
    if (!box) return;
    box.innerHTML = '';
    const grupos = Object.assign({}, cfg.refeicaoGrupos || {});
    const lista = [...new Set([...(estado.frentes || []), ...Object.keys(grupos)])].sort();
    if (!lista.length) {
      const i = document.createElement('span');
      i.className = 'fine';
      i.textContent = 'os grupos aparecem aqui depois da primeira leitura da telemetria';
      box.appendChild(i);
    }
    for (const g of lista) {
      const linha = document.createElement('label');
      linha.className = 'refeicao-item';
      const nome = document.createElement('span');
      nome.textContent = g;
      const sel = document.createElement('select');
      sel.dataset.grupo = g;
      sel.setAttribute('aria-label', 'Tempo de refeição: ' + g);
      const atual = Number(grupos[g]) || 0;
      const opcoes = OPCOES_REFEICAO.some(([v]) => v === atual) ? OPCOES_REFEICAO : OPCOES_REFEICAO.concat([[atual, atual + ' min']]);
      for (const [v, t] of opcoes) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = t;
        if (v === atual) o.selected = true;
        sel.appendChild(o);
      }
      linha.append(nome, sel);
      box.appendChild(linha);
    }
    const eq = $('cfg-refeicao-eq');
    if (eq) eq.value = cfg.refeicaoEquipamentos || '';
  }
  function lerRefeicoes() {
    const grupos = {};
    document.querySelectorAll('#cfg-refeicoes select[data-grupo]').forEach((sel) => {
      const v = Number(sel.value) || 0;
      if (v > 0) grupos[sel.dataset.grupo] = v;
    });
    const eq = $('cfg-refeicao-eq');
    return { refeicaoGrupos: grupos, refeicaoEquipamentos: eq ? eq.value.trim() : '' };
  }
  function renderConfig() {
    if (!$('cfg-rpm')) return;
    renderSelecao();
    const valores = {
      'cfg-rpm': cfg.limiteRpm,
      'cfg-ocioso': cfg.minutosOcioso,
      'cfg-sem-ponto': cfg.minutosSemApontamento,
      'cfg-esc1': cfg.escalarUrgenteMin,
      'cfg-esc2': cfg.escalarLiderMin,
      'cfg-lideres': cfg.lideresFrente,
      'cfg-fila-frente': cfg.filaMaxFrente,
      'cfg-sem-colh': cfg.minutosFrenteSemColhedora,
      'cfg-transb-ag': cfg.transbordosAguardandoMax,
      'cfg-turno': cfg.minutosTurno,
      'cfg-cooldown': cfg.cooldownMin,
      'cfg-maxvoz': cfg.maxPorCiclo,
      'cfg-int': cfg.intervaloSeg,
      'cfg-amostras': cfg.amostras,
      'cfg-atraso': cfg.maxAtrasoMin,
      'cfg-rpmoci': cfg.rpmOcioso,
      'cfg-eq': cfg.equipamentos,
      'cfg-vol': cfg.volume,
      'cfg-taxa': cfg.taxa,
      'cfg-tom': cfg.tom,
    };
    for (const [id, v] of Object.entries(valores)) $(id).value = v;
    const checks = {
      'cfg-liga': cfg.ativo,
      'cfg-local': cfg.calcularLocal,
      'cfg-serv': cfg.espelharServidor,
      'cfg-stream': cfg.usarStream,
      'cfg-mapa': cfg.seguirSelecaoMapa,
      'cfg-popup': cfg.popup,
      'cfg-som': cfg.som,
      'cfg-voz': cfg.voz,
      'cfg-notif': cfg.notificacao,
      'cfg-vib': cfg.vibrar,
      'cfg-repete': cfg.repetirVoz,
    };
    for (const [id, v] of Object.entries(checks)) $(id).checked = !!v;
    $('lb-vol').textContent = Number(cfg.volume).toFixed(2);
    $('lb-taxa').textContent = Number(cfg.taxa).toFixed(2);
    $('lb-tom').textContent = Number(cfg.tom).toFixed(2);
    const gerenciarVozes = $('cfg-gerenciar-vozes');
    const ponteVoz = ponteNativa();
    if (gerenciarVozes) gerenciarVozes.classList.toggle('hide', !(ponteVoz && typeof ponteVoz.gerenciarVozes === 'function'));
    preencherVozes();
    renderPushStatus();

    renderRefeicoes();
    renderParadas();
    const box = $('cfg-frentes');
    box.innerHTML = '';
    const lista = (estado.frentes || []).slice();
    if (!lista.length) {
      const i = document.createElement('span');
      i.className = 'fine';
      i.textContent = 'as frentes aparecem aqui depois da primeira leitura da telemetria';
      box.appendChild(i);
    }
    for (const f of lista) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (cfg.frentes.includes(f) ? ' on' : '');
      b.textContent = f;
      b.onclick = () => {
        const set = new Set(cfg.frentes);
        if (set.has(f)) set.delete(f);
        else set.add(f);
        configurar({ frentes: [...set] });
        b.classList.toggle('on', set.has(f));
        renderAtivos();
        renderCabecalho();
        cicloImediato();
      };
      box.appendChild(b);
    }
    $('cfg-aviso').textContent =
      (ponteNativa() ? 'Voz: usando o motor de voz do aparelho (Android). ' : '') +
      (sintetizador() ? '' : 'Este navegador não expõe voz: o alerta sai com som e pop-up. ') +
      'Limite do portal: 10 requisições/min — mantenha o intervalo em 30 s ou mais.';
  }

  function lerConfig() {
    const n = (id, d) => {
      const v = Number($(id).value);
      return Number.isFinite(v) ? v : d;
    };
    const patch = {
      ativo: $('cfg-liga').checked,
      calcularLocal: $('cfg-local').checked,
      espelharServidor: $('cfg-serv').checked,
      usarStream: $('cfg-stream').checked,
      seguirSelecaoMapa: $('cfg-mapa').checked,
      popup: $('cfg-popup').checked,
      som: $('cfg-som').checked,
      voz: $('cfg-voz').checked,
      notificacao: $('cfg-notif').checked,
      vibrar: $('cfg-vib').checked,
      repetirVoz: $('cfg-repete').checked,
      limiteRpm: n('cfg-rpm', 2000),
      minutosOcioso: n('cfg-ocioso', 5),
      minutosSemApontamento: n('cfg-sem-ponto', 5),
      escalarUrgenteMin: n('cfg-esc1', 10),
      escalarLiderMin: n('cfg-esc2', 20),
      lideresFrente: $('cfg-lideres') ? $('cfg-lideres').value.trim() : '',
      filaMaxFrente: n('cfg-fila-frente', 4),
      minutosFrenteSemColhedora: n('cfg-sem-colh', 10),
      transbordosAguardandoMax: n('cfg-transb-ag', 3),
      minutosTurno: n('cfg-turno', 4),
      cooldownMin: n('cfg-cooldown', 10),
      maxPorCiclo: n('cfg-maxvoz', 4),
      intervaloSeg: n('cfg-int', 45),
      amostras: n('cfg-amostras', 1),
      maxAtrasoMin: n('cfg-atraso', 20),
      rpmOcioso: n('cfg-rpmoci', 900),
      equipamentos: $('cfg-eq').value,
      ...lerRefeicoes(),
      ...lerParadas(),
      volume: n('cfg-vol', 1),
      taxa: n('cfg-taxa', 1),
      tom: n('cfg-tom', 1),
      silencioAte: 0,
    };
    const sel = $('cfg-vozel');
    if (sel) Object.assign(patch, preferenciaVoz(sel.value));
    configurar(patch);
    fecharConfig();
    mostrarAviso('Preferências salvas. ' + (patch.ativo ? 'Central ligada.' : 'Central desligada.'), 'info');
    cicloImediato();
  }

  function exportarCsv() {
    const cab = ['quando', 'tipo', 'equipamento', 'descricao', 'operador', 'valor', 'mensagem', 'fonte', 'detalhe', 'fala', 'codigo_sgpa', 'nome_sgpa', 'frente_grupo', 'notificacao_selecionada'];
    const linhas = hist.map((h) => [
      new Date(h.ts).toLocaleString('pt-BR'),
      (REGRAS[h.regra] || {}).nome || h.regra,
      h.equipamento,
      h.descricao,
      h.operador,
      h.valor == null ? '' : h.valor,
      h.texto,
      h.fonte,
      h.detalhe,
      h.fala,
      h.tipoAlarme || '',
      h.nomeAlarme || '',
      h.frente || '',
      h.notificacaoSelecionada === false ? 'não' : 'sim',
    ]);
    const csv = [cab, ...linhas].map((l) => l.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'alertas-monitoramento-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function testar() {
    const e = {
      id: 'TESTE',
      numero: '8833',
      nome: 'Caminhão Transbordo (exemplo)',
      tipo: 'CAMINHAO CANAVIEIRO',
      frente: 'Frente de teste',
      operacao: '925 - Troca de Turno - HR',
      estadoTxt: 'TRABALHANDO',
      operador: 'Rafael Silva',
      operadorBruto: 'Rafael Silva',
      velocidade: 62,
      rpm: 1650,
      motor: true,
      atraso: 0,
      ativo: 'T',
    };
    emitir({
      chave: 'TESTE|velocidade',
      regra: 'velocidade',
      e,
      valor: 85,
      texto: 'excedeu a velocidade a 85 km/h (exemplo)',
      detalhe: 'Alerta de teste — nada aconteceu na frota real',
      inicio: agora(),
      simulado: true,
    });
    setTimeout(() => {
      ativos.delete('TESTE|velocidade');
      renderAtivos();
    }, 45_000);
  }

  /* seleção feita no mapa: o micro-frontend emite strings JSON em 4 eventos */
  function escutarMapa() {
    window.addEventListener('message', (ev) => {
      let dado = ev.data;
      if (typeof dado === 'string') {
        if (dado.length > 20000) return;
        try {
          dado = JSON.parse(dado);
        } catch {
          return;
        }
      }
      if (!dado || typeof dado !== 'object') return;
      const t = String(dado.type || '');
      const p = dado.payload || dado.data || null;
      let id = null;
      if (p && (p.cdEquipamento || p.equipmentId)) id = String(p.cdEquipamento || p.equipmentId);
      else {
        const bruto = JSON.stringify(dado).slice(0, 4000);
        const m = bruto.match(/"(?:cdEquipamento|equipmentId|equipment)"\s*:\s*"?(\d{3,6})"?/);
        if (m) id = m[1];
      }
      if (!id) return;
      if (/event-|online|command|alarm|select|click/i.test(t) || t === 'props') {
        const novaSelecao = !ctx.selecao.has(id);
        ctx.selecao.add(id);
        if (ctx.selecao.size > 30) ctx.selecao.delete(ctx.selecao.values().next().value);
        configurar({ selecaoMapa: [...ctx.selecao] });
        if (cfg.seguirSelecaoMapa && novaSelecao) {
          reconciliarEscopo();
          renderAtivos();
          renderCabecalho();
          cicloImediato();
        }
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* configuração pública e ciclo de vida                               */
  /* ------------------------------------------------------------------ */

  function configurar(patch) {
    const antes = cfg;
    const pushAntes = JSON.stringify(preferenciasPush());
    patch = patch || {};
    const escopoAlterado = ['frentes', 'equipamentos', 'seguirSelecaoMapa', 'selecaoMapa'].some((k) => Object.prototype.hasOwnProperty.call(patch, k));
    const selecaoMapa = Object.prototype.hasOwnProperty.call(patch, 'selecaoMapa')
      ? (Array.isArray(patch.selecaoMapa) ? [...new Set(patch.selecaoMapa.map(String))] : [])
      : (Array.isArray(cfg.selecaoMapa) ? [...new Set(cfg.selecaoMapa.map(String))] : []);
    cfg = policy.normalizeCfg(Object.assign({}, cfg, patch, {
      notificarCategorias: Object.assign({}, cfg.notificarCategorias, patch.notificarCategorias),
      tiposNotificacao: Object.assign({}, cfg.tiposNotificacao, patch.tiposNotificacao),
      selecaoMapa,
    }));
    cfg.incluirOutros = cfg.notificarCategorias.generico;
    if (!Array.isArray(ctx.selecao)) ctx.selecao = new Set(selecaoMapa);
    if (Object.prototype.hasOwnProperty.call(patch, 'selecaoMapa')) ctx.selecao = new Set(selecaoMapa);
    if (escopoAlterado) {
      reconciliarEscopo();
      renderAtivos();
    }
    if (!cfg.ativo || !cfg.voz || patch.notificarCategorias || patch.tiposNotificacao) pararVoz();
    if (!cfg.ativo || !cfg.usarStream) { fecharStream(); estado.stream = 'desligado'; }
    else if ((!antes.ativo || !antes.usarStream) && ctx.token) abrirStream();
    if (!cfg.ativo && el.toasts) el.toasts.innerHTML = '';
    if (cfg.intervaloSeg < 30) cfg.intervaloSeg = 30;
    if (cfg.amostras < 1) cfg.amostras = 1;
    salvar(KEY_CFG, cfg);
    if (JSON.stringify(preferenciasPush()) !== pushAntes) agendarSyncPush();
    if (timer) {
      clearTimeout(timer);
      agendar();
    }
    renderCabecalho();
    return cfg;
  }

  function iniciar(novoCtx) {
    const base =
      novoCtx && novoCtx.props
        ? Object.assign(contextoDa(novoCtx), { renovar: novoCtx.renovar })
        : novoCtx || {};
    ctx = Object.assign({ selecao: new Set() }, ctx, base);
    const selecaoPersistida = Array.isArray(cfg.selecaoMapa) ? cfg.selecaoMapa.map(String) : [];
    const selecaoAtual = ctx.selecao instanceof Set ? [...ctx.selecao] : Array.isArray(ctx.selecao) ? ctx.selecao.map(String) : [];
    ctx.selecao = new Set([...selecaoPersistida, ...selecaoAtual]);
    if (!el.painel) montar();
    if (!iniciar.escutou) {
      iniciar.escutou = true;
      escutarMapa();
      window.addEventListener('bperes-vozes-atualizadas', () => {
        escolherVoz();
        preencherVozes();
      });
      const s = sintetizador();
      if (s) {
        escolherVoz();
        const atualizarVozes = () => {
          escolherVoz();
          preencherVozes();
        };
        if (typeof s.addEventListener === 'function') s.addEventListener('voiceschanged', atualizarVozes);
        else s.onvoiceschanged = atualizarVozes;
      }
      const nativa = ponteNativa();
      if (nativa && typeof nativa.vozes === 'function') {
        let tentativas = 0;
        const procurarVozes = setInterval(() => {
          tentativas++;
          if (vozesNativas().length) {
            preencherVozes();
            clearInterval(procurarVozes);
          } else if (tentativas >= 20) clearInterval(procurarVozes);
        }, 500);
      }
      setInterval(tique, 1000);
      setInterval(() => {
        // watchdog do stream: sem quadro há 3 min, reconecta
        if (cfg.usarStream && cfg.ativo && worker && ultimoQuadro && agora() - ultimoQuadro > 180000) abrirStream();
      }, 20000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { escondidoEm = agora(); return; }
        if (document.visibilityState === 'visible' && cfg.ativo) {
          escolherVoz();
          if (agora() - (estado.ultimoCiclo || 0) > cfg.intervaloSeg * 1000 + 5000) cicloImediato();
          if (escondidoEm && agora() - escondidoEm > 20000) agendarResumoAbertura(4000);
        }
      });
    }
    configurar({});
    inicializarPush();
    carregarCatalogo().catch(() => {});
    abrirStream();
    cicloImediato();
    // ao entrar: espera a primeira leitura (stream + ciclo) e fala os alertas ativos
    agendarResumoAbertura(7000);
    return { versao: VERSAO, config: cfg };
  }

  function cicloImediato() {
    clearTimeout(timer);
    timer = null;
    proximo = agora() + 800;
    setTimeout(() => {
      if (!correndo) ciclo();
    }, 300);
  }

  function parar() {
    configurar({ ativo: false });
    clearTimeout(timer);
    timer = null;
    fecharStream();
    estado.ligado = false;
    renderCabecalho();
  }

  /* a sessão do portal é renovada em segundo plano: trocamos o token sem reiniciar tudo */
  function atualizarSessao(sess) {
    if (!sess || !sess.props) {
      if (sess && sess.erro) {
        estado.sessao = 'expirada';
        estado.proximoErro = 'sessão SGPA: ' + String(sess.erro);
        renderCabecalho();
      }
      return false;
    }
    const mudou = sess.props.token !== ctx.token;
    ctx = Object.assign({}, ctx, contextoDa(sess));
    estado.sessao = 'ativa';
    if (String(estado.proximoErro || '').startsWith('sessão SGPA:')) estado.proximoErro = '';
    if (mudou && cfg.usarStream) abrirStream();
    renderCabecalho();
    return mudou;
  }

  /* monta o contexto do motor a partir da sessão devolvida pela função/`local.js` */
  function contextoDa(sess) {
    const p = sess.props || {};
    const bu = Array.isArray(p.cdUnidadeRegional) && p.cdUnidadeRegional.length ? p.cdUnidadeRegional[0] : 1;
    return {
      token: p.token,
      api: p.urlSgpa,
      props: p,
      buId: Number(bu) || 1,
      cdCliente: Number(p.cdCliente) || 204,
      unidade: p.descUnidade || (sess.who && sess.who.unidade) || '',
      usuario: p.user || (sess.who && sess.who.usuario) || '',
      mapUrl: sess.mapUrl || '',
      portalMap: sess.portalMap || '',
      proxy: true,
      audit: sess.modo !== 'local',
    };
  }

  window.MonitoramentoAlertas = {
    VERSAO,
    iniciar,
    atualizarSessao,
    parar,
    configurar,
    testar,
    falar,
    pararVoz,
    abrirPainel,
    fecharPainel,
    abrirStream,
    ciclo: cicloImediato,
    exportarCsv,
    config: () => cfg,
    estado: () => estado,
    frota: () => [...frota.values()],
    ativos: () => [...ativos.values()],
    historico: () => hist,
    REGRAS,
  };
})();
