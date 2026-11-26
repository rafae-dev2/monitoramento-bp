(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlertasPolicy = factory();
  }
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis), function () {
  'use strict';

  var CATEGORIAS = ['velocidade', 'rpm', 'ocioso', 'motorCondicao', 'generico', 'aguardandoCaminhao', 'aguardandoBasculamento', 'frenteDividida', 'semApontamento', 'refeicao', 'paradaImprodutiva', 'gestaoFrente', 'emergencia', 'telemetriaMuda', 'inconsistenciaApontamento', 'riscoMoenda', 'bateVolta', 'manutencaoPreditiva', 'semOperadorTrabalhando', 'chaveGeralLigada', 'abastecimentoMotorLigado', 'microParadasCronicas'];
  var DEFAULTS = {
    velocidade: true,
    rpm: true,
    ocioso: true,
    motorCondicao: true,
    generico: true,
    aguardandoCaminhao: true,
    aguardandoBasculamento: true,
    frenteDividida: true,
    semApontamento: true,
    refeicao: true,
    paradaImprodutiva: true,
    gestaoFrente: true,
    emergencia: true,
    telemetriaMuda: true,
    inconsistenciaApontamento: true,
    riscoMoenda: true,
    bateVolta: true,
    manutencaoPreditiva: true,
    semOperadorTrabalhando: true,
    chaveGeralLigada: true,
    abastecimentoMotorLigado: true,
    microParadasCronicas: true
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
    ocioso: ['11', '2343', '2207']
  };
  var CODIGOS_TROCA_TURNO = ['2849', '2851'];

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

  function alarmeTrocaDeTurno(codigo, descricao) {
    var tokens = codigoTokens(codigo).map(function (token) { return token.toLowerCase(); });
    for (var i = 0; i < tokens.length; i += 1) {
      if (CODIGOS_TROCA_TURNO.indexOf(tokens[i]) !== -1) return true;
    }
    var desc = norm(descricao).replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    return /\btroca\s+de\s+turno\b/.test(desc);
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
    if (/\b(?:incendio|fogo|queimada|combate\s+a?\s*incendio|sinistro|emergencia\s+fogo)\b/.test(desc)) {
      return 'emergencia';
    }
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

  function tratorOuTransbordo(e) {
    if (!e || typeof e !== 'object') return false;
    var nomeGrupo = norm([e.nome, e.descEquipamento, e.grupoEquipamento, e.descGrupoEquipamento, e.frente, e.descFrente].filter(Boolean).join(' '));
    if (/\b(?:bombeir\w*|veiculos?\s+leves?|utilitari\w*|camionet\w*|caminhonet\w*|carro|automove\w*|viatura|ambulancia|pipa|comboio|munck|cacamb\w*)\b/.test(nomeGrupo)) {
      return false;
    }
    var tipo = norm([e.tipo, e.tipoCompleto].filter(function (v) { return v != null; }).join(' '));
    if (/\bbombeir/.test(tipo)) return false;
    return /(?:^|[^a-z0-9])(?:trator|transbordo)(?:$|[^a-z0-9])/.test(tipo);
  }

  function aguardandoCaminhao(e) {
    if (!tratorOuTransbordo(e)) return false;

    var operacao = e.operacao == null ? '' : String(e.operacao);
    // Código 905 = Aguardando Caminhão no SGPA da unidade.
    if (String(e.cdOperacao == null ? '' : e.cdOperacao).trim() === '905' || /^\s*905\s*-/.test(operacao)) return true;
    operacao = operacao.replace(/^\s*\d+\s*-\s*/, '');
    var normalized = norm(operacao);
    return /^aguardando caminhao(?:\s*-\s*(?:hd|hr))?$/.test(normalized);
  }

  function frenteDividida(e) {
    if (!e || e.operacaoConfirmada !== true || !tratorOuTransbordo(e)) return false;
    var operacao = e.operacao;
    if (operacao == null || String(operacao).trim() === '') operacao = e.descOperacao;
    var normalized = norm(operacao).replace(/^\s*\d+\s*-\s*/, '');
    return normalized === 'frente dividida';
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

  function caminhaoCanavieiroTerceiro(e) {
    if (!e || typeof e !== 'object') return false;
    var tipo = norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' ')).replace(/[^a-z0-9]+/g, ' ');
    var grupo = norm([e.grupoEquipamento, e.descGrupoEquipamento].filter(Boolean).join(' ')).replace(/[^a-z0-9]+/g, ' ');
    if (/cacamb|munck|bombeir/.test(tipo)) return false;
    var palavras = (tipo + ' ' + grupo).trim().split(/\s+/);
    var caminhao = palavras.indexOf('caminhao') >= 0 || palavras.indexOf('caminhoes') >= 0;
    var canavieiro = palavras.some(function (palavra) { return /^canav/.test(palavra); });
    var terceiro = palavras.some(function (palavra) { return palavra === 'terc' || /^terceir[oa]s?$/.test(palavra); });
    return caminhao && canavieiro && terceiro;
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
    { id: 'paradaIndustrial', nome: 'Parada industrial (911)', min: 30, codigo: '911', re: /^parada industrial/ },
    { id: 'aguardMuda', nome: 'Aguardando muda (plantio)', min: 15, re: /^ag(?:uardando|uard)? (?:muda|carreg\w* (?:de )?muda)/ },
    { id: 'aguardInsumo', nome: 'Aguardando insumo/adubo/calda', min: 15, re: /^ag(?:uardando|uard)? (?:insumo|adubo|fertilizante|calda|defensivo|herbicida|vinhaca)/ },
    { id: 'aguardAgua', nome: 'Aguardando água / pipa', min: 15, re: /^ag(?:uardando|uard)? (?:agua|pipa|caminhao pipa)/ },
    { id: 'aguardComboio', nome: 'Aguardando comboio/abastecimento', min: 20, re: /^ag(?:uardando|uard)? (?:comboio|abastec)/ },
    { id: 'aguardOrdemServico', nome: 'Aguardando ordem de serviço / liberação de área', min: 20, re: /^(?:ag(?:uardando|uard)? (?:ordem|os\b|liberacao|area|instru|orientacao|topograf))|^sem (?:ordem|os\b)/ },
    { id: 'aguardPrancha', nome: 'Aguardando prancha/transporte', min: 30, re: /^ag(?:uardando|uard)? (?:transp\w* )?\(?prancha/ },
    { id: 'aguardMecanico', nome: 'Aguardando mecânico/socorro', min: 30, re: /^ag(?:uardando|uard)? (?:mecanico|socorro|manutencao|borracheiro|eletricista)/ },
    { id: 'emManutencao', nome: 'Em manutenção (mecânica/borracharia)', min: 45, re: /^(?:em )?manutencao\b|^borracharia\b|^mecanica\b|^eletrica\b|^oficina\b/ },
    { id: 'trocaFacas', nome: 'Troca de facas excedida (colhedora)', min: 20, codigo: '3520', re: /^troca (?:de )?facas/ },
    { id: 'lavagemEquipamento', nome: 'Lavagem / limpeza de equipamento', min: 45, codigo: '3500', re: /^(?:lavagem|limpeza)(?: de equipamento)?/ },
    { id: 'trocaJulietaEngate', nome: 'Troca de julieta / engate de implemento', min: 15, re: /^(?:trocando julieta|troca de julieta|engate\s*desengate|desengate de implemento)/ },
    { id: 'filaBalancaPatio', nome: 'Fila de balança / descarga indústria', min: 25, re: /^(?:fila balanca|balanca entrada|balanca saida|aguard\w* desc\w* (?:na )?industria|apos descarregar cana na mesa)/ },
    { id: 'abastLubrifExcedido', nome: 'Abastecimento / lubrificação excedido', min: 20, re: /^(?:abastecimento(?: de)? (?:insumo|combustivel|diesel|lubrificacao)|lubrificacao\b)/ }
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
  /* "Frente 1=João; Frente 2=Pedro" → nome do líder da frente. */
  function liderFrente(cfg, frente) {
    var txt = cfg && cfg.lideresFrente ? String(cfg.lideresFrente) : '';
    var alvo = norm(frente).trim();
    if (!txt || !alvo) return '';
    var partes = txt.split(/[;\n]+/);
    for (var i = 0; i < partes.length; i += 1) {
      var kv = partes[i].split('=');
      if (kv.length < 2) continue;
      var k = norm(kv[0]).trim();
      if (k && (k === alvo || alvo.indexOf(k) !== -1 || k.indexOf(alvo) !== -1)) return kv.slice(1).join('=').trim();
    }
    return '';
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
    var locais = [e.grupoEquipamento, e.frente].filter(function (v) { return v != null && String(v).trim() !== ''; }).map(norm);
    for (var l = 0; l < locais.length; l += 1) {
      for (var g in grupos) {
        if (Object.prototype.hasOwnProperty.call(grupos, g) && norm(g) === locais[l]) return Math.max(0, Number(grupos[g]) || 0);
      }
    }
    return 0;
  }
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  var CATEGORIAS_CRITICAS_PADRAO = {
    emergencia: true,
    velocidade: true,
    rpm: true,
    motorCondicao: true,
    frenteDividida: true,
    abastecimentoMotorLigado: true,
    riscoMoenda: true
  };

  function normalizeCfg(cfg) {
    var source = isObject(cfg) ? cfg : {};
    var suppliedCategories = isObject(source.notificarCategorias) ? source.notificarCategorias : {};
    var categories = Object.assign({}, DEFAULTS, suppliedCategories);
    if (source.incluirOutros === false && !Object.prototype.hasOwnProperty.call(suppliedCategories, 'generico')) {
      categories.generico = false;
    }

    return Object.assign({}, source, {
      somenteCriticos: Boolean(source.somenteCriticos),
      notificarCategorias: categories,
      tiposNotificacao: isObject(source.tiposNotificacao) ? Object.assign({}, source.tiposNotificacao) : {},
      tiposCriticos: isObject(source.tiposCriticos) ? Object.assign({}, source.tiposCriticos) : {},
      gruposEquipamento: Array.isArray(source.gruposEquipamento) ? source.gruposEquipamento.map(function (g) { return String(g || '').trim(); }).filter(Boolean) : [],
      setorMonitorado: source.setorMonitorado === 'FLOW' || source.setorMonitorado === 'COA' ? source.setorMonitorado : 'todos'
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
        velocidade: 'velocidade', rpm: 'rpm', ocioso: 'ocioso',
        motorcondicao: 'motorCondicao', generico: 'generico', aguardandocaminhao: 'aguardandoCaminhao', aguardandobasculamento: 'aguardandoBasculamento', frentedividida: 'frenteDividida', semapontamento: 'semApontamento', refeicao: 'refeicao', paradaimprodutiva: 'paradaImprodutiva', gestaofrente: 'gestaoFrente',
        ociososemapontamento: 'ocioso', emergencia: 'emergencia', telemetriamuda: 'telemetriaMuda',
        inconsistenciaapontamento: 'inconsistenciaApontamento', riscomoenda: 'riscoMoenda', batevolta: 'bateVolta', manutencaopreditiva: 'manutencaoPreditiva',
        semoperadortrabalhando: 'semOperadorTrabalhando', chavegeralligada: 'chaveGeralLigada', abastecimentomotorligado: 'abastecimentoMotorLigado', microparadascronicas: 'microParadasCronicas'
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

  function ehAlertaCritico(cfg, alert) {
    var normalized = normalizeCfg(cfg);
    var item = isObject(alert) ? alert : {};
    var code = codeFromAlert(item);
    if (code && normalized.tiposCriticos && normalized.tiposCriticos[code] === false) return false;
    if (code && normalized.tiposCriticos && normalized.tiposCriticos[code] === true) return true;
    if (Number(item.severidade) >= 3 || Number(item.nivel) >= 2) return true;
    if (item.paradaId === 'faltaTransbordo') return true;
    var cat = categoryFromAlert(item);
    return Boolean(CATEGORIAS_CRITICAS_PADRAO[cat]);
  }

  function notificar(cfg, alert) {
    var normalized = normalizeCfg(cfg);
    var item = isObject(alert) ? alert : {};
    var code = codeFromAlert(item);
    var descTurno = item.nomeAlarme || item.descricao || item.texto || '';
    if (norm(item.regra || item.categoria) === 'turno' || alarmeTrocaDeTurno(code, descTurno)) return false;
    var selectedCategory = !item.regra && !item.categoria && !code && aguardandoCaminhao(eventFor(item)) ? 'aguardandoCaminhao' : categoryFromAlert(item);
    var enabledByCategory = normalized.notificarCategorias[selectedCategory] !== false;
    var enabledByType = !code || normalized.tiposNotificacao[code] !== false;
    var selectedIndividually = !!code &&
      Object.prototype.hasOwnProperty.call(normalized.tiposNotificacao, code) &&
      normalized.tiposNotificacao[code] === true;
    if (!enabledByType) return false;
    if (normalized.somenteCriticos) {
      if (selectedIndividually) return true;
      return enabledByCategory && ehAlertaCritico(normalized, item);
    }
    return enabledByCategory || selectedIndividually;
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

  /* Glossário de pronúncia: abreviações do SGPA → como a voz deve falar.
     Padrões abaixo; o usuário acrescenta/substitui em cfg.glossarioFala
     (uma regra por linha ou separada por ";": "AG=Aguardando"). Vazio = não falar o termo. */
  var GLOSSARIO_PADRAO = [
    ['ag', 'Aguardando'], ['aguard', 'Aguardando'], ['colh', 'colhedora'],
    ['sequenc', 'sequência'], ['transp', 'transporte'], ['bascul', 'basculamento'],
    ['transbo', 'transbordo'], ['manut', 'manutenção'], ['terc', 'Terceiro'],
    ['c o a', 'Coa'], ['f l o w', 'Flow']
  ];
  function fold(texto) {
    var out = '';
    for (var i = 0; i < texto.length; i += 1) {
      var c = texto.charAt(i);
      var d = c.normalize ? c.normalize('NFD').charAt(0) : c;
      out += d.toLowerCase();
    }
    return out;
  }
  function regrasGlossario(cfg) {
    var mapa = {};
    GLOSSARIO_PADRAO.forEach(function (r) { mapa[r[0]] = r[1]; });
    var txt = cfg && cfg.glossarioFala ? String(cfg.glossarioFala) : '';
    txt.split(/[;\n]+/).forEach(function (linha) {
      var i = linha.indexOf('=');
      if (i < 1) return;
      var termo = fold(linha.slice(0, i).trim()).replace(/\s+/g, ' ');
      if (termo) mapa[termo] = linha.slice(i + 1).trim();
    });
    return Object.keys(mapa).map(function (k) { return [k, mapa[k]]; })
      .sort(function (a, b) { return b[0].length - a[0].length; });
  }
  function alnum(c) { return !!c && /[a-z0-9]/.test(c); }
  function aplicarGlossario(texto, cfg) {
    var original = texto == null ? '' : String(texto);
    var regras = regrasGlossario(cfg);
    var f = fold(original);
    var res = '';
    var i = 0;
    while (i < original.length) {
      var achou = null;
      if (!alnum(f.charAt(i - 1))) {
        for (var k = 0; k < regras.length; k += 1) {
          var t = regras[k][0];
          if (f.substr(i, t.length) === t && !alnum(f.charAt(i + t.length))) {
            achou = regras[k];
            break;
          }
        }
      }
      if (achou) {
        var fim = i + achou[0].length;
        // "AG. SEQUENC." → "Aguardando sequência": engole o ponto da abreviação.
        // Terc é uma classe/nome falado por extenso; preserva o ponto de pausa após "Terceiro".
        if (achou[0] !== 'terc' && achou[0].charAt(achou[0].length - 1) !== '.' && f.charAt(fim) === '.') fim += 1;
        res += achou[1];
        i = fim;
      } else {
        res += original.charAt(i);
        i += 1;
      }
    }
    return res.replace(/\s+/g, ' ').replace(/\s+([,.;!?])/g, '$1').replace(/\s+-\s+(?=[,.;!?]|$)/g, '').trim();
  }
  function montarFala(alert, cfg) {
    return aplicarGlossario(montarFalaBase(alert), cfg);
  }

  function textoIdentificacaoEquipamento(alert, event) {
    var ev = isObject(event) ? event : {};
    var al = isObject(alert) ? alert : {};
    var temEventoProprio = isObject(al.e);
    return norm([
      ev.grupoEquipamento, ev.descGrupoEquipamento, ev.frente, ev.descFrente,
      ev.nome, ev.descEquipamento, ev.tipo, ev.tipoCompleto,
      al.grupoEquipamento, al.frente, al.tipo, al.tipoCompleto, al.classe,
      temEventoProprio ? '' : al.descricao
    ].filter(Boolean).join(' ')).replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* No portal Solinftec da usina, caminhões bombeiros podem vir com descTpEquipamento
     cadastrado erroneamente como "TRATOR DE PNEU LEVE". Sempre que pertencer ao grupo
     ou cadastro de bombeiro, deve ser anunciado como "Caminhão" (nunca Trator nem Bombeiro). */
  function ehGrupoBombeiro(alert, event) {
    return /\bbombeir\w*/.test(textoIdentificacaoEquipamento(alert, event));
  }

  function classeEquipamentoFalado(alert, event) {
    if (ehGrupoBombeiro(alert, event)) return 'Caminhão';
    var ev = isObject(event) ? event : {};
    var al = isObject(alert) ? alert : {};
    var nomeGrupo = norm([
      ev.nome, ev.descEquipamento, ev.grupoEquipamento, ev.descGrupoEquipamento,
      ev.frente, ev.descFrente, al.grupoEquipamento
    ].filter(Boolean).join(' ')).replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    var classeInformada = al.classe != null ? String(al.classe).trim() : '';

    // Corrige cadastros onde descTpEquipamento veio como TRATOR DE PNEU LEVE para carro, pipa ou linha amarela
    if (/\b(?:linha\s+amarela|pa\s+carregadeira|carregadeira|retroescavadeira|motoniveladora|patrola|escavadeira|trator\s*(?:de\s*)?esteira|rolo\s+compactador)\b/.test(nomeGrupo)) {
      return 'Máquina';
    }
    if (/\b(?:veiculos?\s+leves?|camionet\w*|caminhonet\w*|carro|automove\w*|viatura|ambulancia|oroche|oroich|strada|hilux|saveiro|montana|toro|fiorino)\b/.test(nomeGrupo)) {
      return classeInformada === 'Utilitário' ? 'Utilitário' : 'Veículo';
    }
    if (/\b(?:caminh(?:ao|oes)|truck|canavieir\w*|canavareir\w*|comboio|munck|cacamb\w*|prancha|oficina\s+volante|pipa)\b/.test(nomeGrupo)) {
      return 'Caminhão';
    }
    if (classeInformada) {
      return /^bombeir/i.test(norm(classeInformada)) ? 'Caminhão' : classeInformada;
    }

    var tipo = textoIdentificacaoEquipamento(al, ev);
    if (/\b(?:linha\s+amarela|pa\s+carregadeira|carregadeira|retroescavadeira|motoniveladora|patrola|escavadeira|trator\s*(?:de\s*)?esteira|rolo\s+compactador)\b/.test(tipo)) return 'Máquina';
    if (/\b(?:veiculos?\s+leves?|camionet\w*|caminhonet\w*|carro|automove\w*|viatura|ambulancia|oroche|oroich)\b/.test(tipo)) return 'Veículo';
    if (/\b(?:quadriciclo|motocicleta|moto)\b/.test(tipo)) return 'Quadriciclo';
    if (/\b(?:onibus|microonibus)\b/.test(tipo)) return 'Ônibus';
    if (/\b(?:colhedora|colheitadeira)\b/.test(tipo)) return 'Colhedora';
    if (/\btransbordo\b/.test(tipo)) return 'Transbordo';
    if (/\b(?:plantadeira|plantadora|semeadora)\b/.test(tipo)) return 'Plantadeira';
    if (/\b(?:pulverizador|uniport|autopropelido)\b/.test(tipo)) return 'Pulverizador';
    if (/\bempilhadeira\b/.test(tipo)) return 'Empilhadeira';
    if (/\b(?:vagao|carreta\s*agri)\b/.test(tipo)) return 'Vagão';
    if (/\btrator\b/.test(tipo)) return 'Trator';
    if (/\b(?:caminh(?:ao|oes)|truck|canavieir\w*|canavareir\w*|comboio|munck|cacamb\w*|pipa)\b/.test(tipo)) return 'Caminhão';
    if (/\b(?:carreta|bitrem|rodotrem)\b/.test(tipo)) return 'Carreta';
    if (/\b(?:utilitari\w*|van)\b/.test(tipo)) return 'Utilitário';
    return 'Veículo';
  }

  /* Divisão operacional da usina:
     - FLOW: todos os grupos de Caminhões e Veículos Leves / utilitários / ônibus.
     - COA: Tratores, Transbordos, Colhedoras, Plantio, Tratos e Linha Amarela. */
  function setorControle(alert, event) {
    var item = isObject(alert) ? alert : {};
    var ev = isObject(event) ? event : eventFor(item);
    var cat = categoryFromAlert(item);
    if (cat === 'gestaoFrente' || cat === 'riscoMoenda' || cat === 'frenteDividida' ||
        cat === 'aguardandoCaminhao' || cat === 'aguardandoBasculamento' || cat === 'microParadasCronicas') {
      return 'COA';
    }
    if (cat === 'bateVolta' || ehGrupoBombeiro(item, ev)) {
      return 'FLOW';
    }
    var cls = classeEquipamentoFalado(item, ev);
    if (cls === 'Colhedora' || cls === 'Trator' || cls === 'Transbordo' || cls === 'Máquina' ||
        cls === 'Plantadeira' || cls === 'Pulverizador' || cls === 'Empilhadeira' || cls === 'Vagão' || cls === 'Torre') {
      return 'COA';
    }
    return 'FLOW';
  }

  function prefixoSetorFalado(alert, event, emergencia) {
    var setor = setorControle(alert, event);
    if (emergencia) {
      return setor === 'FLOW' ? 'Atenção Flow, emergência! ' : 'Atenção Coa, emergência! ';
    }
    return setor === 'FLOW' ? 'Atenção Flow: ' : 'Atenção Coa: ';
  }

  function frenteOuGrupo(event) {
    var frente = event && event.frente;
    if (frente != null && String(frente).trim() !== '') return String(frente).trim();
    var grupo = event && event.grupoEquipamento;
    if (grupo != null && String(grupo).trim() !== '') return String(grupo).trim();
    return 'frente não informada';
  }
  function montarFalaBase(alert) {
    var item = isObject(alert) ? alert : {};
    var event = eventFor(item);
    var selectedCategory = categoryFromAlert(item);
    var vehicleClass = classeEquipamentoFalado(item, event);
    var atencao = prefixoSetorFalado(item, event, false);

    if (selectedCategory === 'aguardandoCaminhao' || (!item.regra && !item.categoria && !codeFromAlert(item) && aguardandoCaminhao(event))) {
      var front = frenteOuGrupo(event);
      return 'Atenção Coa: Trator ' + vehicleNumber(item, event) + ' aguardando caminhão. Frente/grupo ' + String(front).trim() + '. Verificar.';
    }

    if (selectedCategory === 'aguardandoBasculamento') {
      var truckIds = Array.isArray(item.caminhoes) ? item.caminhoes.map(function (id) { return idFalado(id); }).filter(Boolean) : [];
      var basculamentoFrente = frenteOuGrupo(event);
      var truckText = truckIds.length > 1
        ? 'os caminhões ' + truckIds.join(', ') + ' estão aguardando carregamento na mesma frente'
        : truckIds.length === 1
          ? 'o caminhão ' + truckIds[0] + ' está aguardando carregamento na mesma frente'
          : 'há caminhão aguardando carregamento na mesma frente';
      return 'Atenção Coa: Trator ' + vehicleNumber(item, event) + ': aguardando basculamento, inferido pelo aplicativo porque ' + truckText +
        '. Frente/grupo ' + basculamentoFrente + '. No SGPA, o apontamento permanece Aguardando Caminhão. Verificar.';
    }

    if (selectedCategory === 'frenteDividida') {
      var frenteDividida = frenteOuGrupo(event);
      var tipoFrenteDividida = norm([event.tipo, event.tipoCompleto, event.nome].filter(Boolean).join(' '));
      var classeFrenteDividida = vehicleClass === 'Transbordo' || /transbordo/.test(tipoFrenteDividida) ? 'Transbordo' : 'Trator';
      return 'Atenção Coa: ' + classeFrenteDividida + ' ' + vehicleNumber(item, event) +
        ' apontou Frente dividida. Frente/grupo ' + frenteDividida + '. Verificar a sequência de chamada da colhedora no sistema FUT.';
    }

    if (selectedCategory === 'refeicao') {
      var fr = frenteOuGrupo(event);
      var dur = numericAlertValue(item.valor);
      var lim = numericAlertValue(item.limite);
      return atencao + vehicleClass + ' ' + vehicleNumber(item, event) + ' excedeu o tempo de refeição' +
        (dur ? ': ' + String(dur) + ' minutos' : '') +
        (lim ? ', limite de ' + String(lim) + ' minutos' : '') +
        '. Frente/grupo ' + String(fr).trim() + '. Verificar.';
    }
    if (selectedCategory === 'paradaImprodutiva') {
      var fp = frenteOuGrupo(event);
      var mp = numericAlertValue(item.valor);
      var prefixo = item.nivel >= 3 ? 'Escalonamento. ' : item.nivel === 2 ? 'Urgente, parada continua. ' : '';
      var sufixo = item.nivel >= 3 ? ' Acionar ' + (item.lider ? 'líder ' + item.lider : 'líder da frente') + '.' : '';
      if (item.paradaId === 'aguardandoCarregamento' && caminhaoCanavieiroTerceiro(event)) {
        var frenteDireta = event.frente == null ? '' : String(event.frente).trim();
        var frenteInferida = event.frenteInferida == null ? '' : String(event.frenteInferida).trim();
        var frenteColheita = frenteDireta || frenteInferida;
        var localColheita = frenteColheita
          ? (/^(?:frente|fazenda|s[ií]tio|propriedade)\b/i.test(frenteColheita) ? 'na ' + frenteColheita : 'na frente de colheita ' + frenteColheita)
          : 'na frente de colheita não informada';
        return 'Atenção Flow: ' + prefixo + 'Caminhão ' + vehicleNumber(item, event) + ' aguardando carregamento' +
          (mp ? ' há ' + String(mp) + (mp === 1 ? ' minuto' : ' minutos') : '') +
          ', se encontra ' + localColheita + '.' + (sufixo || ' Verificar.');
      }
      if (item.paradaId === 'aguardandoCarregamento') {
        var carregamentoSemFrente = String(item.paradaNome || 'Aguardando carregamento')
          .replace(/\s*\(\s*caminh(?:ão|ões|ao|oes)\s*\)/i, '')
          .replace(/\s*\(\d+\)/, '');
        return atencao + prefixo + vehicleClass + ' ' + vehicleNumber(item, event) + ' em ' + carregamentoSemFrente +
          (mp ? ' há ' + String(mp) + (mp === 1 ? ' minuto' : ' minutos') : '') +
          '.' + (sufixo || ' Verificar.');
      }
      return atencao + prefixo + vehicleClass + ' ' + vehicleNumber(item, event) + ' em ' + String(item.paradaNome || 'parada improdutiva').replace(/\s*\(\d+\)/, '') +
        (mp ? ' há ' + String(mp) + (mp === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(fp).trim() + '.' + (sufixo || ' Verificar.');
    }
    if (selectedCategory === 'gestaoFrente') {
      var ff = event.frente == null || String(event.frente).trim() === '' ? 'não informada' : String(event.frente).trim();
      return 'Atenção Coa, gestão ' + (/^frente\b/i.test(ff) ? ff : 'frente ' + ff) + ': ' + String(item.texto || '').replace(/\s*·.*$/, '') + '.' +
        (item.lider ? ' Líder ' + item.lider + '.' : '') + ' Verificar.';
    }
    if (selectedCategory === 'emergencia') {
      var fem = frenteOuGrupo(event);
      var txtEm = cleanMessage(item.texto) || 'ocorrência de incêndio ou emergência';
      return prefixoSetorFalado(item, event, true) + vehicleClass + ' ' + vehicleNumber(item, event) + ': ' + txtEm + '. Frente/grupo ' + String(fem).trim() + '. Atenção imediata.';
    }
    if (selectedCategory === 'telemetriaMuda') {
      var ftm = frenteOuGrupo(event);
      var mtm = numericAlertValue(item.valor);
      return atencao + vehicleClass + ' ' + vehicleNumber(item, event) + ' sem comunicação de telemetria' +
        (mtm ? ' há ' + String(mtm) + (mtm === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(ftm).trim() + '. Verificar computador de bordo.';
    }
    if (selectedCategory === 'inconsistenciaApontamento') {
      var finc = frenteOuGrupo(event);
      var tinc = cleanMessage(item.texto) || 'inconsistência de apontamento';
      return atencao + 'auditoria de apontamento, ' + vehicleClass + ' ' + vehicleNumber(item, event) + ' ' + tinc + '. Frente/grupo ' + String(finc).trim() + '. Cobrar apontamento correto.';
    }
    if (selectedCategory === 'riscoMoenda') {
      var tmoe = cleanMessage(item.texto) || 'ritmo de colheita abaixo da meta da usina';
      return 'Atenção Coa, risco de moenda: ' + tmoe + '. Priorizar liberação de colhedoras e caminhões.';
    }
    if (selectedCategory === 'bateVolta') {
      var fbv = frenteOuGrupo(event);
      var mbv = numericAlertValue(item.valor);
      return 'Atenção Flow: Caminhão ' + vehicleNumber(item, event) + ' em bate-volta acima do tempo esperado' +
        (mbv ? ', há ' + String(mbv) + ' minutos em viagem' : '') +
        '. Frente/grupo ' + String(fbv).trim() + '. Verificar trajeto.';
    }
    if (selectedCategory === 'manutencaoPreditiva') {
      var fmp = frenteOuGrupo(event);
      var nmp = numericAlertValue(item.valor);
      return atencao + 'manutenção preditiva, ' + vehicleClass + ' ' + vehicleNumber(item, event) + ' acumulou ' +
        (nmp || 3) + ' ocorrências mecânicas ou de motor no turno. Frente/grupo ' + String(fmp).trim() + '. Acionar oficina preventiva.';
    }
    if (selectedCategory === 'semOperadorTrabalhando') {
      var fsop = frenteOuGrupo(event);
      var msop = numericAlertValue(item.valor);
      return atencao + vehicleClass + ' ' + vehicleNumber(item, event) + ' em operação sem operador identificado' +
        (msop ? ' há ' + String(msop) + (msop === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(fsop).trim() + '. Cobrar login imediato no bordo.';
    }
    if (selectedCategory === 'chaveGeralLigada') {
      var fchg = frenteOuGrupo(event);
      var mchg = numericAlertValue(item.valor);
      return atencao + vehicleClass + ' ' + vehicleNumber(item, event) + ' parado com chave geral ligada e motor desligado' +
        (mchg ? ' há ' + String(mchg) + (mchg === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(fchg).trim() + '. Desligar chave geral para proteger bateria e horímetro.';
    }
    if (selectedCategory === 'abastecimentoMotorLigado') {
      var fabm = frenteOuGrupo(event);
      return atencao + 'alerta de segurança, ' + vehicleClass + ' ' + vehicleNumber(item, event) +
        ' em abastecimento ou lubrificação com motor ligado. Frente/grupo ' + String(fabm).trim() + '. Desligar motor imediatamente.';
    }
    if (selectedCategory === 'microParadasCronicas') {
      var fmpc = frenteOuGrupo(event);
      var vmpc = numericAlertValue(item.valor);
      return 'Atenção Coa: ' + vehicleClass + ' ' + vehicleNumber(item, event) +
        ' com micro-paradas repetidas na última hora' + (vmpc ? ', somando ' + String(vmpc) + ' minutos perdidos' : '') +
        '. Frente/grupo ' + String(fmpc).trim() + '. Verificar gargalo operacional.';
    }
    if (selectedCategory === 'semApontamento') {
      var frente = frenteOuGrupo(event);
      var minutos = numericAlertValue(item.valor);
      return atencao + vehicleClass + ' ' + vehicleNumber(item, event) + ' sem apontamento' +
        (minutos ? ' há ' + String(minutos) + (minutos === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(frente).trim() + '. Verificar.';
    }
    var identification = vehicleNumber(item, event);
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
      return atencao + vehicleClass + ' ' + identification + ': ' + aprovada.texto + complemento + '. Verificar.';
    }

    if (selectedCategory === 'velocidade') {
      var speed = numericAlertValue(item.valor);
      if (speed === null) {
        return atencao + vehicleClass + ' ' + identification + ' com alarme oficial de velocidade excedida. Verificar.';
      }
      return atencao + vehicleClass + ' ' + identification + ' excedeu a velocidade a ' + String(speed) + ' quilômetros por hora. Verificar.';
    }

    var message = cleanMessage(item.texto);
    return atencao + vehicleClass + ' ' + identification + (message ? ': ' + message : '') + '. Verificar.';
  }

  /* ------------------ Inteligência COA (Solinftec / CTT) ------------------ */

  function ehAlertaSeguranca(regra) {
    var r = String(regra || '');
    return r === 'emergencia' || r === 'velocidade' || r === 'rpm' || r === 'motorCondicao' || r === 'abastecimentoMotorLigado';
  }

  /* Emergência somente por apontamento confirmado de incêndio/fogo/sinistro ou alarme oficial SGPA.
     Nunca dispara por velocidade de telemetria sem alarme oficial do portal. */
  function emergenciaOperacional(e) {
    if (!e || typeof e !== 'object') return null;
    var opBruta = e.operacao || e.descOperacao || '';
    var op = norm(opBruta).replace(/^\d+\s*-\s*/, '').replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (e.operacaoConfirmada === true && /\b(?:incendio|fogo|queimada|combate a? ?incendio|emergencia fogo|sinistro)\b/.test(op)) {
      return { tipo: 'incendio', motivo: opBruta || 'Combate a incêndio' };
    }
    return null;
  }

  /* Velocidade é exclusivamente o alarme oficial do portal SGPA (nunca cálculo local). */
  function colheitaAcimaDaFaixa() {
    return false;
  }

  /* Frota muda elegível: janela operacional de 25..180 min (máquinas paradas há > 3h ou
     desligadas em Chuva/Clima/Manutenção/Oficina não geram alerta repetido). */
  function frotaMudaElegivel(e, minutosMinimos) {
    if (!e || typeof e !== 'object') return false;
    var min = Math.max(0, Number(minutosMinimos) || 0);
    if (!min) return false;
    var atrasoSeg = e.atraso != null && Number.isFinite(Number(e.atraso)) ? Number(e.atraso) : null;
    if (atrasoSeg === null || atrasoSeg < min * 60 || atrasoSeg > 3 * 3600) return false;
    var vel = numericAlertValue(e.velocidade);
    var parado = vel === null || vel <= 0.5;
    if (parado) {
      var contextoOp = norm([e.operacao, e.descOperacao, e.grupoOperacao, e.descGrupoOperacao].filter(Boolean).join(' '));
      if (/\b(?:chuva|clima|manutenc\w*|oficina|entressafra|reforma)\b/.test(contextoOp)) return false;
    }
    return true;
  }

  function analisarFrentesCtt(listaFrota, opcoes) {
    var opts = isObject(opcoes) ? opcoes : {};
    var minutosMuda = Math.max(0, Number(opts.minutosFrotaMuda != null ? opts.minutosFrotaMuda : 25));
    var filaMax = Math.max(1, Number(opts.filaMaxFrente != null ? opts.filaMaxFrente : 4));
    var chuvas = isObject(opts.chuvas) ? opts.chuvas : {};
    var mapaFrentes = {};
    var ordem = [];
    var frotasMudas = [];
    var totais = {
      equipamentos: 0,
      colhedoras: 0,
      colhedorasColhendo: 0,
      colhedorasParadas: 0,
      colhedorasManut: 0,
      transbordos: 0,
      transbordosAtivos: 0,
      transbordosAgColh: 0,
      transbordosAgCam: 0,
      caminhoes: 0,
      caminhoesFila: 0,
      caminhoesCarregando: 0,
      apoio: 0,
      manutencaoTotal: 0,
      mudas: 0,
      chuvasAtivas: 0
    };

    function obterFrente(rotulo) {
      var nome = String(rotulo || '').trim() || 'Sem frente definida';
      var chave = norm(nome);
      if (!mapaFrentes[chave]) {
        mapaFrentes[chave] = {
          chave: chave,
          frente: nome,
          equipamentos: 0,
          colhTotal: 0,
          colhColhendo: 0,
          colhParadas: 0,
          colhManut: 0,
          tbTotal: 0,
          tbAtivos: 0,
          tbAgColh: 0,
          tbAgCam: 0,
          camTotal: 0,
          camFila: 0,
          camCarregando: 0,
          apoioTotal: 0,
          manutTotal: 0,
          mudas: 0,
          emergencias: 0,
          chuva: chuvas[chave] || null,
          semaforo: 'ok',
          razaoTbColh: null
        };
        ordem.push(chave);
      }
      return mapaFrentes[chave];
    }

    var lista = Array.isArray(listaFrota) ? listaFrota : [];
    for (var i = 0; i < lista.length; i += 1) {
      var e = lista[i];
      if (!e || String(e.ativo || 'T') === 'F') continue;
      var frenteRotulo = e.frente || e.frenteInferida || e.grupoEquipamento || '';
      var f = obterFrente(frenteRotulo);
      f.equipamentos += 1;
      totais.equipamentos += 1;

      var tipoTxt = norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' '));
      var opTxt = norm(e.operacao || e.descOperacao || '').replace(/^\d+\s*-\s*/, '');
      var parada = e.operacaoConfirmada === true ? paradaImprodutiva(e) : null;
      var atrasoSeg = e.atraso != null && Number.isFinite(Number(e.atraso)) ? Number(e.atraso) : null;
      var muda = frotaMudaElegivel(e, minutosMuda);
      var emManut = (parada && (parada.id === 'aguardMecanico' || parada.id === 'emManutencao' || parada.id === 'aguardComboio')) ||
        /\b(?:manutenc|mecan|borrach|socorro|oficina|quebra|eletric)\b/.test(opTxt);

      if (emergenciaOperacional(e)) f.emergencias += 1;
      if (muda) {
        f.mudas += 1;
        totais.mudas += 1;
        frotasMudas.push({
          id: e.id,
          numero: e.numero || e.id,
          nome: e.nome || e.id,
          tipo: e.tipo || '',
          frente: f.frente,
          operacao: e.operacao || '—',
          local: e.local || '',
          minutos: Math.round(atrasoSeg / 60)
        });
      }
      if (emManut) {
        f.manutTotal += 1;
        totais.manutencaoTotal += 1;
      }

      if (/colhed/.test(tipoTxt)) {
        f.colhTotal += 1;
        totais.colhedoras += 1;
        if (emManut) {
          f.colhManut += 1;
          totais.colhedorasManut += 1;
        } else if (!muda && ((e.operacaoConfirmada === true && /colheita|colhendo/.test(opTxt) && !/aguard|parada|manobra|sem apont/.test(opTxt)) || (e.operacaoConfirmada !== true && (Number(e.velocidade) || 0) > 1))) {
          f.colhColhendo += 1;
          totais.colhedorasColhendo += 1;
        } else {
          f.colhParadas += 1;
          totais.colhedorasParadas += 1;
        }
      } else if (/caminh|\btruck\b|canav/.test(tipoTxt) && !/bombeir|munck|pipa|comboio|oficina/.test(tipoTxt)) {
        f.camTotal += 1;
        totais.caminhoes += 1;
        if (parada && (parada.id === 'aguardandoCarregamento' || parada.id === 'filaUnica')) {
          f.camFila += 1;
          totais.caminhoesFila += 1;
        } else if (/carregando|bascul/.test(opTxt)) {
          f.camCarregando += 1;
          totais.caminhoesCarregando += 1;
        }
      } else if (/transbord|trator/.test(tipoTxt)) {
        f.tbTotal += 1;
        totais.transbordos += 1;
        if (aguardandoCaminhao(e)) {
          f.tbAgCam += 1;
          totais.transbordosAgCam += 1;
        } else if (parada && (parada.id === 'agColhedoraParadaRapida' || parada.id === 'aguardandoColhedoraAlocada' || parada.id === 'filaUnica')) {
          f.tbAgColh += 1;
          totais.transbordosAgColh += 1;
        } else if (!emManut && !muda) {
          f.tbAtivos += 1;
          totais.transbordosAtivos += 1;
        }
      } else {
        f.apoioTotal += 1;
        totais.apoio += 1;
      }
    }

    var frentes = ordem.map(function (k) {
      var f = mapaFrentes[k];
      if (f.chuva) totais.chuvasAtivas += 1;
      f.razaoTbColh = f.colhColhendo > 0 ? Math.round((f.tbTotal / f.colhColhendo) * 10) / 10 : null;
      if (f.emergencias > 0 || (f.colhTotal > 0 && f.colhColhendo === 0 && !f.chuva)) {
        f.semaforo = 'critico';
      } else if (f.chuva || f.camFila >= filaMax || f.tbAgCam >= 2 || f.tbAgColh >= 3 || f.mudas > 0 || f.colhManut > 0) {
        f.semaforo = 'atencao';
      } else {
        f.semaforo = 'ok';
      }
      return f;
    }).sort(function (a, b) {
      var peso = { critico: 3, atencao: 2, ok: 1 };
      return (peso[b.semaforo] - peso[a.semaforo]) || (b.colhTotal - a.colhTotal) || a.frente.localeCompare(b.frente, 'pt-BR');
    });

    frotasMudas.sort(function (a, b) { return b.minutos - a.minutos; });

    var doadoras = frentes.filter(function (f) { return !f.chuva && f.camFila >= Math.max(2, filaMax - 1); })
      .sort(function (a, b) { return b.camFila - a.camFila; });
    var receptoras = frentes.filter(function (f) { return !f.chuva && f.tbAgCam >= 1 && f.camFila === 0; })
      .sort(function (a, b) { return b.tbAgCam - a.tbAgCam; });

    var sugestoesBalanceamento = [];
    for (var d = 0; d < doadoras.length && d < receptoras.length; d += 1) {
      var origem = doadoras[d];
      var destino = receptoras[d];
      if (origem.chave === destino.chave) continue;
      var mover = Math.max(1, Math.min(2, Math.floor(origem.camFila / 2)));
      sugestoesBalanceamento.push({
        origem: origem.frente,
        destino: destino.frente,
        caminhoes: mover,
        texto: 'Redirecionar ' + mover + (mover === 1 ? ' caminhão' : ' caminhões') + ' da ' + origem.frente +
          ' (' + origem.camFila + ' em fila) para ' + destino.frente +
          ' (' + destino.tbAgCam + (destino.tbAgCam === 1 ? ' transbordo' : ' transbordos') + ' aguardando caminhão).'
      });
    }

    return { frentes: frentes, sugestoesBalanceamento: sugestoesBalanceamento, frotasMudas: frotasMudas, totais: totais };
  }

  function textoCobrancaWhatsApp(alerta, unidade, tratativa) {
    if (!alerta || typeof alerta !== 'object') return '';
    var e = alerta.e || {};
    var frente = e.frente || e.frenteInferida || e.grupoEquipamento || 'Frente não informada';
    var veic = [alerta.classe || '', alerta.numero || e.id || ''].filter(Boolean).join(' ').trim();
    var op = alerta.operador ? ' (Op. ' + alerta.operador + ')' : ' (sem operador definido)';
    var local = e.local ? ' · Local: ' + e.local : '';
    var prefixo = alerta.regra === 'emergencia' ? '🚨🔥 [EMERGÊNCIA COA' : '🚩 [COA';
    var cab = prefixo + (unidade ? ' ' + unidade : ' Branco Peres') + ']';
    var linha1 = cab + ' ' + frente + ' · ' + veic + op;
    var linha2 = 'Alerta: ' + (alerta.nome || alerta.regra) + ' — ' + (alerta.texto || '');
    var linha3 = (e.operacao ? 'Operação SGPA: ' + e.operacao : '') + local;
    var linha4 = tratativa && (tratativa.tag || tratativa.nota)
      ? 'Tratativa COA: ' + [tratativa.tag, tratativa.nota].filter(Boolean).join(' — ')
      : 'Favor verificar e retornar no rádio para o COA.';
    return [linha1, linha2, linha3, linha4].filter(Boolean).join('\n');
  }

  function turnoAtualCoa(ts) {
    var ms = Number(ts) || Date.now();
    var d = new Date(ms);
    var ano = d.getFullYear(), mes = d.getMonth() + 1, dia = d.getDate(), hora = d.getHours();
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
      }).formatToParts(d);
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].type === 'year') ano = Number(parts[i].value);
        if (parts[i].type === 'month') mes = Number(parts[i].value);
        if (parts[i].type === 'day') dia = Number(parts[i].value);
        if (parts[i].type === 'hour') hora = Number(parts[i].value);
      }
    } catch (_) {
      /* fallback hora local */
    }
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var dataBase = ano + '-' + pad(mes) + '-' + pad(dia);
    var codigo = hora >= 7 && hora < 15 ? 'T1' : hora >= 15 && hora < 23 ? 'T2' : 'T3';
    var nome = codigo === 'T1' ? 'Turno 1 (07h–15h)' : codigo === 'T2' ? 'Turno 2 (15h–23h)' : 'Turno 3 (23h–07h)';
    var horasDecorridas = codigo === 'T1' ? hora - 7 : codigo === 'T2' ? hora - 15 : (hora >= 23 ? hora - 23 : hora + 1);
    var inicioMs = ms - Math.max(0, horasDecorridas) * 3600000 - d.getMinutes() * 60000;
    return { chave: dataBase + '|' + codigo, codigo: codigo, nome: nome, data: pad(dia) + '/' + pad(mes) + '/' + ano, inicioMs: inicioMs };
  }

  function gerarBoletimPassagemTurno(dados) {
    var p = isObject(dados) ? dados : {};
    var agoraMs = Number(p.agoraMs) || Date.now();
    var turno = turnoAtualCoa(agoraMs);
    var ativos = Array.isArray(p.ativos) ? p.ativos : [];
    var hist = Array.isArray(p.hist) ? p.hist : [];
    var tratativas = isObject(p.tratativas) ? p.tratativas : {};
    var chuvas = isObject(p.chuvas) ? p.chuvas : {};
    var resumoCtt = p.resumoCtt || { frentes: [], totais: {}, sugestoesBalanceamento: [], frotasMudas: [] };
    var ociosidade = Array.isArray(p.ociosidadeTurno) ? p.ociosidadeTurno : [];

    var histTurno = hist.filter(function (h) { return Number(h && h.ts) >= turno.inicioMs - 15 * 60000; });
    var porEq = {};
    var porParada = {};
    for (var i = 0; i < histTurno.length; i += 1) {
      var h = histTurno[i];
      var eqKey = String(h.equipamento || h.descricao || '—');
      if (!porEq[eqKey]) porEq[eqKey] = { equipamento: eqKey, frente: h.frente || '', total: 0, criticos: 0 };
      porEq[eqKey].total += 1;
      if (h.regra === 'velocidade' || h.regra === 'rpm' || h.regra === 'emergencia' || h.regra === 'frenteDividida') porEq[eqKey].criticos += 1;

      var motivo = h.nomeAlarme || h.regra || 'outros';
      if (!porParada[motivo]) porParada[motivo] = { motivo: motivo, total: 0 };
      porParada[motivo].total += 1;
    }

    var topOfensores = Object.keys(porEq).map(function (k) { return porEq[k]; })
      .sort(function (a, b) { return b.total - a.total || b.criticos - a.criticos; }).slice(0, 5);
    var topMotivos = Object.keys(porParada).map(function (k) { return porParada[k]; })
      .sort(function (a, b) { return b.total - a.total; }).slice(0, 5);
    var topOciosidade = ociosidade.slice()
      .filter(function (o) { return (Number(o.segAcumulados) || 0) >= 60; })
      .sort(function (a, b) { return (b.segAcumulados || 0) - (a.segAcumulados || 0); }).slice(0, 5);

    var pendentes = ativos.slice().sort(function (a, b) { return (b.severidade || 0) - (a.severidade || 0) || (a.inicio || a.ts) - (b.inicio || b.ts); });
    var criticosAbertos = pendentes.filter(function (a) { return (a.severidade || 0) >= 3; });
    var chuvasLista = Object.keys(chuvas).map(function (k) { return chuvas[k]; }).filter(Boolean);
    var tot = resumoCtt.totais || {};

    var linhas = [];
    linhas.push('📋 *PASSAGEM DE TURNO COA — ' + (p.unidade || 'Usina Branco Peres') + '*');
    linhas.push('📅 ' + turno.data + ' · ' + turno.nome + (p.usuario ? ' · Operador: ' + p.usuario : ''));
    linhas.push('');
    linhas.push('*1. SITUAÇÃO ATUAL CTT*');
    linhas.push('• Colhedoras colhendo: ' + (tot.colhedorasColhendo || 0) + '/' + (tot.colhedoras || 0) + (tot.colhedorasManut ? ' (' + tot.colhedorasManut + ' em manut.)' : ''));
    linhas.push('• Transbordos ativos: ' + (tot.transbordosAtivos || 0) + '/' + (tot.transbordos || 0) + (tot.transbordosAgCam ? ' · ' + tot.transbordosAgCam + ' ag. caminhão' : ''));
    linhas.push('• Caminhões em fila: ' + (tot.caminhoesFila || 0) + ' · Sem telemetria (mudas): ' + (tot.mudas || 0));
    if (chuvasLista.length) {
      linhas.push('• Frentes em pausa/chuva: ' + chuvasLista.map(function (c) { return c.frente + (c.motivo ? ' (' + c.motivo + ')' : ''); }).join(', '));
    }
    if (resumoCtt.sugestoesBalanceamento && resumoCtt.sugestoesBalanceamento.length) {
      linhas.push('• Balanceamento sugerido: ' + resumoCtt.sugestoesBalanceamento.map(function (s) { return s.texto; }).join(' '));
    }

    linhas.push('');
    linhas.push('*2. PENDÊNCIAS EM ABERTO (' + pendentes.length + ' ativos · ' + criticosAbertos.length + ' críticos)*');
    if (!pendentes.length) {
      linhas.push('• Nenhuma pendência aberta no momento.');
    } else {
      for (var j = 0; j < Math.min(10, pendentes.length); j += 1) {
        var al = pendentes[j];
        var minAb = Math.max(1, Math.round((agoraMs - (al.inicio || al.ts || agoraMs)) / 60000));
        var tr = tratativas[al.chave];
        var trTxt = tr && (tr.tag || tr.nota) ? ' [' + [tr.tag, tr.nota].filter(Boolean).join(': ') + ']' : ' [sem tratativa]';
        linhas.push('• ' + (al.classe || '') + ' ' + (al.numero || '') + ' (' + ((al.e && al.e.frente) || 's/ frente') + ') — ' + (al.nome || al.regra) + ' há ' + minAb + ' min' + trTxt);
      }
    }

    if (topOfensores.length) {
      linhas.push('');
      linhas.push('*3. TOP 5 EQUIPAMENTOS OFENSORES DO TURNO (' + histTurno.length + ' eventos)*');
      for (var o = 0; o < topOfensores.length; o += 1) {
        var of = topOfensores[o];
        linhas.push((o + 1) + '. Frota ' + of.equipamento + (of.frente ? ' (' + of.frente + ')' : '') + ' — ' + of.total + ' ocorrência(s)' + (of.criticos ? ', ' + of.criticos + ' crítica(s)' : ''));
      }
    }

    if (topMotivos.length) {
      linhas.push('');
      linhas.push('*4. PRINCIPAIS CAUSAS DE ALERTA/PARADA NO TURNO*');
      for (var m = 0; m < topMotivos.length; m += 1) {
        linhas.push('• ' + topMotivos[m].motivo + ': ' + topMotivos[m].total + 'x');
      }
    }

    if (topOciosidade.length) {
      linhas.push('');
      linhas.push('*5. TOP DESPERDÍCIO DE DIESEL (MOTOR OCIOSO NO TURNO)*');
      for (var d = 0; d < topOciosidade.length; d += 1) {
        var oc = topOciosidade[d];
        var mins = Math.round((oc.segAcumulados || 0) / 60);
        var litros = Math.round(((oc.segAcumulados || 0) / 3600) * 4 * 10) / 10;
        linhas.push((d + 1) + '. ' + (oc.classe || 'Frota') + ' ' + oc.numero + (oc.frente ? ' (' + oc.frente + ')' : '') + ' — ' + mins + ' min ociosos (~' + litros + ' L est.)');
      }
    }

    if (p.custoTotalTurnoRs != null && Number(p.custoTotalTurnoRs) > 0) {
      linhas.push('• Custo estimado de paradas/ocioso no turno: R$ ' + Math.round(Number(p.custoTotalTurnoRs)).toLocaleString('pt-BR'));
    }
    if (p.placarPositivo && p.placarPositivo.resumoCurto) {
      linhas.push('');
      linhas.push('*6. DESTAQUES POSITIVOS PARA O DDS*');
      linhas.push(p.placarPositivo.resumoCurto);
    }

    return {
      turno: turno,
      totalEventosTurno: histTurno.length,
      criticosAbertos: criticosAbertos.length,
      pendentesTotal: pendentes.length,
      topOfensores: topOfensores,
      topMotivos: topMotivos,
      topOciosidade: topOciosidade,
      texto: linhas.join('\n')
    };
  }

  /* ------------------ Inteligência Preditiva & Comboio v4.0 ------------------ */

  function decodificarGeohash(valor) {
    var hash = String(valor || '').trim().toLowerCase();
    if (hash.length < 5 || hash.length > 12) return null;
    var alfabeto = '0123456789bcdefghjkmnpqrstuvwxyz';
    var latMin = -90, latMax = 90, lonMin = -180, lonMax = 180, lonTurn = true;
    for (var i = 0; i < hash.length; i += 1) {
      var idx = alfabeto.indexOf(hash.charAt(i));
      if (idx < 0) return null;
      for (var bit = 4; bit >= 0; bit -= 1) {
        var on = (idx & (1 << bit)) !== 0;
        if (lonTurn) {
          var mLon = (lonMin + lonMax) / 2;
          if (on) lonMin = mLon; else lonMax = mLon;
        } else {
          var mLat = (latMin + latMax) / 2;
          if (on) latMin = mLat; else latMax = mLat;
        }
        lonTurn = !lonTurn;
      }
    }
    return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
  }

  function distanciaKm(a, b) {
    if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
    var rad = function (v) { return v * Math.PI / 180; };
    var dLat = rad(b.lat - a.lat);
    var dLon = rad(b.lon - a.lon);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
    return Math.round(km * 10) / 10;
  }

  function custoHoraEquipamento(e, cfg) {
    var c = isObject(cfg) ? cfg : {};
    var tipo = norm([e && e.tipo, e && e.tipoCompleto, e && e.nome].filter(Boolean).join(' '));
    var classeCusto = 'apoio';
    var valorHora = Number(c.custoHoraApoio) > 0 ? Number(c.custoHoraApoio) : 180;
    if (/colhed/.test(tipo)) {
      classeCusto = 'colhedora';
      valorHora = Number(c.custoHoraColhedora) > 0 ? Number(c.custoHoraColhedora) : 850;
    } else if (/caminh|\btruck\b|canav/.test(tipo) && !/bombeir|pipa|comboio|oficina|munck/.test(tipo)) {
      classeCusto = 'caminhao';
      valorHora = Number(c.custoHoraCaminhao) > 0 ? Number(c.custoHoraCaminhao) : 220;
    } else if (/transbord|trator/.test(tipo)) {
      classeCusto = 'transbordo';
      valorHora = Number(c.custoHoraTransbordo) > 0 ? Number(c.custoHoraTransbordo) : 260;
    }
    return {
      classeCusto: classeCusto,
      valorHora: valorHora,
      valorMinuto: Math.round((valorHora / 60) * 100) / 100
    };
  }

  function inconsistenciaApontamento(e) {
    if (!e || typeof e !== 'object' || e.operacaoConfirmada !== true) return null;
    var opBruta = String(e.operacao || e.descOperacao || '').trim();
    if (!opBruta) return null;
    var op = norm(opBruta).replace(/^\d+\s*-\s*/, '').replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    var tipo = norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' '));
    var vel = numericAlertValue(e.velocidade);
    var rpm = numericAlertValue(e.rpm);
    var motorOn = e.motor === true && (rpm === null || rpm >= 900);

    // Caso 1: Colhedora apontando Colheita/Corte, porém parada (0 km/h)
    if (/colhed/.test(tipo) && /\b(?:colheita|colhendo|corte mecaniz)\b/.test(op) &&
        !/\b(?:aguard|parada|manobra|desloc|manutenc|sem apont|troca|refeic)\b/.test(op)) {
      if ((vel === null ? 0 : vel) <= 0.5 && (e.motor === false || (rpm !== null && rpm <= 950) || vel === 0)) {
        return {
          subtipo: 'colheitaParada',
          operacao: opBruta,
          velocidade: vel || 0,
          motivo: 'apontou Colheita mas está parada a 0 km/h'
        };
      }
    }

    // Caso 2: Apontamento de Parada / Refeição / Sem Apontamento / Aguardando, mas deslocando com motor em carga
    var ehApontamentoParado = semApontamento(e) || emRefeicao(e) || aguardandoCaminhao(e) || !!paradaImprodutiva(e);
    if (ehApontamentoParado && motorOn && vel !== null && vel >= 14 && vel <= 85) {
      return {
        subtipo: 'paradaEmMovimento',
        operacao: opBruta,
        velocidade: Math.round(vel),
        motivo: 'apontou "' + opBruta.replace(/^\d+\s*-\s*/, '') + '" mas está em movimento a ' + Math.round(vel) + ' km/h'
      };
    }
    return null;
  }

  function caminhaoEmBateVolta(e) {
    if (!e || typeof e !== 'object' || e.operacaoConfirmada !== true) return false;
    var tipo = norm([e.tipo, e.tipoCompleto, e.nome, e.grupoEquipamento].filter(Boolean).join(' '));
    if (!/caminh/.test(tipo) || /bombeir|munck|pipa|comboio|oficina|cacamb/.test(tipo)) return false;
    var op = norm(e.operacao || e.descOperacao || '').replace(/^\d+\s*-\s*/, '');
    if (/aguard|fila|carregando|bascul|manutenc|refeic|parada|sem apont/.test(op)) return false;
    return /\b(?:transporte|viagem|deslocamento|ida|retorno|bate\s*volta)\b/.test(op);
  }

  function detectarFalhaRecorrente(idEquipamento, hist, agoraMs, janelaMin, minOcorrencias) {
    var alvo = String(idEquipamento || '').trim();
    if (!alvo || !Array.isArray(hist)) return null;
    var ts = Number(agoraMs) || Date.now();
    var corte = ts - (Math.max(30, Number(janelaMin) || 240) * 60000);
    var minOc = Math.max(2, Number(minOcorrencias) || 3);
    var eventos = [];
    for (var i = 0; i < hist.length; i += 1) {
      var h = hist[i];
      if (!h || Number(h.ts) < corte) continue;
      var chaveId = String(h.chave || '').split('|')[0];
      if (chaveId !== alvo && String(h.equipamento || '') !== alvo) continue;
      var texto = norm([h.regra, h.nomeAlarme, h.texto].filter(Boolean).join(' '));
      var ehMecanico = h.regra === 'rpm' || h.regra === 'motorCondicao' ||
        (h.regra === 'paradaImprodutiva' && /\b(?:mecan|manut|socorro|borrach|eletric|oficina)/.test(texto));
      if (ehMecanico) eventos.push(h);
    }
    if (eventos.length < minOc) return null;
    return {
      ocorrencias: eventos.length,
      ultimoMotivo: eventos[0].nomeAlarme || eventos[0].texto || eventos[0].regra
    };
  }

  function calcularTermometroMoenda(resumoCtt, cfg) {
    var c = isObject(cfg) ? cfg : {};
    var meta = Math.max(0, Number(c.metaMoagemTonHora != null ? c.metaMoagemTonHora : 420));
    var taxaColh = Math.max(10, Number(c.tonHoraPorColhedora != null ? c.tonHoraPorColhedora : 65));
    var tot = (resumoCtt && resumoCtt.totais) || {};
    if (!meta) return { ativo: false, entregaTonHora: 0, metaTonHora: 0, pctMeta: 100, deficitTonHora: 0, status: 'desligado', texto: 'Meta desligada' };
    var bruta = (tot.colhedorasColhendo || 0) * taxaColh;
    // Se há transbordos retidos sem caminhão carregando, a entrega efetiva cai ~15%
    var fatorLogistica = (tot.transbordosAgCam || 0) >= 2 && (tot.caminhoesCarregando || 0) === 0 ? 0.85 : 1;
    var entrega = Math.round(bruta * fatorLogistica);
    var pct = Math.min(150, Math.round((entrega / meta) * 100));
    var deficit = Math.max(0, meta - entrega);
    var status = (tot.colhedoras || 0) === 0 ? 'aguardando' : pct >= 85 ? 'seguro' : pct >= 70 ? 'atencao' : 'risco';
    var texto = status === 'aguardando'
      ? 'Aguardando telemetria das colhedoras para estimar entrega na moenda'
      : 'Entrega estimada ' + entrega + ' t/h de ' + meta + ' t/h (' + pct + '% da meta)' +
        (deficit > 0 ? ' · déficit ' + deficit + ' t/h' : ' · ritmo pleno');
    return {
      ativo: true,
      colhedorasColhendo: tot.colhedorasColhendo || 0,
      colhedorasTotal: tot.colhedoras || 0,
      entregaTonHora: entrega,
      metaTonHora: meta,
      pctMeta: pct,
      deficitTonHora: deficit,
      status: status,
      texto: texto
    };
  }

  function classificarVeiculoApoio(e) {
    if (!e || typeof e !== 'object') return null;
    var txt = norm([e.tipo, e.tipoCompleto, e.nome, e.grupoEquipamento].filter(Boolean).join(' '));
    if (/\b(?:comboio|abastec|lubrific|melosa)\b/.test(txt)) return 'comboio';
    if (/\b(?:oficina|mecan|socorro|borrach|munck|manutenc)\b/.test(txt)) return 'oficina';
    if (/\b(?:bombeir|pipa|agua)\b/.test(txt)) return 'bombeiro';
    return null;
  }

  function calcularFilaComboioApoio(listaFrota, cfg, agoraMs) {
    var lista = Array.isArray(listaFrota) ? listaFrota : [];
    var ts = Number(agoraMs) || Date.now();
    var recursos = { comboios: [], oficinas: [], bombeiros: [] };
    var chamados = [];

    for (var i = 0; i < lista.length; i += 1) {
      var e = lista[i];
      if (!e || String(e.ativo || 'T') === 'F') continue;
      var pos = decodificarGeohash(e.geohash);
      var tipoApoio = classificarVeiculoApoio(e);
      if (tipoApoio) {
        var rec = {
          id: e.id,
          numero: e.numero || e.id,
          nome: e.nome || e.id,
          tipoApoio: tipoApoio,
          frente: e.frente || e.grupoEquipamento || 'Volante',
          local: e.local || '',
          operacao: e.operacao || 'Disponível',
          velocidade: numericAlertValue(e.velocidade) || 0,
          pos: pos
        };
        if (tipoApoio === 'comboio') recursos.comboios.push(rec);
        else if (tipoApoio === 'oficina') recursos.oficinas.push(rec);
        else recursos.bombeiros.push(rec);
      }

      if (e.operacaoConfirmada !== true) continue;
      var p = paradaImprodutiva(e);
      var opNorm = norm(e.operacao || e.descOperacao || '').replace(/^\d+\s*-\s*/, '');
      var categoriaApoio = null;
      var motivo = e.operacao || '';
      if ((p && p.id === 'aguardComboio') || /\b(?:comboio|abastec|falta combust|diesel)\b/.test(opNorm)) {
        categoriaApoio = 'comboio';
        motivo = (p && p.nome) || e.operacao || 'Aguardando comboio/abastecimento';
      } else if ((p && (p.id === 'aguardMecanico' || p.id === 'emManutencao' || p.id === 'equipamentoEncalhado')) ||
                 /\b(?:mecan|manutenc|borrach|socorro|eletric|encalhad|quebra)\b/.test(opNorm)) {
        if (!tipoApoio) {
          categoriaApoio = 'oficina';
          motivo = (p && p.nome) || e.operacao || 'Aguardando mecânico/manutenção';
        }
      } else if ((p && p.id === 'aguardAgua') || /\baguard\w*\s+(?:agua|pipa)\b/.test(opNorm)) {
        if (!tipoApoio) {
          categoriaApoio = 'bombeiro';
          motivo = (p && p.nome) || e.operacao || 'Aguardando água/pipa';
        }
      }
      if (!categoriaApoio) continue;

      var inicio = Number(e.operacaoTs) > 0 && Number(e.operacaoTs) <= ts ? Number(e.operacaoTs) : (ts - 10 * 60000);
      var minEspera = Math.max(1, Math.round((ts - inicio) / 60000));
      var custoInfo = custoHoraEquipamento(e, cfg);
      var pesoClasse = custoInfo.classeCusto === 'colhedora' ? 3.2 : custoInfo.classeCusto === 'transbordo' ? 1.6 : custoInfo.classeCusto === 'caminhao' ? 1.3 : 1.0;
      var custoRs = Math.round(minEspera * custoInfo.valorMinuto);
      var score = Math.round(pesoClasse * Math.max(5, minEspera) * 10);

      chamados.push({
        id: e.id,
        numero: e.numero || e.id,
        nome: e.nome || e.id,
        classeCusto: custoInfo.classeCusto,
        valorHora: custoInfo.valorHora,
        operador: e.operador || '',
        frente: e.frente || e.frenteInferida || e.grupoEquipamento || 'Sem frente',
        local: e.local || '',
        categoriaApoio: categoriaApoio,
        motivo: motivo,
        minutosEspera: minEspera,
        custoRs: custoRs,
        score: score,
        pos: pos,
        apoioMaisProximo: null,
        distanciaKm: null
      });
    }

    // Associa o veículo de apoio mais próximo (geohash ou mesma frente)
    for (var cIdx = 0; cIdx < chamados.length; cIdx += 1) {
      var ch = chamados[cIdx];
      var pool = ch.categoriaApoio === 'comboio' ? recursos.comboios
        : ch.categoriaApoio === 'oficina' ? recursos.oficinas
        : recursos.bombeiros;
      var melhor = null;
      var melhorKm = Infinity;
      for (var rIdx = 0; rIdx < pool.length; rIdx += 1) {
        var cand = pool[rIdx];
        var km = ch.pos && cand.pos ? distanciaKm(ch.pos, cand.pos) : null;
        if (km !== null && km < melhorKm) {
          melhorKm = km;
          melhor = cand;
        } else if (!melhor && norm(cand.frente) === norm(ch.frente)) {
          melhor = cand;
        }
      }
      if (!melhor && pool.length) melhor = pool[0];
      if (melhor) {
        ch.apoioMaisProximo = melhor.numero + ' (' + melhor.frente + ')';
        ch.apoioNumero = melhor.numero;
        ch.distanciaKm = Number.isFinite(melhorKm) ? melhorKm : null;
      }
    }

    chamados.sort(function (a, b) {
      return b.score - a.score || b.custoRs - a.custoRs || b.minutosEspera - a.minutosEspera;
    });

    for (var ord = 0; ord < chamados.length; ord += 1) {
      var item = chamados[ord];
      item.ordem = ord + 1;
      var ico = item.categoriaApoio === 'comboio' ? '⛽ [DESPACHO COMBOIO' : item.categoriaApoio === 'oficina' ? '🔧 [DESPACHO OFICINA' : '🚒 [DESPACHO PIPA';
      item.textoDespacho = ico + ' #' + item.ordem + ' — COA]\n' +
        'Atender Frota ' + item.numero + ' (' + item.nome + ') · ' + item.frente + (item.local ? ' · Talhão ' + item.local : '') + '\n' +
        'Situação: ' + item.motivo + ' há ' + item.minutosEspera + ' min (impacto ~R$ ' + item.custoRs + ')' +
        (item.apoioMaisProximo ? '\nUnidade recomendada: Apoio ' + item.apoioMaisProximo + (item.distanciaKm !== null ? ' a ' + item.distanciaKm + ' km' : '') : '') +
        '\nConfirmar chegada no rádio COA.';
    }

    return {
      chamados: chamados,
      recursos: recursos,
      resumo: {
        totalFila: chamados.length,
        filaComboio: chamados.filter(function (x) { return x.categoriaApoio === 'comboio'; }).length,
        filaOficina: chamados.filter(function (x) { return x.categoriaApoio === 'oficina'; }).length,
        custoFilaRs: chamados.reduce(function (s, x) { return s + x.custoRs; }, 0)
      }
    };
  }

  function avaliarRiscoIncendio303030(clima, bombeiros, posFrente, nomeFrente) {
    var c = isObject(clima) ? clima : {};
    var temp = Number(c.tempC != null ? c.tempC : 28);
    var umid = Number(c.umidadePct != null ? c.umidadePct : 48);
    var vento = Number(c.ventoKmH != null ? c.ventoKmH : 14);
    var chuvaMm = Number(c.chuvaMm != null ? c.chuvaMm : 0);

    var fTemp = temp >= 30;
    var fUmid = umid <= 30;
    var fVento = vento >= 30;
    var fatores = (fTemp ? 1 : 0) + (fUmid ? 1 : 0) + (fVento ? 1 : 0);

    var bandeira = 'verde';
    var nivel = 'BAIXO';
    if (chuvaMm >= 1) {
      bandeira = 'azul';
      nivel = 'CHUVA DETECTADA';
    } else if (fatores === 3) {
      bandeira = 'vermelha';
      nivel = 'EXTREMO · 30-30-30';
    } else if (fatores === 2 || (temp >= 33 && umid <= 28)) {
      bandeira = 'laranja';
      nivel = 'ALTO';
    } else if (fatores === 1) {
      bandeira = 'amarela';
      nivel = 'MODERADO';
    }

    var bLista = Array.isArray(bombeiros) ? bombeiros : [];
    var maisProximo = null;
    var menorKm = Infinity;
    for (var i = 0; i < bLista.length; i += 1) {
      var b = bLista[i];
      var bPos = b.pos || decodificarGeohash(b.geohash);
      var km = posFrente && bPos ? distanciaKm(posFrente, bPos) : null;
      if (km !== null && km < menorKm) {
        menorKm = km;
        maisProximo = { numero: b.numero || b.id, frente: b.frente || '', km: km };
      } else if (!maisProximo && nomeFrente && norm(b.frente) === norm(nomeFrente)) {
        maisProximo = { numero: b.numero || b.id, frente: b.frente || '', km: null };
      }
    }
    if (!maisProximo && bLista.length) {
      maisProximo = { numero: bLista[0].numero || bLista[0].id, frente: bLista[0].frente || '', km: null };
    }

    return {
      tempC: Math.round(temp * 10) / 10,
      umidadePct: Math.round(umid),
      ventoKmH: Math.round(vento),
      chuvaMm: Math.round(chuvaMm * 10) / 10,
      fatores303030: fatores,
      bandeira: bandeira,
      nivel: nivel,
      bombeiroProximo: maisProximo
    };
  }

  function gerarPlacarPositivoTurno(dados) {
    var d = isObject(dados) ? dados : {};
    var resumoCtt = d.resumoCtt || { frentes: [] };
    var frota = Array.isArray(d.frota) ? d.frota : [];
    var hist = Array.isArray(d.hist) ? d.hist : [];
    var ociososMapa = isObject(d.ociososMapa) ? d.ociososMapa : {};
    var turno = turnoAtualCoa(d.agoraMs);
    var histTurno = hist.filter(function (h) { return Number(h && h.ts) >= turno.inicioMs - 15 * 60000; });

    // 1) Frente Campeã
    var candidatas = (resumoCtt.frentes || []).filter(function (f) { return f.colhTotal > 0 || f.tbTotal > 0; });
    var frenteDestaque = null;
    var melhorNotaFrente = -999;
    for (var i = 0; i < candidatas.length; i += 1) {
      var f = candidatas[i];
      var disp = f.colhTotal > 0 ? (f.colhColhendo / f.colhTotal) * 100 : 60;
      var nota = disp - (f.camFila * 6) - (f.emergencias * 50) - (f.mudas * 8);
      if (nota > melhorNotaFrente) {
        melhorNotaFrente = nota;
        frenteDestaque = {
          frente: f.frente,
          colhColhendo: f.colhColhendo,
          colhTotal: f.colhTotal,
          camFila: f.camFila,
          nota: Math.max(0, Math.min(100, Math.round(nota)))
        };
      }
    }

    // 2) Operadores Exemplares (zero infração de velocidade/inconsistência + menor ociosidade)
    var infracoesPorOp = {};
    for (var j = 0; j < histTurno.length; j += 1) {
      var h = histTurno[j];
      var opNome = String(h.operador || '').trim();
      if (!opNome) continue;
      if (!infracoesPorOp[opNome]) infracoesPorOp[opNome] = { graves: 0, total: 0 };
      infracoesPorOp[opNome].total += 1;
      if (h.regra === 'velocidade' || h.regra === 'rpm' || h.regra === 'inconsistenciaApontamento') {
        infracoesPorOp[opNome].graves += 1;
      }
    }

    var porOperador = {};
    for (var k = 0; k < frota.length; k += 1) {
      var eq = frota[k];
      var nome = String((eq && eq.operador) || '').trim();
      if (!nome || /sem operador|nao definid/i.test(nome)) continue;
      var inf = infracoesPorOp[nome] || { graves: 0, total: 0 };
      if (inf.graves > 0) continue; // exemplar exige zero excesso de velocidade / RPM / falso apontamento
      var ocItem = ociososMapa[String(eq.id)] || {};
      var minOcioso = Math.round((Number(ocItem.segAcumulados) || 0) / 60);
      var scoreOp = 100 - Math.min(40, minOcioso * 2) - Math.min(20, inf.total * 5);
      if (!porOperador[nome] || scoreOp > porOperador[nome].score) {
        porOperador[nome] = {
          operador: nome,
          frota: eq.numero || eq.id,
          frente: eq.frente || eq.grupoEquipamento || '',
          minOcioso: minOcioso,
          score: scoreOp
        };
      }
    }

    var operadoresDestaque = Object.keys(porOperador).map(function (n) { return porOperador[n]; })
      .sort(function (a, b) { return b.score - a.score || a.minOcioso - b.minOcioso; })
      .slice(0, 3);

    var partesCurto = [];
    if (frenteDestaque) {
      partesCurto.push('🏆 Frente Destaque: ' + frenteDestaque.frente + ' (' + frenteDestaque.colhColhendo + '/' + frenteDestaque.colhTotal + ' colhedoras ativas · fila ' + frenteDestaque.camFila + ')');
    }
    if (operadoresDestaque.length) {
      partesCurto.push('⭐ Operadores Exemplares (0 infração): ' + operadoresDestaque.map(function (o) {
        return o.operador + ' (Frota ' + o.frota + ', ' + o.score + ' pts)';
      }).join(' · '));
    }
    var resumoCurto = partesCurto.join('\n');
    var textoDds = '🏆 *PLACAR POSITIVO DO TURNO (DDS) — ' + (d.unidade || 'Usina Branco Peres') + '*\n' +
      '📅 ' + turno.data + ' · ' + turno.nome + '\n\n' +
      (resumoCurto || 'Operação em andamento — aguardando consolidação da frota no turno.') +
      '\n\n👏 Parabéns às equipes pela condução segura, apontamento correto e baixo desperdício de diesel!';

    return {
      frenteDestaque: frenteDestaque,
      operadoresDestaque: operadoresDestaque,
      resumoCurto: resumoCurto,
      textoDds: textoDds
    };
  }

  function interpretarComandoCoa(frase) {
    var t = norm(frase);
    if (!t) return { acao: 'desconhecido', textoOriginal: '' };
    var numMatch = t.match(/\b(\d{2,6})\b/);
    if (/\b(?:onde esta|localizar|achar|buscar|cad[eê]|mostrar frota|ver frota)\b/.test(t) && numMatch) {
      return { acao: 'localizar', frota: numMatch[1] };
    }
    if (/\b(?:chuva)\b/.test(t)) {
      var frM = t.match(/frente\s*(\d+)/);
      return { acao: 'chuva', frente: frM ? 'Frente ' + frM[1] : 'Frente 1' };
    }
    if (/\b(?:comboio|abastec\w*|oficina|mecan\w*|apoio|uber)\b/.test(t)) {
      return { acao: 'comboio' };
    }
    if (/\b(?:moenda|moagem|custo\w*|taximetro|financeir\w*|tonelad\w*)\b/.test(t)) {
      return { acao: 'moenda' };
    }
    if (/\b(?:reconhec\w*|ciente|confirmar|cobrad\w*)\b/.test(t)) {
      return { acao: 'reconhecer' };
    }
    if (/\b(?:passagem|boletim|relatorio)\b/.test(t)) {
      return { acao: 'passagem' };
    }
    if (/\b(?:dds|placar|destaque\w*|campe\w*|elogio\w*)\b/.test(t)) {
      return { acao: 'dds' };
    }
    if (/\b(?:pente\s*fino|auditoria|sem\s+ciencia|pendent\w*)\b/.test(t)) {
      return { acao: 'pendentes' };
    }
    if (/\b(?:fixar|split|dividir|acoplar)\b/.test(t)) {
      return { acao: 'fixar' };
    }
    if (/\b(?:flow|controle\s+flow|caminhoes|veiculos\s+leves)\b/.test(t)) {
      return { acao: 'flow' };
    }
    if (/\b(?:resumo|frentes|situacao|panorama|ctt)\b/.test(t)) {
      return { acao: 'frentes' };
    }
    if (numMatch) {
      return { acao: 'localizar', frota: numMatch[1] };
    }
    return { acao: 'desconhecido', textoOriginal: String(frase || '') };
  }

  /* ------------------ Pente-Fino COA v5.0 ("Zero Agulha") ------------------ */

  function operandoSemOperador(e) {
    if (!e || typeof e !== 'object') return null;
    var opNome = String(e.operador || '').trim();
    var opBruto = norm(e.operadorBruto || e.descFuncionario || '');
    var semOp = !opNome || /\b(?:9999|sem operador|indefinido|nao definido|desconhecido|generic)\b/.test(opBruto);
    if (!semOp) return null;
    var opTxt = norm(e.operacao || e.descOperacao || '');
    if (String(e.cdOperacao || '') === '925' || /\btroca\s+de\s+turno\b/.test(opTxt)) return null;
    var vel = numericAlertValue(e.velocidade);
    var rpm = numericAlertValue(e.rpm);
    if (e.motor === true && rpm !== null && rpm >= 900 && vel !== null && vel >= 5) {
      return {
        velocidade: Math.round(vel),
        rpm: Math.round(rpm),
        operacao: String(e.operacao || e.descOperacao || 'Em movimento')
      };
    }
    return null;
  }

  function meiaChaveParada(e) {
    if (!e || typeof e !== 'object') return null;
    if (e.motor !== true) return null;
    var rpm = numericAlertValue(e.rpm);
    var vel = numericAlertValue(e.velocidade);
    if ((rpm === null || rpm === 0) && (vel === null || vel <= 0.5)) {
      return {
        operacao: String(e.operacao || e.descOperacao || 'Parado com ignição ligada')
      };
    }
    return null;
  }

  function abastecendoComMotorLigado(e) {
    if (!e || typeof e !== 'object' || e.operacaoConfirmada !== true) return null;
    if (e.motor !== true) return null;
    var rpm = numericAlertValue(e.rpm);
    if (rpm === null || rpm < 650) return null;
    var opBruta = String(e.operacao || e.descOperacao || '').trim();
    var op = norm(opBruta).replace(/^\d+\s*-\s*/, '').replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!op || /\baguard/.test(op)) return null;
    if (/^(?:abastec|lubrific|insumo\s+abast|abast\s+ins)/.test(op)) {
      return {
        rpm: Math.round(rpm),
        operacao: opBruta
      };
    }
    return null;
  }

  function avaliarMicroParadas(episodios, agoraMs, janelaMin, minEpisodios, minSomaMinutos) {
    if (!Array.isArray(episodios) || !episodios.length) return null;
    var ts = Number(agoraMs) || Date.now();
    var corte = ts - (Math.max(15, Number(janelaMin) || 60) * 60000);
    var qtdMin = Math.max(2, Number(minEpisodios) || 4);
    var somaAlvo = Math.max(5, Number(minSomaMinutos) || 16);
    var validos = [];
    var somaMin = 0;
    for (var i = 0; i < episodios.length; i += 1) {
      var ep = episodios[i];
      if (!ep || Number(ep.fimMs) < corte) continue;
      var durMin = Number(ep.duracaoMin);
      if (!Number.isFinite(durMin) || durMin < 1) continue;
      validos.push(ep);
      somaMin += durMin;
    }
    if (validos.length < qtdMin || somaMin < somaAlvo) return null;
    return {
      episodios: validos.length,
      minutosPerdidos: Math.round(somaMin)
    };
  }

  var VOZES_GEMINI_BR = [
    { id: 'Kore', nome: 'Kore — Firme e Comandante (Recomendada Coa / Rádio)', genero: 'feminina' },
    { id: 'Aoede', nome: 'Aoede — Natural, Clara e Fluida (Recomendada Geral)', genero: 'feminina' },
    { id: 'Puck', nome: 'Puck — Ágil e Dinâmica (Recomendada Flow)', genero: 'masculina' },
    { id: 'Charon', nome: 'Charon — Grave, Sóbria e Informativa', genero: 'masculina' },
    { id: 'Fenrir', nome: 'Fenrir — Energética (Alta Presença / Críticos)', genero: 'masculina' },
    { id: 'Leda', nome: 'Leda — Serena, Limpa e Suave', genero: 'feminina' },
    { id: 'Zephyr', nome: 'Zephyr — Brilhante e Alta Inteligibilidade', genero: 'feminina' },
    { id: 'Orus', nome: 'Orus — Sólida e Executiva', genero: 'masculina' },
    { id: 'Callirrhoe', nome: 'Callirrhoe — Articulada e Equilibrada', genero: 'feminina' },
    { id: 'Autonoe', nome: 'Autonoe — Calorosa e Natural', genero: 'feminina' },
    { id: 'Schedar', nome: 'Schedar — Estável e Cadenciada', genero: 'masculina' },
    { id: 'Sulafat', nome: 'Sulafat — Precisa em Números de Frota', genero: 'feminina' }
  ];

  var GRUPOS_PADRAO_USINA = [
    'COLHEDORAS',
    'TRATORES',
    'TRANSBORDOS',
    'LINHA AMARELA',
    'CAMINHÕES CANAVIEIROS',
    'CAMINHÕES CANAVIEIRO TERC',
    'CAMINHÕES BOMBEIROS',
    'CAMINHÕES COMBOIO',
    'CAMINHÕES PIPA / APOIO',
    'CAMINHÕES MUNCK / PRANCHA',
    'OFICINA VOLANTE',
    'VEÍCULOS LEVES'
  ];

  var FRENTES_PADRAO_USINA = [
    'Frente 1',
    'Frente 2',
    'Frente 3',
    'Frente 4',
    'Frente 5'
  ];

  function inferirGrupoCanonico(e) {
    if (!e || typeof e !== 'object') return [];
    var tags = [];
    var bruto = norm([e.grupoEquipamento, e.descGrupoEquipamento].filter(Boolean).join(' '));
    var texto = norm([e.grupoEquipamento, e.descGrupoEquipamento, e.tipo, e.tipoCompleto, e.nome, e.descEquipamento].filter(Boolean).join(' '));
    if (bruto) tags.push(bruto);
    if (ehGrupoBombeiro(null, e)) tags.push('caminhoes bombeiros');
    if (/\bcomboio|lubrific/.test(texto)) tags.push('caminhoes comboio');
    if (/\boficina\s+volante|socorro\s+mecan/.test(texto)) tags.push('oficina volante');
    if (/\bpipa|agua/.test(texto) && /\bcaminh/.test(texto) && !ehGrupoBombeiro(null, e)) tags.push('caminhoes pipa / apoio');
    if (/\bmunck|prancha|cacamba|basculante|guindauto/.test(texto)) tags.push('caminhoes munck / prancha');
    if (caminhaoCanavieiroTerceiro(e)) tags.push('caminhoes canavieiro terc');
    if (/\bcaminh/.test(texto) && /\bcanav/.test(texto)) tags.push('caminhoes canavieiros');
    if (/\bveiculos?\s+leves?|utilitari|camionet|caminhonet|strada|hilux|saveiro|gol\b|uno\b|mobi\b|fiorino|carro|viatura/.test(texto)) tags.push('veiculos leves');
    if (/\bcolhedor|colheitad/.test(texto)) tags.push('colhedoras');
    if (/\btransbordo/.test(texto)) tags.push('transbordos');
    if (tratorOuTransbordo(e) && /\btrator/.test(texto)) tags.push('tratores');
    if (/\bmotoniveladora|pa\s+carregadeira|escavadeira|retroescavadeira|trator\s+esteira|rolo\s+compactador|linha\s+amarela/.test(texto)) tags.push('linha amarela');
    return tags;
  }

  function grupoEquipamentoPermitido(cfg, e) {
    var normalized = normalizeCfg(cfg);
    if (normalized.setorMonitorado === 'FLOW' || normalized.setorMonitorado === 'COA') {
      if (setorControle(null, e) !== normalized.setorMonitorado) return false;
    }
    var selecionados = normalized.gruposEquipamento || [];
    if (!selecionados.length) return true;
    var tags = inferirGrupoCanonico(e);
    var grupoBruto = norm(e && (e.grupoEquipamento || e.descGrupoEquipamento) || '');
    for (var i = 0; i < selecionados.length; i += 1) {
      var alvo = norm(selecionados[i]);
      if (!alvo) continue;
      if (grupoBruto && grupoBruto === alvo) return true;
      if (tags.indexOf(alvo) !== -1) return true;
    }
    return false;
  }

  function raciocinarOperacaoCoa(contexto, pergunta) {
    var ctx = isObject(contexto) ? contexto : {};
    var ativos = Array.isArray(ctx.ativos) ? ctx.ativos : [];
    var ctt = isObject(ctx.resumoCtt) ? ctx.resumoCtt : { frentes: [], frotasMudas: [], sugestoesBalanceamento: [] };
    var moenda = isObject(ctx.moenda) ? ctx.moenda : { entregaTonHora: 0, metaTonHora: 420, pctMeta: 0, status: 'ok', deficitTonHora: 0 };
    var custo = isObject(ctx.custoTurno) ? ctx.custoTurno : { totalRs: 0 };
    var comboio = isObject(ctx.filaComboio) ? ctx.filaComboio : { chamados: [] };
    var alvoAlerta = isObject(ctx.alertaFoco) ? ctx.alertaFoco : null;
    var q = norm(pergunta || '');

    var criticos = ativos.filter(function (a) { return Number(a && a.severidade) >= 3; });
    var alertasCoa = ativos.filter(function (a) { return (a && a.setor) !== 'FLOW'; });
    var alertasFlow = ativos.filter(function (a) { return a && a.setor === 'FLOW'; });

    var hipoteses = [];
    var acoesCoa = [];
    var acoesFlow = [];

    if (alvoAlerta) {
      var setorAlvo = alvoAlerta.setor || setorControle(alvoAlerta, alvoAlerta.e);
      var frenteAlvo = (alvoAlerta.e && (alvoAlerta.e.frente || alvoAlerta.e.grupoEquipamento)) || 'sem frente informada';
      var opAlvo = (alvoAlerta.e && alvoAlerta.e.operacao) || 'não informada';
      var velAlvo = alvoAlerta.e && alvoAlerta.e.velocidade != null ? Math.round(Number(alvoAlerta.e.velocidade)) + ' km/h' : 'n/d';
      var rpmAlvo = alvoAlerta.e && alvoAlerta.e.rpm != null ? Math.round(Number(alvoAlerta.e.rpm)) + ' RPM' : 'n/d';
      hipoteses.push(
        alvoAlerta.classe + ' ' + alvoAlerta.numero + ' (' + frenteAlvo + '): ' + (alvoAlerta.nome || alvoAlerta.regra) +
        ' — telemetria cruzada indica operação "' + opAlvo + '", velocidade ' + velAlvo + ' e motor a ' + rpmAlvo + '.'
      );
      if (alvoAlerta.regra === 'aguardandoCaminhao' || alvoAlerta.regra === 'aguardandoBasculamento') {
        hipoteses.push('Causa provável: descompasso de chegada de canavieiros na frente ou caminhão já no carreador aguardando posicionamento de transbordo.');
        acoesCoa.push('Confirmar com líder da ' + frenteAlvo + ' se o transbordo ' + alvoAlerta.numero + ' está carregado pronto para bascular.');
        acoesFlow.push('Verificar caminhões em deslocamento/fila para ' + frenteAlvo + ' e antecipar despacho caso não haja canavieiro no raio.');
      } else if (alvoAlerta.regra === 'velocidade') {
        hipoteses.push('Alarme oficial emitido pelo portal SGPA acima do limite parametrizado para o trecho/equipamento.');
        if (setorAlvo === 'FLOW') acoesFlow.push('Acionar imediatamente motorista do ' + alvoAlerta.classe + ' ' + alvoAlerta.numero + ' no rádio e registrar tratativa de segurança.');
        else acoesCoa.push('Cobrar operador do ' + alvoAlerta.classe + ' ' + alvoAlerta.numero + ' no rádio para adequação imediata de velocidade segura.');
      } else if (alvoAlerta.regra === 'inconsistenciaApontamento' || alvoAlerta.regra === 'semApontamento' || alvoAlerta.regra === 'semOperadorTrabalhando') {
        hipoteses.push('Divergência entre estado físico do equipamento (RPM/velocidade) e apontamento no computador de bordo, distorcendo indicadores de eficiência.');
        if (setorAlvo === 'FLOW') acoesFlow.push('Solicitar correção imediata de apontamento/login no bordo da frota ' + alvoAlerta.numero + '.');
        else acoesCoa.push('Cobrar operador da frota ' + alvoAlerta.numero + ' (' + frenteAlvo + ') para corrigir apontamento no computador de bordo.');
      } else {
        if (setorAlvo === 'FLOW') acoesFlow.push('Tratar ocorrência do ' + alvoAlerta.classe + ' ' + alvoAlerta.numero + ' (' + (alvoAlerta.texto || alvoAlerta.nome) + ') junto à logística Flow.');
        else acoesCoa.push('Atuar sobre ' + alvoAlerta.classe + ' ' + alvoAlerta.numero + ' na ' + frenteAlvo + ' (' + (alvoAlerta.texto || alvoAlerta.nome) + ').');
      }
    }

    var frentes = Array.isArray(ctt.frentes) ? ctt.frentes : [];
    for (var i = 0; i < frentes.length; i += 1) {
      var f = frentes[i];
      if (f.colhedorasTotal > 0 && f.colhedorasColhendo === 0) {
        hipoteses.push(f.frente + ' está com 100% das colhedoras paradas (' + f.colhedorasTotal + ' máquinas) — impacto direto na alimentação de cana.');
        acoesCoa.push('Prioridade máxima na ' + f.frente + ': destravar colhedoras paradas (checar falta de transbordo, troca de facas ou manutenção).');
      } else if (f.transbordos905 >= 2 && f.caminhoesFila === 0) {
        hipoteses.push(f.frente + ' sofre fome logística de transporte: ' + f.transbordos905 + ' transbordos retidos em 905 (Aguardando Caminhão) e zero caminhões na fila.');
        acoesFlow.push('Redirecionar caminhões canavieiros imediatamente para ' + f.frente + ' para escoar ' + f.transbordos905 + ' transbordos cheios.');
      } else if (f.caminhoesFila >= 4) {
        hipoteses.push(f.frente + ' apresenta gargalo de carregamento: ' + f.caminhoesFila + ' caminhões acumulando fila (' + f.colhedorasColhendo + '/' + f.colhedorasTotal + ' colhedoras colhendo).');
        acoesFlow.push('Segurar envio adicional e redistribuir excesso de caminhões da ' + f.frente + ' para frentes com transbordo aguardando.');
        acoesCoa.push('Validar ritmo de colheita e chamada de transbordos no FUT na ' + f.frente + '.');
      }
    }

    if (Array.isArray(ctt.sugestoesBalanceamento) && ctt.sugestoesBalanceamento.length) {
      acoesFlow.push('Balanceamento dinâmico: ' + ctt.sugestoesBalanceamento[0].texto);
    }

    if (moenda.metaTonHora > 0 && moenda.status === 'risco') {
      hipoteses.push('Risco de falta de cana na moenda: entrega estimada em ' + moenda.entregaTonHora + ' t/h (' + moenda.pctMeta + '% da meta de ' + moenda.metaTonHora + ' t/h; déficit de ' + moenda.deficitTonHora + ' t/h).');
      acoesCoa.push('Focar recuperação imediata de colhedoras paradas para recompor ' + moenda.deficitTonHora + ' t/h de moagem.');
    }

    if (Array.isArray(comboio.chamados) && comboio.chamados.length) {
      var top = comboio.chamados[0];
      acoesFlow.push('Despachar apoio/comboio ' + (top.apoioNumero ? '#' + top.apoioNumero : 'mais próximo') + ' primeiro para ' + top.classe + ' ' + top.numero + ' (' + top.frente + ') — maior peso produtivo.');
    }

    var micro = ativos.filter(function (a) { return a.regra === 'microParadasCronicas' || a.regra === 'manutencaoPreditiva'; });
    if (micro.length) {
      hipoteses.push(micro.length + ' equipamento(s) com padrão serrote / falha recorrente (' + micro.slice(0, 3).map(function (m) { return m.numero; }).join(', ') + ') — risco de quebra mecânica maior no turno.');
      acoesCoa.push('Solicitar inspeção preventiva da oficina volante nas frotas ' + micro.slice(0, 3).map(function (m) { return m.numero; }).join(', ') + '.');
    }

    if (/\bflow\b|caminh|leve/.test(q) && !acoesFlow.length) {
      acoesFlow.push(alertasFlow.length ? ('Atuar nos ' + alertasFlow.length + ' alerta(s) ativos do Controle Flow, começando pelos de velocidade/bate-volta.') : 'Frota rodoviária e veículos leves do Controle Flow operando sem alertas críticos no momento.');
    }
    if (!hipoteses.length) {
      hipoteses.push(ativos.length
        ? ('Operação com ' + ativos.length + ' alerta(s) ativo(s) (' + alertasCoa.length + ' Coa · ' + alertasFlow.length + ' Flow · ' + criticos.length + ' crítico(s)), sem colapso estrutural de frente.')
        : 'Operação estabilizada: nenhum gargalo crítico entre colheita (Coa) e transporte (Flow) detectado nos dados atuais.');
    }
    if (!acoesCoa.length) {
      acoesCoa.push(alertasCoa.length ? ('Tratar os ' + alertasCoa.length + ' alerta(s) da mesa Coa por ordem de severidade e tempo de parada.') : 'Manter monitoramento preventivo de sincronismo CTT e apontamento de bordo.');
    }
    if (!acoesFlow.length) {
      acoesFlow.push(alertasFlow.length ? ('Tratar os ' + alertasFlow.length + ' alerta(s) da mesa Flow (caminhões e leves) priorizando segurança e giro de viagem.') : 'Manter cadência de despacho de caminhões equilibrada entre as frentes ativas.');
    }

    var impacto = 'Moenda: ' + (moenda.entregaTonHora || 0) + '/' + (moenda.metaTonHora || 420) + ' t/h · Custo improdutivo acumulado no turno: R$ ' + Math.round(Number(custo.totalRs) || 0).toLocaleString('pt-BR');
    var msgRadio = 'Atenção Coa e Flow: ' + (acoesCoa[0] || '') + ' ' + (acoesFlow[0] || '');

    var linhas = [
      '• Diagnóstico Causa-Raiz:',
      '  - ' + hipoteses.join('\n  - '),
      '',
      '• Impacto Operacional & Financeiro:',
      '  - ' + impacto,
      '',
      '• Ações Imediatas — Controle Coa:',
      '  - ' + acoesCoa.join('\n  - '),
      '',
      '• Ações Imediatas — Controle Flow:',
      '  - ' + acoesFlow.join('\n  - '),
      '',
      '• Mensagem Pronta de Rádio / WhatsApp:',
      '  "' + msgRadio.trim() + '"'
    ];

    return {
      ok: true,
      origem: 'especialista-local',
      modelo: 'Motor Causal COA/FLOW v6.0',
      hipotesesCausaRaiz: hipoteses,
      acoesCoa: acoesCoa,
      acoesFlow: acoesFlow,
      impactoEstimado: impacto,
      mensagemRadio: msgRadio.trim(),
      analise: linhas.join('\n')
    };
  }

  return Object.freeze({
    norm: norm,
    alarmeTrocaDeTurno: alarmeTrocaDeTurno,
    categoria: categoria,
    idFalado: idFalado,
    aguardandoCaminhao: aguardandoCaminhao,
    caminhaoCanavieiroTerceiro: caminhaoCanavieiroTerceiro,
    frenteDividida: frenteDividida,
    semApontamento: semApontamento,
    emRefeicao: emRefeicao,
    ehGrupoBombeiro: ehGrupoBombeiro,
    classeEquipamentoFalado: classeEquipamentoFalado,
    setorControle: setorControle,
    CATEGORIAS: CATEGORIAS,
    PARADAS: PARADAS,
    VOZES_GEMINI_BR: VOZES_GEMINI_BR,
    GRUPOS_PADRAO_USINA: GRUPOS_PADRAO_USINA,
    FRENTES_PADRAO_USINA: FRENTES_PADRAO_USINA,
    paradaImprodutiva: paradaImprodutiva,
    limiteParada: limiteParada,
    liderFrente: liderFrente,
    aplicarGlossario: aplicarGlossario,
    GLOSSARIO_PADRAO: GLOSSARIO_PADRAO,
    limiteRefeicao: limiteRefeicao,
    mapaEquipamentos: mapaEquipamentos,
    normalizeCfg: normalizeCfg,
    ehAlertaCritico: ehAlertaCritico,
    grupoEquipamentoPermitido: grupoEquipamentoPermitido,
    notificar: notificar,
    montarFala: montarFala,
    ehAlertaSeguranca: ehAlertaSeguranca,
    emergenciaOperacional: emergenciaOperacional,
    colheitaAcimaDaFaixa: colheitaAcimaDaFaixa,
    frotaMudaElegivel: frotaMudaElegivel,
    analisarFrentesCtt: analisarFrentesCtt,
    textoCobrancaWhatsApp: textoCobrancaWhatsApp,
    turnoAtualCoa: turnoAtualCoa,
    gerarBoletimPassagemTurno: gerarBoletimPassagemTurno,
    decodificarGeohash: decodificarGeohash,
    distanciaKm: distanciaKm,
    custoHoraEquipamento: custoHoraEquipamento,
    inconsistenciaApontamento: inconsistenciaApontamento,
    caminhaoEmBateVolta: caminhaoEmBateVolta,
    detectarFalhaRecorrente: detectarFalhaRecorrente,
    calcularTermometroMoenda: calcularTermometroMoenda,
    calcularFilaComboioApoio: calcularFilaComboioApoio,
    avaliarRiscoIncendio303030: avaliarRiscoIncendio303030,
    gerarPlacarPositivoTurno: gerarPlacarPositivoTurno,
    interpretarComandoCoa: interpretarComandoCoa,
    raciocinarOperacaoCoa: raciocinarOperacaoCoa,
    operandoSemOperador: operandoSemOperador,
    meiaChaveParada: meiaChaveParada,
    abastecendoComMotorLigado: abastecendoComMotorLigado,
    avaliarMicroParadas: avaliarMicroParadas
  });
}));
