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
 * As regras (velocidade excedida, RPM máxima do motor, preso em troca de turno,
 * motor ocioso) são avaliadas AQUI, no aparelho, com histerese: se a regra
 * oficial do portal atrasar ou falhar — queixa do usuário —, o alerta sai mesmo
 * assim. O alerta oficial também é espelhado, para não perder nada.
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

  const VERSAO = '1.1.0';
  const KEY_CFG = 'bperes.alertas.cfg.v2';
  const KEY_HIST = 'bperes.alertas.hist.v2';
  const KEY_ACK = 'bperes.alertas.ack.v2';
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
    2697: 'velocidade',
    2699: 'velocidade',
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
    minutosTurno: 4, // pedido do usuário (o portal usa 3)
    maxAtrasoMin: 20, // ignorar equipamento sem sinal há mais que isso
    espelharServidor: true,
    incluirOutros: false, // alarmes oficiais de outros tipos (SEM CONEXÃO, IMPL. OCIOSO…) ficam fora
    calcularLocal: true,
    usarStream: true,
    frentes: [],
    equipamentos: '',
    seguirSelecaoMapa: false,
    popup: true,
    som: true,
    voz: true,
    vozNome: '',
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

  let cfg = carregar(KEY_CFG, PADRAO);
  let hist = carregar(KEY_HIST, []);
  let acks = carregar(KEY_ACK, {});
  let ctx = { selecao: new Set(), props: null };
  let timer = null;
  let correndo = false;
  let proximo = 0;
  let worker = null;
  let ultimoQuadro = 0;
  let tentativasStream = 0;

  const frota = new Map(); // cdEquipamento => leitura consolidada
  const estados = new Map(); // "equipamento|regra" => máquina de estados
  const ativos = new Map(); // chave => alerta exibido
  let el = {};

  const estado = {
    ligado: false,
    ultimoCiclo: 0,
    erros: 0,
    proximoErro: '',
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
      return JSON.parse(JSON.stringify(Object.assign({}, padrao, JSON.parse(bruto))));
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
    if (res.status === 401 || res.status === 403) {
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

  async function chamarProxy(caminho) {
    const res = await fetch('/.netlify/functions/session?acao=dados&rota=' + encodeURIComponent(caminho), {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('proxy HTTP ' + res.status);
    const json = await res.json();
    if (json && json.erro) throw new Error(json.erro);
    return json.dados;
  }

  async function renovarToken() {
    if (typeof ctx.renovar !== 'function') return;
    try {
      const nova = await ctx.renovar();
      if (nova && nova.props) {
        ctx.token = nova.props.token;
        ctx.api = nova.props.urlSgpa || ctx.api;
        ctx.props = nova.props;
        if (worker) abrirStream(); // o stream precisa do token novo
      }
    } catch {
      /* sem sessão nova: o próximo ciclo tenta de novo */
    }
  }

  const rotaTelemetria = () => `/estatistica/monitoramento?buId=${encodeURIComponent(ctx.buId)}&language=pt-br`;
  const rotaAlarmes = () => `/alarmeOnline?ativo=true&idioma=pt-br&buId=${encodeURIComponent(ctx.buId)}&language=pt-br`;
  const rotaTempos = () => `/alarmeTempoEquipamento?buId=${encodeURIComponent(ctx.buId)}&language=pt-br`;

  /* ------------------------------------------------------------------ */
  /* 1) stream ao vivo (subscribe-live) dentro de um Web Worker         */
  /* ------------------------------------------------------------------ */

  function abrirStream() {
    fecharStream();
    if (!cfg.usarStream || typeof Worker === 'undefined' || !ctx.token) {
      estado.stream = cfg.usarStream ? 'indisponível' : 'desligado';
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
          // reconecta com respiro, como faz o worker oficial do mapa
          const espera = Math.min(60_000, 2000 * 2 ** tentativasStream);
          tentativasStream++;
          setTimeout(() => {
            if (cfg.usarStream && cfg.ativo) abrirStream();
          }, espera);
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
    const lista = Array.isArray(itens) ? itens : [];
    for (const q of lista) {
      if (!q || !q.cdEquipamento) continue;
      if (q.type === 'alarme') {
        quadroAlarme(q);
        continue;
      }
      const e = mesclar(String(q.cdEquipamento));
      e.frente = q.descFrente || e.frente;
      if (q.cdOperacao !== undefined && q.cdOperacao !== null) {
        const novaOperacao = String(q.descOperacao || q.cdOperacao || '');
        if (norm(novaOperacao) !== norm(e.operacao)) {
          e.operacaoTs = agora(); // acabou de entrar nesta operação
        }
        e.operacao = novaOperacao;
        e.cdOperacao = String(q.cdOperacao || '');
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
    }
    estado.quadros += lista.length;
  }

  /* quadro de alarme do stream: é o que desenha o halo pulsante no mapa */
  function quadroAlarme(q) {
    let regra = MAPA_ALARME[q.cdTpAlarme];
    if (!regra) {
      if (!cfg.incluirOutros) return;
      regra = 'generico';
    }
    const e = mesclar(String(q.cdEquipamento));
    e.alarmeOficial = q.descAlarme || e.alarmeOficial;
    if (q.fgOnline === false || q.fgOnline === 0) {
      e.alarmeOnline = false;
      return;
    }
    e.alarmeOnline = true;
    e.tsAlarme = agora();
    emitirAlarmeOficial(
      {
        cdEquipamento: q.cdEquipamento,
        descEquipamento: q.descEquipamento || e.nome,
        descTpAlarme: q.descAlarme || q.descTpAlarme,
        cdTpAlarme: q.cdTpAlarme,
        nomeOperador: q.descOperador || e.operadorBruto,
        descOperacao: q.descOperacao || e.operacao,
        descGrupoEquipamento: q.descFrente || e.frente,
        vlAlarme: q.vlPeso != null ? q.vlPeso : q.vlAlarme,
        dtHrLocal: dataHorario(q.dtHrLocal),
      },
      regra,
      'mapa',
    );
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
        operador: '',
        operadorBruto: '',
        estadoTxt: '',
        velocidade: null,
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
      const e = mesclar(id);
      const p = partirEquipamento(row.descEquipamento, id);
      e.nome = p.nome || e.nome;
      e.numero = p.numero;
      e.tipo = row.descTpEquipamento || e.tipo;
      e.frente = row.descGrupoEquipamento || e.frente;
      if (row.descOperacao && norm(row.descOperacao) !== norm(e.operacao)) {
        e.operacaoTs = agora();
        e.operacao = String(row.descOperacao);
      }
      e.cdOperacao = String(row.cdOperacao || e.cdOperacao || '');
      e.estadoTxt = row.descEstado || e.estadoTxt;
      e.grupoOperacao = row.descGrupoOperacao || e.grupoOperacao;
      if (norm(row.descFuncionario) !== norm(e.operadorBruto)) {
        e.operadorTs = agora();
        e.operadorBruto = String(row.descFuncionario || '');
        e.operador = nomeOperador(row.descFuncionario);
      }
      e.velocidade = num(row.vlVelocidade);
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

  function dentroDoEscopo(e) {
    if (String(e.ativo || 'T') === 'F') return false;
    if (e.atraso !== null && e.atraso !== undefined && e.atraso > cfg.maxAtrasoMin * 60) return false;
    if (cfg.seguirSelecaoMapa && ctx.selecao && ctx.selecao.size) {
      if (!ctx.selecao.has(String(e.id)) && !ctx.selecao.has(String(e.numero))) return false;
    }
    if (cfg.frentes && cfg.frentes.length) {
      if (!cfg.frentes.some((f) => norm(f) === norm(e.frente))) return false;
    }
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
      if (cfg.calcularLocal) {
        const t = await chamar(rotaTelemetria());
        if (Array.isArray(t)) {
          aplicarTelemetria(t);
          pegou = true;
        }
      }
      // rodízio: o stream já traz o alarme na hora; o espelho varre a cada 3 ciclos
      if (cfg.espelharServidor && nCiclo % 3 === 1) {
        const a = await chamar(rotaAlarmes()).catch(() => null);
        if (Array.isArray(a)) {
          espelharAlarmes(a);
          pegou = true;
        }
      }
      if (cfg.espelharServidor && nCiclo % 3 === 2) {
        const d = await chamar(rotaTempos()).catch(() => null);
        if (Array.isArray(d)) aplicarTempos(d);
      }
      estado.erros = 0;
      estado.backoff = 0;
      estado.ultimoCiclo = ts;
      estado.fonte = pegou ? (cfg.calcularLocal ? 'telemetria + portal' : 'portal') : 'sem dados';
      avaliarFrota(ts, 'lotes');
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
    for (const t of itens || []) {
      const id = String(t.cdEquipamento || '');
      const regra = MAPA_ALARME[t.cdTpAlarme];
      if (!id || !regra) continue;
      const st = estados.get(id + '|' + regra) || marcar(id, regra, true, agora(), null);
      const m = String(t.tempo || '').match(/(\d{1,3}):(\d{2}):(\d{2})/);
      if (m) st.duracaoServidor = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
  }

  /* ------------------------------------------------------------------ */
  /* as 4 regras pedidas                                                */
  /* ------------------------------------------------------------------ */

  /* modo='lotes' (depois de uma leitura nova) avalia tudo;
     modo='tempo' (relógio de 1 s) só as regras de duração — é o tempo que muda entre leituras. */
  function avaliarFrota(ts, modo) {
    const lotes = modo !== 'tempo';
    let cont = 0;
    for (const e of frota.values()) {
      if (!dentroDoEscopo(e)) continue;
      cont++;
      if (lotes) {
        regraVelocidade(e, ts);
        regraRpm(e, ts);
      }
      regraTurno(e, ts);
      regraOcioso(e, ts);
    }
    estado.monitorados = cont;
  }

  function regraVelocidade(e, ts) {
    if (!cfg.calcularLocal || e.velocidade === null) return;
    const canav = num(cfg.limiteVelocidadeCanavieiro);
    const ehCanavieiro = /caminhao|canavieiro/.test(norm(e.tipo) + ' ' + norm(e.frente));
    const limite = canav > 0 && ehCanavieiro ? canav : num(cfg.limiteVelocidade);
    if (limite <= 0) return;
    const st = marcar(e.id, 'velocidade', e.velocidade >= limite, ts, e.velocidade);
    if (!podeDisparar(st, ts)) return;
    const v = Math.round(e.velocidade);
    emitir({
      chave: st.chave,
      regra: 'velocidade',
      e,
      valor: v,
      limite: Math.round(limite),
      texto: `excedeu a velocidade: ${v} km/h, limite ${Math.round(limite)} km/h`,
      detalhe: `${e.nome} · ${e.frente || 'sem frente'} · operação ${e.operacao || '—'} · estado ${e.estadoTxt || '—'}`,
      inicio: st.since,
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
    const st = marcar(e.id, 'ocioso', liga, ts, e.rpm);
    if (!st.firing) return;
    const min = Math.max(1, num(cfg.minutosOcioso) || 5);
    const durou = (ts - inicioReal(st, e)) / 60000;
    if (durou < min) return;
    if (!podeDisparar(st, ts)) return;
    emitir({
      chave: st.chave,
      regra: 'ocioso',
      e,
      valor: Math.round(durou),
      limite: Math.round(min),
      texto: `com motor ocioso há ${minutosTxt(durou)} (${milhar(e.rpm || 0)} RPM parado)`,
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
    for (const a of itens || []) {
      if (a.fgOnline === false) continue;
      let regra = MAPA_ALARME[a.cdTpAlarme];
      if (!regra) {
        if (!cfg.incluirOutros) continue;
        regra = 'generico';
      }
      emitirAlarmeOficial(a, regra, 'portal');
    }
  }

  function emitirAlarmeOficial(a, regra, via) {
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
    if (!dentroDoEscopo(e)) return;

    const chave = id + '|' + regra;
    const st = estados.get(chave) || marcar(id, regra, true, agora(), null);
    if (!st.firing) {
      st.firing = true;
      if (!st.since) st.since = agora();
      st.consec = 1;
    } else {
      st.consec = Math.max(1, st.consec);
    }
    if (!podeDisparar(st, agora())) return;

    const valor = a.vlAlarme != null ? a.vlAlarme : a.vlAlarmeMaximoAtingido;
    const nomeAlarme = a.descTpAlarme || a.descAlarme || '';
    let texto;
    if (regra === 'velocidade') {
      texto = valor ? `velocidade excedida (${Math.round(num(valor))} km/h, alarme oficial do portal)` : 'velocidade excedida (alarme oficial do portal)';
    } else if (regra === 'rpm') {
      texto = valor ? `RPM máxima do motor (${milhar(num(valor))} RPM, alarme oficial do portal)` : 'RPM máxima do motor (alarme oficial do portal)';
    } else if (regra === 'turno') {
      texto = 'tempo excedido em troca de turno (alarme oficial do portal)';
    } else if (regra === 'ocioso') {
      texto = 'motor ocioso (alarme oficial do portal)';
    } else {
      texto = `alarme ${nomeAlarme || 'não classificado'} (portal)`;
    }
    emitir({
      chave,
      regra,
      e,
      valor: num(valor) || null,
      texto,
      detalhe: `Alarme oficial · tipo ${a.cdTpAlarme || '—'} ${nomeAlarme} · via ${via} · operação ${e.operacao || '—'}${a.cdId ? ' · código ' + a.cdId : ''}`,
      inicio: dataArray(a.dtHrLocal) || (typeof a.dtHrLocal === 'number' ? a.dtHrLocal : agora()),
      servidor: true,
    });
  }

  /* ------------------------------------------------------------------ */
  /* emissão: pop-up, som, voz, histórico                               */
  /* ------------------------------------------------------------------ */

  function emitir(a) {
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
      nome: regra.nome,
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
      limite: a.limite == null ? null : a.limite,
      texto: a.texto,
      detalhe: a.detalhe || '',
      fonte: a.servidor ? 'portal' : a.simulado ? 'teste' : 'app',
      contagem: (prev && prev.contagem ? prev.contagem : 0) + 1,
      repeticao: !!prev,
    };
    alerta.fala = montarFala(alerta);
    ativos.set(chave, alerta);

    hist.unshift({
      ts,
      chave,
      regra: alerta.regra,
      equipamento: alerta.numero,
      descricao: alerta.descricao,
      operador: alerta.operador,
      valor: alerta.valor,
      texto: alerta.texto,
      detalhe: alerta.detalhe,
      fonte: alerta.fonte,
      fala: alerta.fala,
      unidade: ctx.unidade || '',
      usuario: ctx.usuario || '',
    });
    if (hist.length > MAX_HIST) hist.length = MAX_HIST;
    salvar(KEY_HIST, hist);
    registrarNoServidor(alerta);

    const silenciado = ts < (Number(cfg.silencioAte) || 0) || jaReconhecido;
    // rajada: ao abrir o app podem nascer dezenas de alertas de uma vez — só os
    // primeiros N falam; o resto entra mudo na central (histórico completo).
    if (ts - rajada.ts > 20000) rajada = { ts, voz: 0 };
    const demais = ++rajada.voz > Math.max(1, Number(cfg.maxPorCiclo) || 4);
    if (cfg.popup) mostrarToast(alerta, silenciado || demais);
    if (!silenciado && !demais) {
      if (cfg.som) tocar(regra.severidade);
      if (cfg.voz && (!alerta.repeticao || cfg.repetirVoz)) falar(alerta.fala);
      if (cfg.vibrar) vibrar(regra.severidade);
      notificar(alerta);
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
    const partes = [`${a.classe} ${String(a.numero).replace(/\D/g, '')}`];
    if (a.operador) partes.push(`operador ${a.operador}`);
    else partes.push('sem operador definido');
    const oficial = /alarme oficial/.test(String(a.texto));
    let msg = String(a.texto)
      .replace(/ ?\(alarme oficial do portal\)/gi, '')
      .replace(/\(alarme oficial do portal\)/gi, '')
      .replace(/ ?alarme oficial do portal/gi, '')
      .replace(/\(([^)]*)\)/g, '$1')
      .replace(/RPM do motor no máximo:/, 'rotação do motor no máximo:')
      .replace(/RPM máxima do motor \(/, 'rotação máxima do motor (')
      .replace(/RPM máxima do motor/, 'rotação máxima do motor')
      .replace(/km\/h/g, 'quilômetros por hora')
      .replace(/RPM/g, 'rotações por minuto')
      .replace(/—/g, ',')
      .replace(/\s{2,}/g, ' ')
      .trim();
    partes.push(msg.replace(/,\s*(?=,|$)/g, '').replace(/\s{2,}/g, ' ').trim());
    if (oficial) partes.push('conforme o alarme oficial do portal');
    return partes.join(', ').replace(/,\s*$/, '') + '. Verificar.';
  }

  /* --------------------------- voz (TTS) --------------------------- */

  let rajada = { ts: 0, voz: 0, aviso: false };
  let fila = [];
  let falando = false;
  let vozEscolhida = null;

  const sintetizador = () => (typeof window !== 'undefined' ? window.speechSynthesis : null);

  function ponteNativa() {
    // O WebView do Android não implementa speechSynthesis: usamos a ponte Java do APK
    const p = window.AndroidTTS;
    return p && typeof p.falar === 'function' ? p : null;
  }

  function escolherVoz() {
    const s = sintetizador();
    if (!s) return;
    const vozes = s.getVoices() || [];
    if (!vozes.length) return;
    let v = cfg.vozNome ? vozes.find((x) => x.name === cfg.vozNome) : null;
    if (!v) v = vozes.find((x) => /pt[-_]br/i.test(x.lang));
    if (!v) v = vozes.find((x) => /^pt/i.test(x.lang));
    if (!v) v = vozes.find((x) => /brazil|brasil/i.test(x.name));
    vozEscolhida = v || null;
  }

  function falar(texto) {
    if (!cfg.voz) return;
    fila.push(String(texto));
    if (fila.length > 8) fila.shift();
    descargarFila();
  }

  function descargarFila() {
    if (falando || !fila.length) return;
    const texto = fila.shift();
    const nativa = ponteNativa();
    if (nativa) {
      falando = true;
      try {
        nativa.falar(texto, Number(cfg.volume) || 1, Number(cfg.taxa) || 1);
      } catch {
        /* segue sem voz */
      }
      setTimeout(() => {
        falando = false;
        descargarFila();
      }, Math.min(20000, 900 + texto.length * 65));
      return;
    }
    const s = sintetizador();
    if (!s) {
      tocar(3);
      return;
    }
    escolherVoz();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = (vozEscolhida && vozEscolhida.lang) || 'pt-BR';
    if (vozEscolhida) u.voice = vozEscolhida;
    u.volume = Math.max(0, Math.min(1, Number(cfg.volume)));
    u.rate = Math.max(0.5, Math.min(2, Number(cfg.taxa)));
    u.pitch = Math.max(0.5, Math.min(2, Number(cfg.tom)));
    u.onend = u.onerror = () => {
      falando = false;
      setTimeout(descargarFila, 200);
    };
    falando = true;
    try {
      s.speak(u);
      setTimeout(() => {
        if (falando && !s.speaking && !s.pending) {
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
  if (typeof window !== 'undefined') {
    const marcarToque = () => { toquei = true; };
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

  function notificar(a) {
    if (!cfg.notificacao || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification(`${a.classe} ${a.numero} — ${a.nome}`, {
        body: a.texto + (a.operador ? ' · ' + a.operador : ''),
        tag: a.chave,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        requireInteraction: a.severidade >= 3,
        renotify: true,
      });
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
        <button id="btn-cfg" class="icone" title="Regras e limiares">⚙️</button>
      </div>
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

<div id="cfg-alertas" class="hide">
  <div class="card cfg">
    <img class="marca" src="/icons/logo-mark.png" alt="" width="44" height="44" />
    <h2>Regras de alerta</h2>
    <p class="fine">Salvas neste aparelho. O app lê a telemetria oficial do portal e aplica estes limites; a central continua funcionando mesmo se o alerta oficial atrasar.</p>
    <div class="grade">
      <label class="campo"><span>Velocidade (km/h)</span><input id="cfg-vel" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>RPM máxima do motor</span><input id="cfg-rpm" type="number" min="0" step="10" inputmode="numeric"></label>
      <label class="campo"><span>Motor ocioso (min)</span><input id="cfg-ocioso" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Troca de turno (min)</span><input id="cfg-turno" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Repetir o mesmo alerta a cada (min)</span><input id="cfg-cooldown" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Máx. de alertas falados por ciclo</span><input id="cfg-maxvoz" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Intervalo de leitura (s)</span><input id="cfg-int" type="number" min="30" step="5" inputmode="numeric"></label>
      <label class="campo"><span>Leituras p/ confirmar</span><input id="cfg-amostras" type="number" min="1" max="5" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Ignorar sem sinal há (min)</span><input id="cfg-atraso" type="number" min="1" step="1" inputmode="numeric"></label>
      <label class="campo"><span>Velocidade canavieiro (0 = off)</span><input id="cfg-velcan" type="number" min="0" step="1" inputmode="numeric"></label>
      <label class="campo"><span>RPM abaixo disto é ocioso</span><input id="cfg-rpmoci" type="number" min="0" step="10" inputmode="numeric"></label>
    </div>
    <label class="campo"><span>Só estes equipamentos (separados por espaço ou vírgula; vazio = todos)</span>
      <input id="cfg-eq" type="text" placeholder="ex.: 8833 4462 74073" spellcheck="false" autocomplete="off"></label>
    <p class="rotulo">Frentes / grupos monitorados</p>
    <div id="cfg-frentes" class="chips"></div>
    <div class="switches">
      <label class="chk"><input id="cfg-liga" type="checkbox"><span>Central de alertas ligada</span></label>
      <label class="chk"><input id="cfg-local" type="checkbox"><span>Calcular as regras no app (cobre a falha do portal)</span></label>
      <label class="chk"><input id="cfg-serv" type="checkbox"><span>Espelhar os alarmes oficiais do portal</span></label>
      <label class="chk"><input id="cfg-outros" type="checkbox"><span>Avisar também os alarmes oficiais de outros tipos</span></label>
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
    <div class="row">
      <button id="cfg-salvar" class="primary">Salvar regras</button>
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
      contAtivos: $('cont-ativos'),
      contHist: $('cont-hist'),
      dot: $('dot-ciclo'),
      toasts: $('toasts'),
      cfg: $('cfg-alertas'),
      sino: $('btn-alertas'),
      badge: $('alert-badge'),
    };

    const p = el.painel;
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
    $('cfg-salvar').onclick = lerConfig;
    $('cfg-teste2').onclick = () =>
      falar('Veículo 8833, operador Rafael, excedeu a velocidade, 62 quilômetros por hora, limite 51. Verificar.');
    el.cfg.addEventListener('click', (ev) => {
      if (ev.target === el.cfg) fecharConfig();
    });
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
    if (el.badge) {
      el.badge.textContent = n ? String(n) : '';
      el.badge.classList.toggle('hide', !n);
    }
    if (el.sino) el.sino.classList.toggle('alertando', n > 0);
    const s = Math.max(0, Math.round((proximo - agora()) / 1000));
    if (el.proximo) el.proximo.textContent = estado.ligado ? `próxima leitura em ${s}s` : 'central desligada';
    if (el.status) {
      el.status.textContent = `${n} ativo${n === 1 ? '' : 's'} · ${estado.monitorados} equipamentos vigiados`;
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
        ${a.fonte === 'portal' ? '<span class="a-chip oficial">portal</span>' : ''}
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

  function renderAtivos() {
    if (!el.ativos) return;
    const lista = [...ativos.values()].sort((x, y) => y.severidade - x.severidade || y.ts - x.ts);
    el.ativos.innerHTML = '';
    if (!lista.length) {
      el.ativos.innerHTML =
        '<div class="vazio">Nenhum alerta ativo agora.<br><span class="fine">A central continua lendo o portal a cada ' +
        cfg.intervaloSeg + 's e os eventos do mapa em tempo real.</span></div>';
    }
    for (const a of lista) el.ativos.appendChild(card(a, true));
    el.contAtivos.textContent = String(lista.length);
    el.contHist.textContent = String(hist.length);

    if (el.historico && !el.historico.classList.contains('hide')) {
      el.historico.innerHTML = '';
      if (!hist.length) el.historico.innerHTML = '<div class="vazio">Sem histórico neste aparelho.</div>';
      for (const h of hist.slice(0, 150)) {
        const r = REGRAS[h.regra] || REGRAS.generico;
        const d = document.createElement('div');
        d.className = 'alerta menor';
        d.style.setProperty('--cor', r.cor);
        d.innerHTML =
          `<div class="a-top"><span class="a-icone">${r.icone}</span><strong class="a-eq">${esc(h.equipamento)}</strong>` +
          `<span class="a-chip">${esc(r.nome)}</span><span class="a-hora">${hora(h.ts)}</span></div>` +
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
    const t = setTimeout(() => fecharCard(d), (a.severidade >= 3 ? 26 : 18) * 1000);
    d.addEventListener('mouseenter', () => {
      clearTimeout(t);
      barra.style.animationPlayState = 'paused';
    });
    d.addEventListener('mouseleave', () => {
      setTimeout(() => fecharCard(d), 4000);
    });
  }

  function mostrarAviso(txt, tipo) {
    if (!el.toasts) return;
    const d = document.createElement('div');
    d.className = 'aviso ' + (tipo || '');
    d.textContent = txt;
    el.toasts.appendChild(d);
    setTimeout(() => fecharCard(d), 4200);
  }

  /* "ver no mapa": o micro-frontend só aceita 'props'; rastroBI.equipment faz flyTo + popup */
  function abrirNoMapa(a) {
    const id = String((a.e && a.e.id) || a.numero || '');
    if (!id) return;
    const iframe = $('map');
    if (iframe && iframe.contentWindow && ctx.mapUrl && ctx.props) {
      const props = JSON.parse(JSON.stringify(ctx.props));
      props.rastroBI = { equipment: isNaN(Number(id)) ? id : Number(id) };
      try {
        iframe.contentWindow.postMessage({ type: 'props', data: props }, ctx.mapUrl);
        mostrarAviso(`Centralizando ${a.classe || ''} ${a.numero} no mapa.`, 'info');
        return;
      } catch {
        /* segue para o portal */
      }
    }
    const url = (ctx.portalMap || 'https://branco-peres-cana.saas-solinftec.com/#!/details/analytic-map-v4') +
      '?equipment=' + encodeURIComponent(id);
    window.open(url, '_blank', 'noopener');
  }

  /* ------------------------------ config ------------------------------ */

  function abrirConfig() {
    if (!el.cfg) montar();
    renderConfig();
    el.cfg.classList.remove('hide');
  }
  function fecharConfig() {
    el.cfg.classList.add('hide');
  }

  function preencherVozes() {
    const sel = $('cfg-vozel');
    if (!sel) return;
    const s = sintetizador();
    const vozes = s ? s.getVoices() || [] : [];
    sel.innerHTML = '';
    const add = (v, t) => {
      const o = document.createElement('option');
      o.value = v || '';
      o.textContent = t;
      sel.appendChild(o);
    };
    if (ponteNativa()) add('__nativa__', 'Voz do aparelho (Android)');
    if (!vozes.length) {
      add('', 'voz padrão do navegador');
      return;
    }
    const pt = vozes.filter((v) => /^pt/i.test(v.lang));
    const outras = vozes.filter((v) => !/^pt/i.test(v.lang));
    for (const v of [...pt, ...outras]) add(v.name, `${v.name} (${v.lang})`);
    sel.value = cfg.vozNome || '';
  }

  function renderConfig() {
    if (!$('cfg-vel')) return;
    const valores = {
      'cfg-vel': cfg.limiteVelocidade,
      'cfg-rpm': cfg.limiteRpm,
      'cfg-ocioso': cfg.minutosOcioso,
      'cfg-turno': cfg.minutosTurno,
      'cfg-cooldown': cfg.cooldownMin,
      'cfg-maxvoz': cfg.maxPorCiclo,
      'cfg-int': cfg.intervaloSeg,
      'cfg-amostras': cfg.amostras,
      'cfg-atraso': cfg.maxAtrasoMin,
      'cfg-velcan': cfg.limiteVelocidadeCanavieiro,
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
      'cfg-outros': cfg.incluirOutros,
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
    preencherVozes();

    const box = $('cfg-frentes');
    box.innerHTML = '';
    const lista = (estado.frentes || []).slice(0, 60);
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
      incluirOutros: $('cfg-outros').checked,
      usarStream: $('cfg-stream').checked,
      seguirSelecaoMapa: $('cfg-mapa').checked,
      popup: $('cfg-popup').checked,
      som: $('cfg-som').checked,
      voz: $('cfg-voz').checked,
      notificacao: $('cfg-notif').checked,
      vibrar: $('cfg-vib').checked,
      repetirVoz: $('cfg-repete').checked,
      limiteVelocidade: n('cfg-vel', 51),
      limiteRpm: n('cfg-rpm', 1600),
      minutosOcioso: n('cfg-ocioso', 5),
      minutosTurno: n('cfg-turno', 4),
      cooldownMin: n('cfg-cooldown', 10),
      maxPorCiclo: n('cfg-maxvoz', 4),
      intervaloSeg: n('cfg-int', 45),
      amostras: n('cfg-amostras', 1),
      maxAtrasoMin: n('cfg-atraso', 20),
      limiteVelocidadeCanavieiro: n('cfg-velcan', 0),
      rpmOcioso: n('cfg-rpmoci', 900),
      equipamentos: $('cfg-eq').value,
      volume: n('cfg-vol', 1),
      taxa: n('cfg-taxa', 1),
      tom: n('cfg-tom', 1),
      silencioAte: 0,
    };
    const sel = $('cfg-vozel');
    if (sel) patch.vozNome = sel.value === '__nativa__' ? '' : sel.value;
    configurar(patch);
    if (patch.notificacao && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        Notification.requestPermission();
      } catch {
        /* o usuário autoriza depois */
      }
    }
    fecharConfig();
    mostrarAviso('Regras salvas. ' + (patch.ativo ? 'Central ligada.' : 'Central desligada.'), 'info');
    cicloImediato();
  }

  function exportarCsv() {
    const cab = ['quando', 'tipo', 'equipamento', 'descricao', 'operador', 'valor', 'mensagem', 'fonte', 'detalhe', 'fala'];
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
    const e = mesclar('8833');
    Object.assign(e, {
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
    });
    emitir({
      chave: 'TESTE|velocidade',
      regra: 'velocidade',
      e,
      valor: 62,
      texto: `excedeu a velocidade: 62 km/h, limite ${cfg.limiteVelocidade} km/h`,
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
        ctx.selecao.add(id);
        if (ctx.selecao.size > 30) ctx.selecao.delete(ctx.selecao.values().next().value);
        if (cfg.seguirSelecaoMapa) cicloImediato();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* configuração pública e ciclo de vida                               */
  /* ------------------------------------------------------------------ */

  function configurar(patch) {
    cfg = Object.assign({}, cfg, patch || {});
    if (cfg.intervaloSeg < 30) cfg.intervaloSeg = 30;
    if (cfg.amostras < 1) cfg.amostras = 1;
    salvar(KEY_CFG, cfg);
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
    if (!ctx.selecao) ctx.selecao = new Set();
    if (!el.painel) montar();
    if (!iniciar.escutou) {
      iniciar.escutou = true;
      escutarMapa();
      const s = sintetizador();
      if (s) {
        escolherVoz();
        s.onvoiceschanged = escolherVoz;
      }
      setInterval(tique, 1000);
      setInterval(() => {
        // watchdog do stream: sem quadro há 3 min, reconecta
        if (cfg.usarStream && cfg.ativo && worker && ultimoQuadro && agora() - ultimoQuadro > 180000) abrirStream();
      }, 20000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && cfg.ativo) {
          escolherVoz();
          if (agora() - (estado.ultimoCiclo || 0) > cfg.intervaloSeg * 1000 + 5000) cicloImediato();
        }
      });
    }
    configurar({});
    abrirStream();
    cicloImediato();
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
    if (!sess || !sess.props || !cfg.ativo) return;
    const mudou = sess.props.token !== ctx.token;
    ctx = Object.assign({}, ctx, contextoDa(sess));
    if (mudou && cfg.usarStream) abrirStream();
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
