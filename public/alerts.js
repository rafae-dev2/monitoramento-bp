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

  const VERSAO = '4.0.0';
  const policy = window.AlertasPolicy;
  const KEY_CFG = 'bperes.alertas.cfg.v2';
  const KEY_HIST = 'bperes.alertas.hist.v2';
  const KEY_ACK = 'bperes.alertas.ack.v2';
  const KEY_TRATATIVAS = 'bperes.coa.tratativas.v1';
  const KEY_CHUVAS = 'bperes.coa.chuvas.v1';
  const KEY_OCIOSIDADE = 'bperes.coa.ocioso-turno.v1';
  const KEY_FINANCEIRO = 'bperes.coa.custo-turno.v1';
  const KEY_CLIMA = 'bperes.coa.clima.v1';
  const KEY_TELAO = 'bperes.visual.telao.v1';
  const KEY_AUDIT_QUEUE = 'bperes.alertas.audit-queue.v1';
  const KEY_PUSH_DEVICE = 'bperes.push.deviceId.v1';
  const KEY_PUSH_SYNC_HASH = 'bperes.push.syncHash.v1';
  const MAX_HIST = 600;
  const JANELA_CORRELACAO_905_MS = 3000;
  const MAX_IDADE_POSICAO_FRENTE_MS = 5 * 60_000;
  const MAX_DISTANCIA_FRENTE_M = 1000;
  const MIN_REFERENCIAS_FRENTE = 3;
  const MIN_CONSENSO_FRENTE = 0.75;
  const MIN_MARGEM_FRENTE = 2;
  const PRECISAO_MIN_GEOHASH = 7;
  const MONITORAMENTO_API = 'https://api-usa.saas-solinftec.com/monitoramento/v2';

  const $ = (id) => document.getElementById(id);
  const agora = () => Date.now();

  /* Tema visual por aparelho: 'vidro' (Liquid Glass) ou 'black' (Tema Black OLED).
     Aceita 'solido' legado migrando para 'black'. Fica fora do cfg sincronizado. */
  const KEY_ACABAMENTO = 'bperes.visual.acabamento.v1';
  function normalizarTema(valor) {
    return valor === 'black' || valor === 'solido' ? 'black' : 'vidro';
  }
  function acabamentoSalvo() {
    try {
      const v = localStorage.getItem(KEY_ACABAMENTO);
      if (v === 'vidro' || v === 'black' || v === 'solido') return normalizarTema(v);
    } catch {
      /* sem storage */
    }
    try {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return 'black';
    } catch {
      /* matchMedia indisponível */
    }
    return 'vidro';
  }
  function sincronizarControlesTema(v) {
    const sel = document.getElementById('cfg-acabamento');
    if (sel && sel.value !== v) sel.value = v;
    const botoes = document.querySelectorAll('[data-tema]');
    for (const btn of botoes) {
      btn.setAttribute('aria-pressed', btn.dataset.tema === v ? 'true' : 'false');
    }
  }
  function aplicarAcabamento(valor, persistir) {
    const v = normalizarTema(valor);
    document.documentElement.dataset.acabamento = v;
    sincronizarControlesTema(v);
    if (persistir) {
      try {
        localStorage.setItem(KEY_ACABAMENTO, v);
      } catch {
        /* sem storage */
      }
    }
    return v;
  }
  aplicarAcabamento(acabamentoSalvo(), false);
  document.addEventListener('click', (ev) => {
    const btn = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-tema]') : null;
    if (!btn) return;
    ev.stopPropagation();
    aplicarAcabamento(btn.dataset.tema, true);
  });
  let prazoRequisicaoMs = 15_000;

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
    emergencia: { id: 'emergencia', nome: 'Emergência / Incêndio / Bombeiro', icone: '🔥', cor: '#dc2626', severidade: 4 },
    velocidade: { id: 'velocidade', nome: 'Velocidade excedida', icone: '🚨', cor: '#ef4444', severidade: 3 },
    rpm: { id: 'rpm', nome: 'RPM máxima do motor', icone: '⚙️', cor: '#f97316', severidade: 3 },
    turno: { id: 'turno', nome: 'Preso em troca de turno', icone: '⏱️', cor: '#eab308', severidade: 2 },
    ocioso: { id: 'ocioso', nome: 'Motor ocioso', icone: '🔌', cor: '#38bdf8', severidade: 2 },
    ociosoSemApontamento: { id: 'ociosoSemApontamento', nome: 'Motor ocioso sem apontamento', icone: '🔌', cor: '#d97706', severidade: 2 },
    motorCondicao: { id: 'motorCondicao', nome: 'Motor ligado — condição combinada', icone: 'M', cor: '#06b6d4', severidade: 2 },
    aguardandoCaminhao: { id: 'aguardandoCaminhao', nome: 'Aguardando caminhão', icone: 'T', cor: '#eab308', severidade: 2 },
    aguardandoBasculamento: { id: 'aguardandoBasculamento', nome: 'Aguardando basculamento (inferido)', icone: '↻', cor: '#d97706', severidade: 2 },
    frenteDividida: { id: 'frenteDividida', nome: 'Frente dividida (validar FUT)', icone: '⇄', cor: '#ef4444', severidade: 3 },
    refeicao: { id: 'refeicao', nome: 'Refeição excedida', icone: '🍽️', cor: '#ea580c', severidade: 2 },
    semApontamento: { id: 'semApontamento', nome: 'Sem apontamento', icone: '📝', cor: '#f97316', severidade: 2 },
    paradaImprodutiva: { id: 'paradaImprodutiva', nome: 'Parada improdutiva', icone: '⏸️', cor: '#d97706', severidade: 2 },
    gestaoFrente: { id: 'gestaoFrente', nome: 'Gestão da frente', icone: '🚩', cor: '#f59e0b', severidade: 3 },
    telemetriaMuda: { id: 'telemetriaMuda', nome: 'Frota muda (sem telemetria)', icone: '📡', cor: '#f59e0b', severidade: 3 },
    qualidadeColheita: { id: 'qualidadeColheita', nome: 'Qualidade de colheita (velocidade)', icone: '🌾', cor: '#eab308', severidade: 2 },
    inconsistenciaApontamento: { id: 'inconsistenciaApontamento', nome: 'Falso apontamento (inconsistência)', icone: '🕵️', cor: '#f97316', severidade: 2 },
    riscoMoenda: { id: 'riscoMoenda', nome: 'Risco de moenda (entrega abaixo da meta)', icone: '🏭', cor: '#ef4444', severidade: 3 },
    bateVolta: { id: 'bateVolta', nome: 'Bate-volta excedido (caminhão)', icone: '🛣️', cor: '#f59e0b', severidade: 2 },
    manutencaoPreditiva: { id: 'manutencaoPreditiva', nome: 'Manutenção preditiva (falha recorrente)', icone: '🔧', cor: '#ef4444', severidade: 3 },
    generico: { id: 'generico', nome: 'Alarme do portal', icone: '⚠️', cor: '#94a3b8', severidade: 1 },
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
    glossarioFala: '', // "AG=Aguardando; HR=" (termo=como falar; vazio omite o termo)
    refeicaoEquipamentos: '', // "6614=30, 8833=60": prevalece sobre o grupo
    escalarUrgenteMin: 10, // minutos após a tolerância: repete como urgente
    escalarLiderMin: 20, // minutos após a tolerância: pede acionar o líder
    lideresFrente: '', // "Frente 1=João; Frente 2=Pedro"
    filaMaxFrente: 4, // caminhões/transbordos em fila/aguardando carregamento na mesma frente (0 = desliga)
    gestaoFrenteAtiva: true, // chave geral dos alertas “Atenção gestão”
    minutosFrenteSemColhedora: 10, // todas as colhedoras da frente paradas (0 = desliga)
    transbordosAguardandoMax: 3, // transbordos aguardando colhedora na mesma frente (0 = desliga)
    minutosFrotaMuda: 25, // minutos sem comunicação de telemetria para alertar frota muda (0 = desliga)
    velMaxColheita: 7.5, // km/h máximo técnico em colheita (0 = desliga)
    slaAlertaMin: 10, // meta de SLA do COA em minutos para destaque no cartão
    auditarApontamento: true, // auditoria automática de falso apontamento (operação vs. telemetria)
    minutosInconsistencia: 8, // minutos em inconsistência de apontamento antes de alertar (0 = desliga)
    minutosBateVoltaMax: 55, // minutos máximos em transporte/viagem antes de alertar caminhão retido (0 = desliga)
    manutencaoPreditivaAtiva: true, // alerta falha mecânica/RPM recorrente (>= 3 em 4h)
    metaMoagemTonHora: 420, // t/h meta da moenda da usina (0 = desliga)
    tonHoraPorColhedora: 65, // produtividade média estimada por colhedora colhendo (t/h)
    custoHoraColhedora: 850, // R$/h parada improdutiva colhedora
    custoHoraTransbordo: 260, // R$/h parada improdutiva transbordo/trator
    custoHoraCaminhao: 220, // R$/h parada improdutiva caminhão canavieiro
    custoHoraApoio: 180, // R$/h veículo de apoio
    custoLitroDiesel: 6.2, // R$/L diesel agrícola
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
    perfilVoz: 'padrao',
    estiloToque: 'gongo-coa',
    volume: 1,
    taxa: 1,
    tom: 1,
    vibrar: true,
    notificacao: false,
    repetirVoz: false,
    sentinelaSegundoPlano: true,
    manterTelaAtiva: true,
    alertaQuedaSgpa: true,
    reescalarCriticos: true,
    reescalarCriticosMin: 5,
    silencioAte: 0,
  };

  /* ------------------------------------------------------------------ */
  /* estado                                                             */
  /* ------------------------------------------------------------------ */

  let cfg = policy.normalizeCfg(Object.assign({}, PADRAO, carregar(KEY_CFG, PADRAO)));
  let hist = carregar(KEY_HIST, []);
  let acks = carregar(KEY_ACK, {});
  let tratativas = carregar(KEY_TRATATIVAS, {});
  let chuvas = carregar(KEY_CHUVAS, {});
  let ociosidadeTurno = carregar(KEY_OCIOSIDADE, { turnoChave: '', itens: {} });
  let custoImprodutivoTurno = carregar(KEY_FINANCEIRO, { turnoChave: '', paradoRs: 0, porClasse: {} });
  let climaCoa = carregar(KEY_CLIMA, { tempC: 29, umidadePct: 44, ventoKmH: 16, chuvaMm: 0, atualizadoEm: 0, origem: 'manual' });
  let telaoAtivo = false;
  let emergenciaAtiva = null;
  let ultimoAcumuloOciosoTs = 0;
  let ultimoAcumuloCustoTs = 0;
  let ultimaRespostaAloCoa = '';
  let reconhecedorVozAtivo = null;
  let ultimoResumoCtt = { frentes: [], sugestoesBalanceamento: [], frotasMudas: [], totais: {} };
  const TAGS_TRATATIVA_COA = ['Cobrado no rádio', 'Mecânica acionada', 'Comboio acionado', 'Líder ciente', 'Chuva/Clima', 'Falso alarme'];
  let ctx = { selecao: new Set(Array.isArray(cfg.selecaoMapa) ? cfg.selecaoMapa.map(String) : []), props: null };
  let timer = null;
  let correndo = false;
  let proximo = 0;
  let worker = null;
  let workerRelogio = null;
  let streamRetryTimer = null;
  let ultimoSinalStream = 0;
  let ultimoQuadro = 0;
  let tentativasStream = 0;
  let renovacaoPendente = null;
  let ultimaComunicacaoSgpa = 0;
  let quedaSgpaAtiva = false;
  let ultimoAvisoQuedaSgpa = 0;
  let wakeLockAtivo = null;
  let sentinelaAudio = null;
  let janelaPip = null;
  let ultimaFalaEmitida = null;

  const frota = new Map(); // cdEquipamento => leitura consolidada
  const estados = new Map(); // "equipamento|regra" => máquina de estados
  const ativos = new Map(); // chave => alerta exibido
  const gestaoUltimoDisparo = new Map(); // cooldown por frente/regra, mesmo se a contagem oscilar
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
    fontes: {
      telemetria: { status: 'aguardando', ultimaSucesso: 0, erro: '' },
      alarmes: { status: 'aguardando', ultimaSucesso: 0, erro: '' },
    },
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

  function podarAcks(mapa) {
    const limite = agora() - 2 * 3600_000;
    let removeu = false;
    if (!mapa || typeof mapa !== 'object') return {};
    for (const k of Object.keys(mapa)) {
      if (!(Number(mapa[k]) > limite)) {
        delete mapa[k];
        removeu = true;
      }
    }
    if (removeu) salvar(KEY_ACK, mapa);
    return mapa;
  }
  acks = podarAcks(acks);

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
      glossarioFala: String(cfg.glossarioFala || '').slice(0, 2000),
      seguirSelecaoMapa: !!cfg.seguirSelecaoMapa,
      selecaoMapa,
    };
  }

  function assinaturaSyncPush(endpoint) {
    return String(endpoint || '') + '|' + JSON.stringify(preferenciasPush());
  }

  function gravarAssinaturaSyncPush(endpoint) {
    try {
      localStorage.setItem(KEY_PUSH_SYNC_HASH, assinaturaSyncPush(endpoint));
    } catch {
      /* segue sem cache local do hash */
    }
  }

  function limparAssinaturaSyncPush() {
    try {
      localStorage.removeItem(KEY_PUSH_SYNC_HASH);
    } catch {
      /* nada a limpar */
    }
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
        limparAssinaturaSyncPush();
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
        limparAssinaturaSyncPush();
        pushStatusText = 'Não há uma assinatura Push ativa neste aparelho.';
        return;
      }
      pushStatusText = 'Sincronizando as preferências deste aparelho…';
      renderPushStatus();
      await enviarPreferenciaPush({ action: 'sync', deviceId: idDispositivoPush(), preferences: preferenciasPush() });
      gravarAssinaturaSyncPush(subscription.endpoint);
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
          let ultimoHash = '';
          try { ultimoHash = localStorage.getItem(KEY_PUSH_SYNC_HASH) || ''; } catch { /* sem storage */ }
          if (ultimoHash && ultimoHash === assinaturaSyncPush(subscription.endpoint)) {
            pushRegistered = true;
            pushStatusText = 'Push ativo neste aparelho. As preferências estão sincronizadas.';
          } else {
            pushStatusText = 'Assinatura Push encontrada. Sincronizando as preferências deste aparelho…';
            renderPushStatus();
            await syncPushAgora();
          }
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
      gravarAssinaturaSyncPush(subscription.endpoint);
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
      limparAssinaturaSyncPush();
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

  let formatadorFusoTenant = null;
  function horarioTenantParaMs(ano, mes, dia, hora, minuto, segundo, milissegundo = 0) {
    const valores = [ano, mes, dia, hora, minuto, segundo, milissegundo].map(Number);
    if (valores.some((v) => !Number.isInteger(v))) return null;
    const [y, mo, d, h, mi, s, ms] = valores;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59 || ms < 0 || ms > 999) return null;
    const nominal = Date.UTC(y, mo - 1, d, h, mi, s);
    const validacao = new Date(nominal);
    if (validacao.getUTCFullYear() !== y || validacao.getUTCMonth() !== mo - 1 || validacao.getUTCDate() !== d) return null;
    try {
      if (!formatadorFusoTenant) {
        formatadorFusoTenant = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Sao_Paulo', calendar: 'gregory', numberingSystem: 'latn',
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
          minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        });
      }
      let utc = nominal;
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        const p = Object.fromEntries(formatadorFusoTenant.formatToParts(new Date(utc))
          .filter((parte) => parte.type !== 'literal').map((parte) => [parte.type, parte.value]));
        const representado = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
        const proximo = nominal + (utc - representado);
        if (!Number.isFinite(proximo) || proximo === utc) break;
        utc = proximo;
      }
      return utc + ms;
    } catch {
      // Fuso atual do tenant: UTC−03:00. Usado apenas em navegadores sem IANA Intl.
      return nominal + 3 * 60 * 60_000 + ms;
    }
  }
  /* "23/11/2026 06:53:46" (dd/mm/aaaa, horário do tenant) => ms */
  function dataHorario(txt) {
    const m = String(txt || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return null;
    const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
    return horarioTenantParaMs(m[3], m[2], m[1], m[4], m[5], m[6], ms);
  }

  /* [2026,11,23,6,51,14] (array do /alarmeOnline, fuso do tenant) => ms */
  function dataArray(a) {
    if (!Array.isArray(a) || a.length < 3) return null;
    return horarioTenantParaMs(a[0], a[1] || 1, a[2], a[3] || 0, a[4] || 0, a[5] || 0, 0);
  }
  function timestampEquipamento(valor) {
    if (Array.isArray(valor)) return dataArray(valor);
    if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
    const texto = String(valor || '').trim();
    if (!texto) return null;
    const local = dataHorario(texto);
    if (local) return local;
    const isoLocal = texto.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/);
    if (isoLocal) {
      const ms = isoLocal[7] ? Number((isoLocal[7] + '00').slice(0, 3)) : 0;
      return horarioTenantParaMs(isoLocal[1], isoLocal[2], isoLocal[3], isoLocal[4], isoLocal[5], isoLocal[6], ms);
    }
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(texto)) return null;
    const parseado = Date.parse(texto);
    return Number.isFinite(parseado) ? parseado : null;
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

  async function requisitarJson(url, opcoes, origem) {
    const controle = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let expirou = false;
    let temporizador = null;
    const pedido = (async () => {
      const res = await fetch(url, Object.assign({}, opcoes || {}, { signal: controle ? controle.signal : undefined }));
      const texto = await res.text();
      let json = null;
      try { json = texto ? JSON.parse(texto) : null; } catch { /* preserva o código HTTP mesmo sem JSON */ }
      return { res, json };
    })();
    const limite = new Promise((_, rejeitar) => {
      temporizador = setTimeout(() => {
        expirou = true;
        if (controle) controle.abort();
        const erro = new Error(`${origem || 'consulta SGPA'} sem resposta em ${Math.ceil(prazoRequisicaoMs / 1000)} segundos`);
        erro.code = 'ETIMEDOUT';
        rejeitar(erro);
      }, prazoRequisicaoMs);
    });
    try {
      return await Promise.race([pedido, limite]);
    } catch (erro) {
      if (expirou && (!erro || erro.code !== 'ETIMEDOUT')) {
        const timeout = new Error(`${origem || 'consulta SGPA'} excedeu o tempo limite`);
        timeout.code = 'ETIMEDOUT';
        throw timeout;
      }
      throw erro;
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }

  async function chamar(caminho) {
    if (!ctx.api) throw new Error('sem sessão com o portal');
    const url = ctx.api.replace(/\/$/, '') + caminho;
    let resposta;
    try {
      resposta = await requisitarJson(url, { method: 'GET', headers: cabecalhos(), cache: 'no-store' }, 'API SGPA');
    } catch (e) {
      if (ctx.proxy && (!e || e.code !== 'ETIMEDOUT')) return chamarProxy(caminho); // rede/CORS contra a API: vai pelo servidor
      throw e;
    }
    if (resposta.res.status === 401) {
      await renovarToken();
      const deNovo = await requisitarJson(url, { method: 'GET', headers: cabecalhos(), cache: 'no-store' }, 'API SGPA após renovar sessão');
      if (!deNovo.res.ok) throw new Error('HTTP ' + deNovo.res.status);
      return deNovo.json;
    }
    if (resposta.res.status === 429) {
      estado.backoff = 90_000;
      throw new Error('limite de requisições do portal (10/min) atingido — reduzindo o ritmo');
    }
    if (!resposta.res.ok) throw new Error('HTTP ' + resposta.res.status);
    return resposta.json;
  }

  async function chamarProxy(caminho, tentarRenovar = true) {
    const headers = { accept: 'application/json' };
    if (typeof window !== 'undefined' && window.__APP_KEY) headers['x-app-key'] = String(window.__APP_KEY);
    const resposta = await requisitarJson('/.netlify/functions/session?acao=dados&rota=' + encodeURIComponent(caminho), {
      headers,
      cache: 'no-store',
    }, 'proxy SGPA');
    const { res, json } = resposta;
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

  function marcarComunicacaoSgpa(ts = agora()) {
    ultimaComunicacaoSgpa = ts;
    if (quedaSgpaAtiva) {
      quedaSgpaAtiva = false;
      ultimoAvisoQuedaSgpa = 0;
      mostrarAviso('Comunicação com o SGPA restabelecida.', 'info');
      if (cfg.ativo && cfg.voz && cfg.alertaQuedaSgpa !== false && ts >= (Number(cfg.silencioAte) || 0)) {
        falar('Comunicação com o S G P A restabelecida.', { oficial: true });
      }
      renderCabecalho();
    }
  }

  function verificarSaudeComunicacaoSgpa(ts = agora()) {
    if (!cfg.ativo || cfg.alertaQuedaSgpa === false || !ultimaComunicacaoSgpa) return;
    const streamVivo = estado.stream === 'ao vivo' && ultimoSinalStream > 0 && ts - ultimoSinalStream < 90_000;
    if (streamVivo) return;
    const semSinalMs = ts - ultimaComunicacaoSgpa;
    const falhando = estado.erros >= 2 || estado.sessao === 'expirada' || estado.sessao === 'sem autorização';
    if (!falhando || semSinalMs < 120_000) return;
    if (ultimoAvisoQuedaSgpa && ts - ultimoAvisoQuedaSgpa < 5 * 60_000) return;
    quedaSgpaAtiva = true;
    ultimoAvisoQuedaSgpa = ts;
    const minutos = Math.max(2, Math.round(semSinalMs / 60_000));
    mostrarAviso(`Atenção COA: sem comunicação com o SGPA há ${minutos} minutos. Verifique rede ou sessão.`, 'erro');
    if (ts >= (Number(cfg.silencioAte) || 0)) {
      if (cfg.som) tocar(3, true);
      if (cfg.voz) {
        falar(`Atenção C O A: sem comunicação com o S G P A há ${minutos} minutos. Verificar conexão.`, { oficial: true });
      }
    }
    renderCabecalho();
  }

  function aoPulsoSegundoPlano() {
    if (!cfg.ativo) return;
    tique();
    if (!correndo && proximo > 0 && agora() >= proximo + 1500) {
      ciclo();
    }
  }

  function encerrarRelogioIsolado() {
    if (!workerRelogio) return;
    const w = workerRelogio;
    workerRelogio = null;
    try { w.postMessage({ type: 'parar-relogio' }); } catch { /* encerrando */ }
    try { w.terminate(); } catch { /* já encerrado */ }
    if (w._blobUrl) {
      try { URL.revokeObjectURL(w._blobUrl); } catch { /* ignora */ }
    }
  }

  function sincronizarRelogioSegundoPlano() {
    if (!iniciar.escutou || !cfg.ativo || cfg.sentinelaSegundoPlano === false || typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      encerrarRelogioIsolado();
      return;
    }
    if (worker) {
      encerrarRelogioIsolado();
      return;
    }
    if (workerRelogio) return;
    let blobUrl = '';
    try {
      const src = "let t=null,ms=0;function loop(){if(!ms)return;t=setTimeout(()=>{t=null;if(!ms)return;self.postMessage({type:'pulso',ts:Date.now()});loop();},ms);}self.onmessage=(e)=>{const m=(e&&e.data)||{};if(m.type==='relogio'){if(t)clearTimeout(t);ms=Math.max(250,Number(m.intervaloMs)||5000);loop();}else if(m.type==='parar-relogio'){ms=0;if(t)clearTimeout(t);t=null;}};";
      blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      const w = new Worker(blobUrl);
      w._blobUrl = blobUrl;
      w.onmessage = (ev) => {
        if (ev && ev.data && ev.data.type === 'pulso') aoPulsoSegundoPlano();
      };
      w.onerror = (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (workerRelogio === w) encerrarRelogioIsolado();
      };
      w.postMessage({ type: 'relogio', intervaloMs: 5000 });
      workerRelogio = w;
    } catch {
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch { /* ignora */ }
      }
      workerRelogio = null;
    }
  }

  function abrirStream() {
    clearTimeout(streamRetryTimer);
    streamRetryTimer = null;
    fecharStream();
    if (!cfg.ativo || !cfg.usarStream || typeof Worker === 'undefined' || !ctx.token) {
      estado.stream = !cfg.ativo || !cfg.usarStream ? 'desligado' : 'indisponível';
      sincronizarRelogioSegundoPlano();
      renderCabecalho();
      return;
    }
    const corpo = {
      cdCliente: [Number(ctx.cdCliente) || 204],
      cdUnidade: [Number(ctx.buId) || 1],
    };
    const url = MONITORAMENTO_API + '/subscribe-live?buId=' + encodeURIComponent(ctx.buId) + '&language=pt-br';
    let workerAtual;
    try {
      workerAtual = new Worker('/alerts-stream.js');
      worker = workerAtual;
      encerrarRelogioIsolado();
    } catch {
      estado.stream = 'indisponível';
      estado.proximoErro = 'não foi possível iniciar o Worker do stream';
      agendarReconexaoStream(60_000);
      renderCabecalho();
      return;
    }
    ultimoSinalStream = agora();
    estado.stream = 'conectando';
    workerAtual.onmessage = (ev) => {
      const m = (ev && ev.data) || {};
      if (m.type === 'pulso') {
        if (workerAtual === worker) aoPulsoSegundoPlano();
        return;
      }
      if (m.type === 'quadros') {
        if (workerAtual === worker) {
          ultimoQuadro = agora();
          ultimoSinalStream = ultimoQuadro;
          tentativasStream = 0;
          estado.stream = 'ao vivo';
          marcarComunicacaoSgpa(ultimoQuadro);
        }
        processarQuadros(m.itens);
      } else if (m.type === 'estado') {
        if (workerAtual !== worker) {
          if (m.status === 'fechado') {
            clearTimeout(workerAtual._timerFechamento);
            try { workerAtual.terminate(); } catch { /* já encerrado */ }
          }
          return;
        }
        estado.stream = m.status;
        if (m.status === 'ao vivo') {
          ultimoSinalStream = agora();
          marcarComunicacaoSgpa(ultimoSinalStream);
        }
        if (m.status === 'erro' || m.status === 'fechado') {
          const reconectar = (espera) => agendarReconexaoStream(espera);
          if (m.statusCode === 401) renovarToken().catch(() => reconectar());
          else if (m.statusCode === 403) {
            estado.sessao = 'sem autorização';
            estado.proximoErro = 'o SGPA recusou a autorização do stream (403)';
            reconectar(60_000);
          } else {
            estado.proximoErro = m.mensagem || 'stream encerrado; tentando reconectar';
            reconectar();
          }
        }
      } else if (m.type === 'aviso') {
        estado.proximoErro = m.mensagem || m.type;
      }
      renderCabecalho();
    };
    workerAtual.onerror = () => {
      if (workerAtual !== worker) {
        try { workerAtual.terminate(); } catch { /* já encerrado */ }
        return;
      }
      estado.stream = 'erro';
      estado.proximoErro = 'erro inesperado no Worker do stream';
      renderCabecalho();
      agendarReconexaoStream();
    };
    workerAtual.postMessage({ type: 'abrir', url, token: ctx.token, corpo });
    if (cfg.sentinelaSegundoPlano !== false) {
      workerAtual.postMessage({ type: 'relogio', intervaloMs: 5000 });
    }
  }

  function agendarReconexaoStream(esperaForcada) {
    if (streamRetryTimer || !cfg.usarStream || !cfg.ativo) return;
    const espera = Number.isFinite(esperaForcada)
      ? Math.max(1000, esperaForcada)
      : Math.min(60_000, 2000 * 2 ** tentativasStream);
    tentativasStream++;
    streamRetryTimer = setTimeout(() => {
      streamRetryTimer = null;
      if (cfg.usarStream && cfg.ativo) abrirStream();
    }, espera);
  }

  function fecharStream() {
    clearTimeout(streamRetryTimer);
    streamRetryTimer = null;
    const anterior = worker;
    worker = null;
    if (anterior) {
      try {
        anterior.postMessage({ type: 'parar-relogio' });
        anterior.postMessage({ type: 'fechar' });
        anterior._timerFechamento = setTimeout(() => {
          try { anterior.terminate(); } catch { /* já encerrado */ }
        }, 1000);
      } catch {
        try { anterior.terminate(); } catch { /* já encerrado */ }
      }
    }
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
      const existente = frota.get(id) || {};
      const frenteAtual = frenteDoRegistro(q, existente, false);
      const grupoAtual = grupoDoRegistro(q, existente);
      const candidato = {
        tipo: q.descTpEquipamento || existente.tipo,
        tipoCompleto: q.descFullTpEquipamento || existente.tipoCompleto,
        nome: q.descEquipamento || existente.nome,
        frente: frenteAtual,
        grupoEquipamento: grupoAtual,
      };
      if (!frenteSelecionada({ frente: frenteAtual, frenteInferida: existente.frenteInferida, grupoEquipamento: grupoAtual }) && !manterParaInferencia(candidato)) {
        atualizarFrenteAtivos(id, frenteAtual, grupoAtual);
        frota.delete(id);
        reconciliarEscopo();
        continue;
      }
      const e = mesclar(id);
      if (q.descEquipamento) {
        const p = partirEquipamento(q.descEquipamento, id);
        e.nome = p.nome || e.nome;
        e.numero = p.numero || e.numero;
      }
      if (q.descTpEquipamento) e.tipo = q.descTpEquipamento;
      if (q.descFullTpEquipamento) e.tipoCompleto = q.descFullTpEquipamento;
      e.frente = frenteAtual;
      e.grupoEquipamento = grupoAtual;
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
      e.ativo = String(q.fgMonitoramentoAtivo || e.ativo || 'T');
      if (q.deleted === true) {
        frota.delete(e.id);
        continue;
      }
      const ts = timestampEquipamento(q.dtHrLocal);
      if (ts) e.tsEquipamento = ts;
      if (Object.prototype.hasOwnProperty.call(q, 'geohash')) {
        const hash = String(q.geohash || '').trim().toLowerCase();
        e.geohash = hash;
        e.localizacaoTs = hash && ts ? ts : 0;
      }
      e.vistoEm = agora();
      if (!e.fonte) e.fonte = 'stream';
      e.ultimaObservacaoFonte = ts > 0 ? `sgpa:${ts}` : `stream:${++sequenciaStreamObservacao}:${id}`;
      const observacaoAnterior = observacaoEmAvaliacao;
      const avaliacaoAnterior = avaliacaoSoTempo;
      observacaoEmAvaliacao = e.ultimaObservacaoFonte;
      avaliacaoSoTempo = false;
      try {
        if (q.descOperacao !== undefined && dentroDoEscopo(e)) {
          regraSemApontamento(e, agora());
          if (!ehCaminhaoAguardandoCarregamento(e)) regraParada(e, agora());
          regraRefeicao(e, agora());
        }
      } finally {
        observacaoEmAvaliacao = observacaoAnterior;
        avaliacaoSoTempo = avaliacaoAnterior;
      }
    }
    // Avalia o 905 após consolidar o lote inteiro para não dispará-lo antes de
    // processar o caminhão da mesma frente que veio no mesmo quadro do stream.
    const tsAguardando = agora();
    atualizarFrentesInferidas(tsAguardando);
    const observacaoAnterior = observacaoEmAvaliacao;
    const avaliacaoAnterior = avaliacaoSoTempo;
    try {
      avaliacaoSoTempo = false;
      for (const e of frota.values()) {
        if (!dentroDoEscopo(e)) continue;
        observacaoEmAvaliacao = e.ultimaObservacaoFonte || (Number(e.tsEquipamento) > 0
          ? `sgpa:${Number(e.tsEquipamento)}`
          : `quadro:${Number(e.vistoEm) || 0}:${e.id}`);
        if (ehCaminhaoAguardandoCarregamento(e)) regraParada(e, tsAguardando);
        const stCaminhao = estados.get(e.id + '|aguardandoCaminhao');
        const stBasculamento = estados.get(e.id + '|aguardandoBasculamento');
        const stFrenteDividida = estados.get(e.id + '|frenteDividida');
        if (policy.frenteDividida(e) || stFrenteDividida) regraFrenteDividida(e, tsAguardando);
        if (policy.aguardandoCaminhao(e) || stCaminhao || stBasculamento) regraAguardandoCaminhao(e, tsAguardando);
      }
    } finally {
      observacaoEmAvaliacao = observacaoAnterior;
      avaliacaoSoTempo = avaliacaoAnterior;
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
      descFrente: q.descFrente || e.frente || undefined,
      descGrupoEquipamento: q.descGrupoEquipamento || e.grupoEquipamento || undefined,
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
        grupoEquipamento: '',
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
      const existente = frota.get(id) || {};
      const frenteAtual = frenteDoRegistro(row, existente, true);
      const grupoAtual = grupoDoRegistro(row, existente);
      const candidato = {
        tipo: row.descTpEquipamento || existente.tipo,
        tipoCompleto: row.descFullTpEquipamento || existente.tipoCompleto,
        nome: row.descEquipamento || existente.nome,
        frente: frenteAtual,
        grupoEquipamento: grupoAtual,
      };
      if (!frenteSelecionada({ frente: frenteAtual, frenteInferida: existente.frenteInferida, grupoEquipamento: grupoAtual }) && !manterParaInferencia(candidato)) {
        atualizarFrenteAtivos(id, frenteAtual, grupoAtual);
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
      e.frente = frenteAtual;
      e.grupoEquipamento = grupoAtual;
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
      e.velocidadeTs = e.velocidade === null ? 0 : (timestampEquipamento(row.dtHrLocal) || agora());
      e.rpm = num(row.vlParametro4);
      e.motor = String(row.vlEd1 || '0') === '1';
      e.atraso = segundosAtraso(row.vlTempoSemComunicacao);
      e.ativo = row.fgMonitoramentoAtivo || e.ativo;
      e.local = [row.cdFazenda, row.cdZona, row.cdTalhao]
        .map((v) => (v && String(v) !== '0' ? String(v) : ''))
        .filter(Boolean)
        .join(' / ');
      const ts = timestampEquipamento(row.dtHrLocal);
      if (ts) e.tsEquipamento = ts;
      const hash = String(row.geohash || '').trim().toLowerCase();
      if (hash) {
        e.geohash = hash;
        e.localizacaoTs = ts || 0;
      }
      e.fonte = 'telemetria';
      e.vistoEm = agora();
    }
    atualizarFrentesInferidas(agora());
    estado.frentes = [...frentes].sort();
    // largura de banda/limite de requisições: só guarda o que a unidade tem hoje
    const corte = agora() - 30 * 60000;
    for (const [id, e] of frota) if (e.vistoEm < corte && !ativos.has(id + '|velocidade')) frota.delete(id);
  }

  function frenteDoRegistro(registro, anterior, limparAusente) {
    if (registro && registro.descFrente != null) {
      const direta = String(registro.descFrente).trim();
      if (direta || limparAusente) return direta;
    }
    return limparAusente ? '' : String(anterior && anterior.frente || '').trim();
  }

  function grupoDoRegistro(registro, anterior) {
    if (registro && registro.descGrupoEquipamento != null) return String(registro.descGrupoEquipamento).trim();
    return String(anterior && anterior.grupoEquipamento || '').trim();
  }

  function frenteConhecida(valor) {
    const m = norm(valor).match(/^frente\s*([123])$/);
    return m ? 'Frente ' + m[1] : '';
  }

  function equipamentoReferenciaFrente(e) {
    if (!e) return false;
    const tipo = norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' '));
    const frente = frenteConhecida(e.frente) || frenteConhecida(e.grupoEquipamento);
    return !!frente && /colhedora|transbordo|trator/.test(tipo) && !/caminh|munck|cacamb|bombeir/.test(tipo);
  }

  function manterParaInferencia(e) {
    return policy.caminhaoCanavieiroTerceiro(e) || equipamentoReferenciaFrente(e);
  }

  function ehCaminhaoAguardandoCarregamento(e) {
    if (!policy.caminhaoCanavieiroTerceiro(e)) return false;
    const parada = e && e.operacaoConfirmada === true ? policy.paradaImprodutiva(e) : null;
    return !!parada && parada.id === 'aguardandoCarregamento';
  }

  function frenteOperacional(e) {
    const direta = e && e.frente != null ? String(e.frente).trim() : '';
    if (direta) return direta;
    return e && e.frenteInferida != null ? String(e.frenteInferida).trim() : '';
  }

  function centroGeohash(valor) {
    const hash = String(valor || '').trim().toLowerCase();
    if (hash.length < PRECISAO_MIN_GEOHASH || hash.length > 12) return null;
    const alfabeto = '0123456789bcdefghjkmnpqrstuvwxyz';
    let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, longitude = true;
    for (const caractere of hash) {
      const codigo = alfabeto.indexOf(caractere);
      if (codigo < 0) return null;
      for (let bit = 4; bit >= 0; bit--) {
        const ligado = (codigo & (1 << bit)) !== 0;
        if (longitude) {
          const meio = (lonMin + lonMax) / 2;
          if (ligado) lonMin = meio; else lonMax = meio;
        } else {
          const meio = (latMin + latMax) / 2;
          if (ligado) latMin = meio; else latMax = meio;
        }
        longitude = !longitude;
      }
    }
    return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
  }

  function posicaoAtual(e, ts) {
    if (!e || String(e.ativo || 'T').toUpperCase() === 'F') return null;
    const posicao = centroGeohash(e.geohash);
    const instante = Number(e.localizacaoTs);
    if (!posicao || !Number.isFinite(instante) || instante <= 0) return null;
    const idade = Number(ts) - instante;
    if (!Number.isFinite(idade) || idade < -30_000 || idade > MAX_IDADE_POSICAO_FRENTE_MS) return null;
    if (e.atraso != null && (!Number.isFinite(Number(e.atraso)) || Number(e.atraso) > MAX_IDADE_POSICAO_FRENTE_MS / 1000)) return null;
    return posicao;
  }

  function distanciaMetros(a, b) {
    const rad = (valor) => valor * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const lat1 = rad(a.lat);
    const lat2 = rad(b.lat);
    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  }

  function inferirFrenteGeografica(alvo, referencias, ts) {
    const posicaoAlvo = posicaoAtual(alvo, ts);
    if (!posicaoAlvo) return null;
    const contagens = new Map();
    for (const referencia of referencias) {
      if (String(referencia.e.id) === String(alvo.id)) continue;
      const distancia = distanciaMetros(posicaoAlvo, referencia.posicao);
      if (distancia > MAX_DISTANCIA_FRENTE_M) continue;
      let item = contagens.get(referencia.frente);
      if (!item) {
        item = { frente: referencia.frente, quantidade: 0, distanciaMaxima: 0 };
        contagens.set(referencia.frente, item);
      }
      item.quantidade++;
      item.distanciaMaxima = Math.max(item.distanciaMaxima, distancia);
    }
    const ranking = [...contagens.values()].sort((a, b) => b.quantidade - a.quantidade || a.frente.localeCompare(b.frente));
    const vencedor = ranking[0];
    const totalProximo = ranking.reduce((soma, item) => soma + item.quantidade, 0);
    const concorrente = ranking[1];
    if (!vencedor || vencedor.quantidade < MIN_REFERENCIAS_FRENTE ||
        (concorrente && vencedor.quantidade - concorrente.quantidade < MIN_MARGEM_FRENTE) ||
        vencedor.quantidade / totalProximo < MIN_CONSENSO_FRENTE) return null;
    return { frente: vencedor.frente, referencias: vencedor.quantidade, distanciaMaxima: vencedor.distanciaMaxima };
  }

  function textoLocalCaminhao(e) {
    if (e.frente) return 'frente/grupo informado: ' + String(e.frente).trim();
    if (e.frenteInferida) return 'frente inferida: ' + String(e.frenteInferida).trim();
    return 'frente/grupo: não informada';
  }

  function atualizarAlertaFrenteInferida(e, frenteAnterior, frenteNova) {
    let alterou = false;
    let historicoAlterado = false;
    for (const alerta of ativos.values()) {
      if (!alerta.e || String(alerta.e.id) !== String(e.id) || alerta.regra !== 'paradaImprodutiva' || alerta.paradaId !== 'aguardandoCarregamento') continue;
      alerta.e = e;
      alerta.texto = (alerta.paradaNome || 'Aguardando carregamento') + ' há ' + minutosTxt(alerta.valor || 0) + ' · ' + textoLocalCaminhao(e);
      alerta.detalhe = 'Operação SGPA ' + (e.operacao || '—') + ' · ' + (e.tipo || 'caminhão canavieiro terceiro') +
        (e.frenteInferida ? ' · consenso espacial de ' + (e.frenteInferidaReferencias || 0) + ' equipamentos próximos' : '');
      alerta.fala = montarFala(alerta);
      if (!Array.isArray(alerta.frentesInferidasNotificadas)) alerta.frentesInferidasNotificadas = [];
      if (frenteNova && !alerta.frentesInferidasNotificadas.includes(frenteNova)) {
        alerta.frentesInferidasNotificadas.push(frenteNova);
        const ts = agora();
        const reconhecido = acks[alerta.chave] && ts - acks[alerta.chave] < 2 * 3600_000;
        const silenciado = ts < (Number(cfg.silencioAte) || 0) || reconhecido;
        if (cfg.voz && alerta.notificar && !silenciado) falar('Atualização de localização. ' + alerta.fala, { oficial: alerta.fonte === 'portal' });
      }
      const registro = hist.find((item) => item.chave === alerta.chave);
      if (registro) {
        Object.assign(registro, { frenteInferida: e.frenteInferida || '', texto: alerta.texto, detalhe: alerta.detalhe, fala: alerta.fala });
        historicoAlterado = true;
      }
      if (el.toasts) {
        for (const toast of el.toasts.querySelectorAll('.toast')) {
          if (toast.dataset.chave !== alerta.chave) continue;
          const texto = toast.querySelector('.a-txt');
          const fala = toast.querySelector('.a-fala');
          if (texto) texto.textContent = alerta.texto;
          if (fala) fala.textContent = '🗣️ ' + alerta.fala;
        }
      }
      alterou = true;
    }
    if (!alterou) return;
    if (historicoAlterado) salvar(KEY_HIST, hist);
    renderAtivos();
    renderCabecalho();
  }

  function atualizarFrentesInferidas(ts = agora()) {
    const referencias = [];
    for (const e of frota.values()) {
      const frente = frenteConhecida(e.frente) || frenteConhecida(e.grupoEquipamento);
      if (!frente || !equipamentoReferenciaFrente(e)) continue;
      const posicao = posicaoAtual(e, ts);
      if (posicao) referencias.push({ e, frente, posicao });
    }
    const alterados = [];
    for (const e of frota.values()) {
      const frenteAnterior = String(e.frenteInferida || '');
      const referenciasAnteriores = Number(e.frenteInferidaReferencias) || 0;
      const inferencia = !String(e.frente || '').trim() && ehCaminhaoAguardandoCarregamento(e)
        ? inferirFrenteGeografica(e, referencias, ts)
        : null;
      const frenteNova = inferencia ? inferencia.frente : '';
      const quantidadeNova = inferencia ? inferencia.referencias : 0;
      if (frenteAnterior !== frenteNova || referenciasAnteriores !== quantidadeNova) {
        e.frenteInferida = frenteNova;
        e.frenteInferidaReferencias = quantidadeNova;
        e.frenteInferidaTs = inferencia ? ts : 0;
        alterados.push({ e, frenteAnterior, frenteNova });
      }
    }
    for (const alteracao of alterados) {
      atualizarAlertaFrenteInferida(alteracao.e, alteracao.frenteAnterior, alteracao.frenteNova);
    }
    if (alterados.length) reconciliarEscopo();
  }

  function frenteSelecionada(alvo) {
    if (!cfg.frentes || !cfg.frentes.length) return true;
    const valores = alvo && typeof alvo === 'object'
      ? [alvo.frente, alvo.frenteInferida, alvo.grupoEquipamento]
      : [alvo];
    return valores.some((valor) => valor != null && String(valor).trim() !== '' &&
      cfg.frentes.some((f) => norm(f) === norm(valor)));
  }

  function atualizarFrenteAtivos(id, frente, grupoEquipamento) {
    const equipamento = String(id);
    const e = frota.get(equipamento);
    if (e) {
      e.frente = frente;
      e.grupoEquipamento = grupoEquipamento;
    }
    for (const alerta of ativos.values()) {
      if (alerta.e && String(alerta.e.id) === equipamento) {
        alerta.e.frente = frente;
        alerta.e.grupoEquipamento = grupoEquipamento;
      }
    }
  }

  function dentroDoEscopo(e, opcoes = {}) {
    if (!opcoes.alarmesOficiais && String(e.ativo || 'T') === 'F') return false;
    if (!opcoes.alarmesOficiais && !opcoes.ignorarAtraso && e.atraso !== null && e.atraso !== undefined && e.atraso > cfg.maxAtrasoMin * 60) return false;
    if (cfg.seguirSelecaoMapa && ctx.selecao && ctx.selecao.size) {
      if (!ctx.selecao.has(String(e.id)) && !ctx.selecao.has(String(e.numero))) return false;
    }
    if (!frenteSelecionada(e)) return false;
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
      if (dentroDoEscopo(alerta.e, { alarmesOficiais: alerta.fonte === 'portal' })) continue;
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
  let sequenciaObservacao = 0;
  let sequenciaStreamObservacao = 0;
  let avaliacaoSoTempo = false;
  let observacaoEmAvaliacao = null;

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
    const tsInicio = agora();
    let telemetriaNova = false;
    try {
      // Cada fonte expõe sua própria saúde: sucesso parcial não apaga a falha da outra.
      const resultados = await Promise.allSettled([
        chamar(rotaTelemetria()),
        cfg.espelharServidor ? chamar(rotaAlarmes()) : Promise.resolve(null),
      ]);
      if (!cfg.ativo) return;
      const telemetriaOK = resultados[0].status === 'fulfilled' && Array.isArray(resultados[0].value);
      const alarmesOK = !cfg.espelharServidor || (resultados[1].status === 'fulfilled' && Array.isArray(resultados[1].value));
      const erroFonte = (resultado) => resultado.status === 'rejected'
        ? (resultado.reason && resultado.reason.message) || 'falha na consulta'
        : 'resposta do SGPA em formato inválido';
      const falhas = [];

      estado.fontes.telemetria = telemetriaOK
        ? { status: 'ok', ultimaSucesso: agora(), erro: '' }
        : { ...estado.fontes.telemetria, status: 'falha', erro: erroFonte(resultados[0]) };
      if (!telemetriaOK) falhas.push('telemetria: ' + estado.fontes.telemetria.erro);

      if (cfg.espelharServidor) {
        estado.fontes.alarmes = alarmesOK
          ? { status: 'ok', ultimaSucesso: agora(), erro: '' }
          : { ...estado.fontes.alarmes, status: 'falha', erro: erroFonte(resultados[1]) };
        if (!alarmesOK) falhas.push('alarmes oficiais: ' + estado.fontes.alarmes.erro);
      } else {
        estado.fontes.alarmes = { status: 'desligado', ultimaSucesso: estado.fontes.alarmes.ultimaSucesso, erro: '' };
      }

      if (telemetriaOK) {
        aplicarTelemetria(resultados[0].value);
        telemetriaNova = true;
      }
      if (cfg.espelharServidor && alarmesOK) espelharAlarmes(resultados[1].value);
      if (telemetriaOK || (cfg.espelharServidor && alarmesOK)) {
        marcarComunicacaoSgpa(agora());
      }
      if (!telemetriaOK && !cfg.espelharServidor) throw new Error(falhas.join(' · ') || 'sem resposta das fontes SGPA');
      if (!telemetriaOK && !alarmesOK) throw new Error(falhas.join(' · ') || 'sem resposta das fontes SGPA');

      if (cfg.espelharServidor && nCiclo % 3 === 2) {
        const d = await chamar(rotaTempos()).catch(() => null);
        if (cfg.ativo && Array.isArray(d)) aplicarTempos(d);
      }
      if (falhas.length) {
        estado.erros++;
        estado.proximoErro = falhas.join(' · ');
        estado.backoff = Math.max(estado.backoff, Math.min(5 * 60_000, estado.backoff || 20_000));
      } else {
        estado.erros = 0;
        estado.proximoErro = '';
        estado.backoff = 0;
      }
      estado.ultimoCiclo = tsInicio;
      estado.fonte = telemetriaNova ? (cfg.espelharServidor && alarmesOK ? 'telemetria + SGPA oficial' : 'telemetria') : 'SGPA oficial';
      // Inicia estados temporizados quando os dados foram efetivamente avaliados.
      const tsAvaliacao = agora();
      avaliarFrota(tsAvaliacao, telemetriaNova ? 'lotes' : 'tempo');
      purarResolvidos(tsAvaliacao);
    } catch (e) {
      estado.erros++;
      estado.proximoErro = (e && e.message) || 'falha ao ler o portal';
      estado.backoff = Math.max(estado.backoff, Math.min(5 * 60_000, estado.backoff || 20_000));
    } finally {
      correndo = false;
      verificarSaudeComunicacaoSgpa(agora());
      renderAtivos();
      renderCabecalho();
      agendar();
    }
  }

  function verificarReescalonamentoCriticos(ts) {
    if (!cfg.ativo || cfg.reescalarCriticos === false) return;
    if (ts < (Number(cfg.silencioAte) || 0)) return;
    const intervaloMin = Number(cfg.reescalarCriticosMin);
    if (!Number.isFinite(intervaloMin) || intervaloMin <= 0) return;
    const intervaloMs = Math.max(1, intervaloMin) * 60_000;
    for (const alerta of ativos.values()) {
      if (!alerta || alerta.simulado || !alerta.notificar || (alerta.severidade || 0) < 3) continue;
      if (alerta.fonte !== 'portal' && alerta.regra !== 'frenteDividida') continue;
      if (acks[alerta.chave] && ts - acks[alerta.chave] < 2 * 3600_000) continue;
      const referencia = Number(alerta.ultimoReescalonamento || alerta.ts || 0);
      if (!referencia || ts - referencia < intervaloMs) continue;
      alerta.ultimoReescalonamento = ts;
      if (cfg.som) tocar(3, true);
      if (cfg.voz) {
        falar('Alerta crítico pendente sem confirmação. ' + alerta.fala, { oficial: true });
        faladoEm.set(alerta.chave, ts);
      }
    }
  }

  /* relógio fino: avalia troca de turno/ociosidade entre duas leituras */
  function tique() {
    if (!cfg.ativo) return;
    try {
      const ts = agora();
      if (frota.size) avaliarFrota(ts, 'tempo');
      verificarReescalonamentoCriticos(ts);
      verificarSaudeComunicacaoSgpa(ts);
      revisarChuvas(ts);
      atualizarCronometrosSla(ts);
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
    const observacao = observacaoEmAvaliacao || `direta:${ts}`;
    if (liga) {
      st.negados = 0;
      if (!st.firing) {
        st.firing = true;
        st.since = ts;
        st.consec = 1;
        st.emitido = false;
        st.ultimaObservacaoPositiva = observacao;
      } else if (!avaliacaoSoTempo && st.ultimaObservacaoPositiva !== observacao) {
        st.consec++;
        st.ultimaObservacaoPositiva = observacao;
      }
      st.ultimaObservacaoNegativa = null;
      if (valor !== undefined && valor !== null) st.valor = valor;
    } else if (st.firing) {
      if (avaliacaoSoTempo || st.ultimaObservacaoNegativa === observacao) return st;
      st.ultimaObservacaoNegativa = observacao;
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

  /* ------------- Inteligência COA: Chuva, Ociosidade, Frota Muda, Emergência e Qualidade ------------- */

  function frenteEmChuva(frente) {
    const chave = policy.norm(frente);
    if (!chave) return null;
    const item = chuvas && chuvas[chave];
    return item && typeof item === 'object' ? item : null;
  }

  function alternarChuvaFrente(frente, motivo) {
    const rotulo = String(frente || '').trim();
    const chave = policy.norm(rotulo);
    if (!chave) return null;
    if (chuvas[chave]) {
      delete chuvas[chave];
      salvar(KEY_CHUVAS, chuvas);
      mostrarAviso(`Pausa de chuva encerrada em ${rotulo}. Alertas improdutivos reativados.`, 'info');
      renderFrentes();
      renderAtivos();
      renderCabecalho();
      return null;
    }
    const ts = agora();
    chuvas[chave] = {
      chave,
      frente: rotulo,
      motivo: String(motivo || 'Chuva / Parada programada').trim(),
      desde: ts,
      revisarEm: ts + 30 * 60_000,
    };
    salvar(KEY_CHUVAS, chuvas);
    mostrarAviso(`Modo Chuva ativo em ${rotulo} (lembrete em 30 min). Segurança permanece 100% ligada.`, 'info');
    renderFrentes();
    renderAtivos();
    renderCabecalho();
    return chuvas[chave];
  }

  function revisarChuvas(ts = agora()) {
    let mudou = false;
    for (const [chave, item] of Object.entries(chuvas || {})) {
      if (!item || !item.revisarEm || ts < item.revisarEm) continue;
      const mins = Math.max(1, Math.round((ts - (item.desde || ts)) / 60_000));
      item.revisarEm = ts + 30 * 60_000;
      mudou = true;
      mostrarAviso(`🌧️ Revisar pausa de chuva em ${item.frente} (ativa há ${mins} min).`, 'info');
      if (cfg.som) tocar(2);
      if (cfg.voz) falar(`Atenção C O A: revisar pausa de chuva na ${item.frente}, ativa há ${mins} minutos.`);
    }
    if (mudou) salvar(KEY_CHUVAS, chuvas);
  }

  function registrarTratativa(chave, dados) {
    if (!chave) return null;
    const atual = tratativas[chave] || {};
    const novo = {
      tag: dados && dados.tag !== undefined ? String(dados.tag || '').trim() : (atual.tag || ''),
      nota: dados && dados.nota !== undefined ? String(dados.nota || '').trim().slice(0, 180) : (atual.nota || ''),
      ts: agora(),
      usuario: ctx.usuario || '',
    };
    tratativas[chave] = novo;
    const corte = agora() - 24 * 3600_000;
    for (const [k, v] of Object.entries(tratativas)) {
      if (!v || (v.ts && v.ts < corte)) delete tratativas[k];
    }
    salvar(KEY_TRATATIVAS, tratativas);
    for (const h of hist) {
      if (h.chave === chave) {
        h.tratativa = [novo.tag, novo.nota].filter(Boolean).join(' — ');
        break;
      }
    }
    salvar(KEY_HIST, hist);
    return novo;
  }

  function acumularOciosidadeTurno(ts = agora()) {
    const turno = policy.turnoAtualCoa(ts);
    if (!ociosidadeTurno || ociosidadeTurno.turnoChave !== turno.chave) {
      ociosidadeTurno = { turnoChave: turno.chave, itens: {} };
    }
    const deltaSeg = ultimoAcumuloOciosoTs > 0 ? Math.min(90, Math.max(0, Math.round((ts - ultimoAcumuloOciosoTs) / 1000))) : 0;
    ultimoAcumuloOciosoTs = ts;
    if (deltaSeg <= 0) return;
    let mudou = false;
    const rpmMax = num(cfg.rpmOcioso);
    for (const e of frota.values()) {
      if (!dentroDoEscopo(e)) continue;
      const parado = (e.velocidade === null ? 0 : e.velocidade) <= 1;
      const ligado = e.rpm > 0 && (e.motor === null ? true : e.motor);
      if (!(ligado && parado && (rpmMax === 0 || e.rpm <= rpmMax))) continue;
      const id = String(e.id);
      const atual = ociosidadeTurno.itens[id] || {
        id,
        numero: e.numero || id,
        classe: classeFala(e.nome, e.tipo, e.frente),
        frente: e.frente || e.grupoEquipamento || '',
        operador: e.operador || '',
        segAcumulados: 0,
      };
      atual.segAcumulados += deltaSeg;
      atual.frente = e.frente || atual.frente;
      atual.operador = e.operador || atual.operador;
      ociosidadeTurno.itens[id] = atual;
      mudou = true;
    }
    if (mudou) salvar(KEY_OCIOSIDADE, ociosidadeTurno);
  }

  function resumoFrentes() {
    const lista = [...frota.values()].filter((e) => dentroDoEscopo(e, { ignorarAtraso: true }));
    ultimoResumoCtt = policy.analisarFrentesCtt(lista, {
      minutosFrotaMuda: Math.max(0, num(cfg.minutosFrotaMuda) || 0),
      filaMaxFrente: Math.max(1, num(cfg.filaMaxFrente) || 4),
      chuvas,
    });
    return ultimoResumoCtt;
  }

  function regraFrotaMuda(e, ts) {
    const min = Math.max(0, num(cfg.minutosFrotaMuda) || 0);
    if (!min) return;
    const atrasoSeg = e.atraso != null && Number.isFinite(Number(e.atraso)) ? Number(e.atraso) : null;
    const liga = atrasoSeg !== null && atrasoSeg >= min * 60 && atrasoSeg <= 12 * 3600;
    const st = marcar(e.id, 'telemetriaMuda', liga, ts, atrasoSeg ? Math.round(atrasoSeg / 60) : null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!st.firing) return;
    if (!podeDisparar(st, ts)) return;
    const mins = Math.max(min, Math.round((atrasoSeg || 0) / 60));
    emitir({
      chave: st.chave,
      regra: 'telemetriaMuda',
      e,
      valor: mins,
      limite: min,
      texto: `sem comunicação de telemetria há ${minutosTxt(mins)} (frota muda) · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Última operação: ${e.operacao || '—'}${e.local ? ' · Último local: ' + e.local : ''} · limiar ${minutosTxt(min)}`,
      inicio: ts - mins * 60_000,
    });
  }

  function regraEmergencia(e, ts) {
    const det = policy.emergenciaOperacional(e);
    const liga = !!det;
    const st = marcar(e.id, 'emergencia', liga, ts, e.velocidade);
    if (!liga && !st.firing) {
      ativos.delete(st.chave);
      if (emergenciaAtiva && emergenciaAtiva.chave === st.chave) fecharBannerEmergencia();
    }
    if (!liga || !st.firing) return;
    st.consec = Math.max(st.consec, Math.max(1, cfg.amostras)); // emergência nunca espera 2º ciclo
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'emergencia',
      e,
      valor: e.velocidade,
      texto: `${det.motivo} · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Canal de Emergência COA · ${e.nome}${e.local ? ' · Local: ' + e.local : ''} · prioridade máxima`,
      inicio: st.since,
    });
  }

  function regraQualidadeColheita(e, ts) {
    const lim = Math.max(0, num(cfg.velMaxColheita) || 0);
    if (!lim) return;
    const liga = policy.colheitaAcimaDaFaixa(e, lim);
    const st = marcar(e.id, 'qualidadeColheita', liga, ts, e.velocidade);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!st.firing) return;
    if (!podeDisparar(st, ts)) return;
    const vel = Math.round((Number(e.velocidade) || 0) * 10) / 10;
    emitir({
      chave: st.chave,
      regra: 'qualidadeColheita',
      e,
      valor: vel,
      limite: lim,
      texto: `colhendo acima da faixa técnica: ${vel} km/h (limite ${lim} km/h) · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Qualidade da colheita · operação ${e.operacao || 'Colheita'} · risco de perda de cana e impureza`,
      inicio: st.since,
    });
  }

  function acumularCustosTurno(ts = agora()) {
    const turno = policy.turnoAtualCoa(ts);
    if (!custoImprodutivoTurno || custoImprodutivoTurno.turnoChave !== turno.chave) {
      custoImprodutivoTurno = { turnoChave: turno.chave, paradoRs: 0, porClasse: {} };
    }
    const deltaSeg = ultimoAcumuloCustoTs > 0 ? Math.min(90, Math.max(0, Math.round((ts - ultimoAcumuloCustoTs) / 1000))) : 0;
    ultimoAcumuloCustoTs = ts;
    if (deltaSeg <= 0) return;
    let somou = false;
    for (const e of frota.values()) {
      if (!dentroDoEscopo(e) || e.operacaoConfirmada !== true) continue;
      if (frenteEmChuva(e.frente || e.frenteInferida || e.grupoEquipamento)) continue;
      const improdutivo = !!policy.paradaImprodutiva(e) || policy.aguardandoCaminhao(e) || policy.semApontamento(e);
      if (!improdutivo) continue;
      const info = policy.custoHoraEquipamento(e, cfg);
      const inc = (deltaSeg / 3600) * info.valorHora;
      custoImprodutivoTurno.paradoRs = Math.round((Number(custoImprodutivoTurno.paradoRs || 0) + inc) * 100) / 100;
      custoImprodutivoTurno.porClasse[info.classeCusto] = Math.round(((custoImprodutivoTurno.porClasse[info.classeCusto] || 0) + inc) * 100) / 100;
      somou = true;
    }
    if (somou) salvar(KEY_FINANCEIRO, custoImprodutivoTurno);
  }

  function custoTurno() {
    const segOciosoTotal = Object.values((ociosidadeTurno && ociosidadeTurno.itens) || {})
      .reduce((s, o) => s + (Number(o && o.segAcumulados) || 0), 0);
    const litrosOcioso = Math.round((segOciosoTotal / 3600) * 4 * 10) / 10;
    const precoDiesel = Math.max(1, num(cfg.custoLitroDiesel) || 6.2);
    const dieselRs = Math.round(litrosOcioso * precoDiesel);
    const paradoBase = Math.round(Number((custoImprodutivoTurno && custoImprodutivoTurno.paradoRs) || 0));
    // Também reflete impacto vivo das paradas ativas ainda abertas caso o turno tenha acabado de abrir
    let abertoRs = 0;
    const ts = agora();
    for (const a of ativos.values()) {
      if (a.regra === 'paradaImprodutiva' || a.regra === 'aguardandoCaminhao' || a.regra === 'aguardandoBasculamento' || a.regra === 'semApontamento') {
        const min = Math.max(0, (ts - (a.inicio || a.ts || ts)) / 60_000);
        const info = policy.custoHoraEquipamento(a.e || {}, cfg);
        abertoRs += Math.round(min * info.valorMinuto);
      }
    }
    const paradoRs = Math.max(paradoBase, abertoRs);
    return {
      paradoRs,
      dieselRs,
      litrosOcioso,
      totalRs: paradoRs + dieselRs,
      porClasse: (custoImprodutivoTurno && custoImprodutivoTurno.porClasse) || {},
    };
  }

  function termometroMoenda() {
    const res = ultimoResumoCtt && ultimoResumoCtt.totais ? ultimoResumoCtt : resumoFrentes();
    return policy.calcularTermometroMoenda(res, cfg);
  }

  function filaComboio() {
    const lista = [...frota.values()].filter((e) => dentroDoEscopo(e, { ignorarAtraso: true }));
    return policy.calcularFilaComboioApoio(lista, cfg, agora());
  }

  function placarPositivo() {
    const res = ultimoResumoCtt && ultimoResumoCtt.frentes ? ultimoResumoCtt : resumoFrentes();
    const lista = [...frota.values()].filter((e) => dentroDoEscopo(e, { ignorarAtraso: true }));
    return policy.gerarPlacarPositivoTurno({
      resumoCtt: res,
      frota: lista,
      hist,
      ociososMapa: (ociosidadeTurno && ociosidadeTurno.itens) || {},
      unidade: ctx.unidade || 'Usina Branco Peres',
      agoraMs: agora(),
    });
  }

  function radarIncendio() {
    const fila = filaComboio();
    const amostraPos = [...frota.values()].map((e) => policy.decodificarGeohash(e.geohash)).find(Boolean) || null;
    const frenteRef = (ultimoResumoCtt && ultimoResumoCtt.frentes && ultimoResumoCtt.frentes[0] && ultimoResumoCtt.frentes[0].frente) || '';
    return Object.assign(
      policy.avaliarRiscoIncendio303030(climaCoa, fila.recursos.bombeiros, amostraPos, frenteRef),
      { origem: (climaCoa && climaCoa.origem) || 'manual', atualizadoEm: (climaCoa && climaCoa.atualizadoEm) || 0 }
    );
  }

  function definirClimaManual(patch) {
    if (!patch || typeof patch !== 'object') return radarIncendio();
    climaCoa = Object.assign({}, climaCoa, {
      tempC: patch.tempC != null ? Number(patch.tempC) : climaCoa.tempC,
      umidadePct: patch.umidadePct != null ? Number(patch.umidadePct) : climaCoa.umidadePct,
      ventoKmH: patch.ventoKmH != null ? Number(patch.ventoKmH) : climaCoa.ventoKmH,
      chuvaMm: patch.chuvaMm != null ? Number(patch.chuvaMm) : (climaCoa.chuvaMm || 0),
      atualizadoEm: agora(),
      origem: patch.origem || 'manual',
    });
    salvar(KEY_CLIMA, climaCoa);
    const aval = radarIncendio();
    if (aval.bandeira === 'vermelha' && cfg.voz && agora() >= (Number(cfg.silencioAte) || 0)) {
      falar(`Atenção C O A: regra trinta trinta trinta atingida. Risco extremo de incêndio com ${aval.tempC} graus, umidade ${aval.umidadePct} por cento e vento de ${aval.ventoKmH} quilômetros por hora.`, { oficial: true });
    }
    if (el.comboio && !el.comboio.classList.contains('hide')) renderComboio();
    renderTelaoBar();
    return aval;
  }

  async function atualizarClimaOnline() {
    const pos = [...frota.values()].map((e) => policy.decodificarGeohash(e.geohash)).find(Boolean) || { lat: -21.25, lon: -50.65 };
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${pos.lat.toFixed(4)}&longitude=${pos.lon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const cur = (j && j.current) || {};
      const aval = definirClimaManual({
        tempC: Number(cur.temperature_2m ?? climaCoa.tempC),
        umidadePct: Number(cur.relative_humidity_2m ?? climaCoa.umidadePct),
        ventoKmH: Number(cur.wind_speed_10m ?? climaCoa.ventoKmH),
        chuvaMm: Number(cur.precipitation ?? 0),
        origem: 'meteorologia GPS',
      });
      mostrarAviso(`Clima atualizado (${aval.tempC}°C · ${aval.umidadePct}% · vento ${aval.ventoKmH} km/h).`, 'info');
      return aval;
    } catch {
      mostrarAviso('Sem acesso externo de meteorologia agora — ajuste os valores manualmente no cartão 30-30-30.', 'info');
      return radarIncendio();
    }
  }

  function regraInconsistenciaApontamento(e, ts) {
    if (cfg.auditarApontamento === false) return;
    const min = Math.max(0, num(cfg.minutosInconsistencia) || 0);
    if (!min) return;
    const det = policy.inconsistenciaApontamento(e);
    const liga = !!det;
    const st = marcar(e.id, 'inconsistenciaApontamento', liga, ts, det ? det.velocidade : null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!liga || !st.firing) return;
    const durou = (ts - inicioReal(st, e)) / 60_000;
    if (durou < min) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'inconsistenciaApontamento',
      e,
      valor: Math.round(durou),
      limite: min,
      texto: `inconsistência de apontamento há ${minutosTxt(durou)}: ${det.motivo} · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Auditoria automática COA · Operação SGPA: ${det.operacao} · validar apontamento no computador de bordo`,
      inicio: inicioReal(st, e),
    });
  }

  function regraBateVolta(e, ts) {
    const min = Math.max(0, num(cfg.minutosBateVoltaMax) || 0);
    if (!min) return;
    const liga = policy.caminhaoEmBateVolta(e);
    const st = marcar(e.id, 'bateVolta', liga, ts, null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!liga || !st.firing) return;
    const durou = (ts - inicioReal(st, e)) / 60_000;
    if (durou < min) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'bateVolta',
      e,
      valor: Math.round(durou),
      limite: min,
      texto: `em viagem/bate-volta há ${minutosTxt(durou)} acima do ciclo de ${minutosTxt(min)} · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Monitor de ciclo rodoviário · operação ${e.operacao || 'Transporte'}${e.local ? ' · Local: ' + e.local : ''} · verificar retenção ou quebra na estrada`,
      inicio: inicioReal(st, e),
    });
  }

  function regraManutencaoPreditiva(e, ts) {
    if (cfg.manutencaoPreditivaAtiva === false) return;
    const rec = policy.detectarFalhaRecorrente(e.id, hist, ts, 240, 3);
    const liga = !!rec;
    const st = marcar(e.id, 'manutencaoPreditiva', liga, ts, rec ? rec.ocorrencias : null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!liga || !st.firing) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'manutencaoPreditiva',
      e,
      valor: rec.ocorrencias,
      texto: `${rec.ocorrencias} alertas mecânicos/motor nas últimas 4h (último: ${rec.ultimoMotivo}) · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Manutenção preditiva COA · recomendar inspeção preventiva à oficina volante antes de quebra grave`,
      inicio: st.since,
    });
  }

  function regraRiscoMoenda(ts) {
    if (cfg.gestaoFrenteAtiva === false) return;
    const meta = Math.max(0, num(cfg.metaMoagemTonHora) || 0);
    if (!meta) return;
    const res = ultimoResumoCtt || { frentes: [], totais: {} };
    const tot = res.totais || {};
    const todasEmChuva = res.frentes.length > 0 && Object.keys(chuvas || {}).length >= res.frentes.length;
    const term = policy.calcularTermometroMoenda(res, cfg);
    const liga = (tot.colhedoras || 0) >= 2 && !todasEmChuva && term.status === 'risco';
    const pe = { id: 'usina:moenda', numero: 'Usina', nome: 'Alimentação de Moenda', tipo: 'Indústria / CTT', frente: 'Moenda' };
    const st = marcar(pe.id, 'riscoMoenda', liga, ts, term.entregaTonHora);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!liga || !st.firing) return;
    if ((ts - st.since) / 60_000 < 15) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'riscoMoenda',
      e: pe,
      valor: term.entregaTonHora,
      limite: term.metaTonHora,
      texto: `entrega estimada em ${term.entregaTonHora} t/h (${term.pctMeta}% da meta de ${term.metaTonHora} t/h) — risco de falta de cana na moenda`,
      detalhe: `${term.colhedorasColhendo}/${term.colhedorasTotal} colhedoras em colheita · déficit estimado de ${term.deficitTonHora} t/h`,
      inicio: st.since,
    });
  }

  function avaliarFrota(ts, modo) {
    const lotes = modo !== 'tempo';
    const modoAnterior = avaliacaoSoTempo;
    const observacaoAnterior = observacaoEmAvaliacao;
    avaliacaoSoTempo = !lotes;
    const rodada = lotes ? ++sequenciaObservacao : 0;
    let cont = 0;
    try {
      atualizarFrentesInferidas(ts);
      for (const e of frota.values()) {
        if (dentroDoEscopo(e, { ignorarAtraso: true })) {
          const tsEquipMuda = Number(e.tsEquipamento);
          observacaoEmAvaliacao = lotes
            ? tsEquipMuda > 0 ? `sgpa:${tsEquipMuda}` : `rodada:${rodada}:${e.id}`
            : null;
          regraFrotaMuda(e, ts);
        }
        if (!dentroDoEscopo(e)) continue;
        cont++;
        const tsEquipamento = Number(e.tsEquipamento);
        observacaoEmAvaliacao = lotes
          ? tsEquipamento > 0 ? `sgpa:${tsEquipamento}` : `rodada:${rodada}:${e.id}`
          : null;
        if (lotes) e.ultimaObservacaoFonte = observacaoEmAvaliacao;
        if (lotes) {
          regraRpm(e, ts);
          regraEmergencia(e, ts);
          regraQualidadeColheita(e, ts);
          regraManutencaoPreditiva(e, ts);
        }
        regraInconsistenciaApontamento(e, ts);
        regraBateVolta(e, ts);
        regraFrenteDividida(e, ts);
        regraAguardandoCaminhao(e, ts);
        regraSemApontamento(e, ts);
        regraParada(e, ts);
        regraRefeicao(e, ts);
        regraTurno(e, ts);
        regraOcioso(e, ts);
      }
      observacaoEmAvaliacao = lotes ? `frente:rodada:${rodada}` : null;
      regrasFrente(ts);
      acumularOciosidadeTurno(ts);
      acumularCustosTurno(ts);
      resumoFrentes();
      regraRiscoMoenda(ts);
      estado.monitorados = cont;
      if (el.frentes && !el.frentes.classList.contains('hide')) renderFrentes();
      if (el.comboio && !el.comboio.classList.contains('hide')) renderComboio();
    } finally {
      avaliacaoSoTempo = modoAnterior;
      observacaoEmAvaliacao = observacaoAnterior;
    }
  }

  function equipamentoCaminhao(e) {
    const tipo = policy.norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' '));
    return /caminh|\btruck\b|munck|cacamb|bombeir/.test(tipo);
  }
  function telemetriaRecente(e) {
    const tsEquipamento = Number(e && e.tsEquipamento);
    if (!Number.isFinite(tsEquipamento) || tsEquipamento <= 0) return false;
    const intervaloMs = Math.max(30, Number(cfg.intervaloSeg) || 45) * 1000;
    const maxIdadeMs = Math.min(5 * 60_000, Math.max(120_000, intervaloMs * 2));
    // vistoEm marca a chegada de qualquer quadro, não a idade do dado SGPA.
    // Só dtHrLocal e, quando disponível, vlTempoSemComunicacao comprovam atualidade.
    const idade = agora() - tsEquipamento;
    if (idade < -60_000 || idade > maxIdadeMs) return false;
    if (e.atraso != null && (!Number.isFinite(Number(e.atraso)) || Number(e.atraso) > maxIdadeMs / 1000)) return false;
    return true;
  }
  function caminhoesAguardandoCarregamento(frente) {
    const alvo = policy.norm(frente);
    if (!alvo) return [];
    return [...frota.values()].filter((e) => {
      if (!dentroDoEscopo(e) || e.operacaoConfirmada !== true || policy.norm(frenteOperacional(e)) !== alvo) return false;
      if (!telemetriaRecente(e)) return false;
      if (!policy.caminhaoCanavieiroTerceiro(e)) return false;
      const parada = policy.paradaImprodutiva(e);
      return !!parada && parada.id === 'aguardandoCarregamento';
    }).map((e) => ({ id: e.id, numero: e.numero || e.id }));
  }
  function encerrarEstadoLocal(id, regra) {
    const chave = String(id) + '|' + regra;
    const st = estados.get(chave);
    if (st) Object.assign(st, { firing: false, since: 0, consec: 0, negados: 0, emitido: false, ultimo: 0 });
    const removido = ativos.delete(chave);
    if (removido && el.toasts) {
      el.toasts.querySelectorAll('.toast').forEach((flutuante) => {
        if (flutuante.dataset.chave === chave) flutuante.remove();
      });
      atualizarBotaoLimparToasts();
      renderAtivos();
      renderCabecalho();
    }
  }
  function regraAguardandoBasculamento(e, ts, caminhoes) {
    const parada = policy.paradaImprodutiva({ operacao: 'Aguardando basculamento' });
    const limite = parada ? policy.limiteParada(cfg, parada) : 15;
    const st = marcar(e.id, 'aguardandoBasculamento', true, ts, null);
    if (!st.firing || limite <= 0) return;
    const durou = Math.max(0, (ts - st.since) / 60000);
    if (durou < limite || !podeDisparar(st, ts)) return;
    const numeros = caminhoes.map((c) => String(c.numero || c.id));
    const descricao = numeros.length === 1
      ? 'caminhão ' + numeros[0] + ' aguardando carregamento na mesma frente'
      : 'caminhões ' + numeros.join(', ') + ' aguardando carregamento na mesma frente';
    emitir({
      chave: st.chave,
      regra: 'aguardandoBasculamento',
      e,
      caminhoes: numeros,
      paradaId: 'aguardBasculamento',
      paradaNome: parada ? parada.nome : 'Aguardando basculamento',
      valor: Math.round(durou),
      limite: Math.round(limite),
      texto: 'Aguardando basculamento (inferido pelo app): ' + descricao + ' · frente/grupo: ' + (e.frente || 'não informada'),
      detalhe: 'Inferência do aplicativo pela presença de caminhão na mesma frente. O SGPA continua registrando ' + (e.operacao || '905 — Aguardando Caminhão') + '; nenhum apontamento foi alterado.',
      inicio: st.since,
    });
  }
  function regraAguardandoCaminhao(e, ts) {
    const liga = policy.aguardandoCaminhao(e);
    if (!liga) {
      const anterior = estados.get(e.id + '|aguardandoCaminhao');
      if (anterior) {
        const stAnterior = marcar(e.id, 'aguardandoCaminhao', false, ts, null);
        if (!stAnterior.firing) {
          ativos.delete(stAnterior.chave);
          encerrarEstadoLocal(e.id, 'aguardandoBasculamento');
        }
      } else {
        encerrarEstadoLocal(e.id, 'aguardandoBasculamento');
      }
      return;
    }
    // O timestamp recebido pelo ciclo pode anteceder uma consulta REST demorada;
    // nunca deixe essa espera começar antes de observar a operação 905.
    ts = Math.max(Number(ts) || 0, agora());
    const caminhoes = caminhoesAguardandoCarregamento(e.frente);
    if (caminhoes.length) {
      encerrarEstadoLocal(e.id, 'aguardandoCaminhao');
      regraAguardandoBasculamento(e, ts, caminhoes);
      return;
    }
    encerrarEstadoLocal(e.id, 'aguardandoBasculamento');
    const st = marcar(e.id, 'aguardandoCaminhao', true, ts, null);
    // Pequena janela para reconciliar eventos em lotes separados; sem caminhão,
    // o 905 continua sendo emitido quase imediatamente, sem aguardar a tolerância de parada.
    if (!st.emitido) {
      if (ts - st.since < JANELA_CORRELACAO_905_MS) return;
      st.emitido = true;
      st.ultimo = ts;
    }
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

  /* “Frente dividida” é um apontamento operacional, não uma acusação: alerta
     no primeiro quadro para o COA validar a sequência da chamada pelo FUT. */
  function regraFrenteDividida(e, ts) {
    const liga = policy.frenteDividida(e);
    const st = marcar(e.id, 'frenteDividida', liga, ts, null);
    if (!liga && !st.firing) ativos.delete(st.chave);
    if (!liga || !st.firing) return;

    const instante = Math.max(Number(ts) || 0, agora());
    if (!st.emitido) {
      st.emitido = true;
      st.ultimo = instante;
    } else {
      const cd = Math.max(0, Number(cfg.cooldownMin) || 0) * 60000;
      if (!cd || instante - st.ultimo < cd) return;
      st.ultimo = instante;
    }
    const operacao = e.operacao || e.descOperacao || 'Frente dividida';
    emitir({
      chave: st.chave,
      regra: 'frenteDividida',
      e,
      texto: `apontou Frente dividida · frente/grupo: ${e.frente || 'não informada'}`,
      detalhe: `Apontamento SGPA ${operacao} · validar a sequência de chamada da colhedora no sistema FUT. A operação e a fila não foram alteradas.`,
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
    if (anterior && (!p || anterior !== p.id) && !avaliacaoSoTempo) {
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
    const caminhaoCanavieiroAguardando = p.id === 'aguardandoCarregamento' && policy.caminhaoCanavieiroTerceiro(e);
    const localizacaoTexto = caminhaoCanavieiroAguardando ? textoLocalCaminhao(e) : 'frente/grupo: ' + (e.frente || 'não informada');
    emitir({
      chave: st.chave,
      regra: 'paradaImprodutiva',
      nivel,
      lider: policy.liderFrente(cfg, frenteOperacional(e)),
      paradaId: p.id,
      paradaNome: p.nome,
      e,
      valor: Math.round(durou),
      limite: Math.round(lim),
      texto: `${nivel >= 3 ? '[ESCALAR LÍDER] ' : nivel === 2 ? '[URGENTE] ' : ''}${p.nome} há ${minutosTxt(durou)} · ${localizacaoTexto}`,
      detalhe: `Operação SGPA ${e.operacao || '—'} · ${e.tipo || 'equipamento'} · tolerância ${minutosTxt(lim)}` +
        (e.frenteInferida ? ` · consenso espacial de ${e.frenteInferidaReferencias || 0} equipamentos próximos` : ''),
      inicio: inicioReal(st, e),
    });
  }
  const paradaAtual = new Map();
  function limparAlertasGestao() {
    let mudou = false;
    for (const [chave, alerta] of ativos) {
      if (alerta.regra !== 'gestaoFrente') continue;
      ativos.delete(chave);
      mudou = true;
      if (el.toasts) {
        el.toasts.querySelectorAll('.toast').forEach((flutuante) => {
          if (flutuante.dataset.chave === chave) flutuante.remove();
        });
      }
    }
    for (const st of estados.values()) {
      if (String(st.regra || '').startsWith('gestao:')) {
        Object.assign(st, { firing: false, since: 0, consec: 0, negados: 0, emitido: false, ultimo: 0 });
      }
    }
    if (mudou) {
      renderAtivos();
      renderCabecalho();
    }
    if (el.toasts) atualizarBotaoLimparToasts();
  }
  /* Alertas de gestão por frente: problema da frente, não do operador. */
  function regrasFrente(ts) {
    if (cfg.gestaoFrenteAtiva === false) {
      limparAlertasGestao();
      return;
    }
    const porFrente = new Map();
    for (const e of frota.values()) {
      if (!dentroDoEscopo(e) || !e.frente) continue;
      const rotuloFrente = String(e.frente).trim();
      const chaveFrente = policy.norm(rotuloFrente);
      let f = porFrente.get(chaveFrente);
      if (!f) { f = { frente: rotuloFrente, fila: [], colh: 0, colhParadas: 0, transbAg: [] }; porFrente.set(chaveFrente, f); }
      const p = e.operacaoConfirmada === true ? policy.paradaImprodutiva(e) : null;
      const elegivelFilaFrente = p && (
        (p.id === 'filaUnica' && (!equipamentoCaminhao(e) || policy.caminhaoCanavieiroTerceiro(e))) ||
        (p.id === 'aguardandoCarregamento' && policy.caminhaoCanavieiroTerceiro(e))
      );
      if (elegivelFilaFrente) f.fila.push(e.numero || e.id);
      if (p && (p.id === 'agColhedoraParadaRapida' || p.id === 'aguardandoColhedoraAlocada')) f.transbAg.push(e.numero || e.id);
      const tipo = policy.norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' '));
      if (/colhed/.test(tipo)) {
        f.colh++;
        const op = policy.norm(e.operacao || '');
        if (e.operacaoConfirmada === true && op && !/colheita/.test(op)) f.colhParadas++;
      }
    }
    const checar = (frente, chaveFrente, id, liga, minMin, texto, detalhe, valor) => {
      const pe = { id: 'frente:' + chaveFrente, numero: frente, nome: 'Frente ' + frente, tipo: 'Frente', frente };
      const st = marcar(pe.id, 'gestao:' + id, liga, ts, null);
      if (!liga && !st.firing) ativos.delete(st.chave);
      if (!st.firing) return;
      if ((ts - st.since) / 60000 < minMin) return;
      const cooldown = Math.max(0, Number(cfg.cooldownMin) || 0) * 60000;
      const ultimoDisparo = gestaoUltimoDisparo.get(st.chave) || 0;
      if (ultimoDisparo && (!cooldown || ts - ultimoDisparo < cooldown)) return;
      if (!podeDisparar(st, ts)) return;
      gestaoUltimoDisparo.set(st.chave, ts);
      emitir({ chave: st.chave, regra: 'gestaoFrente', e: pe, valor, lider: policy.liderFrente(cfg, frente),
        texto: texto + ' · frente/grupo: ' + frente, detalhe, inicio: st.since });
    };
    const filaMax = Math.max(0, num(cfg.filaMaxFrente) || 0);
    const semColh = Math.max(0, num(cfg.minutosFrenteSemColhedora) || 0);
    const tbMax = Math.max(0, num(cfg.transbordosAguardandoMax) || 0);
    for (const [chaveFrente, f] of porFrente) {
      const frente = f.frente;
      checar(frente, chaveFrente, 'fila', filaMax > 0 && f.fila.length >= filaMax, 0,
        `${f.fila.length} equipamentos em fila aguardando carregamento, segurar o despacho de caminhões`,
        'Fila/aguardando carregamento: ' + f.fila.join(', '), f.fila.length);
      checar(frente, chaveFrente, 'semColhedora', semColh > 0 && f.colh > 0 && f.colhParadas === f.colh, semColh,
        `todas as ${f.colh} colhedoras paradas, frente sem colheita`,
        'Nenhuma colhedora em operação de colheita', f.colh);
      checar(frente, chaveFrente, 'desequilibrio', tbMax > 0 && f.transbAg.length >= tbMax, 0,
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
    if (stOutra && !avaliacaoSoTempo) {
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
    if (a.descFrente != null && String(a.descFrente).trim() !== '') e.frente = String(a.descFrente).trim();
    if (a.descGrupoEquipamento != null) {
      e.grupoEquipamento = String(a.descGrupoEquipamento).trim();
    }
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
    if (!dentroDoEscopo(e, { alarmesOficiais: true })) {
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
      caminhoes: Array.isArray(a.caminhoes) ? a.caminhoes.slice() : [],
      nivel: a.nivel || 1,
      lider: a.lider || '',
      texto: a.texto,
      detalhe: a.detalhe || '',
      frentesInferidasNotificadas: prev && Array.isArray(prev.frentesInferidasNotificadas)
        ? prev.frentesInferidasNotificadas.slice()
        : a.e.frenteInferida ? [a.e.frenteInferida] : [],
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
        frenteInferida: alerta.e.frenteInferida || '',
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

    const emergencia = alerta.regra === 'emergencia';
    const seguranca = policy.ehAlertaSeguranca(alerta.regra);
    const chuvaAtiva = !seguranca && !a.simulado
      ? frenteEmChuva(alerta.e && (alerta.e.frente || alerta.e.frenteInferida || alerta.e.grupoEquipamento))
      : null;
    if (chuvaAtiva) {
      alerta.emChuva = chuvaAtiva.frente;
      renderAtivos();
      renderCabecalho();
      return; // frente em pausa/chuva: mantém registro na Central sem gerar fadiga sonora
    }

    const silenciado = !emergencia && (ts < (Number(cfg.silencioAte) || 0) || jaReconhecido);
    const oficial = alerta.fonte === 'portal' || emergencia;
    const localAberto = localComCanais(alerta) && alerta.notificar;
    // Alarmes oficiais e emergências não podem ser suprimidos pela proteção de rajada.
    let demais = false;
    if (!oficial) {
      if (ts - rajada.ts > 20000) rajada = { ts, voz: 0, aviso: false };
      demais = ++rajada.voz > Math.max(1, Number(cfg.maxPorCiclo) || 4);
    }
    if (emergencia) mostrarBannerEmergencia(alerta);
    if (cfg.popup && (oficial || localAberto || a.simulado)) mostrarToast(alerta, silenciado || demais);
    if (!silenciado && !demais) {
      if ((oficial || localAberto || a.simulado) && cfg.som) tocar(emergencia ? 4 : regra.severidade, emergencia);
      if (cfg.voz && (oficial || localAberto || a.simulado || vozLocalSemPontoConfirmado) && (emergencia || !alerta.repeticao || cfg.repetirVoz)) {
        falar(alerta.fala, { oficial, emergencia });
        faladoEm.set(chave, ts);
      }
      if ((oficial || localAberto || a.simulado) && cfg.vibrar) vibrar(emergencia ? 4 : regra.severidade);
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
    return policy.montarFala(a, cfg);
  }

  /* --------------------------- voz (TTS) --------------------------- */

  const PERFIS_VOZ = {
    padrao: { nome: 'Padrão equilibrado', taxa: 1.0, tom: 1.0, estiloToque: 'gongo-coa' },
    'coa-firme': { nome: 'Locutor firme COA (comando)', taxa: 1.05, tom: 0.88, estiloToque: 'gongo-coa' },
    'clara-pausada': { nome: 'Locução clara e pausada (ambiente ruidoso)', taxa: 0.92, tom: 1.04, estiloToque: 'radio-bip' },
    urgente: { nome: 'Alerta rápido operacional', taxa: 1.15, tom: 1.02, estiloToque: 'sirene-curta' },
    personalizado: { nome: 'Personalizado (ritmo e tom manuais)', taxa: null, tom: null, estiloToque: null },
  };

  let rajada = { ts: 0, voz: 0, aviso: false };
  const faladoEm = new Map();
  let vozBloqueada = false;
  let timerResumeVoz = null;
  let timerWatchdogVoz = null;

  function limparTimersVozWeb() {
    if (timerResumeVoz) {
      clearInterval(timerResumeVoz);
      timerResumeVoz = null;
    }
    if (timerWatchdogVoz) {
      clearTimeout(timerWatchdogVoz);
      timerWatchdogVoz = null;
    }
  }

  /* Chrome/Safari bloqueiam a voz antes do primeiro toque: guarda a fila e pede um toque. */
  function bloquearVoz(item) {
    limparTimersVozWeb();
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
    renderHudBarra();
  }
  function liberarVoz() {
    toquei = true;
    const b = document.getElementById('voz-bloqueada');
    if (b) b.classList.add('hide');
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { ac = ac || new AC(); if (ac.state === 'suspended') ac.resume(); }
    } catch { /* sem áudio */ }
    sincronizarAudioSentinela();
    if (!vozBloqueada) {
      renderHudBarra();
      return;
    }
    vozBloqueada = false;
    falando = false;
    const s = sintetizador();
    if (s) { try { s.cancel(); s.resume(); } catch { /* nada */ } }
    renderHudBarra();
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

  function qualidadeVozPt(v) {
    const nome = String((v && v.name) || '');
    const lang = String((v && v.lang) || '');
    let pontos = 0;
    if (/pt[-_]br/i.test(lang)) pontos += 50;
    else if (/^pt/i.test(lang)) pontos += 25;
    if (/natural|neural|francisca|antonio|thalita|luciana|felipe|google portugu/i.test(nome)) pontos += 30;
    if (/online|network/i.test(nome)) pontos += 10;
    return pontos;
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
    if (!v) {
      const candidatasPt = vozes.filter((x) => /pt[-_]br/i.test(x.lang) || /^pt/i.test(x.lang) || /brazil|brasil/i.test(x.name));
      if (candidatasPt.length) {
        candidatasPt.sort((a, b) => qualidadeVozPt(b) - qualidadeVozPt(a));
        v = candidatasPt[0];
      }
    }
    vozEscolhida = v || null;
  }

  function falar(texto, opcoes) {
    if (!cfg.voz) return;
    const emergencia = !!(opcoes && opcoes.emergencia);
    const item = { texto: String(texto), oficial: !!(opcoes && opcoes.oficial) || emergencia, emergencia, retentou: false };
    ultimaFalaEmitida = { texto: item.texto, ts: agora(), oficial: item.oficial, emergencia };
    if (emergencia) {
      const pendentes = fila.slice();
      pararVoz();
      fila = [item, ...pendentes];
    } else if (item.oficial) {
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
    atualizarJanelaFlutuante();
    descargarFila();
  }

  let timerVozNativa = null;
  function concluirVozNativa() {
    if (timerVozNativa) {
      clearTimeout(timerVozNativa);
      timerVozNativa = null;
    }
    if (!falando) return;
    falando = false;
    setTimeout(descargarFila, 80);
  }

  function descargarFila() {
    if (falando || vozBloqueada || !fila.length) return;
    limparTimersVozWeb();
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
        const vol = Number(cfg.volume) || 1;
        const taxa = Number(cfg.taxa) || 1;
        const tom = Number(cfg.tom) || 1;
        if (typeof nativa.falarComVozETom === 'function') {
          nativa.falarComVozETom(texto, vol, taxa, tom, idNativo);
        } else if (typeof nativa.falarComVoz === 'function') {
          nativa.falarComVoz(texto, vol, taxa, idNativo);
        } else {
          nativa.falar(texto, vol, taxa);
        }
      } catch {
        /* segue sem voz */
      }
      clearTimeout(timerVozNativa);
      timerVozNativa = setTimeout(concluirVozNativa, Math.min(20000, 900 + texto.length * 65));
      return;
    }
    if (!s) {
      tocar(3);
      setTimeout(descargarFila, 200);
      return;
    }
    escolherVoz();
    try {
      if (s.paused && typeof s.resume === 'function') s.resume();
    } catch { /* navegador sem resume */ }
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = (vozEscolhida && vozEscolhida.lang) || 'pt-BR';
    if (vozEscolhida) u.voice = vozEscolhida;
    u.volume = Math.max(0, Math.min(1, Number(cfg.volume)));
    u.rate = Math.max(0.5, Math.min(2, Number(cfg.taxa)));
    u.pitch = Math.max(0.5, Math.min(2, Number(cfg.tom)));
    let comecou = false;
    let concluida = false;
    const finalizarItem = () => {
      if (concluida) return;
      concluida = true;
      limparTimersVozWeb();
      falando = false;
      setTimeout(descargarFila, 180);
    };
    u.onstart = () => { comecou = true; };
    u.onend = finalizarItem;
    u.onerror = (ev) => {
      if (concluida) return;
      limparTimersVozWeb();
      const erro = ev && ev.error;
      if (erro === 'not-allowed' || (!comecou && erro !== 'interrupted' && erro !== 'canceled' && !toquei)) {
        bloquearVoz(item);
        return;
      }
      if (!comecou && !item.retentou && erro !== 'canceled' && erro !== 'interrupted') {
        item.retentou = true;
        falando = false;
        try { s.cancel(); if (typeof s.resume === 'function') s.resume(); } catch { /* nada */ }
        fila.unshift(item);
        setTimeout(descargarFila, 250);
        return;
      }
      if (!comecou && cfg.som) tocar(3);
      finalizarItem();
    };
    falando = true;
    try {
      s.speak(u);
      if (falando) {
        // Evita o bug clássico do Chrome onde falas longas ou em 2º plano pausam sozinhas após ~14s.
        timerResumeVoz = setInterval(() => {
          if (!falando) { limparTimersVozWeb(); return; }
          try { if (s.paused && typeof s.resume === 'function') s.resume(); } catch { /* ignora */ }
        }, 4000);
        const prazoMax = Math.min(28000, 3500 + texto.length * 110);
        timerWatchdogVoz = setTimeout(() => {
          if (!falando || concluida) return;
          const semGesto = !toquei && navigator.userActivation && !navigator.userActivation.hasBeenActive;
          if (!comecou && semGesto) { bloquearVoz(item); return; }
          try { s.cancel(); if (typeof s.resume === 'function') s.resume(); } catch { /* ignora */ }
          if (!comecou && !item.retentou) {
            item.retentou = true;
            concluida = true;
            limparTimersVozWeb();
            falando = false;
            fila.unshift(item);
            setTimeout(descargarFila, 220);
            return;
          }
          if (!comecou && cfg.som) tocar(3);
          finalizarItem();
        }, prazoMax);
      }
    } catch {
      limparTimersVozWeb();
      falando = false;
    }
  }

  function pararVoz() {
    fila = [];
    falando = false;
    limparTimersVozWeb();
    if (timerVozNativa) {
      clearTimeout(timerVozNativa);
      timerVozNativa = null;
    }
    const s = sintetizador();
    if (s) {
      try { s.cancel(); } catch { /* ignora */ }
    }
    const nativa = ponteNativa();
    if (nativa && typeof nativa.parar === 'function') {
      try {
        nativa.parar();
      } catch {
        /* nada a fazer */
      }
    }
  }

  function calarFalaAtual() {
    pararVoz();
    mostrarAviso('Fala atual interrompida — os próximos alertas continuam habilitados.', 'info');
  }

  function alternarVoz() {
    if (vozBloqueada) {
      liberarVoz();
      if (!cfg.voz) configurar({ voz: true });
      return cfg.voz;
    }
    const novo = !cfg.voz;
    configurar({ voz: novo });
    if (novo) falar('Voz dos alertas ativada.');
    else pararVoz();
    return novo;
  }

  /* --------------------------- som / vibração --------------------------- */

  let ac = null;
  function padraoNotasToque(estilo, severidade, escalado) {
    if (severidade >= 4) {
      return [
        ['sawtooth', 880, 0, 0.16, 0.22],
        ['sawtooth', 1320, 0.17, 0.16, 0.22],
        ['sawtooth', 880, 0.34, 0.16, 0.22],
        ['sawtooth', 1320, 0.51, 0.2, 0.24],
      ];
    }
    if (estilo === 'radio-bip') {
      return severidade >= 3 || escalado
        ? [['square', 1046, 0, 0.09, 0.14], ['square', 1318, 0.11, 0.09, 0.16], ['square', 1046, 0.22, 0.11, 0.14]]
        : [['sine', 988, 0, 0.08, 0.14], ['sine', 1174, 0.11, 0.1, 0.14]];
    }
    if (estilo === 'sirene-curta') {
      return severidade >= 3 || escalado
        ? [['sawtooth', 740, 0, 0.14, 0.14], ['sawtooth', 1108, 0.15, 0.14, 0.15], ['sawtooth', 740, 0.3, 0.14, 0.14], ['sawtooth', 1108, 0.45, 0.16, 0.15]]
        : [['triangle', 698, 0, 0.14, 0.16], ['triangle', 932, 0.16, 0.16, 0.16]];
    }
    if (estilo === 'gongo-coa') {
      return severidade >= 3 || escalado
        ? [['sine', 587.33, 0, 0.26, 0.22], ['triangle', 880, 0.14, 0.28, 0.2], ['sine', 1174.66, 0.28, 0.34, 0.22]]
        : severidade === 2
          ? [['sine', 523.25, 0, 0.22, 0.18], ['sine', 783.99, 0.15, 0.26, 0.18]]
          : [['sine', 587.33, 0, 0.2, 0.15]];
    }
    return severidade >= 3 || escalado
      ? [['triangle', 880, 0, 0.18, 0.2], ['triangle', 1174, 0.17, 0.18, 0.2], ['triangle', 880, 0.34, 0.18, 0.2]]
      : severidade === 2
        ? [['triangle', 698, 0, 0.18, 0.18], ['triangle', 880, 0.19, 0.18, 0.18]]
        : [['triangle', 587, 0, 0.18, 0.16]];
  }

  function tocar(severidade, escalado = false) {
    if (!cfg.som) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = ac || new AC();
      if (ac.state === 'suspended') ac.resume();
      const notas = padraoNotasToque(cfg.estiloToque || 'gongo-coa', severidade, escalado);
      for (const [tipo, f, t, dur, ganho] of notas) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = tipo;
        o.frequency.value = f;
        const i = ac.currentTime + t;
        g.gain.setValueAtTime(0.0001, i);
        g.gain.exponentialRampToValueAtTime(ganho, i + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, i + dur);
        o.connect(g).connect(ac.destination);
        o.start(i);
        o.stop(i + dur + 0.04);
      }
    } catch {
      /* sem WebAudio: a voz e o pop-up continuam */
    }
  }

  /* ------------ Sentinela 2º plano (Áudio Keep-Alive, Wake Lock e PiP) ------------ */

  function criarWavSilenciosoUrl() {
    const taxaAmostragem = 8000;
    const amostras = taxaAmostragem; // 1 segundo mono 8-bit PCM sem ruído
    const buffer = new ArrayBuffer(44 + amostras);
    const v = new DataView(buffer);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + amostras, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, taxaAmostragem, true);
    v.setUint32(28, taxaAmostragem, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    str(36, 'data');
    v.setUint32(40, amostras, true);
    new Uint8Array(buffer, 44).fill(128);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function sincronizarAudioSentinela() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const deveManter = !!toquei && !!cfg.ativo && !!cfg.voz && cfg.sentinelaSegundoPlano !== false && !ponteNativa();
    if (!deveManter) {
      if (sentinelaAudio) {
        try { sentinelaAudio.el.pause(); } catch { /* ignora */ }
        if (sentinelaAudio.osc) {
          try { sentinelaAudio.osc.stop(); sentinelaAudio.osc.disconnect(); } catch { /* ignora */ }
          sentinelaAudio.osc = null;
        }
      }
      return;
    }
    try {
      if (!sentinelaAudio) {
        const audio = document.createElement('audio');
        audio.loop = true;
        audio.preload = 'auto';
        audio.volume = 0.01;
        audio.setAttribute('playsinline', '');
        audio.src = criarWavSilenciosoUrl();
        sentinelaAudio = { el: audio, osc: null };
      }
      if (sentinelaAudio.el.paused) {
        const p = sentinelaAudio.el.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        ac = ac || new AC();
        if (ac.state === 'suspended') ac.resume().catch(() => {});
        if (!sentinelaAudio.osc && ac.state === 'running') {
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          osc.type = 'sine';
          osc.frequency.value = 18;
          gain.gain.value = 0.00001;
          osc.connect(gain).connect(ac.destination);
          osc.start();
          sentinelaAudio.osc = osc;
        }
      }
      if ('mediaSession' in navigator && navigator.mediaSession) {
        if (typeof MediaMetadata !== 'undefined') {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Monitoramento BP · Sentinela COA',
            artist: 'Branco Peres — Alertas por voz em 2º plano',
            album: 'Centro de Operações Agrícolas',
          });
        }
      }
    } catch {
      /* ambiente sem suporte a keep-alive de mídia */
    }
  }

  async function sincronizarWakeLock() {
    if (typeof navigator === 'undefined' || !navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
    const deveTravar = !!cfg.ativo && cfg.manterTelaAtiva !== false && typeof document !== 'undefined' && document.visibilityState === 'visible';
    if (!deveTravar) {
      if (wakeLockAtivo) {
        const atual = wakeLockAtivo;
        wakeLockAtivo = null;
        try { await atual.release(); } catch { /* já liberado */ }
      }
      return;
    }
    if (wakeLockAtivo && !wakeLockAtivo.released) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLockAtivo = sentinel;
      if (sentinel && typeof sentinel.addEventListener === 'function') {
        sentinel.addEventListener('release', () => {
          if (wakeLockAtivo === sentinel) wakeLockAtivo = null;
        });
      }
    } catch {
      /* permissão de wakeLock recusada ou aba em segundo plano */
    }
  }

  function sincronizarSegundoPlanoNativo() {
    const nativa = ponteNativa();
    if (!nativa || typeof nativa.configurarSegundoPlano !== 'function') return;
    try {
      nativa.configurarSegundoPlano(Boolean(cfg.ativo && cfg.sentinelaSegundoPlano !== false));
    } catch {
      /* APK anterior sem suporte a serviço de segundo plano */
    }
  }

  function sincronizarSentinelaCompleta() {
    sincronizarRelogioSegundoPlano();
    sincronizarAudioSentinela();
    sincronizarWakeLock();
    sincronizarSegundoPlanoNativo();
  }

  function estadoConexaoCoa() {
    if (!cfg.ativo) return { chave: 'off', rotulo: 'DESLIGADO' };
    const ts = agora();
    const streamVivo = estado.stream === 'ao vivo' && ultimoSinalStream > 0 && ts - ultimoSinalStream < 90_000;
    if (quedaSgpaAtiva || estado.sessao === 'expirada' || estado.sessao === 'sem autorização' || (estado.erros >= 2 && !streamVivo)) {
      return { chave: 'warn', rotulo: 'SEM SINAL' };
    }
    if (streamVivo) return { chave: 'live', rotulo: 'AO VIVO' };
    if (estado.ultimoCiclo > 0) return { chave: 'rest', rotulo: 'REST ATIVO' };
    return { chave: 'boot', rotulo: 'CONECTANDO' };
  }

  function atualizarJanelaFlutuante() {
    if (!janelaPip || janelaPip.closed) {
      janelaPip = null;
      const btnPip = $('btn-pip');
      if (btnPip) btnPip.classList.remove('pip-ativo');
      return;
    }
    try {
      const doc = janelaPip.document;
      const lista = [...ativos.values()].sort((a, b) => (b.severidade || 0) - (a.severidade || 0) || (b.ts || 0) - (a.ts || 0));
      const criticos = lista.filter((a) => (a.severidade || 0) >= 3).length;
      const st = estadoConexaoCoa();
      const pill = doc.getElementById('pip-status');
      const cont = doc.getElementById('pip-contadores');
      const card = doc.getElementById('pip-ultimo');
      const btnVoz = doc.getElementById('pip-voz');
      const btnMapa = doc.getElementById('pip-mapa');
      if (pill) {
        pill.textContent = st.rotulo;
        pill.dataset.state = st.chave;
      }
      if (cont) {
        cont.textContent = `${lista.length} ativo${lista.length === 1 ? '' : 's'} · ${criticos} crítico${criticos === 1 ? '' : 's'}`;
      }
      const topo = lista[0];
      if (card) {
        if (topo) {
          card.innerHTML = '';
          const eq = doc.createElement('strong');
          eq.textContent = `${topo.icone || '🚨'} ${topo.classe || 'Equipamento'} ${topo.numero || ''} — ${topo.nome || ''}`;
          const txt = doc.createElement('p');
          txt.textContent = topo.texto || '';
          const meta = doc.createElement('span');
          meta.className = 'pip-meta';
          meta.textContent = `${hora(topo.ts)} · ${(topo.e && (topo.e.frente || topo.e.frenteInferida)) || 'Unidade BP'}`;
          card.append(eq, txt, meta);
          if (btnMapa) {
            btnMapa.disabled = false;
            btnMapa.onclick = () => { window.focus(); abrirNoMapa(topo); };
          }
        } else {
          card.innerHTML = '<p class="pip-vazio">Nenhum alerta ativo no momento. Monitoramento e voz prontos em 2º plano.</p>';
          if (btnMapa) btnMapa.disabled = true;
        }
      }
      if (btnVoz) {
        btnVoz.textContent = cfg.voz ? '🔊 Voz ativa' : '🔇 Voz muda';
        btnVoz.className = cfg.voz ? 'pip-btn ok' : 'pip-btn warn';
      }
    } catch {
      janelaPip = null;
    }
  }

  async function alternarJanelaFlutuante() {
    if (janelaPip && !janelaPip.closed) {
      janelaPip.close();
      janelaPip = null;
      renderHudBarra();
      return false;
    }
    toquei = true;
    sincronizarAudioSentinela();
    let win = null;
    try {
      if (window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
        win = await window.documentPictureInPicture.requestWindow({ width: 390, height: 275 });
      } else {
        win = window.open('', 'bp_coa_sentinela', 'popup=yes,width=390,height=290');
      }
    } catch {
      win = null;
    }
    if (!win || !win.document) {
      mostrarAviso('Não foi possível abrir a janela flutuante neste navegador. O modo Sentinela em 2º plano continua ativo.', 'info');
      return false;
    }
    janelaPip = win;
    const d = win.document;
    d.open();
    d.write(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><title>Sentinela COA — Branco Peres</title>
      <style>
        *{box-sizing:border-box}body{margin:0;padding:12px;background:#091119;color:#f1f5f9;font:13px/1.42 system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;gap:10px;height:100vh}
        header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-bottom:8px;border-bottom:1px solid rgba(250,204,21,.28)}
        .tit{font-weight:800;font-size:13.5px;letter-spacing:-.01em}.tit b{color:#facc15}
        #pip-status{padding:3px 9px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.06em;background:#1e293b;color:#cbd5e1}
        #pip-status[data-state="live"]{background:rgba(6,78,59,.6);color:#6ee7b7;border:1px solid rgba(16,185,129,.45)}
        #pip-status[data-state="rest"]{background:rgba(120,53,15,.5);color:#fde68a;border:1px solid rgba(245,158,11,.45)}
        #pip-status[data-state="warn"]{background:rgba(127,29,29,.65);color:#fecaca;border:1px solid rgba(239,68,68,.55)}
        #pip-contadores{font-size:11.5px;color:#94a3b8;font-weight:600;font-variant-numeric:tabular-nums}
        #pip-ultimo{flex:1;padding:10px 12px;border-radius:12px;background:#111d2a;border:1px solid rgba(148,163,184,.18);overflow:auto;display:flex;flex-direction:column;gap:4px}
        #pip-ultimo strong{font-size:13px;color:#fef08a}#pip-ultimo p{margin:0;font-size:12.5px;color:#e2e8f0}
        .pip-meta{font-size:11px;color:#94a3b8}.pip-vazio{color:#94a3b8!important}
        footer{display:flex;gap:6px}
        .pip-btn{flex:1;padding:7px 8px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:#172636;color:#f1f5f9;font-size:11.5px;font-weight:600;cursor:pointer}
        .pip-btn.ok{border-color:rgba(16,185,129,.45);color:#6ee7b7}.pip-btn.warn{border-color:rgba(239,68,68,.5);color:#fca5a5}
        .pip-btn:disabled{opacity:.45;cursor:default}
      </style></head><body>
      <header><span class="tit">Sentinela <b>COA · BP</b></span><span id="pip-status">ATIVO</span></header>
      <div id="pip-contadores">0 ativos</div>
      <div id="pip-ultimo"></div>
      <footer>
        <button id="pip-calar" class="pip-btn" type="button">⏹ Calar fala</button>
        <button id="pip-voz" class="pip-btn ok" type="button">🔊 Voz ativa</button>
        <button id="pip-mapa" class="pip-btn" type="button">📍 No mapa</button>
      </footer></body></html>`);
    d.close();
    d.getElementById('pip-calar').onclick = () => calarFalaAtual();
    d.getElementById('pip-voz').onclick = () => { alternarVoz(); atualizarJanelaFlutuante(); };
    win.addEventListener('pagehide', () => {
      if (janelaPip === win) janelaPip = null;
      renderHudBarra();
    });
    renderHudBarra();
    atualizarJanelaFlutuante();
    return true;
  }

  let toquei = false;
  let escondidoEm = 0;
  if (typeof window !== 'undefined') {
    const marcarToque = () => {
      const primeiro = !toquei;
      toquei = true;
      if (vozBloqueada) setTimeout(liberarVoz, 0);
      else if (primeiro) setTimeout(sincronizarAudioSentinela, 0);
    };
    addEventListener('pointerdown', marcarToque, { passive: true, capture: true });
    addEventListener('touchstart', marcarToque, { passive: true, capture: true });
    addEventListener('keydown', marcarToque, { capture: true });
  }
  function vibrar(severidade) {
    if (!cfg.vibrar) return;
    try {
      const nativa = ponteNativa();
      if (nativa && nativa.vibrar) nativa.vibrar(severidade >= 4 ? 700 : severidade >= 3 ? 400 : 180);
      // o navegador só deixa vibrar depois do primeiro toque do usuário: sem isso, enche o console de aviso
      else if (toquei && navigator.vibrate) navigator.vibrate(severidade >= 4 ? [300, 100, 300, 100, 300] : severidade >= 3 ? [220, 90, 220] : [140]);
    } catch {
      /* aparelho sem vibração */
    }
  }

  /* Exceção pedida pelo usuário: regras COA locais com fala/pop-up enquanto o app está aberto. */
  function localComCanais(a) {
    return !!a && a.fonte === 'app' && (
      a.regra === 'semApontamento' || a.regra === 'refeicao' || a.regra === 'paradaImprodutiva' ||
      a.regra === 'gestaoFrente' || a.regra === 'aguardandoBasculamento' || a.regra === 'frenteDividida' ||
      a.regra === 'emergencia' || a.regra === 'telemetriaMuda' || a.regra === 'qualidadeColheita' ||
      a.regra === 'inconsistenciaApontamento' || a.regra === 'riscoMoenda' ||
      a.regra === 'bateVolta' || a.regra === 'manutencaoPreditiva'
    );
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
  let auditStorageError = '';
  let auditRemoteError = '';
  let auditFilaMigrada = false;
  let auditPausaAte = 0;
  let auditTimer = null;
  let auditEnviando = false;

  function novoIdAudit() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `audit-${agora()}-${Math.random().toString(36).slice(2)}`;
  }

  function carregarFilaAudit() {
    try {
      const bruto = localStorage.getItem(KEY_AUDIT_QUEUE);
      if (!bruto) return [];
      const salva = JSON.parse(bruto);
      if (!Array.isArray(salva)) throw new Error('formato de fila inválido');
      return salva.filter((item) => item && typeof item === 'object').map((item) => {
        if (item.eventId) return item;
        auditFilaMigrada = true;
        return Object.assign({}, item, { eventId: novoIdAudit() });
      });
    } catch {
      auditStorageError = 'A fila local de auditoria não pôde ser lida; os próximos alertas ficarão apenas na memória.';
      return [];
    }
  }

  const filaAudit = carregarFilaAudit();
  if (auditFilaMigrada) persistirFilaAudit();

  function persistirFilaAudit() {
    try {
      localStorage.setItem(KEY_AUDIT_QUEUE, JSON.stringify(filaAudit));
      auditStorageError = '';
      return true;
    } catch {
      auditStorageError = 'Não foi possível persistir a fila de auditoria neste aparelho; ela fica vulnerável ao fechamento da página.';
      return false;
    }
  }

  function registrarNoServidor(a) {
    if (!ctx.audit) return;
    filaAudit.push({
      eventId: novoIdAudit(),
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
    persistirFilaAudit();
    if (!auditTimer) auditTimer = setTimeout(enviarAudit, 20000);
    renderCabecalho();
  }

  async function enviarAudit() {
    if (auditTimer) clearTimeout(auditTimer);
    auditTimer = null;
    if (auditEnviando || !filaAudit.length) return;
    if (agora() < auditPausaAte) {
      auditTimer = setTimeout(enviarAudit, Math.max(1000, auditPausaAte - agora()));
      return;
    }
    auditEnviando = true;
    const lote = filaAudit.slice(0, 25);
    try {
      const auditHeaders = { 'content-type': 'application/json' };
      if (typeof window !== 'undefined' && window.__APP_KEY) auditHeaders['x-app-key'] = String(window.__APP_KEY);
      const { res, json } = await requisitarJson('/.netlify/functions/session?acao=alerta', {
        method: 'POST',
        headers: auditHeaders,
        body: JSON.stringify({ alertas: lote, unidade: ctx.unidade || '', usuario: ctx.usuario || '' }),
      }, 'gravação da auditoria');
      if (res.status === 429) {
        auditPausaAte = agora() + 120000;
        auditRemoteError = 'O servidor limitou a gravação da auditoria; a fila foi mantida para nova tentativa.';
        return;
      }
      if (!res.ok || !json || !Array.isArray(json.resultados) || json.resultados.length !== lote.length) {
        throw new Error('o servidor não confirmou cada alerta da fila');
      }
      const esperados = new Set(lote.map((item) => String(item.eventId)));
      const vistos = new Set();
      const gravados = new Set();
      for (const resultado of json.resultados) {
        const id = String(resultado && resultado.eventId || '');
        if (!esperados.has(id) || vistos.has(id)) throw new Error('confirmação de auditoria inválida');
        vistos.add(id);
        if (resultado.ok === true) gravados.add(id);
      }
      if (vistos.size !== esperados.size) throw new Error('confirmação de auditoria incompleta');
      if (gravados.size) {
        for (let i = filaAudit.length - 1; i >= 0; i--) {
          if (gravados.has(String(filaAudit[i].eventId))) filaAudit.splice(i, 1);
        }
        persistirFilaAudit();
      }
      const falhas = json.resultados.length - gravados.size;
      if (falhas) {
        auditRemoteError = `${falhas} alerta(s) não foram confirmados no servidor; permaneceram na fila.`;
        auditPausaAte = agora() + 30000;
      } else {
        auditRemoteError = '';
        auditPausaAte = 0;
      }
    } catch (erro) {
      auditRemoteError = 'A gravação da auditoria não foi confirmada; os alertas permanecem na fila.';
      auditPausaAte = agora() + 60000;
    } finally {
      auditEnviando = false;
      if (filaAudit.length) auditTimer = setTimeout(enviarAudit, Math.max(30000, auditPausaAte - agora()));
      renderCabecalho();
    }
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
        <img src="/icons/logo.png" alt="" width="28" height="28" />
        <div><strong>Central de alertas · COA</strong><span id="alertas-status" class="fine"></span></div>
      </div>
      <button id="alertas-fechar" class="icone" title="Fechar" aria-label="Fechar">✕</button>
    </header>
    <div class="ferramentas">
      <div class="abas">
        <button class="aba ativa" data-aba="ativos">Ativos <span id="cont-ativos" class="pill">0</span></button>
        <button class="aba" data-aba="frentes">Frentes <span id="cont-frentes" class="pill">0</span></button>
        <button class="aba" data-aba="comboio">Comboio <span id="cont-comboio" class="pill">0</span></button>
        <button class="aba" data-aba="historico">Histórico <span id="cont-hist" class="pill">0</span></button>
      </div>
      <div class="atalhos">
        <button id="btn-calar" class="icone" title="Calar apenas a fala atual (mantém próximos alertas)" aria-label="Calar fala atual">⏹</button>
        <button id="btn-som" class="icone" title="Som do alerta">🔊</button>
        <button id="btn-voz" class="icone" title="Fala do alerta">🗣️</button>
        <button id="btn-silencio" class="icone" title="Silenciar por 30 minutos">🤫</button>
        <button id="btn-cfg" class="icone" title="Preferências de alertas">⚙️</button>
      </div>
    </div>
    <div class="busca-central" role="search">
      <input id="alertas-busca" type="search" aria-label="Buscar por frota, alerta ou operador" aria-controls="lista-ativos lista-frentes lista-comboio lista-historico" placeholder="Frota, frente, alerta ou operador" autocomplete="off">
      <button id="alertas-busca-limpar" class="icone hide" type="button" title="Limpar busca" aria-label="Limpar busca">✕</button>
    </div>
    <div class="linha-status">
      <span class="dot" id="dot-ciclo" title="estado da conexão"></span>
      <span id="alertas-proximo">—</span>
      <span class="fine" id="alertas-stream"></span>
      <span class="fine" id="alertas-escopo"></span>
    </div>
    <div id="lista-ativos" class="lista"></div>
    <div id="lista-frentes" class="lista hide"></div>
    <div id="lista-comboio" class="lista hide"></div>
    <div id="lista-historico" class="lista hide"></div>
    <footer>
      <button id="btn-limpar">Limpar ativos</button>
      <button id="btn-passagem" title="Gerar boletim automático de passagem de turno do COA">📋 Turno</button>
      <button id="btn-exportar">Exportar CSV</button>
      <button id="btn-teste" class="primary">Testar pop-up e voz</button>
    </footer>
  </div>
  <div class="veu"></div>
</div>

<div id="emergencia-banner" class="hide" role="alert" aria-live="assertive">
  <div class="emg-info">
    <span class="emg-tag">🔥 EMERGÊNCIA COA</span>
    <strong id="emg-titulo"></strong>
    <span id="emg-detalhe"></span>
  </div>
  <div class="emg-acoes">
    <button id="emg-mapa" type="button">📍 Ver local</button>
    <button id="emg-whats" type="button">💬 Cobrar</button>
    <button id="emg-ciente" type="button" class="emg-ok">✓ Ciente</button>
  </div>
</div>

<div id="coa-telao-bar" aria-label="Painel Telão COA">
  <div class="telao-kpis" id="telao-kpis"></div>
  <button id="telao-sair" type="button">✕ Sair do Telão</button>
</div>

<div id="toasts" aria-live="assertive" aria-atomic="false"></div>

<div id="modal-passagem" class="hide" role="dialog" aria-modal="true" aria-labelledby="passagem-titulo">
  <div class="card cfg passagem-card">
    <div class="cfg-topo">
      <span aria-hidden="true"></span>
      <img class="marca" src="/icons/logo.png" alt="" width="44" height="44" />
      <button id="passagem-fechar-x" class="icone cfg-fechar-x" type="button" title="Fechar passagem de turno" aria-label="Fechar passagem de turno">✕</button>
    </div>
    <h2 id="passagem-titulo">Boletim de Passagem de Turno · COA</h2>
    <p id="passagem-meta" class="fine"></p>
    <div id="passagem-kpis" class="passagem-kpis"></div>
    <textarea id="passagem-texto" rows="13" aria-label="Texto da passagem de turno" spellcheck="false"></textarea>
    <div class="row">
      <button id="passagem-copiar" type="button" class="primary">📋 Copiar boletim</button>
      <a id="passagem-whats" class="btn" target="_blank" rel="noopener">💬 Enviar WhatsApp</a>
      <button id="passagem-imprimir" type="button">🖨️ Imprimir / PDF</button>
      <button id="passagem-fechar" type="button">Fechar</button>
    </div>
  </div>
</div>

<div id="cfg-alertas" class="hide" role="dialog" aria-modal="true" aria-labelledby="cfg-titulo">
  <div class="card cfg">
    <div class="cfg-topo">
      <span aria-hidden="true"></span>
      <img class="marca" src="/icons/logo.png" alt="" width="48" height="48" />
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
    <h3 class="secao-alertas">Tema visual</h3>
    <div class="grade">
      <label class="campo"><span>Tema da interface neste aparelho</span>
        <select id="cfg-acabamento">
          <option value="vidro">Liquid Glass (vidro escuro refrativo estilo iPhone)</option>
          <option value="black">Tema Black (preto puro · máximo contraste)</option>
        </select>
      </label>
    </div>
    <p class="fine">Aplica na hora neste aparelho (também disponível como atalho rápido em ⚙ Centro de Comando COA). O Tema Black usa preto puro sem transparência, ideal para telões claros ou máxima nitidez.</p>
    <h3 class="secao-alertas">Modo Sentinela COA (2º plano e anti-perda)</h3>
    <p class="fine">Garante que o computador (aba minimizada ou atrás de outros sistemas) e o APK Android continuem monitorando e falando os alertas, além de avisar imediatamente caso o sinal do SGPA caia.</p>
    <div class="switches">
      <label class="chk"><input id="cfg-sentinela" type="checkbox"><span>Manter voz e monitoramento vivos em 2º plano (Sentinela COA — PC e APK Android)</span></label>
      <label class="chk"><input id="cfg-wakelock" type="checkbox"><span>Impedir desligamento automático da tela (Wake Lock)</span></label>
      <label class="chk"><input id="cfg-queda-sgpa" type="checkbox"><span>Avisar por som e voz se perder comunicação com o SGPA (&gt; 2 min)</span></label>
      <label class="chk"><input id="cfg-reescalar-criticos" type="checkbox"><span>Re-alertar por voz alertas críticos pendentes sem confirmação</span></label>
    </div>
    <div class="grade">
      <label class="campo"><span>Repetir crítico não confirmado a cada (min)</span><input id="cfg-reescalar-min" type="number" min="1" step="1" inputmode="numeric"></label>
    </div>
    <div class="voice-actions">
      <button id="cfg-bateria-android" type="button" class="hide">Desativar restrição de bateria do Android (recomendado p/ 2º plano)</button>
      <button id="cfg-abrir-pip" type="button">Abrir mini-painel flutuante COA (sempre visível no PC)</button>
    </div>
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
    <label class="chk"><input id="cfg-gestao-frente" type="checkbox"><span>Ativar alertas “Atenção gestão” por frente</span></label>
    <p class="fine">Desligar interrompe novos alertas de gestão e remove os ativos correspondentes; o histórico é preservado. Oscilações momentâneas na contagem não reiniciam o cooldown por frente e regra.</p>
    <div class="grade">
      <label class="campo"><span>Fila: nº de equipamentos aguardando carregamento</span><input id="cfg-fila-frente" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Todas as colhedoras paradas há (min)</span><input id="cfg-sem-colh" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Transbordos aguardando colhedora (nº)</span><input id="cfg-transb-ag" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Frota muda: sem telemetria há (min)</span><input id="cfg-frota-muda" type="number" min="0" step="5" inputmode="numeric"></label>
      <label class="campo"><span>Qualidade colheita: vel. máx. (km/h)</span><input id="cfg-vel-colheita" type="number" min="0" step="0.5" inputmode="decimal"></label>
      <label class="campo"><span>Meta SLA de atendimento COA (min)</span><input id="cfg-sla-min" type="number" min="1" step="1" inputmode="numeric"></label>
    </div>
    <h3 class="secao-alertas">Inteligência v4.0: Moenda, Custos R$, Comboio e Auditoria</h3>
    <p class="fine">Alimenta o Termômetro de Moenda (t/h), o Taxímetro Financeiro do Turno (R$), a fila inteligente do Uber do Comboio/Oficina e a auditoria automática de falso apontamento.</p>
    <div class="switches">
      <label class="chk"><input id="cfg-auditar-apontamento" type="checkbox"><span>Auditar falso apontamento (operação SGPA incoerente com velocidade/motor)</span></label>
      <label class="chk"><input id="cfg-manut-preditiva" type="checkbox"><span>Manutenção preditiva (avisar ao atingir 3 alertas mecânicos/RPM em 4h)</span></label>
    </div>
    <div class="grade">
      <label class="campo"><span>Falso apontamento: tolerância (min)</span><input id="cfg-inconsistencia-min" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Bate-volta máx. caminhão (min)</span><input id="cfg-batevolta-min" type="number" min="0" step="5" inputmode="numeric"></label>
      <label class="campo"><span>Meta de moagem da usina (t/h)</span><input id="cfg-meta-moenda" type="number" min="0" step="10" inputmode="numeric"></label>
      <label class="campo"><span>Produtividade p/ colhedora (t/h)</span><input id="cfg-ton-colh" type="number" min="10" step="5" inputmode="numeric"></label>
      <label class="campo"><span>Custo parada Colhedora (R$/h)</span><input id="cfg-custo-colh" type="number" min="0" step="10" inputmode="numeric"></label>
      <label class="campo"><span>Custo parada Transbordo (R$/h)</span><input id="cfg-custo-tb" type="number" min="0" step="10" inputmode="numeric"></label>
      <label class="campo"><span>Custo parada Caminhão (R$/h)</span><input id="cfg-custo-cam" type="number" min="0" step="10" inputmode="numeric"></label>
      <label class="campo"><span>Preço do Diesel (R$/L)</span><input id="cfg-custo-diesel" type="number" min="1" step="0.1" inputmode="decimal"></label>
    </div>
    <h3 class="secao-alertas">Pronúncia dos termos (glossário)</h3>
    <p class="fine">Ensine a voz a falar abreviações do SGPA. Uma regra por linha, no formato <b>termo=como falar</b>. O glossário já transforma <b>AG colhedora parada rápida</b> em <b>Aguardando colhedora parada rápida</b>. Exemplos: <code>AG=Aguardando</code>, <code>COLH=colhedora</code>. Deixar vazio depois do = faz a voz omitir o termo (ex.: <code>HR=</code>). Vale para todos os alertas falados; maiúsculas e acentos não importam. Depois, toque em Salvar preferências.</p>
    <textarea id="cfg-glossario" aria-label="Glossário de pronúncia" rows="6" spellcheck="false" autocomplete="off" placeholder="AG=Aguardando&#10;COLH=colhedora&#10;HR="></textarea>
    <p class="fine" id="cfg-glossario-padrao"></p>
    <div class="grade">
      <label class="campo"><span>Testar frase</span><input id="cfg-glossario-teste" type="text" value="AG colhedora parada rápida" autocomplete="off"></label>
    </div>
    <p id="cfg-glossario-previa" class="fine"></p>
    <button id="cfg-glossario-ouvir" type="button">Ouvir pronúncia</button>
    <h3 class="secao-alertas">Fontes, vozes e perfis de locução COA</h3>
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
      <label class="campo"><span>Perfil de locução COA</span>
        <select id="cfg-perfil-voz">
          <option value="padrao">Padrão equilibrado</option>
          <option value="coa-firme">Locutor firme COA (comando)</option>
          <option value="clara-pausada">Locução clara e pausada (rádio/ruído)</option>
          <option value="urgente">Alerta rápido operacional</option>
          <option value="personalizado">Personalizado (manual)</option>
        </select>
      </label>
      <label class="campo"><span>Sinal sonoro pré-alerta</span>
        <select id="cfg-estilo-toque">
          <option value="gongo-coa">Gongo harmônico COA</option>
          <option value="radio-bip">Bip duplo de rádio PTT</option>
          <option value="sirene-curta">Pulso rápido de atenção</option>
          <option value="padrao">Triângulo clássico</option>
        </select>
      </label>
      <label class="campo"><span>Voz do sistema / aparelho</span><select id="cfg-vozel"></select></label>
      <label class="campo"><span>Volume <b id="lb-vol"></b></span><input id="cfg-vol" type="range" min="0" max="1" step="0.05"></label>
      <label class="campo"><span>Ritmo <b id="lb-taxa"></b></span><input id="cfg-taxa" type="range" min="0.6" max="1.6" step="0.05"></label>
      <label class="campo"><span>Tom <b id="lb-tom"></b></span><input id="cfg-tom" type="range" min="0.6" max="1.4" step="0.05"></label>
    </div>
    <div class="voice-actions">
      <div class="voice-btn-row">
        <button id="cfg-previa-voz" type="button">▶ Ouvir prévia desta voz</button>
        <button id="cfg-gerenciar-vozes" type="button" class="hide">Instalar ou gerenciar vozes do Android</button>
      </div>
      <p class="fine">Dica COA: no computador com Microsoft Edge, selecione as vozes naturais gratuitas (<i>Francisca Natural</i> ou <i>Antonio Natural</i>); no Android, toque em “Instalar ou gerenciar vozes” para baixar variantes de alta definição em português do Brasil. Todos os perfis funcionam 100% localmente, sem custos externos.</p>
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
      frentes: $('lista-frentes'),
      comboio: $('lista-comboio'),
      historico: $('lista-historico'),
      busca: $('alertas-busca'),
      buscaLimpar: $('alertas-busca-limpar'),
      contAtivos: $('cont-ativos'),
      contFrentes: $('cont-frentes'),
      contComboio: $('cont-comboio'),
      contHist: $('cont-hist'),
      dot: $('dot-ciclo'),
      toasts: $('toasts'),
      cfg: $('cfg-alertas'),
      sino: $('btn-alertas'),
      badge: $('alert-badge'),
      emgBanner: $('emergencia-banner'),
      emgTitulo: $('emg-titulo'),
      emgDetalhe: $('emg-detalhe'),
      telaoBar: $('coa-telao-bar'),
      telaoKpis: $('telao-kpis'),
      modalPassagem: $('modal-passagem'),
      passagemMeta: $('passagem-meta'),
      passagemKpis: $('passagem-kpis'),
      passagemTexto: $('passagem-texto'),
      passagemWhats: $('passagem-whats'),
    };

    const p = el.painel;
    el.busca.addEventListener('input', () => {
      buscaCentral = el.busca.value;
      el.buscaLimpar.classList.toggle('hide', !norm(buscaCentral));
      renderAtivos();
      if (el.frentes && !el.frentes.classList.contains('hide')) renderFrentes();
      if (el.comboio && !el.comboio.classList.contains('hide')) renderComboio();
    });
    el.buscaLimpar.onclick = () => {
      el.busca.value = '';
      buscaCentral = '';
      el.buscaLimpar.classList.add('hide');
      renderAtivos();
      if (el.frentes && !el.frentes.classList.contains('hide')) renderFrentes();
      if (el.comboio && !el.comboio.classList.contains('hide')) renderComboio();
      el.busca.focus();
    };
    $('alertas-fechar').onclick = fecharPainel;
    p.querySelector('.veu').onclick = fecharPainel;
    for (const b of p.querySelectorAll('.aba')) {
      b.onclick = () => selecionarAbaCentral(b.dataset.aba);
    }
    if ($('btn-calar')) $('btn-calar').onclick = calarFalaAtual;
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
    if ($('btn-passagem')) $('btn-passagem').onclick = abrirPassagemTurno;
    $('btn-exportar').onclick = exportarCsv;
    $('btn-teste').onclick = testar;
    if ($('emg-mapa')) $('emg-mapa').onclick = () => { if (emergenciaAtiva) abrirNoMapa(emergenciaAtiva); };
    if ($('emg-whats')) $('emg-whats').onclick = () => { if (emergenciaAtiva) cobrarNoWhatsApp(emergenciaAtiva); };
    if ($('emg-ciente')) $('emg-ciente').onclick = () => {
      if (emergenciaAtiva) {
        podarAcks(acks);
        acks[emergenciaAtiva.chave] = agora();
        salvar(KEY_ACK, acks);
      }
      fecharBannerEmergencia();
      renderAtivos();
    };
    if ($('telao-sair')) $('telao-sair').onclick = () => alternarTelao(false);
    if ($('passagem-fechar')) $('passagem-fechar').onclick = fecharPassagemTurno;
    if ($('passagem-fechar-x')) $('passagem-fechar-x').onclick = fecharPassagemTurno;
    if (el.modalPassagem) el.modalPassagem.addEventListener('click', (ev) => { if (ev.target === el.modalPassagem) fecharPassagemTurno(); });
    if ($('passagem-copiar')) $('passagem-copiar').onclick = () => {
      const txt = el.passagemTexto ? el.passagemTexto.value : '';
      copiarTextoArea(txt, 'Boletim de passagem de turno copiado!');
    };
    if ($('passagem-imprimir')) $('passagem-imprimir').onclick = () => imprimirPassagemTurno();
    try {
      if (localStorage.getItem(KEY_TELAO) === '1') alternarTelao(true, false);
    } catch { /* sem storage */ }
    $('cfg-fechar').onclick = fecharConfig;
    $('cfg-fechar-x').onclick = fecharConfig;
    $('cfg-salvar').onclick = lerConfig;
    if ($('cfg-acabamento')) {
      $('cfg-acabamento').onchange = () => aplicarAcabamento($('cfg-acabamento').value, true);
    }
    $('push-ativar').onclick = ativarPush;
    $('push-desligar').onclick = desligarPush;
    $('cfg-vozel').onchange = () => {
      configurar(preferenciaVoz($('cfg-vozel').value));
      escolherVoz();
    };
    if ($('cfg-perfil-voz')) {
      $('cfg-perfil-voz').onchange = () => {
        const chave = $('cfg-perfil-voz').value;
        const perfil = PERFIS_VOZ[chave];
        if (perfil && perfil.taxa !== null) {
          $('cfg-taxa').value = perfil.taxa;
          $('cfg-tom').value = perfil.tom;
          if (perfil.estiloToque && $('cfg-estilo-toque')) $('cfg-estilo-toque').value = perfil.estiloToque;
          $('lb-taxa').textContent = Number(perfil.taxa).toFixed(2);
          $('lb-tom').textContent = Number(perfil.tom).toFixed(2);
          configurar({
            perfilVoz: chave,
            taxa: perfil.taxa,
            tom: perfil.tom,
            estiloToque: perfil.estiloToque || cfg.estiloToque,
          });
        } else {
          configurar({ perfilVoz: 'personalizado' });
        }
      };
    }
    for (const idRange of [['cfg-vol', 'lb-vol', false], ['cfg-taxa', 'lb-taxa', true], ['cfg-tom', 'lb-tom', true]]) {
      const inp = $(idRange[0]);
      if (inp) {
        inp.addEventListener('input', () => {
          const lb = $(idRange[1]);
          if (lb) lb.textContent = Number(inp.value).toFixed(2);
          if (idRange[2] && $('cfg-perfil-voz')) $('cfg-perfil-voz').value = 'personalizado';
        });
      }
    }
    if ($('cfg-estilo-toque')) {
      $('cfg-estilo-toque').onchange = () => {
        configurar({ estiloToque: $('cfg-estilo-toque').value });
        if (cfg.som) tocar(2);
      };
    }
    if ($('cfg-previa-voz')) {
      $('cfg-previa-voz').onclick = () => {
        const patch = Object.assign(
          {},
          preferenciaVoz($('cfg-vozel').value),
          {
            voz: true,
            volume: Number($('cfg-vol').value) || 1,
            taxa: Number($('cfg-taxa').value) || 1,
            tom: Number($('cfg-tom').value) || 1,
            perfilVoz: $('cfg-perfil-voz') ? $('cfg-perfil-voz').value : cfg.perfilVoz,
            estiloToque: $('cfg-estilo-toque') ? $('cfg-estilo-toque').value : cfg.estiloToque,
          },
        );
        configurar(patch);
        escolherVoz();
        if (cfg.som) tocar(2);
        falar('Atenção C O A: prévia de voz ativa. Colhedora cinco sete oito três oito operando normalmente na Frente 1.', { oficial: true });
      };
    }
    $('cfg-gerenciar-vozes').onclick = () => {
      const nativa = ponteNativa();
      if (nativa && typeof nativa.gerenciarVozes === 'function') nativa.gerenciarVozes();
    };
    if ($('cfg-bateria-android')) {
      $('cfg-bateria-android').onclick = () => {
        const nativa = ponteNativa();
        if (nativa && typeof nativa.otimizarBateria === 'function') nativa.otimizarBateria();
      };
    }
    if ($('cfg-abrir-pip')) {
      $('cfg-abrir-pip').onclick = () => alternarJanelaFlutuante();
    }
    $('cfg-teste2').onclick = () => falar(policy.montarFala({ regra: 'velocidade', numero: '8833', valor: 85 }, cfg));
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

  function selecionarAbaCentral(aba) {
    if (!el.painel) return;
    const alvo = aba === 'frentes' || aba === 'comboio' || aba === 'historico' ? aba : 'ativos';
    for (const x of el.painel.querySelectorAll('.aba')) x.classList.toggle('ativa', x.dataset.aba === alvo);
    if (el.ativos) el.ativos.classList.toggle('hide', alvo !== 'ativos');
    if (el.frentes) el.frentes.classList.toggle('hide', alvo !== 'frentes');
    if (el.comboio) el.comboio.classList.toggle('hide', alvo !== 'comboio');
    if (el.historico) el.historico.classList.toggle('hide', alvo !== 'historico');
    if (alvo === 'frentes') renderFrentes();
    else if (alvo === 'comboio') renderComboio();
    else renderAtivos();
  }

  function abrirPainel(aba) {
    if (!el.painel) montar();
    el.painel.classList.remove('hide');
    if (aba) selecionarAbaCentral(aba);
    else {
      renderAtivos();
      if (el.frentes && !el.frentes.classList.contains('hide')) renderFrentes();
      if (el.comboio && !el.comboio.classList.contains('hide')) renderComboio();
    }
    renderCabecalho();
  }
  function fecharPainel() {
    el.painel.classList.add('hide');
  }

  function despacharApoioWhatsApp(item) {
    if (!item || !item.textoDespacho) return '';
    const url = 'https://wa.me/?text=' + encodeURIComponent(item.textoDespacho);
    copiarTextoArea(item.textoDespacho, `Despacho #${item.ordem} (Frota ${item.numero}) copiado!`, url);
    return item.textoDespacho;
  }

  function copiarDdsWhatsApp() {
    const p = placarPositivo();
    const url = 'https://wa.me/?text=' + encodeURIComponent(p.textoDds);
    copiarTextoArea(p.textoDds, 'Placar Positivo do Turno (DDS) copiado!', url);
    return p.textoDds;
  }

  function executarComandoCoa(frase) {
    const cmd = policy.interpretarComandoCoa(frase);
    let resposta = '';
    if (cmd.acao === 'localizar') {
      const alvoNum = String(cmd.frota || '').trim();
      const eq = [...frota.values()].find((e) => String(e.numero) === alvoNum || String(e.id) === alvoNum || String(e.numero || '').endsWith(alvoNum));
      if (eq) {
        const cls = classeFala(eq.nome, eq.tipo, eq.frente);
        const velTxt = eq.velocidade != null ? `${Math.round(eq.velocidade)} km/h` : 'velocidade n/d';
        resposta = `${cls} ${eq.numero} na ${eq.frente || eq.grupoEquipamento || 'unidade'}, operação ${eq.operacao || 'não informada'}, a ${velTxt}${eq.operador ? ', operador ' + eq.operador : ''}.`;
        abrirNoMapa({ e: eq, numero: eq.numero, classe: cls });
      } else {
        resposta = `Frota ${alvoNum} ainda não consta na leitura atual da telemetria.`;
      }
    } else if (cmd.acao === 'comboio') {
      abrirPainel('comboio');
      const fila = filaComboio();
      if (!fila.chamados.length) {
        resposta = `Fila de apoio livre: nenhuma máquina aguardando comboio ou oficina. ${fila.recursos.comboios.length} comboio(s) e ${fila.recursos.oficinas.length} oficina(s) online.`;
      } else {
        const top = fila.chamados[0];
        resposta = `Fila de apoio com ${fila.chamados.length} chamado(s) (~R$ ${fila.resumo.custoFilaRs}). Prioridade 1: Frota ${top.numero} na ${top.frente}, ${top.motivo} há ${top.minutosEspera} minutos${top.apoioMaisProximo ? ', apoio ' + top.apoioNumero + (top.distanciaKm !== null ? ' a ' + top.distanciaKm + ' km' : '') : ''}.`;
      }
    } else if (cmd.acao === 'moenda') {
      abrirPainel('frentes');
      const term = termometroMoenda();
      const fin = custoTurno();
      resposta = `Moenda: entrega estimada em ${term.entregaTonHora} toneladas por hora (${term.pctMeta}% da meta de ${term.metaTonHora} t/h). Custo acumulado no turno: R$ ${fin.totalRs.toLocaleString('pt-BR')}.`;
    } else if (cmd.acao === 'frentes') {
      abrirPainel('frentes');
      const res = resumoFrentes();
      const t = res.totais || {};
      resposta = `Panorama CTT: ${t.colhedorasColhendo || 0} de ${t.colhedoras || 0} colhedoras colhendo, ${t.transbordosAtivos || 0} transbordos ativos, ${t.caminhoesFila || 0} caminhões em fila e ${ativos.size} alerta(s) na Central.`;
    } else if (cmd.acao === 'reconhecer') {
      const ts = agora();
      const pendente = [...ativos.values()]
        .filter((a) => !(acks[a.chave] && ts - acks[a.chave] < 2 * 3600_000))
        .sort((a, b) => (b.severidade || 0) - (a.severidade || 0) || (a.inicio || a.ts) - (b.inicio || b.ts))[0];
      if (pendente) {
        podarAcks(acks);
        acks[pendente.chave] = ts;
        salvar(KEY_ACK, acks);
        if (emergenciaAtiva && emergenciaAtiva.chave === pendente.chave) fecharBannerEmergencia();
        renderAtivos();
        renderCabecalho();
        resposta = `Confirmado: ${pendente.classe} ${pendente.numero} (${pendente.nome}) marcado como ciente no COA.`;
      } else {
        resposta = 'Todos os alertas ativos já estão reconhecidos no momento.';
      }
    } else if (cmd.acao === 'chuva') {
      const estadoChuva = alternarChuvaFrente(cmd.frente || 'Frente 1', 'Comando Alô COA');
      resposta = estadoChuva
        ? `Modo Chuva ativado na ${estadoChuva.frente}. Alertas de segurança continuam ligados.`
        : `Modo Chuva encerrado na ${cmd.frente || 'Frente 1'}.`;
    } else if (cmd.acao === 'passagem') {
      abrirPassagemTurno();
      resposta = 'Boletim de passagem de turno gerado e pronto para copiar ou enviar.';
    } else if (cmd.acao === 'dds') {
      abrirPainel('comboio');
      const dds = placarPositivo();
      resposta = dds.resumoCurto ? dds.resumoCurto.replace(/\n/g, ' · ') : 'Placar DDS aguardando consolidação das frentes no turno.';
    } else {
      resposta = 'Exemplos Alô COA: "fila de comboio", "risco de moenda", "resumo das frentes", "onde está a 57838", "reconhecer" ou "placar dds".';
    }
    ultimaRespostaAloCoa = resposta;
    const boxResp = document.getElementById('alo-coa-resposta');
    if (boxResp) {
      boxResp.textContent = '🤖 ' + resposta;
      boxResp.classList.remove('hide');
    }
    if (cfg.voz && cmd.acao !== 'desconhecido') falar(resposta, { oficial: true });
    return { comando: cmd, resposta };
  }

  function abrirAssistenteCoa() {
    abrirPainel('comboio');
    setTimeout(() => {
      const inp = document.getElementById('alo-coa-input');
      if (inp) inp.focus();
    }, 60);
  }

  function atualizarEstadoBotoesMic(ouvindo) {
    for (const id of ['btn-mic-bar', 'alo-coa-mic']) {
      const b = document.getElementById(id);
      if (b) {
        b.classList.toggle('mic-ouvindo', !!ouvindo);
        b.setAttribute('aria-pressed', ouvindo ? 'true' : 'false');
      }
    }
  }

  function ouvirComandoVoz() {
    if (reconhecedorVozAtivo) {
      try { reconhecedorVozAtivo.stop(); } catch { /* ignora */ }
      reconhecedorVozAtivo = null;
      atualizarEstadoBotoesMic(false);
      return false;
    }
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) {
      abrirAssistenteCoa();
      mostrarAviso('Digite ou use o microfone do teclado no campo Alô COA.', 'info');
      return false;
    }
    try {
      const rec = new SR();
      rec.lang = 'pt-BR';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      reconhecedorVozAtivo = rec;
      atualizarEstadoBotoesMic(true);
      mostrarAviso('🎙️ Alô COA ouvindo… diga p. ex. "fila de comboio" ou "risco de moenda".', 'info');
      rec.onresult = (ev) => {
        const transcrito = ev && ev.results && ev.results[0] && ev.results[0][0] ? String(ev.results[0][0].transcript || '').trim() : '';
        const inp = document.getElementById('alo-coa-input');
        if (inp && transcrito) inp.value = transcrito;
        if (transcrito) executarComandoCoa(transcrito);
      };
      rec.onerror = () => {
        atualizarEstadoBotoesMic(false);
        reconhecedorVozAtivo = null;
        abrirAssistenteCoa();
      };
      rec.onend = () => {
        atualizarEstadoBotoesMic(false);
        reconhecedorVozAtivo = null;
      };
      rec.start();
      return true;
    } catch {
      atualizarEstadoBotoesMic(false);
      reconhecedorVozAtivo = null;
      abrirAssistenteCoa();
      return false;
    }
  }

  function renderComboio() {
    if (!el.comboio) return;
    const fila = filaComboio();
    const radar = radarIncendio();
    const dds = placarPositivo();
    if (el.contComboio) el.contComboio.textContent = String(fila.resumo.totalFila);
    const chamadosFiltrados = fila.chamados.filter((c) =>
      correspondeBuscaCentral([c.numero, c.nome, c.frente, c.motivo, c.operador, c.apoioMaisProximo, c.categoriaApoio])
    );

    const html = [];
    // 1) Assistente Alô COA (voz e comando rápido)
    html.push(`
      <div class="alo-coa-box">
        <div class="alo-coa-head">
          <strong>🎙️ Alô COA · Assistente Mãos-Livres</strong>
          <span class="fine">Voz ou texto</span>
        </div>
        <form id="alo-coa-form" class="alo-coa-form">
          <input id="alo-coa-input" type="text" placeholder="Ex.: fila de comboio, onde está a 57838, risco de moenda…" autocomplete="off">
          <button id="alo-coa-mic" type="button" title="Falar comando por microfone" aria-label="Falar comando">🎙️</button>
          <button id="alo-coa-enviar" type="submit" class="primary">OK</button>
        </form>
        <div class="alo-coa-chips">
          <button type="button" data-coa-cmd="fila de comboio">⛽ Fila Comboio</button>
          <button type="button" data-coa-cmd="risco de moenda">🏭 Moenda &amp; R$</button>
          <button type="button" data-coa-cmd="resumo das frentes">🚜 Resumo CTT</button>
          <button type="button" data-coa-cmd="reconhecer">✓ Ciente Crítico</button>
          <button type="button" data-coa-cmd="placar dds">🏆 Placar DDS</button>
        </div>
        <div id="alo-coa-resposta" class="alo-coa-resp ${ultimaRespostaAloCoa ? '' : 'hide'}">${ultimaRespostaAloCoa ? '🤖 ' + esc(ultimaRespostaAloCoa) : ''}</div>
      </div>
    `);

    // 2) Uber do Comboio e Oficina Volante
    html.push(`
      <div class="comboio-sec">
        <div class="comboio-head">
          <div>
            <h4>⛽ Uber do Comboio &amp; Oficina Volante</h4>
            <span class="fine">Prioridade automática por criticidade × espera × custo R$/min</span>
          </div>
        </div>
        <div class="comboio-pills">
          <span class="cpill">⛽ Comboios <b>${fila.recursos.comboios.length}</b></span>
          <span class="cpill">🔧 Oficinas <b>${fila.recursos.oficinas.length}</b></span>
          <span class="cpill">🚒 Bombeiros <b>${fila.recursos.bombeiros.length}</b></span>
          <span class="cpill ${fila.resumo.totalFila > 0 ? 'warn' : ''}">⏳ Fila <b>${fila.resumo.totalFila}</b></span>
          <span class="cpill ${fila.resumo.custoFilaRs > 0 ? 'crit' : ''}">💸 Espera <b>R$ ${fila.resumo.custoFilaRs.toLocaleString('pt-BR')}</b></span>
        </div>
    `);

    if (!chamadosFiltrados.length) {
      html.push(`<div class="vazio comboio-vazio">Nenhuma máquina aguardando comboio, oficina ou pipa agora.<br><span class="fine">Assim que qualquer colhedora, transbordo ou caminhão apontar espera de abastecimento ou manutenção, o ranking #1 aparece aqui com distância em km.</span></div>`);
    } else {
      for (const item of chamadosFiltrados) {
        const ico = item.categoriaApoio === 'comboio' ? '⛽' : item.categoriaApoio === 'oficina' ? '🔧' : '🚒';
        const distTxt = item.apoioMaisProximo
          ? `${ico} Apoio rec.: <b>${esc(item.apoioMaisProximo)}</b>${item.distanciaKm !== null ? ` · <b>${item.distanciaKm} km</b>` : ''}`
          : `${ico} Sem veículo de apoio com GPS lido — acionar volante no rádio`;
        html.push(`
          <div class="comboio-card cat-${esc(item.categoriaApoio)}" data-comboio-id="${esc(item.id)}">
            <div class="comboio-top">
              <span class="comboio-rank">#${item.ordem}</span>
              <strong class="comboio-eq">${ico} Frota ${esc(item.numero)}</strong>
              <span class="a-chip">${esc(item.frente)}</span>
              <span class="comboio-rs">~R$ ${item.custoRs.toLocaleString('pt-BR')}</span>
            </div>
            <p class="comboio-motivo">${esc(item.motivo)} há <b>${item.minutosEspera} min</b> · <small>${esc(item.nome)} (R$ ${item.valorHora}/h)</small></p>
            <p class="comboio-apoio">${distTxt}${item.local ? ` · Talhão ${esc(item.local)}` : ''}</p>
            <div class="comboio-acoes">
              <button type="button" class="primary" data-comboio-whats="${item.ordem}">📲 Despachar WhatsApp</button>
              <button type="button" data-comboio-mapa="${esc(item.id)}">📍 Ver no mapa</button>
            </div>
          </div>
        `);
      }
    }
    html.push('</div>');

    // 3) Radar Climático & Regra 30-30-30 de Risco de Incêndio
    const bombTxt = radar.bombeiroProximo
      ? `🚒 Bombeiro/Pipa mais próximo: <b>Frota ${esc(radar.bombeiroProximo.numero)}</b>${radar.bombeiroProximo.frente ? ' (' + esc(radar.bombeiroProximo.frente) + ')' : ''}${radar.bombeiroProximo.km !== null ? ` a <b>${radar.bombeiroProximo.km} km</b>` : ''}`
      : '🚒 Nenhum caminhão bombeiro/pipa identificado na telemetria atual';
    html.push(`
      <div class="radar-303030 bandeira-${esc(radar.bandeira)}">
        <div class="radar-head">
          <strong>🔥 Radar 30-30-30 · Risco de Incêndio</strong>
          <span class="radar-badge bandeira-${esc(radar.bandeira)}">${esc(radar.nivel)}</span>
        </div>
        <div class="radar-metricas">
          <div class="rmet ${radar.tempC >= 30 ? 'alerta' : ''}"><span>🌡️ Temp.</span><b>${radar.tempC}°C</b><small>${radar.tempC >= 30 ? '≥ 30°C ⚠️' : '&lt; 30°C'}</small></div>
          <div class="rmet ${radar.umidadePct <= 30 ? 'alerta' : ''}"><span>💧 Umidade</span><b>${radar.umidadePct}%</b><small>${radar.umidadePct <= 30 ? '≤ 30% ⚠️' : '&gt; 30%'}</small></div>
          <div class="rmet ${radar.ventoKmH >= 30 ? 'alerta' : ''}"><span>💨 Vento</span><b>${radar.ventoKmH} km/h</b><small>${radar.ventoKmH >= 30 ? '≥ 30 km/h ⚠️' : '&lt; 30 km/h'}</small></div>
        </div>
        <p class="radar-bombeiro">${bombTxt}</p>
        <div class="radar-inputs">
          <label><span>°C</span><input id="clima-temp" type="number" step="1" value="${radar.tempC}"></label>
          <label><span>% Umid</span><input id="clima-umid" type="number" min="5" max="100" step="1" value="${radar.umidadePct}"></label>
          <label><span>km/h</span><input id="clima-vento" type="number" min="0" step="1" value="${radar.ventoKmH}"></label>
          <button type="button" id="clima-aplicar">Aplicar</button>
          <button type="button" id="clima-gps" title="Consultar meteorologia atual pelas coordenadas da frente">🌐 GPS</button>
        </div>
      </div>
    `);

    // 4) Placar Positivo do Turno (Gamificação DDS)
    html.push(`
      <div class="dds-card">
        <div class="dds-head">
          <strong>🏆 Placar Positivo do Turno (DDS)</strong>
          <button type="button" id="btn-copiar-dds">💬 Copiar p/ DDS</button>
        </div>
        ${dds.frenteDestaque
          ? `<p class="dds-frente">🥇 <b>${esc(dds.frenteDestaque.frente)}</b> — ${dds.frenteDestaque.colhColhendo}/${dds.frenteDestaque.colhTotal} colhedoras ativas · fila ${dds.frenteDestaque.camFila} · nota <b>${dds.frenteDestaque.nota}/100</b></p>`
          : '<p class="fine">Aguardando leitura das frentes para eleger a Frente Destaque do turno.</p>'}
        ${dds.operadoresDestaque.length
          ? '<div class="dds-ops">' + dds.operadoresDestaque.map((op, i) =>
              `<div class="dds-op"><span>${i === 0 ? '⭐' : '👏'} <b>${esc(op.operador)}</b> · Frota ${esc(op.frota)}</span><b>${op.score} pts · 0 infração</b></div>`
            ).join('') + '</div>'
          : '<p class="fine">Operadores exemplares (zero excesso de velocidade/RPM/falso apontamento) aparecerão aqui.</p>'}
      </div>
    `);

    el.comboio.innerHTML = html.join('');

    const formAlo = document.getElementById('alo-coa-form');
    if (formAlo) {
      formAlo.onsubmit = (ev) => {
        ev.preventDefault();
        const inp = document.getElementById('alo-coa-input');
        if (inp && inp.value.trim()) executarComandoCoa(inp.value.trim());
      };
    }
    const btnMic = document.getElementById('alo-coa-mic');
    if (btnMic) btnMic.onclick = () => ouvirComandoVoz();
    el.comboio.querySelectorAll('[data-coa-cmd]').forEach((b) => {
      b.onclick = () => {
        const c = b.dataset.coaCmd || '';
        const inp = document.getElementById('alo-coa-input');
        if (inp) inp.value = c;
        executarComandoCoa(c);
      };
    });
    el.comboio.querySelectorAll('[data-comboio-whats]').forEach((b) => {
      b.onclick = () => {
        const ord = Number(b.dataset.comboioWhats);
        const item = fila.chamados.find((x) => x.ordem === ord);
        if (item) despacharApoioWhatsApp(item);
      };
    });
    el.comboio.querySelectorAll('[data-comboio-mapa]').forEach((b) => {
      b.onclick = () => abrirNoMapa({ cdEquipamento: b.dataset.comboioMapa, numero: b.dataset.comboioMapa, classe: 'Frota' });
    });
    const btnAplicarClima = document.getElementById('clima-aplicar');
    if (btnAplicarClima) {
      btnAplicarClima.onclick = () => {
        const tVal = Number((document.getElementById('clima-temp') || {}).value);
        const uVal = Number((document.getElementById('clima-umid') || {}).value);
        const vVal = Number((document.getElementById('clima-vento') || {}).value);
        definirClimaManual({
          tempC: Number.isFinite(tVal) ? tVal : climaCoa.tempC,
          umidadePct: Number.isFinite(uVal) ? uVal : climaCoa.umidadePct,
          ventoKmH: Number.isFinite(vVal) ? vVal : climaCoa.ventoKmH,
          chuvaMm: 0,
          origem: 'manual COA',
        });
      };
    }
    const btnClimaGps = document.getElementById('clima-gps');
    if (btnClimaGps) btnClimaGps.onclick = () => atualizarClimaOnline();
    const btnDds = document.getElementById('btn-copiar-dds');
    if (btnDds) btnDds.onclick = () => copiarDdsWhatsApp();
  }

  function copiarTextoArea(texto, msgSucesso, linkWhats) {
    const val = String(texto || '');
    const finalizar = () => {
      if (linkWhats) mostrarAvisoComLink(msgSucesso || 'Copiado!', 'Abrir WhatsApp ↗', linkWhats);
      else mostrarAviso(msgSucesso || 'Texto copiado!', 'info');
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(val).then(finalizar).catch(() => {
        copiarFallback(val);
        finalizar();
      });
      return;
    }
    copiarFallback(val);
    finalizar();
  }

  function copiarFallback(val) {
    try {
      const ta = document.createElement('textarea');
      ta.value = val;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch { /* sem clipboard */ }
  }

  function cobrarNoWhatsApp(alerta) {
    const tr = tratativas[alerta.chave];
    const msg = policy.textoCobrancaWhatsApp(alerta, ctx.unidade || 'Usina Branco Peres', tr);
    const url = 'https://wa.me/?text=' + encodeURIComponent(msg);
    copiarTextoArea(msg, 'Cobrança COA copiada para colar no grupo.', url);
    return msg;
  }

  function mostrarAvisoComLink(txt, rotuloLink, href) {
    if (!el.toasts) return;
    prepararBotaoLimparToasts();
    const d = document.createElement('div');
    d.className = 'aviso aviso-whats';
    const sp = document.createElement('span');
    sp.textContent = txt + ' ';
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'aviso-link';
    a.textContent = rotuloLink;
    d.append(sp, a);
    el.toasts.appendChild(d);
    atualizarBotaoLimparToasts();
    rolarToastMaisNovo();
    setTimeout(() => fecharCard(d), 7500);
  }

  function mostrarBannerEmergencia(alerta) {
    emergenciaAtiva = alerta;
    if (!el.emgBanner) return;
    if (el.emgTitulo) el.emgTitulo.textContent = `${alerta.classe} ${alerta.numero} — ${alerta.texto}`;
    if (el.emgDetalhe) el.emgDetalhe.textContent = alerta.detalhe || '';
    el.emgBanner.classList.remove('hide');
  }

  function fecharBannerEmergencia() {
    emergenciaAtiva = null;
    if (el.emgBanner) el.emgBanner.classList.add('hide');
  }

  function alternarTelao(forcar, persistir = true) {
    const proximoEstado = typeof forcar === 'boolean' ? forcar : !telaoAtivo;
    telaoAtivo = proximoEstado;
    document.documentElement.dataset.telao = telaoAtivo ? '1' : '0';
    const txtMenu = $('menu-telao-txt');
    if (txtMenu) txtMenu.textContent = telaoAtivo ? 'Sair do Modo Telão / Videowall COA' : 'Modo Telão / Videowall COA';
    if (persistir) {
      try { localStorage.setItem(KEY_TELAO, telaoAtivo ? '1' : '0'); } catch { /* sem storage */ }
    }
    renderTelaoBar();
    if (persistir) {
      mostrarAviso(telaoAtivo ? 'Modo Telão COA ativado: alertas críticos ficam fixos até confirmação.' : 'Modo Telão COA desativado.', 'info');
    }
    return telaoAtivo;
  }

  function renderTelaoBar() {
    if (!el.telaoKpis) return;
    const res = ultimoResumoCtt && ultimoResumoCtt.totais ? ultimoResumoCtt : resumoFrentes();
    const t = res.totais || {};
    const term = policy.calcularTermometroMoenda(res, cfg);
    const fin = custoTurno();
    const criticos = [...ativos.values()].filter((a) => (a.severidade || 0) >= 3 && !(acks[a.chave] && agora() - acks[a.chave] < 2 * 3600_000)).length;
    const st = estadoConexaoCoa();
    const chuvasAtivas = Object.keys(chuvas || {}).length;
    el.telaoKpis.innerHTML =
      (term.ativo ? `<span class="tkpi ${term.status === 'risco' ? 'critico-kpi' : term.status === 'atencao' ? 'alerta-kpi' : ''}">🏭 Moenda <b>${term.entregaTonHora}/${term.metaTonHora} t/h</b></span>` : '') +
      `<span class="tkpi">🚜 Colhedoras <b>${t.colhedorasColhendo || 0}/${t.colhedoras || 0}</b></span>` +
      `<span class="tkpi ${t.caminhoesFila >= (num(cfg.filaMaxFrente) || 4) ? 'alerta-kpi' : ''}">🚛 Fila <b>${t.caminhoesFila || 0}</b></span>` +
      `<span class="tkpi ${criticos > 0 ? 'critico-kpi' : ''}">🚨 Críticos s/ ciência <b>${criticos}</b></span>` +
      (fin.totalRs > 0 ? `<span class="tkpi alerta-kpi">💸 Perda turno <b>R$ ${fin.totalRs.toLocaleString('pt-BR')}</b></span>` : '') +
      `<span class="tkpi ${(t.mudas || 0) > 0 ? 'alerta-kpi' : ''}">📡 Mudas <b>${t.mudas || 0}</b></span>` +
      (chuvasAtivas ? `<span class="tkpi">🌧️ Chuva <b>${chuvasAtivas}</b></span>` : '') +
      `<span class="tkpi">SGPA <b>${esc(st.rotulo)}</b></span>`;
  }

  function gerarPassagemTurno() {
    const res = resumoFrentes();
    const listaOciosos = Object.values((ociosidadeTurno && ociosidadeTurno.itens) || {});
    const fin = custoTurno();
    const dds = placarPositivo();
    return policy.gerarBoletimPassagemTurno({
      ativos: [...ativos.values()],
      hist,
      tratativas,
      chuvas,
      resumoCtt: res,
      ociosidadeTurno: listaOciosos,
      custoTotalTurnoRs: fin.totalRs,
      placarPositivo: dds,
      unidade: ctx.unidade || 'Usina Branco Peres',
      usuario: ctx.usuario || '',
      agoraMs: agora(),
    });
  }

  function abrirPassagemTurno() {
    if (!el.modalPassagem) montar();
    const boletim = gerarPassagemTurno();
    const fin = custoTurno();
    if (el.passagemMeta) el.passagemMeta.textContent = `${boletim.turno.data} · ${boletim.turno.nome} · ${boletim.totalEventosTurno} evento(s) registrados no turno`;
    if (el.passagemKpis) {
      el.passagemKpis.innerHTML =
        `<span class="pkpi"><b>${boletim.pendentesTotal}</b> pendências abertas</span>` +
        `<span class="pkpi ${boletim.criticosAbertos ? 'crit' : ''}"><b>${boletim.criticosAbertos}</b> críticos</span>` +
        `<span class="pkpi"><b>${boletim.totalEventosTurno}</b> alertas no turno</span>` +
        `<span class="pkpi ${fin.totalRs > 0 ? 'crit' : ''}"><b>R$ ${fin.totalRs.toLocaleString('pt-BR')}</b> custo improdutivo</span>`;
    }
    if (el.passagemTexto) el.passagemTexto.value = boletim.texto;
    if (el.passagemWhats) el.passagemWhats.href = 'https://wa.me/?text=' + encodeURIComponent(boletim.texto);
    el.modalPassagem.classList.remove('hide');
    return boletim;
  }

  function fecharPassagemTurno() {
    if (el.modalPassagem) el.modalPassagem.classList.add('hide');
  }

  function imprimirPassagemTurno() {
    const txt = el.passagemTexto ? el.passagemTexto.value : gerarPassagemTurno().texto;
    const w = window.open('', '_blank', 'width=820,height=720');
    if (!w) {
      copiarTextoArea(txt, 'Pop-up de impressão bloqueado — boletim copiado para a área de transferência.');
      return;
    }
    w.document.write(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><title>Passagem de Turno COA</title>` +
      `<style>body{font:13px/1.6 ui-monospace,Consolas,monospace;padding:24px;color:#111}pre{white-space:pre-wrap;margin:0}</style></head>` +
      `<body><pre>${esc(txt)}</pre></body></html>`);
    w.document.close();
    try { w.focus(); w.print(); } catch { /* ignora */ }
  }

  function classeSla(inicioMs, severidade, ts = agora()) {
    const min = Math.max(0, Math.floor((ts - (inicioMs || ts)) / 60_000));
    const meta = Math.max(1, num(cfg.slaAlertaMin) || 10);
    const estourado = (severidade >= 3 && min >= meta) || min >= meta * 2;
    const atencao = !estourado && min >= Math.max(3, Math.floor(meta * 0.6));
    const rotulo = min < 1 ? 'agora' : min < 60 ? `há ${min}m` : `há ${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
    return {
      cls: estourado ? 'sla-crit' : atencao ? 'sla-warn' : 'sla-ok',
      txt: estourado ? `${rotulo} · SLA` : rotulo,
    };
  }

  function atualizarCronometrosSla(ts = agora()) {
    document.querySelectorAll('.a-sla[data-sla-inicio]').forEach((sp) => {
      const ini = Number(sp.dataset.slaInicio) || ts;
      const sev = Number(sp.dataset.slaSev) || 1;
      const info = classeSla(ini, sev, ts);
      sp.className = 'a-sla ' + info.cls;
      sp.textContent = info.txt;
    });
  }

  function renderFrentes() {
    if (!el.frentes) return;
    const res = resumoFrentes();
    const term = policy.calcularTermometroMoenda(res, cfg);
    const fin = custoTurno();
    if (el.contFrentes) el.contFrentes.textContent = String(res.frentes.length);
    const frentesFiltradas = res.frentes.filter((f) => correspondeBuscaCentral([f.frente, f.semaforo, f.chuva && f.chuva.motivo]));
    const htmlPartes = [];

    if (term.ativo) {
      const barWidth = Math.max(6, Math.min(100, term.pctMeta));
      const statusRotulo = term.status === 'seguro' ? 'RITMO PLENO' : term.status === 'atencao' ? 'ATENÇÃO MOENDA' : term.status === 'risco' ? 'RISCO DE FALTA DE CANA' : 'AGUARDANDO FROTA';
      htmlPartes.push(`
        <div class="moenda-card moenda-${esc(term.status)}">
          <div class="moenda-top">
            <strong>🏭 Termômetro de Moenda</strong>
            <span class="moenda-badge moenda-${esc(term.status)}">${statusRotulo}</span>
          </div>
          <div class="moenda-nums">
            <b>${term.entregaTonHora} t/h</b>
            <span>meta ${term.metaTonHora} t/h (${term.pctMeta}%)${term.deficitTonHora > 0 && term.colhedorasTotal > 0 ? ` · déficit ${term.deficitTonHora} t/h` : ''}</span>
          </div>
          <div class="moenda-bar"><span style="width:${barWidth}%"></span></div>
          <div class="taximetro-bar">
            <span>💸 Taxímetro de perdas no turno: <b>R$ ${fin.totalRs.toLocaleString('pt-BR')}</b></span>
            <small>Paradas: R$ ${fin.paradoRs.toLocaleString('pt-BR')} · Diesel ocioso: R$ ${fin.dieselRs.toLocaleString('pt-BR')} (${fin.litrosOcioso} L)</small>
          </div>
        </div>
      `);
    }

    if (res.sugestoesBalanceamento.length) {
      htmlPartes.push(
        '<div class="ctt-balanceamento"><strong>⚖️ Sugestão de Balanceamento CTT</strong>' +
        res.sugestoesBalanceamento.map((s) => `<p>${esc(s.texto)}</p>`).join('') +
        '</div>'
      );
    }

    if (!frentesFiltradas.length) {
      htmlPartes.push('<div class="vazio">Nenhuma frente de colheita lida ainda.<br><span class="fine">Assim que a telemetria SGPA chegar, o Raio-X CTT aparece automaticamente aqui.</span></div>');
    } else {
      for (const f of frentesFiltradas) {
        const semLbl = f.chuva ? '🌧️ CHUVA / PAUSA' : f.semaforo === 'critico' ? 'CRÍTICO' : f.semaforo === 'atencao' ? 'ATENÇÃO' : 'OPERANDO';
        const semCls = f.chuva ? 'sem-chuva' : 'sem-' + f.semaforo;
        const razaoTxt = f.razaoTbColh != null ? `${f.razaoTbColh} TB/Colh` : '—';
        htmlPartes.push(`
          <div class="ctt-card ${semCls}" data-frente="${esc(f.frente)}">
            <div class="ctt-head">
              <strong class="ctt-nome">${esc(f.frente)}</strong>
              <span class="ctt-sem ${semCls}">${semLbl}</span>
            </div>
            <div class="ctt-grid">
              <div class="ctt-cell"><span>🚜 Colhedoras</span><b>${f.colhColhendo}/${f.colhTotal} colh.</b><small>${f.colhParadas} par. · ${f.colhManut} manut.</small></div>
              <div class="ctt-cell"><span>🌾 Transbordos</span><b>${f.tbAtivos}/${f.tbTotal} ativ.</b><small>${f.tbAgCam} ag. cam. · ${razaoTxt}</small></div>
              <div class="ctt-cell"><span>🚛 Caminhões</span><b>${f.camFila} em fila</b><small>${f.camCarregando} carreg. · ${f.camTotal} total</small></div>
              <div class="ctt-cell"><span>🔧 Apoio / Sinal</span><b>${f.manutTotal} manut.</b><small>${f.mudas} muda(s) · ${f.equipamentos} eq.</small></div>
            </div>
            <div class="ctt-acoes">
              <button type="button" data-ctt-act="filtrar" data-frente="${esc(f.frente)}">🔍 Ver alertas</button>
              <button type="button" data-ctt-act="chuva" data-frente="${esc(f.frente)}" class="${f.chuva ? 'chuva-on' : ''}">${f.chuva ? '☀️ Encerrar chuva' : '🌧️ Modo Chuva'}</button>
            </div>
          </div>`);
      }
    }

    if (res.frotasMudas.length) {
      htmlPartes.push(
        '<div class="ctt-sec"><h4>📡 Frota Muda — sem telemetria (' + res.frotasMudas.length + ')</h4>' +
        res.frotasMudas.slice(0, 8).map((m) =>
          `<div class="ctt-row"><div><b>${esc(m.numero)}</b> · ${esc(m.frente)}<br><small>sem sinal há ${m.minutos} min · últ. op: ${esc(m.operacao)}${m.local ? ' · ' + esc(m.local) : ''}</small></div>` +
          `<button type="button" data-ctt-mapa="${esc(m.id)}">📍 último ponto</button></div>`
        ).join('') +
        '</div>'
      );
    }

    const ociosos = Object.values((ociosidadeTurno && ociosidadeTurno.itens) || {})
      .filter((o) => (Number(o.segAcumulados) || 0) >= 60)
      .sort((a, b) => (b.segAcumulados || 0) - (a.segAcumulados || 0))
      .slice(0, 5);
    if (ociosos.length) {
      const maxSeg = ociosos[0].segAcumulados || 60;
      htmlPartes.push(
        '<div class="ctt-sec"><h4>⛽ Top 5 Desperdício de Diesel (Ocioso no Turno)</h4>' +
        ociosos.map((o) => {
          const mins = Math.round(o.segAcumulados / 60);
          const litros = Math.round((o.segAcumulados / 3600) * 4 * 10) / 10;
          const pct = Math.max(12, Math.round((o.segAcumulados / maxSeg) * 100));
          return `<div class="ctt-diesel"><div class="ctt-diesel-top"><b>${esc(o.classe)} ${esc(o.numero)}</b><span>${mins} min (~${litros} L)</span></div>` +
            `<div class="ctt-diesel-bar"><span style="width:${pct}%"></span></div>` +
            `<small>${esc(o.frente || 'Sem frente')}${o.operador ? ' · ' + esc(o.operador) : ''}</small></div>`;
        }).join('') +
        '</div>'
      );
    }

    el.frentes.innerHTML = htmlPartes.join('');
    el.frentes.querySelectorAll('[data-ctt-act="filtrar"]').forEach((btn) => {
      btn.onclick = () => {
        const fr = btn.dataset.frente || '';
        if (el.busca) {
          el.busca.value = fr;
          buscaCentral = fr;
          if (el.buscaLimpar) el.buscaLimpar.classList.toggle('hide', !fr);
        }
        selecionarAbaCentral('ativos');
      };
    });
    el.frentes.querySelectorAll('[data-ctt-act="chuva"]').forEach((btn) => {
      btn.onclick = () => alternarChuvaFrente(btn.dataset.frente || '');
    });
    el.frentes.querySelectorAll('[data-ctt-mapa]').forEach((btn) => {
      btn.onclick = () => abrirNoMapa({ cdEquipamento: btn.dataset.cttMapa });
    });
  }

  function renderHudBarra() {
    const pillLive = $('coa-live');
    const txtLive = $('coa-live-txt');
    if (pillLive && txtLive) {
      const st = estadoConexaoCoa();
      pillLive.dataset.state = st.chave;
      txtLive.textContent = st.rotulo;
    }
    const pillSev = $('coa-sev');
    if (pillSev) {
      const lista = [...ativos.values()];
      const criticos = lista.filter((a) => (a.severidade || 0) >= 3).length;
      const atencao = lista.length - criticos;
      if (!lista.length) {
        pillSev.classList.add('hide');
        pillSev.classList.remove('critico');
        pillSev.textContent = '';
      } else {
        const partes = [];
        if (criticos > 0) partes.push(`${criticos} crít`);
        if (atencao > 0) partes.push(`${atencao} aten`);
        pillSev.textContent = partes.join(' · ');
        pillSev.classList.toggle('critico', criticos > 0);
        pillSev.classList.remove('hide');
      }
    }
    const btnVozBar = $('btn-voz-bar');
    if (btnVozBar) {
      const ligada = !!cfg.voz && !vozBloqueada;
      btnVozBar.classList.toggle('voz-ativa', ligada);
      btnVozBar.classList.toggle('voz-muda', !ligada);
      btnVozBar.setAttribute('aria-pressed', ligada ? 'true' : 'false');
      btnVozBar.title = vozBloqueada
        ? 'Voz aguardando um clique para liberar áudio — clique aqui'
        : cfg.voz
          ? 'Voz dos alertas ligada (clique para silenciar)'
          : 'Voz dos alertas silenciada (clique para ativar)';
      const onIco = btnVozBar.querySelector('.ico-voz-on');
      const offIco = btnVozBar.querySelector('.ico-voz-off');
      if (onIco) onIco.classList.toggle('hide', !ligada);
      if (offIco) offIco.classList.toggle('hide', ligada);
    }
    const btnPip = $('btn-pip');
    if (btnPip) {
      btnPip.classList.toggle('pip-ativo', !!(janelaPip && !janelaPip.closed));
    }
    renderTelaoBar();
    atualizarJanelaFlutuante();
  }

  function renderCabecalho() {
    renderHudBarra();
    if (!el.painel) return;
    const n = ativos.size;
    const avisaveis = [...ativos.values()].filter((a) => (a.fonte === 'portal' || a.regra === 'emergencia') && a.notificar).length;
    if (el.badge) {
      el.badge.textContent = n ? String(n) : '';
      el.badge.classList.toggle('hide', !n);
    }
    if (el.sino) el.sino.classList.toggle('alertando', cfg.ativo && avisaveis > 0);
    if (el.contFrentes && ultimoResumoCtt && Array.isArray(ultimoResumoCtt.frentes)) {
      el.contFrentes.textContent = String(ultimoResumoCtt.frentes.length);
    }
    if (el.contComboio) {
      el.contComboio.textContent = String(filaComboio().resumo.totalFila);
    }
    const s = Math.max(0, Math.round((proximo - agora()) / 1000));
    if (el.proximo) el.proximo.textContent = estado.ligado ? `próxima leitura em ${s}s` : 'central desligada';
    if (el.status) {
      const sessao = estado.sessao === 'ativa' ? 'sessão SGPA ativa' : `sessão SGPA ${estado.sessao}`;
      const resumoFonte = (fonte) => fonte.status === 'ok' ? 'ok' : fonte.status === 'falha' ? 'falha' : fonte.status === 'desligado' ? 'desligada' : 'aguardando';
      const statusAudit = auditStorageError ? 'não persistida' : auditRemoteError ? 'falha remota' : filaAudit.length ? 'pendente' : ctx.audit ? 'ok' : 'desativada';
      el.status.textContent = `${n} ativo${n === 1 ? '' : 's'} · ${estado.monitorados} equipamentos · telemetria ${resumoFonte(estado.fontes.telemetria)} · SGPA ${resumoFonte(estado.fontes.alarmes)} · auditoria ${statusAudit} · ${sessao}`;
      el.status.title = [estado.fontes.telemetria.erro && 'Telemetria: ' + estado.fontes.telemetria.erro,
        estado.fontes.alarmes.erro && 'Alarmes oficiais: ' + estado.fontes.alarmes.erro,
        auditStorageError && 'Auditoria local: ' + auditStorageError,
        auditRemoteError && 'Auditoria servidor: ' + auditRemoteError].filter(Boolean).join(' | ');
    }
    if (el.stream) {
      const vivo = estado.stream === 'ao vivo' && agora() - ultimoQuadro < 120000;
      el.stream.textContent = estado.stream === 'ao vivo'
        ? vivo ? 'eventos do mapa: ao vivo' : 'eventos do mapa: parado'
        : 'eventos do mapa: ' + estado.stream;
    }
    if (el.dot) {
      const temErro = estado.erros > 0 || !!auditStorageError || !!auditRemoteError;
      el.dot.classList.toggle('ruim', temErro);
      el.dot.title = [estado.erros > 0 && 'fontes SGPA: ' + estado.proximoErro,
        auditStorageError && 'auditoria local: ' + auditStorageError,
        auditRemoteError && 'auditoria servidor: ' + auditRemoteError].filter(Boolean).join(' | ') || 'fontes e auditoria lendo normalmente';
    }
    if (el.escopo) {
      const pedacos = [];
      if (cfg.frentes.length) pedacos.push(cfg.frentes.length + ' frente(s)');
      if ((cfg.equipamentos || '').trim()) pedacos.push('lista de equipamentos');
      if (cfg.seguirSelecaoMapa) pedacos.push('seleção do mapa');
      const qtdChuva = Object.keys(chuvas || {}).length;
      if (qtdChuva) pedacos.push(`🌧️ ${qtdChuva} frente(s) em chuva`);
      el.escopo.textContent = pedacos.length ? 'escopo: ' + pedacos.join(', ') : 'escopo: unidade toda';
    }
    document.title = n ? `(${n}) Monitoramento BP · COA` : 'Monitoramento BP — Branco Peres · COA';
    const bSom = $('btn-som');
    const bVoz = $('btn-voz');
    if (bSom) bSom.classList.toggle('mudo', !cfg.som);
    if (bVoz) bVoz.classList.toggle('mudo', !cfg.voz);
  }

  function card(a, comAccoes, contexto) {
    const d = document.createElement('div');
    d.className = 'alerta sev' + a.severidade + (a.fonte === 'portal' ? ' oficial' : '') + (a.regra === 'emergencia' ? ' emergencia' : '');
    d.dataset.chave = a.chave;
    d.style.setProperty('--cor', a.cor);
    const reconhecido = acks[a.chave] && agora() - acks[a.chave] < 2 * 3600_000;
    const trat = tratativas[a.chave] || null;
    const inicioSla = a.inicio || a.ts;
    const sla = classeSla(inicioSla, a.severidade || 1);
    const mostrarPainelTratativa = contexto === 'central' && comAccoes && reconhecido;
    const ehParadaCusto = a.regra === 'paradaImprodutiva' || a.regra === 'aguardandoCaminhao' || a.regra === 'aguardandoBasculamento' || a.regra === 'semApontamento' || a.regra === 'inconsistenciaApontamento';
    const minAberto = Math.max(0, Math.round((agora() - inicioSla) / 60_000));
    const custoAlertaRs = ehParadaCusto && minAberto >= 2 ? Math.round(minAberto * policy.custoHoraEquipamento(a.e || {}, cfg).valorMinuto) : 0;
    d.innerHTML = `
      <div class="a-top">
        <span class="a-icone">${a.icone}</span>
        <strong class="a-eq">${esc(a.classe)} ${esc(a.numero)}</strong>
        <span class="a-chip">${esc(a.nome)}</span>
        ${a.fonte === 'portal' ? '<span class="a-chip oficial">SGPA</span>' : ''}
        ${a.fonte === 'teste' ? '<span class="a-chip cinza">AMOSTRA MANUAL</span>' : ''}
        ${a.emChuva ? `<span class="a-chip cinza">🌧️ Chuva</span>` : ''}
        ${a.paradaId === 'aguardandoCarregamento' && a.e && a.e.frenteInferida ? `<span class="a-chip">Frente inferida: ${esc(a.e.frenteInferida)}</span>` : ''}
        ${custoAlertaRs > 0 ? `<span class="a-chip custo">💸 ~R$ ${custoAlertaRs.toLocaleString('pt-BR')}</span>` : ''}
        ${!a.notificar ? '<span class="a-chip cinza">sem notificação do sistema</span>' : ''}
        ${a.contagem > 1 ? `<span class="a-chip cinza">×${a.contagem}</span>` : ''}
        ${trat && trat.tag ? `<span class="a-chip verde">📝 ${esc(trat.tag)}</span>` : ''}
        <span class="a-sla ${sla.cls}" data-sla-inicio="${inicioSla}" data-sla-sev="${a.severidade || 1}">${sla.txt}</span>
        <span class="a-hora" title="há ${desde(a.ts)}">${hora(a.ts)}</span>
      </div>
      <p class="a-txt">${esc(a.texto)}</p>
      <p class="a-meta">${esc(a.descricao)}${a.operador ? ' · operador <b>' + esc(a.operador) + '</b>' : ' · <b>sem operador definido</b>'}${a.detalhe ? '<br>' + esc(a.detalhe) : ''}</p>
      <p class="a-fala">🗣️ ${esc(a.fala)}</p>
      ${mostrarPainelTratativa ? `
      <div class="a-tratativa">
        <div class="a-trat-tags">${TAGS_TRATATIVA_COA.map((tag) => `<button type="button" data-trat-tag="${esc(tag)}" class="${trat && trat.tag === tag ? 'on' : ''}">${esc(tag)}</button>`).join('')}</div>
        <div class="a-trat-nota">
          <input type="text" data-trat-nota value="${esc(trat && trat.nota ? trat.nota : '')}" placeholder="Obs. COA (ex.: mecânico acionado no rádio)..." maxlength="180" autocomplete="off">
          <button type="button" data-trat-salvar>Salvar</button>
        </div>
      </div>` : ''}
      <div class="a-acoes">
        <button data-q="ouvir">▶ ouvir</button>
        <button data-q="mapa">📍 ver no mapa</button>
        <button data-q="whats" title="Copiar cobrança padronizada COA e abrir WhatsApp">💬 cobrar</button>
        ${comAccoes ? '<button data-q="snz">🤫 15 min</button>' : ''}
        ${comAccoes && !reconhecido ? '<button data-q="ack">✓ reconhecer</button>' : comAccoes ? '<span class="a-chip verde">reconhecido</span>' : ''}
        <button data-q="fechar" class="fim">✕</button>
      </div>`;
    d.querySelector('[data-q="ouvir"]').onclick = () => falar(a.fala);
    d.querySelector('[data-q="mapa"]').onclick = () => abrirNoMapa(a);
    d.querySelector('[data-q="whats"]').onclick = () => cobrarNoWhatsApp(a);
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
        podarAcks(acks);
        acks[a.chave] = agora();
        salvar(KEY_ACK, acks);
        if (emergenciaAtiva && emergenciaAtiva.chave === a.chave) fecharBannerEmergencia();
        renderAtivos();
        renderCabecalho();
      };
    if (mostrarPainelTratativa) {
      d.querySelectorAll('[data-trat-tag]').forEach((btnTag) => {
        btnTag.onclick = () => {
          const inp = d.querySelector('[data-trat-nota]');
          registrarTratativa(a.chave, { tag: btnTag.dataset.tratTag, nota: inp ? inp.value : undefined });
          renderAtivos();
        };
      });
      const btnSalvarNota = d.querySelector('[data-trat-salvar]');
      if (btnSalvarNota) {
        btnSalvarNota.onclick = () => {
          const inp = d.querySelector('[data-trat-nota]');
          registrarTratativa(a.chave, { nota: inp ? inp.value : '' });
          mostrarAviso('Tratativa COA registrada no turno.', 'info');
          renderAtivos();
        };
      }
    }
    d.querySelector('[data-q="fechar"]').onclick = () => {
      ativos.delete(a.chave);
      if (emergenciaAtiva && emergenciaAtiva.chave === a.chave) fecharBannerEmergencia();
      fecharCard(d);
      renderAtivos();
      renderCabecalho();
    };
    return d;
  }

  function fecharCard(d) {
    d.classList.add('saindo');
    setTimeout(() => { d.remove(); atualizarBotaoLimparToasts(); }, 200);
  }
  let listenerResizeLimparToasts = false;
  function prepararBotaoLimparToasts() {
    if (!el.toasts) return null;
    if (!listenerResizeLimparToasts) {
      window.addEventListener('resize', atualizarBotaoLimparToasts);
      listenerResizeLimparToasts = true;
    }
    let b = document.getElementById('btn-limpar-toasts');
    if (b) return b;
    b = document.createElement('button');
    b.type = 'button';
    b.id = 'btn-limpar-toasts';
    b.className = 'toast-limpar hide';
    b.setAttribute('aria-label', 'Limpar todas as notificações flutuantes; os alertas continuam na Central e no histórico');
    b.title = 'Limpa somente as notificações flutuantes; mantém alertas ativos e histórico';
    b.textContent = 'Limpar tudo';
    b.addEventListener('click', limparToasts);
    document.body.appendChild(b);
    return b;
  }
  function atualizarBotaoLimparToasts() {
    if (!el.toasts) return;
    const b = document.getElementById('btn-limpar-toasts');
    if (!b) return;
    const temCards = !!el.toasts.querySelector('.toast, .aviso');
    b.classList.toggle('hide', !temCards);
    if (!temCards) return;
    const r = el.toasts.getBoundingClientRect();
    const w = b.getBoundingClientRect().width || 96;
    b.style.top = Math.max(4, r.top + 3) + 'px';
    b.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    b.style.right = 'auto';
  }
  function limparToasts() {
    if (!el.toasts) return;
    el.toasts.querySelectorAll('.toast, .aviso').forEach((cardFlutuante) => cardFlutuante.remove());
    el.toasts.scrollTop = 0;
    atualizarBotaoLimparToasts();
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
        a.numero, a.e && a.e.id, a.e && a.e.nome, a.e && a.e.tipo, a.e && a.e.frente, a.e && a.e.frenteInferida,
        a.operador, a.nomeAlarme, a.tipoAlarme, a.regra, a.texto, a.detalhe,
      ]));
    el.ativos.innerHTML = '';
    if (!lista.length) {
      el.ativos.innerHTML = norm(buscaCentral)
        ? '<div class="vazio">Nenhum alerta ativo corresponde à busca.</div>'
        : '<div class="vazio">Nenhum alerta ativo agora.<br><span class="fine">A central continua lendo o portal a cada ' +
          cfg.intervaloSeg + 's e os eventos do mapa em tempo real.</span></div>';
    }
    for (const a of lista) el.ativos.appendChild(card(a, true, 'central'));
    el.contAtivos.textContent = String(ativos.size);
    el.contHist.textContent = String(hist.length);

    if (el.historico && !el.historico.classList.contains('hide')) {
      el.historico.innerHTML = '';
      const resultados = hist.filter((h) => correspondeBuscaCentral([
        h.equipamento, h.descricao, h.nomeAlarme, h.tipoAlarme, h.regra,
        h.texto, h.detalhe, h.operador, h.frente, h.frenteInferida, h.tratativa,
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
          `<span class="a-chip">${esc(h.nomeAlarme || r.nome)}</span>${h.frenteInferida ? `<span class="a-chip">Frente inferida: ${esc(h.frenteInferida)}</span>` : ''}${h.tratativa ? `<span class="a-chip verde">📝 ${esc(h.tratativa)}</span>` : ''}${h.notificacaoSelecionada === false ? '<span class="a-chip cinza">sem aviso</span>' : ''}<span class="a-hora">${hora(h.ts)}</span></div>` +
          `<p class="a-txt">${esc(h.texto)}</p>` +
          `<p class="a-meta">${esc(h.descricao || '')}${h.operador ? ' · ' + esc(h.operador) : ''} · fonte ${esc(h.fonte)}</p>`;
        d.onclick = () => falar(h.fala || h.texto);
        el.historico.appendChild(d);
      }
    }
  }

  function mostrarToast(a, silenciado) {
    if (!el.toasts) return;
    prepararBotaoLimparToasts();
    const d = card(a, !silenciado, 'toast');
    d.classList.add('toast');
    if (silenciado) d.classList.add('mudo');
    const fixoNoTelao = (telaoAtivo && (a.severidade || 0) >= 3) || a.regra === 'emergencia';
    if (fixoNoTelao) d.classList.add('toast-fixo');
    d.style.setProperty('--tempo', (a.severidade >= 3 ? 26 : 18) + 's');
    el.toasts.appendChild(d);
    if (!fixoNoTelao) {
      const barra = document.createElement('div');
      barra.className = 'barra';
      barra.style.animationDuration = (a.severidade >= 3 ? 26 : 18) + 's';
      d.appendChild(barra);
      const t = setTimeout(() => fecharCard(d), (a.severidade >= 3 ? 26 : 18) * 1000);
      d.addEventListener('mouseenter', () => {
        clearTimeout(t);
        barra.style.animationPlayState = 'paused';
      });
      d.addEventListener('mouseleave', () => {
        setTimeout(() => fecharCard(d), 4000);
      });
    }
    const maxVisiveis = Math.max(4, Math.min(8, Math.floor(innerHeight / 120))); // retém mais notificações; a área continua rolável
    const cardsFlutuantes = () => Array.from(el.toasts.children).filter((n) => n.matches('.toast, .aviso'));
    while (cardsFlutuantes().length > maxVisiveis) cardsFlutuantes()[0].remove();
    atualizarBotaoLimparToasts();
    rolarToastMaisNovo();
  }

  function rolarToastMaisNovo() {
    if (!el.toasts) return;
    requestAnimationFrame(() => {
      if (el.toasts) el.toasts.scrollTop = -el.toasts.scrollHeight;
    });
  }

  function mostrarAviso(txt, tipo) {
    if (!el.toasts) return;
    prepararBotaoLimparToasts();
    const d = document.createElement('div');
    d.className = 'aviso ' + (tipo || '');
    d.textContent = txt;
    el.toasts.appendChild(d);
    atualizarBotaoLimparToasts();
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
    aguardandoBasculamento: 'Correlação local: se trator/transbordo estiver em 905 e houver caminhão na mesma frente em “Aguardando Carregamento”, classifica a situação como basculamento provável após a tolerância configurada de 15 min. O apontamento SGPA não é alterado.',
    frenteDividida: 'Apontamento “Frente dividida” observado no stream/telemetria em trator/transbordo. Alerta sem tolerância para o COA validar a chamada da colhedora no FUT. Fala/notificação locais dependem do PWA aberto e conectado.',
    refeicao: 'Refeição acima do tempo configurado por grupo ou equipamento (seção Controle de refeições). Fala e notifica só com o app aberto.',
    semApontamento: 'Equipamento na operação SGPA “Sem Apontamento” por 5 min ou mais (sem alarme do portal). Fala e notifica só com o app aberto.',
    paradaImprodutiva: 'Paradas improdutivas de maior impacto (fila, aguardando carregamento, 983, falta de transbordo, mecânica, comboio etc.) acima da tolerância da seção Paradas improdutivas. Fala e notifica com o app aberto.',
    gestaoFrente: 'Alertas da frente: fila acumulada de caminhões, frente com todas as colhedoras paradas e transbordos demais aguardando colhedora (seção Gestão por frente).',
    emergencia: 'Prioridade máxima: apontamento ou alarme de incêndio/fogo ou caminhão bombeiro em deslocamento rápido. Fura a fila de voz, dispara sirene e abre banner vermelho no topo.',
    telemetriaMuda: 'Frota monitorada sem comunicação de telemetria acima do limiar configurado (ponto cego de bordo/GPS). Fala e exibe último ponto conhecido.',
    qualidadeColheita: 'Colhedora operando em colheita acima da velocidade técnica configurada (risco de perda de cana e impureza mineral/vegetal).',
    inconsistenciaApontamento: 'Auditoria automática COA: máquina apontando Colheita parada (0 km/h) ou apontando Parada/Refeição/Sem Apontamento enquanto desloca em velocidade.',
    riscoMoenda: 'Alerta estratégico quando o ritmo estimado de entrega das colhedoras fica abaixo de 70% da meta de moagem da usina por mais de 15 min.',
    bateVolta: 'Caminhão canavieiro em viagem/transporte acima do tempo máximo de bate-volta configurado (possível retenção ou quebra na estrada).',
    manutencaoPreditiva: 'Equipamento com 3 ou mais alertas mecânicos/RPM/motor em janela de 4 horas — sugere inspeção preventiva antes de quebra grave.',
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


  function rotuloVozAmigavel(nomeBruto, langBruta, origem) {
    const nome = String(nomeBruto || 'Voz padrão').trim();
    const lang = String(langBruta || '').trim();
    const mGoogle = /^pt[-_]br[-_]x[-_]([a-z0-9]+)[-_](network|local)$/i.exec(nome);
    if (mGoogle) {
      const variante = mGoogle[1].toUpperCase();
      const rede = /network/i.test(mGoogle[2]) ? 'Alta definição · Online' : 'Offline no aparelho';
      return `Português Brasil · Voz ${variante} (${rede}) — ${nome}`;
    }
    const tags = [];
    if (/natural|neural/i.test(nome)) tags.push('Voz Natural · Recomendada COA');
    if (origem === 'android') tags.push('Android' + (lang ? ' · ' + lang : ''));
    else if (lang) tags.push(lang);
    else tags.push('idioma não informado');
    return `${nome} (${tags.join(' · ')})`;
  }

  function preencherVozes() {
    const sel = $('cfg-vozel');
    if (!sel) return;
    const s = sintetizador();
    const vozes = s ? (s.getVoices() || []).slice() : [];
    const nativas = vozesNativas().slice();
    sel.innerHTML = '';
    const add = (v, t) => {
      const o = document.createElement('option');
      o.value = v || '';
      o.textContent = t;
      sel.appendChild(o);
    };
    if (nativas.length) {
      nativas.sort((a, b) => {
        const pa = /^pt/i.test(String(a.lang || '')) ? 1 : 0;
        const pb = /^pt/i.test(String(b.lang || '')) ? 1 : 0;
        return pb - pa || String(a.name || '').localeCompare(String(b.name || ''));
      });
      for (const v of nativas) {
        const nome = String(v.name || v.id || 'Voz do aparelho');
        add('android:' + nome, rotuloVozAmigavel(nome, v.lang, 'android'));
      }
    } else if (ponteNativa()) add('__nativa__', 'Voz padrão do aparelho (Android)');
    const pt = vozes.filter((v) => /^pt/i.test(v.lang)).sort((a, b) => qualidadeVozPt(b) - qualidadeVozPt(a));
    const outras = vozes.filter((v) => !/^pt/i.test(v.lang));
    for (const v of [...pt, ...outras]) add(idVozWeb(v), rotuloVozAmigavel(v.name, v.lang, 'web'));
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
  function textoGlossarioAtual() {
    const t = $('cfg-glossario');
    return t ? t.value : cfg.glossarioFala || '';
  }
  function previaGlossario() {
    const i = $('cfg-glossario-teste');
    const p = $('cfg-glossario-previa');
    if (!i || !p) return '';
    const falado = policy.aplicarGlossario(i.value, { glossarioFala: textoGlossarioAtual() });
    p.textContent = 'A voz vai falar: “' + falado + '”';
    return falado;
  }
  function iniciarGlossario() {
    const t = $('cfg-glossario');
    if (!t) return;
    t.value = cfg.glossarioFala || '';
    const pad = $('cfg-glossario-padrao');
    if (pad) pad.textContent = 'Já incluídos: ' + policy.GLOSSARIO_PADRAO.map((r) => r[0].toUpperCase() + '=' + r[1]).join(', ') + '. Uma regra sua com o mesmo termo substitui a padrão.';
    t.oninput = previaGlossario;
    if ($('cfg-glossario-teste')) $('cfg-glossario-teste').oninput = previaGlossario;
    if ($('cfg-glossario-ouvir')) $('cfg-glossario-ouvir').onclick = () => {
      const f = previaGlossario();
      if (f) falar(f);
    };
    previaGlossario();
  }
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
      'cfg-frota-muda': cfg.minutosFrotaMuda != null ? cfg.minutosFrotaMuda : 25,
      'cfg-vel-colheita': cfg.velMaxColheita != null ? cfg.velMaxColheita : 7.5,
      'cfg-sla-min': cfg.slaAlertaMin != null ? cfg.slaAlertaMin : 10,
      'cfg-inconsistencia-min': cfg.minutosInconsistencia != null ? cfg.minutosInconsistencia : 8,
      'cfg-batevolta-min': cfg.minutosBateVoltaMax != null ? cfg.minutosBateVoltaMax : 55,
      'cfg-meta-moenda': cfg.metaMoagemTonHora != null ? cfg.metaMoagemTonHora : 420,
      'cfg-ton-colh': cfg.tonHoraPorColhedora != null ? cfg.tonHoraPorColhedora : 65,
      'cfg-custo-colh': cfg.custoHoraColhedora != null ? cfg.custoHoraColhedora : 850,
      'cfg-custo-tb': cfg.custoHoraTransbordo != null ? cfg.custoHoraTransbordo : 260,
      'cfg-custo-cam': cfg.custoHoraCaminhao != null ? cfg.custoHoraCaminhao : 220,
      'cfg-custo-diesel': cfg.custoLitroDiesel != null ? cfg.custoLitroDiesel : 6.2,
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
      'cfg-reescalar-min': cfg.reescalarCriticosMin != null ? cfg.reescalarCriticosMin : 5,
    };
    for (const [id, v] of Object.entries(valores)) {
      if ($(id)) $(id).value = v;
    }
    if ($('cfg-perfil-voz')) $('cfg-perfil-voz').value = PERFIS_VOZ[cfg.perfilVoz] ? cfg.perfilVoz : 'padrao';
    if ($('cfg-estilo-toque')) $('cfg-estilo-toque').value = cfg.estiloToque || 'gongo-coa';
    if ($('cfg-acabamento')) $('cfg-acabamento').value = normalizarTema(document.documentElement.dataset.acabamento);
    const checks = {
      'cfg-liga': cfg.ativo,
      'cfg-gestao-frente': cfg.gestaoFrenteAtiva !== false,
      'cfg-auditar-apontamento': cfg.auditarApontamento !== false,
      'cfg-manut-preditiva': cfg.manutencaoPreditivaAtiva !== false,
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
      'cfg-sentinela': cfg.sentinelaSegundoPlano !== false,
      'cfg-wakelock': cfg.manterTelaAtiva !== false,
      'cfg-queda-sgpa': cfg.alertaQuedaSgpa !== false,
      'cfg-reescalar-criticos': cfg.reescalarCriticos !== false,
    };
    for (const [id, v] of Object.entries(checks)) {
      if ($(id)) $(id).checked = !!v;
    }
    $('lb-vol').textContent = Number(cfg.volume).toFixed(2);
    $('lb-taxa').textContent = Number(cfg.taxa).toFixed(2);
    $('lb-tom').textContent = Number(cfg.tom).toFixed(2);
    const gerenciarVozes = $('cfg-gerenciar-vozes');
    const bateriaAndroid = $('cfg-bateria-android');
    const ponteVoz = ponteNativa();
    if (gerenciarVozes) gerenciarVozes.classList.toggle('hide', !(ponteVoz && typeof ponteVoz.gerenciarVozes === 'function'));
    if (bateriaAndroid) bateriaAndroid.classList.toggle('hide', !(ponteVoz && typeof ponteVoz.otimizarBateria === 'function'));
    preencherVozes();
    renderPushStatus();

    renderRefeicoes();
    renderParadas();
    iniciarGlossario();
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
      const elInput = $(id);
      if (!elInput) return d;
      const v = Number(elInput.value);
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
      gestaoFrenteAtiva: $('cfg-gestao-frente').checked,
      auditarApontamento: $('cfg-auditar-apontamento') ? $('cfg-auditar-apontamento').checked : cfg.auditarApontamento !== false,
      manutencaoPreditivaAtiva: $('cfg-manut-preditiva') ? $('cfg-manut-preditiva').checked : cfg.manutencaoPreditivaAtiva !== false,
      sentinelaSegundoPlano: $('cfg-sentinela') ? $('cfg-sentinela').checked : cfg.sentinelaSegundoPlano !== false,
      manterTelaAtiva: $('cfg-wakelock') ? $('cfg-wakelock').checked : cfg.manterTelaAtiva !== false,
      alertaQuedaSgpa: $('cfg-queda-sgpa') ? $('cfg-queda-sgpa').checked : cfg.alertaQuedaSgpa !== false,
      reescalarCriticos: $('cfg-reescalar-criticos') ? $('cfg-reescalar-criticos').checked : cfg.reescalarCriticos !== false,
      reescalarCriticosMin: Math.max(1, n('cfg-reescalar-min', 5)),
      perfilVoz: $('cfg-perfil-voz') ? $('cfg-perfil-voz').value : cfg.perfilVoz || 'padrao',
      estiloToque: $('cfg-estilo-toque') ? $('cfg-estilo-toque').value : cfg.estiloToque || 'gongo-coa',
      limiteRpm: n('cfg-rpm', 2000),
      minutosOcioso: n('cfg-ocioso', 5),
      minutosSemApontamento: n('cfg-sem-ponto', 5),
      escalarUrgenteMin: n('cfg-esc1', 10),
      escalarLiderMin: n('cfg-esc2', 20),
      lideresFrente: $('cfg-lideres') ? $('cfg-lideres').value.trim() : '',
      filaMaxFrente: n('cfg-fila-frente', 4),
      minutosFrenteSemColhedora: n('cfg-sem-colh', 10),
      transbordosAguardandoMax: n('cfg-transb-ag', 3),
      minutosFrotaMuda: n('cfg-frota-muda', 25),
      velMaxColheita: n('cfg-vel-colheita', 7.5),
      slaAlertaMin: Math.max(1, n('cfg-sla-min', 10)),
      minutosInconsistencia: Math.max(0, n('cfg-inconsistencia-min', 8)),
      minutosBateVoltaMax: Math.max(0, n('cfg-batevolta-min', 55)),
      metaMoagemTonHora: Math.max(0, n('cfg-meta-moenda', 420)),
      tonHoraPorColhedora: Math.max(10, n('cfg-ton-colh', 65)),
      custoHoraColhedora: Math.max(0, n('cfg-custo-colh', 850)),
      custoHoraTransbordo: Math.max(0, n('cfg-custo-tb', 260)),
      custoHoraCaminhao: Math.max(0, n('cfg-custo-cam', 220)),
      custoLitroDiesel: Math.max(1, n('cfg-custo-diesel', 6.2)),
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
      glossarioFala: $('cfg-glossario') ? $('cfg-glossario').value.trim() : cfg.glossarioFala || '',
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
    const cab = ['quando', 'tipo', 'equipamento', 'descricao', 'operador', 'valor', 'mensagem', 'fonte', 'detalhe', 'fala', 'codigo_sgpa', 'nome_sgpa', 'frente_grupo', 'notificacao_selecionada', 'tratativa_coa'];
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
      h.tratativa || '',
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

  function origemMapaConfiavel(origemEvento) {
    if (!origemEvento) return false;
    const origens = new Set();
    const iframe = $('map');
    const iframeSrc = iframe && (iframe.getAttribute('src') || iframe.src);
    for (const candidato of [ctx.mapUrl, iframeSrc]) {
      if (!candidato) continue;
      try {
        origens.add(new URL(candidato, window.location.href).origin);
      } catch {
        /* ignora URL malformada */
      }
    }
    return origens.has(origemEvento);
  }

  /* seleção feita no mapa: o micro-frontend emite strings JSON em 4 eventos */
  function escutarMapa() {
    window.addEventListener('message', (ev) => {
      if (!origemMapaConfiavel(ev && ev.origin)) return;
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
    if (cfg.gestaoFrenteAtiva === false) limparAlertasGestao();
    if (!Array.isArray(ctx.selecao)) ctx.selecao = new Set(selecaoMapa);
    if (Object.prototype.hasOwnProperty.call(patch, 'selecaoMapa')) ctx.selecao = new Set(selecaoMapa);
    if (escopoAlterado) {
      reconciliarEscopo();
      renderAtivos();
    }
    if (!cfg.ativo || !cfg.voz || patch.notificarCategorias || patch.tiposNotificacao) pararVoz();
    if (!cfg.ativo || !cfg.usarStream) { fecharStream(); estado.stream = 'desligado'; }
    else if ((!antes.ativo || !antes.usarStream) && ctx.token) abrirStream();
    else if (worker && antes.sentinelaSegundoPlano !== cfg.sentinelaSegundoPlano) {
      try {
        worker.postMessage(cfg.sentinelaSegundoPlano === false ? { type: 'parar-relogio' } : { type: 'relogio', intervaloMs: 5000 });
      } catch { /* ignora */ }
    }
    sincronizarSentinelaCompleta();
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
    if (filaAudit.length && !auditTimer) auditTimer = setTimeout(enviarAudit, 2000);
    const selecaoPersistida = Array.isArray(cfg.selecaoMapa) ? cfg.selecaoMapa.map(String) : [];
    const selecaoAtual = ctx.selecao instanceof Set ? [...ctx.selecao] : Array.isArray(ctx.selecao) ? ctx.selecao.map(String) : [];
    ctx.selecao = new Set([...selecaoPersistida, ...selecaoAtual]);
    if (!el.painel) montar();
    if (!iniciar.escutou) {
      iniciar.escutou = true;
      escutarMapa();
      window.addEventListener('bperes-tts-fim', concluirVozNativa);
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
        // Watchdog mais rápido (75s) para reconectar stream travado sem perder janelas de alerta.
        if (cfg.usarStream && cfg.ativo && worker && estado.stream === 'ao vivo' && ultimoSinalStream && agora() - ultimoSinalStream > 75000) {
          estado.proximoErro = 'stream sem atividade há mais de 75s; reconectando automaticamente';
          fecharStream();
          renderCabecalho();
          agendarReconexaoStream();
        }
      }, 15000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          escondidoEm = agora();
          sincronizarAudioSentinela();
          return;
        }
        if (document.visibilityState === 'visible' && cfg.ativo) {
          escolherVoz();
          sincronizarWakeLock();
          sincronizarAudioSentinela();
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
    encerrarRelogioIsolado();
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
    calarFalaAtual,
    alternarVoz,
    alternarJanelaFlutuante,
    aplicarTema: aplicarAcabamento,
    obterTema: () => normalizarTema(document.documentElement.dataset.acabamento),
    alternarTelao,
    alternarChuvaFrente,
    resumoFrentes,
    filaComboio,
    despacharApoioWhatsApp,
    termometroMoenda,
    custoTurno,
    placarPositivo,
    radarIncendio,
    definirClimaManual,
    executarComandoCoa,
    abrirAssistenteCoa,
    ouvirComandoVoz,
    registrarTratativa,
    cobrarNoWhatsApp,
    gerarPassagemTurno,
    abrirPassagemTurno,
    fecharPassagemTurno,
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
