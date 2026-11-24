(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlertasPolicy = factory();
  }
}(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis), function () {
  'use strict';

  var CATEGORIAS = ['velocidade', 'rpm', 'ocioso', 'turno', 'motorCondicao', 'generico', 'aguardandoCaminhao', 'aguardandoBasculamento', 'frenteDividida', 'semApontamento', 'refeicao', 'paradaImprodutiva', 'gestaoFrente'];
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
    gestaoFrente: true
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
    { id: 'aguardMecanico', nome: 'Aguardando mecânico/socorro', min: 30, re: /^ag(?:uardando|uard)? (?:mecanico|socorro|manutencao|borracheiro|eletricista)/ }
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
    if (selectedCategory === 'semApontamento') {
      var frente = frenteOuGrupo(event);
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
    montarFala: montarFala
  });
}));
