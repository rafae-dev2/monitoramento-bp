(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlertasPolicy = factory();
  }
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis), function () {
  'use strict';

  var CATEGORIAS = ['velocidade', 'rpm', 'ocioso', 'turno', 'motorCondicao', 'generico', 'aguardandoCaminhao', 'aguardandoBasculamento', 'frenteDividida', 'semApontamento', 'refeicao', 'paradaImprodutiva', 'gestaoFrente', 'emergencia', 'telemetriaMuda', 'qualidadeColheita'];
  var DEFAULTS = {
    velocidade: true,
    rpm: true,
    ocioso: true,
    turno: true,
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
    qualidadeColheita: true
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
    var tipo = norm([e.tipo, e.tipoCompleto].filter(function (v) { return v != null; }).join(' '));
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
    { id: 'emManutencao', nome: 'Em manutenção (mecânica/borracharia)', min: 45, re: /^(?:em )?manutencao\b|^borracharia\b|^mecanica\b|^eletrica\b|^oficina\b/ }
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
        motorcondicao: 'motorCondicao', generico: 'generico', aguardandocaminhao: 'aguardandoCaminhao', aguardandobasculamento: 'aguardandoBasculamento', frentedividida: 'frenteDividida', semapontamento: 'semApontamento', refeicao: 'refeicao', paradaimprodutiva: 'paradaImprodutiva', gestaofrente: 'gestaoFrente',
        ociososemapontamento: 'ocioso', emergencia: 'emergencia', telemetriamuda: 'telemetriaMuda', qualidadecolheita: 'qualidadeColheita'
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

  /* Glossário de pronúncia: abreviações do SGPA → como a voz deve falar.
     Padrões abaixo; o usuário acrescenta/substitui em cfg.glossarioFala
     (uma regra por linha ou separada por ";": "AG=Aguardando"). Vazio = não falar o termo. */
  var GLOSSARIO_PADRAO = [
    ['ag', 'Aguardando'], ['aguard', 'Aguardando'], ['colh', 'colhedora'],
    ['sequenc', 'sequência'], ['transp', 'transporte'], ['bascul', 'basculamento'],
    ['transbo', 'transbordo'], ['manut', 'manutenção'], ['terc', 'Terceiro']
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
  function classeEquipamentoFalado(alert, event) {
    var classe = alert && alert.classe != null ? String(alert.classe).trim() : '';
    if (classe) return classe;
    var tipo = norm([
      event && event.tipoCompleto, event && event.tipo, event && event.nome,
      alert && alert.tipoCompleto, alert && alert.tipo, alert && alert.descricao
    ].filter(Boolean).join(' '));
    if (/\btrator\b/.test(tipo)) return 'Trator';
    if (/\bcolhedora\b/.test(tipo)) return 'Colhedora';
    if (/\btransbordo\b/.test(tipo)) return 'Transbordo';
    if (/\bcaminh(?:ao|oes)\b|\btruck\b/.test(tipo)) return 'Caminhão';
    return 'Veículo';
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

    if (selectedCategory === 'aguardandoCaminhao' || (!item.regra && !item.categoria && !codeFromAlert(item) && aguardandoCaminhao(event))) {
      var front = frenteOuGrupo(event);
      return 'Trator ' + vehicleNumber(item, event) + ' aguardando caminhão. Frente/grupo ' + String(front).trim() + '. Verificar.';
    }

    if (selectedCategory === 'aguardandoBasculamento') {
      var truckIds = Array.isArray(item.caminhoes) ? item.caminhoes.map(function (id) { return idFalado(id); }).filter(Boolean) : [];
      var basculamentoFrente = frenteOuGrupo(event);
      var truckText = truckIds.length > 1
        ? 'os caminhões ' + truckIds.join(', ') + ' estão aguardando carregamento na mesma frente'
        : truckIds.length === 1
          ? 'o caminhão ' + truckIds[0] + ' está aguardando carregamento na mesma frente'
          : 'há caminhão aguardando carregamento na mesma frente';
      return 'Trator ' + vehicleNumber(item, event) + ': aguardando basculamento, inferido pelo aplicativo porque ' + truckText +
        '. Frente/grupo ' + basculamentoFrente + '. No SGPA, o apontamento permanece Aguardando Caminhão. Verificar.';
    }

    if (selectedCategory === 'frenteDividida') {
      var frenteDividida = frenteOuGrupo(event);
      var tipoFrenteDividida = norm([event.tipo, event.tipoCompleto, event.nome].filter(Boolean).join(' '));
      var classeFrenteDividida = item.classe || (/transbordo/.test(tipoFrenteDividida) ? 'Transbordo' : 'Trator');
      return 'Atenção COA: ' + classeFrenteDividida + ' ' + vehicleNumber(item, event) +
        ' apontou Frente dividida. Frente/grupo ' + frenteDividida + '. Verificar a sequência de chamada da colhedora no sistema FUT.';
    }

    if (selectedCategory === 'refeicao') {
      var fr = frenteOuGrupo(event);
      var vc = item.classe == null || String(item.classe).trim() === '' ? 'Veículo' : String(item.classe).trim();
      var dur = numericAlertValue(item.valor);
      var lim = numericAlertValue(item.limite);
      return vc + ' ' + vehicleNumber(item, event) + ' excedeu o tempo de refeição' +
        (dur ? ': ' + String(dur) + ' minutos' : '') +
        (lim ? ', limite de ' + String(lim) + ' minutos' : '') +
        '. Frente/grupo ' + String(fr).trim() + '. Verificar.';
    }
    if (selectedCategory === 'paradaImprodutiva') {
      var fp = frenteOuGrupo(event);
      var cp = item.classe == null || String(item.classe).trim() === '' ? 'Veículo' : String(item.classe).trim();
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
        return prefixo + 'Caminhão ' + vehicleNumber(item, event) + ' aguardando carregamento' +
          (mp ? ' há ' + String(mp) + (mp === 1 ? ' minuto' : ' minutos') : '') +
          ', se encontra ' + localColheita + '.' + (sufixo || ' Verificar.');
      }
      if (item.paradaId === 'aguardandoCarregamento') {
        var carregamentoSemFrente = String(item.paradaNome || 'Aguardando carregamento')
          .replace(/\s*\(\s*caminh(?:ão|ões|ao|oes)\s*\)/i, '')
          .replace(/\s*\(\d+\)/, '');
        return prefixo + cp + ' ' + vehicleNumber(item, event) + ' em ' + carregamentoSemFrente +
          (mp ? ' há ' + String(mp) + (mp === 1 ? ' minuto' : ' minutos') : '') +
          '.' + (sufixo || ' Verificar.');
      }
      return prefixo + cp + ' ' + vehicleNumber(item, event) + ' em ' + String(item.paradaNome || 'parada improdutiva').replace(/\s*\(\d+\)/, '') +
        (mp ? ' há ' + String(mp) + (mp === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(fp).trim() + '.' + (sufixo || ' Verificar.');
    }
    if (selectedCategory === 'gestaoFrente') {
      var ff = event.frente == null || String(event.frente).trim() === '' ? 'não informada' : String(event.frente).trim();
      return 'Atenção gestão, ' + (/^frente\b/i.test(ff) ? ff : 'frente ' + ff) + ': ' + String(item.texto || '') .replace(/\s*·.*$/, '') + '.' +
        (item.lider ? ' Líder ' + item.lider + '.' : '') + ' Verificar.';
    }
    if (selectedCategory === 'emergencia') {
      var fem = frenteOuGrupo(event);
      var cem = item.classe == null || String(item.classe).trim() === '' ? vehicleClass : String(item.classe).trim();
      var txtEm = cleanMessage(item.texto) || 'ocorrência de incêndio ou emergência';
      return 'Emergência C O A! ' + cem + ' ' + vehicleNumber(item, event) + ': ' + txtEm + '. Frente/grupo ' + String(fem).trim() + '. Atenção imediata.';
    }
    if (selectedCategory === 'telemetriaMuda') {
      var ftm = frenteOuGrupo(event);
      var ctm = item.classe == null || String(item.classe).trim() === '' ? vehicleClass : String(item.classe).trim();
      var mtm = numericAlertValue(item.valor);
      return 'Atenção C O A: ' + ctm + ' ' + vehicleNumber(item, event) + ' sem comunicação de telemetria' +
        (mtm ? ' há ' + String(mtm) + (mtm === 1 ? ' minuto' : ' minutos') : '') +
        '. Frente/grupo ' + String(ftm).trim() + '. Verificar computador de bordo.';
    }
    if (selectedCategory === 'qualidadeColheita') {
      var fqc = frenteOuGrupo(event);
      var numDec = function (v) {
        var n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return null;
        return String(Math.round(n * 10) / 10).replace('.', ' vírgula ');
      };
      var vqc = numDec(item.valor);
      var lqc = numDec(item.limite);
      return 'Qualidade de colheita: Colhedora ' + vehicleNumber(item, event) +
        (vqc !== null ? ' colhendo a ' + vqc + ' quilômetros por hora' : ' acima da velocidade técnica') +
        (lqc !== null ? ', limite técnico de ' + lqc : '') +
        '. Frente/grupo ' + String(fqc).trim() + '. Verificar.';
    }
    if (selectedCategory === 'semApontamento') {
      var frente = frenteOuGrupo(event);
      var vClass = item.classe == null || String(item.classe).trim() === '' ? 'Veículo' : String(item.classe).trim();
      var minutos = numericAlertValue(item.valor);
      return vClass + ' ' + vehicleNumber(item, event) + ' sem apontamento' +
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
      return vehicleClass + ' ' + identification + ': ' + aprovada.texto + complemento + '. Verificar.';
    }

    if (selectedCategory === 'velocidade') {
      var speed = numericAlertValue(item.valor);
      if (speed === null) {
        return vehicleClass + ' ' + identification + ' com alarme oficial de velocidade excedida. Verificar.';
      }
      return vehicleClass + ' ' + identification + ' excedeu a velocidade a ' + String(speed) + ' quilômetros por hora. Verificar.';
    }

    var message = cleanMessage(item.texto);
    return vehicleClass + ' ' + identification + (message ? ': ' + message : '') + '. Verificar.';
  }

  /* ------------------ Inteligência COA (Solinftec / CTT) ------------------ */

  function ehAlertaSeguranca(regra) {
    var r = String(regra || '');
    return r === 'emergencia' || r === 'velocidade' || r === 'rpm' || r === 'motorCondicao';
  }

  function emergenciaOperacional(e) {
    if (!e || typeof e !== 'object') return null;
    var opBruta = e.operacao || e.descOperacao || '';
    var op = norm(opBruta).replace(/^\d+\s*-\s*/, '').replace(/[._\-\/]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (e.operacaoConfirmada === true && /\b(?:incendio|fogo|queimada|combate a? ?incendio|emergencia fogo|sinistro)\b/.test(op)) {
      return { tipo: 'incendio', motivo: opBruta || 'Combate a incêndio' };
    }
    var tipo = norm([e.tipo, e.tipoCompleto, e.nome, e.grupoEquipamento].filter(Boolean).join(' '));
    var vel = numericAlertValue(e.velocidade);
    if (/bombeir/.test(tipo) && vel !== null && vel >= 40) {
      return { tipo: 'bombeiro', motivo: 'Caminhão bombeiro em deslocamento rápido (' + Math.round(vel) + ' km/h)' };
    }
    return null;
  }

  function colheitaAcimaDaFaixa(e, limiteKmH) {
    if (!e || typeof e !== 'object' || e.operacaoConfirmada !== true) return false;
    var lim = Number(limiteKmH);
    if (!Number.isFinite(lim) || lim <= 0) return false;
    var tipo = norm([e.tipo, e.tipoCompleto, e.nome].filter(Boolean).join(' '));
    if (!/colhed/.test(tipo)) return false;
    var op = norm(e.operacao || e.descOperacao || '').replace(/^\d+\s*-\s*/, '');
    if (!/(?:colheita|colhendo|corte\s+mecaniz)/.test(op)) return false;
    if (/(?:aguard|parada|manobra|desloc|manutenc|transp|refeic|sem apont|troca)/.test(op)) return false;
    var vel = numericAlertValue(e.velocidade);
    return vel !== null && vel > lim;
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
      var muda = minutosMuda > 0 && atrasoSeg !== null && atrasoSeg >= minutosMuda * 60 && atrasoSeg <= 12 * 3600;
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

  return Object.freeze({
    norm: norm,
    categoria: categoria,
    idFalado: idFalado,
    aguardandoCaminhao: aguardandoCaminhao,
    caminhaoCanavieiroTerceiro: caminhaoCanavieiroTerceiro,
    frenteDividida: frenteDividida,
    semApontamento: semApontamento,
    emRefeicao: emRefeicao,
    PARADAS: PARADAS,
    paradaImprodutiva: paradaImprodutiva,
    limiteParada: limiteParada,
    liderFrente: liderFrente,
    aplicarGlossario: aplicarGlossario,
    GLOSSARIO_PADRAO: GLOSSARIO_PADRAO,
    limiteRefeicao: limiteRefeicao,
    mapaEquipamentos: mapaEquipamentos,
    normalizeCfg: normalizeCfg,
    notificar: notificar,
    montarFala: montarFala,
    ehAlertaSeguranca: ehAlertaSeguranca,
    emergenciaOperacional: emergenciaOperacional,
    colheitaAcimaDaFaixa: colheitaAcimaDaFaixa,
    analisarFrentesCtt: analisarFrentesCtt,
    textoCobrancaWhatsApp: textoCobrancaWhatsApp,
    turnoAtualCoa: turnoAtualCoa,
    gerarBoletimPassagemTurno: gerarBoletimPassagemTurno
  });
}));
