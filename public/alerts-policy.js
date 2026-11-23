(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlertasPolicy = factory();
  }
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis), function () {
  'use strict';

  var CATEGORIAS = ['velocidade', 'rpm', 'ocioso', 'turno', 'motorCondicao', 'generico', 'aguardandoCaminhao', 'semApontamento', 'refeicao', 'paradaImprodutiva'];
  var DEFAULTS = {
    velocidade: true,
    rpm: true,
    ocioso: true,
    turno: true,
    motorCondicao: true,
    generico: true,
    aguardandoCaminhao: true,
    semApontamento: true,
    refeicao: true,
    paradaImprodutiva: true
  };
  var NUMEROS_FALADOS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'];
  // Expansões confirmadas pelo usuário no DOCX de 23/11/2026. Os códigos sem
  // entrada aqui continuam sendo falados com o nome recebido do SGPA.
  var FALAS_SGPA = {
    '12600': { texto: 'velocidade excedida na usina', referenciaKmH: 23, medirVelocidade: true },
    '12744': { texto: 'sem apontamento' },
    '10700': { texto: 'abastecimento de insumo com motor ligado' },
    '10820': { texto: 'controle de velocidade do equipamento', medirVelocidade: true },
    '10840': { texto: 'abastecimento de insumo com tempo excedido' },
    '10860': { texto: 'aguardando colheitadeira indevidamente' },
    '11304': { texto: 'frente de pátio indevida no transbordo' },
    '11340': { texto: 'sem operador trabalhando' },
    '11400': { texto: 'velocidade excedida na oficina', referenciaKmH: 50, medirVelocidade: true },
    '11480': { texto: 'velocidade excedida na usina', referenciaKmH: 23, medirVelocidade: true },
    '12122': { texto: 'apontar o centro de custo correto' },
    '12440': { texto: 'mudar para a operação mecanizada do caminhão terceiro canavieiro' },
    '12180': { texto: 'desligar a chave geral' },
    '12080': { texto: 'forçar a balança de entrada' },
    '12724': { texto: 'alerta de velocidade', referenciaKmH: 60, medirVelocidade: true },
    '12100': { texto: 'não apontar aguardando carregamento' },
    '12200': { texto: 'apontar o centro de custo correto da pipa' },
    '3483': { texto: 'aguardando manobra do transbordo' },
    '11500': { texto: 'abastecimento de insumo: desligar o motor' },
    '12500': { texto: 'sair do apontamento de abastecimento de insumo' }
  };
  var CODIGOS = {
    motorCondicao: ['2697', '2699'],
    velocidade: ['5', '2203', '2685', '1641', '10820', '12600', '11400', '11480', '12724', 'velocidade5'],
    rpm: ['4', '6', '8'],
    ocioso: ['11', '2343', '2207'],
    turno: ['2849', '2851']
  };

  function norm(txt) {
    var value = txt == null ? '' : String(txt);
    if (typeof value.normalize === 'function') value = value.normalize('NFD');
    return value
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function codigoTokens(codigo) {
    if (Array.isArray(codigo)) {
      return codigo.reduce(function (all, item) { return all.concat(codigoTokens(item)); }, []);
    }
    if (codigo == null) return [];
    return String(codigo).trim().split(/[;,/|]+/).map(function (part) {
      return part.trim();
    }).filter(Boolean);
  }

  function categoria(codigo, descricao) {
    var tokens = codigoTokens(codigo).map(function (token) { return token.toLowerCase(); });
    var known = Object.keys(CODIGOS);
    var i;
    var j;

    // Os códigos de condição do motor são deliberadamente prioritários, inclusive em combinações.
    for (i = 0; i < known.length; i += 1) {
      if (known[i] !== 'motorCondicao') continue;
      for (j = 0; j < tokens.length; j += 1) {
        if (CODIGOS[known[i]].indexOf(tokens[j]) !== -1) return known[i];
      }
    }
    for (i = 0; i < known.length; i += 1) {
      if (known[i] === 'motorCondicao') continue;
      for (j = 0; j < tokens.length; j += 1) {
        if (CODIGOS[known[i]].indexOf(tokens[j]) !== -1) return known[i];
      }
    }

    var desc = norm(descricao);
    if (/(?:velocidade|controle_vel|alarme_vel)/.test(desc) || /\bvl\s*_?\s*60\s*km\s*\/\s*h\b/.test(desc)) {
      return 'velocidade';
    }
    return 'generico';
  }

  function idFalado(id) {
    if (id == null) return '';
    var source = String(id).trim();
    if (!source) return '';

    // Mantém letras e separadores originais, mas converte cada algarismo isoladamente,
    // preservando zeros à esquerda e IDs que misturam letras e números.
    var result = '';
    var previousWasDigit = false;
    for (var i = 0; i < source.length; i += 1) {
      var char = source.charAt(i);
      if (/\d/.test(char)) {
        if (result && !previousWasDigit && !/\s$/.test(result)) result += ' ';
        else if (previousWasDigit) result += ' ';
        result += NUMEROS_FALADOS[Number(char)];
        previousWasDigit = true;
      } else {
        if (/\s/.test(char)) {
          result = result.replace(/\s+$/g, '') + ' ';
          previousWasDigit = false;
        } else {
          if (previousWasDigit) result += ' ';
          result += char;
          previousWasDigit = false;
        }
      }
    }
    return result.replace(/\s+/g, ' ').trim();
  }

  function aguardandoCaminhao(e) {
    if (!e || typeof e !== 'object') return false;
    var tipo = norm([e.tipo, e.tipoCompleto].filter(function (v) { return v != null; }).join(' '));
    if (!/(?:^|[^a-z0-9])(?:trator|transbordo)(?:$|[^a-z0-9])/.test(tipo)) return false;

    var operacao = e.operacao == null ? '' : String(e.operacao);
    // Código 905 = Aguardando Caminhão no SGPA da unidade.
    if (String(e.cdOperacao == null ? '' : e.cdOperacao).trim() === '905' || /^\s*905\s*-/.test(operacao)) return true;
    operacao = operacao.replace(/^\s*\d+\s*-\s*/, '');
    var normalized = norm(operacao);
    return /^aguardando caminhao\b/.test(normalized);
  }

  function semApontamento(e) {
    if (!e || typeof e !== 'object') return false;
    var operacao = e.operacao;
    if (operacao == null || String(operacao).trim() === '') operacao = e.descOperacao;
    var normalized = norm(operacao)
      .replace(/^\d+\s*-\s*/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /^(?:sem apontamento(?: (?:tpl|cct))?|digitar op vl)$/.test(normalized);
  }

  /* Paradas improdutivas de maior impacto (ranking SGPA 23/10–22/11/2026). */
  var PARADAS = [
    { id: 'agColhedoraParadaRapida', nome: 'AG colhedora parada rápida (983)', min: 10, codigo: '983', re: /^ag(?:uardando|uard)? colhedora parada rapida/ },
    { id: 'faltaTransbordo', nome: 'Falta de transbordo (colhedora)', min: 1, re: /^falta (?:de )?transbordo/ },
    { id: 'aguardManobraTransbordo', nome: 'Aguardando manobra de transbordo', min: 5, re: /^ag(?:uardando|uard)? manobra (?:de )?transbordo/ },
    { id: 'filaUnica', nome: 'Fila única (transbordo)', min: 20, re: /^fila unica/ },
    { id: 'aguardandoCarregamento', nome: 'Aguardando carregamento (caminhão)', min: 30, re: /^ag(?:uardando|uard)? carreg/ },
    { id: 'agSequencTrabalho', nome: 'Ag. sequência de trabalho', min: 20, re: /^ag(?:uardando|uard)? sequenc/ },
    { id: 'aguardLiberarTrafego', nome: 'Aguardando liberar tráfego', min: 20, re: /^ag(?:uardando|uard)? liberar trafego/ },
    { id: 'aguardandoColhedoraAlocada', nome: 'Aguardando colhedora alocada', min: 15, re: /^ag(?:uardando|uard)? colhedora alocada/ },
    { id: 'aguardReboqueCaminhao', nome: 'Aguardando reboque do caminhão', min: 15, re: /^ag(?:uardando|uard)? reboque caminhao/ },
    { id: 'aguardBasculamento', nome: 'Aguardando basculamento', min: 15, re: /^ag(?:uardando|uard)? bascul/ },
    { id: 'equipamentoEncalhado', nome: 'Equipamento encalhado', min: 10, re: /^equipamento encalhado/ },
    { id: 'faltaOperador', nome: 'Falta operador', min: 5, re: /^falta (?:de )?operador/ },
    { id: 'paradaIndustrial', nome: 'Parada industrial (911)', min: 30, codigo: '911', re: /^parada industrial/ }
  ];
  function paradaImprodutiva(e) {
    if (!e || typeof e !== 'object') return null;
    var operacao = e.operacao;
    if (operacao == null || String(operacao).trim() === '') operacao = e.descOperacao;
    var bruto = operacao == null ? '' : String(operacao);
    var cod = String(e.cdOperacao == null ? '' : e.cdOperacao).trim();
    var m = /^\s*(\d+)\s*-/.exec(bruto);
    if (!cod && m) cod = m[1];
    var t = norm(bruto).replace(/^\d+\s*-\s*/, '').replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (var i = 0; i < PARADAS.length; i += 1) {
      var p = PARADAS[i];
      if ((p.codigo && cod === p.codigo) || p.re.test(t)) return p;
    }
    return null;
  }
  function limiteParada(cfg, p) {
    var mapa = cfg && cfg.paradasLimites && typeof cfg.paradasLimites === 'object' ? cfg.paradasLimites : {};
    var v = Object.prototype.hasOwnProperty.call(mapa, p.id) ? Number(mapa[p.id]) : p.min;
    return Number.isFinite(v) && v >= 0 ? v : p.min;
  }
  /* Operação SGPA de refeição (ex.: “REFEIÇÃO”, “REFEIÇÃO (1 HORA)”, “REFEIÇÃO_TPL”). */
  function emRefeicao(e) {
    if (!e || typeof e !== 'object') return false;
    var operacao = e.operacao;
    if (operacao == null || String(operacao).trim() === '') operacao = e.descOperacao;
    return /\b(?:refeicao|almoco|jantar)/.test(norm(operacao).replace(/[_-]+/g, ' '));
  }
  /* Limite em minutos: equipamento prevalece sobre grupo; 0 = não controlado. */
  function mapaEquipamentos(texto) {
    var out = {};
    String(texto || '').split(/[\n,;]+/).forEach(function (parte) {
      var m = parte.trim().match(/^([^=:\s]+)\s*[=:]\s*(\d+)\s*$/);
      if (m) out[norm(m[1])] = Math.max(0, Number(m[2]));
    });
    return out;
  }
  function limiteRefeicao(cfg, e) {
    if (!cfg || !e) return 0;
    var eq = mapaEquipamentos(cfg.refeicaoEquipamentos);
    var ids = [e.numero, e.id].filter(function (v) { return v != null && String(v).trim() !== ''; });
    for (var i = 0; i < ids.length; i += 1) {
      var k = norm(ids[i]);
      if (Object.prototype.hasOwnProperty.call(eq, k)) return eq[k];
      var semZeros = k.replace(/^0+(?=\d)/, '');
      if (Object.prototype.hasOwnProperty.call(eq, semZeros)) return eq[semZeros];
    }
    var grupos = isObject(cfg.refeicaoGrupos) ? cfg.refeicaoGrupos : {};
    var frente = norm(e.frente);
    for (var g in grupos) {
      if (Object.prototype.hasOwnProperty.call(grupos, g) && norm(g) === frente) return Math.max(0, Number(grupos[g]) || 0);
    }
    return 0;
  }
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeCfg(cfg) {
    var source = isObject(cfg) ? cfg : {};
    var suppliedCategories = isObject(source.notificarCategorias) ? source.notificarCategorias : {};
    var categories = Object.assign({}, DEFAULTS, suppliedCategories);
    if (source.incluirOutros === false && !Object.prototype.hasOwnProperty.call(suppliedCategories, 'generico')) {
      categories.generico = false;
    }

    return Object.assign({}, source, {
      notificarCategorias: categories,
      tiposNotificacao: isObject(source.tiposNotificacao) ? Object.assign({}, source.tiposNotificacao) : {}
    });
  }

  function categoryFromAlert(alert) {
    if (!isObject(alert)) return 'generico';
    var direct = alert.regra || alert.categoria;
    if (direct != null) {
      var directText = String(direct);
      if (CATEGORIAS.indexOf(directText) !== -1) return directText;
      var compact = norm(directText).replace(/[\s_-]+/g, '');
      var aliases = {
        velocidade: 'velocidade', rpm: 'rpm', ocioso: 'ocioso', turno: 'turno',
        motorcondicao: 'motorCondicao', generico: 'generico', aguardandocaminhao: 'aguardandoCaminhao', semapontamento: 'semApontamento', refeicao: 'refeicao', paradaimprodutiva: 'paradaImprodutiva',
        ociososemapontamento: 'ocioso'
      };
      if (aliases[compact]) return aliases[compact];
    }
    var code = alert.tipoAlarme || alert.codigo;
    if (code == null || String(code).trim() === '') code = alert.codigoAlerta;
    if (code == null || String(code).trim() === '') code = alert.idTipo;
    var description = alert.descricao;
    if (description == null || String(description).trim() === '') description = alert.texto;
    return categoria(code, description);
  }

  function codeFromAlert(alert) {
    if (!isObject(alert)) return '';
    var event = eventFor(alert);
    var candidates = [alert.tipoAlarme, alert.codigo, alert.codigoAlerta, alert.idTipo, event && event.codigo, event && event.codigoAlerta, event && event.idTipo];
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i] != null && String(candidates[i]).trim() !== '') return String(candidates[i]).trim();
    }
    return '';
  }

  function notificar(cfg, alert) {
    var normalized = normalizeCfg(cfg);
    var item = isObject(alert) ? alert : {};
    var selectedCategory = !item.regra && !item.categoria && !codeFromAlert(item) && aguardandoCaminhao(eventFor(item)) ? 'aguardandoCaminhao' : categoryFromAlert(item);
    var enabledByCategory = normalized.notificarCategorias[selectedCategory] !== false;
    var code = codeFromAlert(item);
    var enabledByType = !code || normalized.tiposNotificacao[code] !== false;
    var selectedIndividually = !!code &&
      Object.prototype.hasOwnProperty.call(normalized.tiposNotificacao, code) &&
      normalized.tiposNotificacao[code] === true;
    return enabledByType && (enabledByCategory || selectedIndividually);
  }

  function vehicleNumber(alert, event) {
    var number = alert && alert.numero;
    if ((number == null || String(number).trim() === '') && event) number = event.numero;
    return idFalado(number) || 'não informado';
  }

  function eventFor(alert) {
    return alert && isObject(alert.e) ? alert.e : alert;
  }

  function numericAlertValue(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string') {
      var text = value.trim();
      if (!text || /^(?:null|undefined|nan|n\/a|na|n\/d|s\/i|--?|none|sem valor|nao informado|indisponivel)$/i.test(norm(text))) return null;
      value = text.replace(',', '.');
    }
    var numeric;
    try {
      numeric = Number(value);
    } catch (error) {
      return null;
    }
    return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : null;
  }

  function cleanMessage(text) {
    if (text == null) return '';
    return String(text)
      .replace(/\s*\(alarme oficial do portal\)/gi, '')
      .replace(/\balarme\s+oficial\s+do\s+portal\b/gi, '')
      .replace(/\balarme\s+oficial\b/gi, '')
      .replace(/^[\s,:;.-]+/g, '')
      .replace(/\brpm\b/gi, 'rotações por minuto')
      .replace(/\bkm\s*\/\s*h\b/gi, 'quilômetros por hora')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;!?])/g, '$1')
      .trim()
      .replace(/[.!?]+$/g, '')
      .trim();
  }

  function montarFala(alert) {
    var item = isObject(alert) ? alert : {};
    var event = eventFor(item);
    var selectedCategory = categoryFromAlert(item);

    if (selectedCategory === 'aguardandoCaminhao' || (!item.regra && !item.categoria && !codeFromAlert(item) && aguardandoCaminhao(event))) {
      var front = event.frente;
      if (front == null || String(front).trim() === '') front = 'frente não informada';
      return 'Trator ' + vehicleNumber(item, event) + ' aguardando caminhão. Frente/grupo ' + String(front).trim() + '. Verificar.';
    }

    if (selectedCategory === 'refeicao') {
      var fr = event.frente;
      if (fr == null || String(fr).trim() === '') fr = 'frente não informada';
      var vc = item.classe == null || String(item.classe).trim() === '' ? 'Veículo' : String(item.classe).trim();
      var dur = numericAlertValue(item.valor);
      var lim = numericAlertValue(item.limite);
      return vc + ' ' + vehicleNumber(item, event) + ' excedeu o tempo de refeição' +
        (dur ? ': ' + String(dur) + ' minutos' : '') +
        (lim ? ', limite de ' + String(lim) + ' minutos' : '') +
        '. Frente/grupo ' + String(fr).trim() + '. Verificar.';
    }
    if (selectedCategory === 'paradaImprodutiva') {
      var fp = event.frente;
      if (fp == null || String(fp).trim() === '') fp = 'frente não informada';
      var cp = item.classe == null || String(item.classe).trim() === '' ? 'Veículo' : String(item.classe).trim();
      var mp = numericAlertValue(item.valor);
      return cp + ' ' + vehicleNumber(item, event) + ' em ' + String(item.paradaNome || 'parada improdutiva').replace(/\s*\(\d+\)/, '') +
        (mp ? ' há ' + String(mp) + (mp === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(fp).trim() + '. Verificar.';
    }
    if (selectedCategory === 'semApontamento') {
      var frente = event.frente;
      if (frente == null || String(frente).trim() === '') frente = 'frente não informada';
      var vClass = item.classe == null || String(item.classe).trim() === '' ? 'Veículo' : String(item.classe).trim();
      var minutos = numericAlertValue(item.valor);
      return vClass + ' ' + vehicleNumber(item, event) + ' sem apontamento' +
        (minutos ? ' há ' + String(minutos) + (minutos === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(frente).trim() + '. Verificar.';
    }
    var identification = vehicleNumber(item, event);
    var vehicleClass = item.classe == null || String(item.classe).trim() === '' ? 'Veículo' : String(item.classe).trim();
    var aprovada = FALAS_SGPA[codeFromAlert(item)];
    if (aprovada) {
      var complemento = '';
      if (aprovada.referenciaKmH != null) {
        complemento += ', referência de ' + String(aprovada.referenciaKmH) + ' quilômetros por hora';
      }
      var velocidadeMedida = aprovada.medirVelocidade ? numericAlertValue(item.valor) : null;
      if (velocidadeMedida !== null) {
        complemento += ', velocidade medida de ' + String(velocidadeMedida) + ' quilômetros por hora';
      }
      return vehicleClass + ' ' + identification + ': ' + aprovada.texto + complemento + '. Verificar.';
    }

    if (selectedCategory === 'velocidade') {
      var speed = numericAlertValue(item.valor);
      if (speed === null) {
        return 'Veículo ' + identification + ' com alarme oficial de velocidade excedida. Verificar.';
      }
      return 'Veículo ' + identification + ' excedeu a velocidade a ' + String(speed) + ' quilômetros por hora. Verificar.';
    }

    var message = cleanMessage(item.texto);
    return vehicleClass + ' ' + identification + (message ? ': ' + message : '') + '. Verificar.';
  }

  return Object.freeze({
    norm: norm,
    categoria: categoria,
    idFalado: idFalado,
    aguardandoCaminhao: aguardandoCaminhao,
    semApontamento: semApontamento,
    emRefeicao: emRefeicao,
    PARADAS: PARADAS,
    paradaImprodutiva: paradaImprodutiva,
    limiteParada: limiteParada,
    limiteRefeicao: limiteRefeicao,
    mapaEquipamentos: mapaEquipamentos,
    normalizeCfg: normalizeCfg,
    notificar: notificar,
    montarFala: montarFala
  });
}));
