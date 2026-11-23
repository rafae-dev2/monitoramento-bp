'use strict';

const assert = require('node:assert/strict');
const policy = require('../public/alerts-policy.js');

// UMD/normalização básica.
assert.equal(typeof policy.norm, 'function');
assert.equal(policy.norm('  Aguardando   CAMINHÃO\t'), 'aguardando caminhao');
assert.equal(policy.norm(null), '');

// IDs conhecidos, códigos de condição do motor e detecção conservadora de desconhecidos.
assert.equal(policy.categoria(5, ''), 'velocidade');
for (const code of [2203, 2685, 1641, 10820, 12600, 11400, 11480, 12724]) assert.equal(policy.categoria(code, ''), 'velocidade');
for (const code of [4, 6, 8]) assert.equal(policy.categoria(code, ''), 'rpm');
for (const code of [11, 2343, 2207]) assert.equal(policy.categoria(code, ''), 'ocioso');
for (const code of [2849, 2851]) assert.equal(policy.categoria(code, ''), 'turno');
assert.equal(policy.categoria(2697, 'alarme_vel'), 'motorCondicao');
assert.equal(policy.categoria(2699, 'Velocidade'), 'motorCondicao');
assert.equal(policy.categoria('2697/5', 'Velocidade'), 'motorCondicao');
assert.equal(policy.categoria('desconhecido', 'Controle_Vel ativado'), 'velocidade');
assert.equal(policy.categoria('desconhecido', 'ALARME_VEL'), 'velocidade');
assert.equal(policy.categoria('desconhecido', 'VL _60 KM/H'), 'velocidade');
assert.equal(policy.categoria('desconhecido', 'DIGITAR_OP_VL'), 'generico');
assert.equal(policy.categoria('desconhecido', 'SEM OPERADOR'), 'generico');
assert.equal(policy.categoria('desconhecido', 'alarme de rotação'), 'generico');
assert.equal(policy.categoria('desconhecido', 'velocidade e rpm'), 'velocidade');

// Dígitos falados mantêm zeros e IDs alfanuméricos não são apagados.
assert.equal(policy.idFalado('0083'), 'zero zero oito três');
assert.equal(policy.idFalado('8833'), 'oito oito três três');
assert.equal(policy.idFalado('AB-001'), 'AB- zero zero um');
assert.equal(policy.idFalado(''), '');
assert.equal(policy.idFalado(null), '');

// Matcher exige tipo pertinente e a operação exata; acentos, prefixo e sufixos permitidos.
assert.equal(policy.aguardandoCaminhao({ tipo: 'Trator agrícola', operacao: 'Aguardando Caminhão' }), true);
assert.equal(policy.aguardandoCaminhao({ tipoCompleto: 'Transbordo', operacao: '123 - Aguardando Caminhao' }), true);
assert.equal(policy.aguardandoCaminhao({ tipo: 'Trator', operacao: '456-Aguardando Caminhão - HD' }), true);
assert.equal(policy.aguardandoCaminhao({ tipoCompleto: 'Transbordo agrícola', operacao: 'Aguardando Caminhao - HR' }), true);
assert.equal(policy.aguardandoCaminhao({ tipo: 'Caminhão', operacao: 'Aguardando Caminhão' }), false);
assert.equal(policy.aguardandoCaminhao({ tipo: 'Trator', operacao: 'Aguardando Carregamento' }), false);
assert.equal(policy.aguardandoCaminhao({ tipo: 'Transbordo', operacao: 'Aguard Bascul Transbo' }), false);
assert.equal(policy.aguardandoCaminhao({ tipo: 'Trator', operacao: 'Aguardando Caminhao - XX' }), false);
assert.equal(policy.aguardandoCaminhao({ tipo: 'Trator', operacao: 'prefixo 123 - Aguardando Caminhao' }), false);

// Só classifica operações explicitamente sem apontamento, não carregamento ou nomes parecidos.
assert.equal(policy.semApontamento({ operacao: '3484 - SEM APONTAMENTO' }), true);
assert.equal(policy.semApontamento({ operacao: 'SEM APONTAMENTO - TPL' }), true);
assert.equal(policy.semApontamento({ operacao: 'SEM APONTAMENTO CCT' }), true);
assert.equal(policy.semApontamento({ operacao: 'DIGITAR_OP_VL' }), true);
assert.equal(policy.semApontamento({ operacao: 'Não Apontar Aguardando Carregamento' }), false);
assert.equal(policy.semApontamento({ operacao: 'Aguardando Carregamento' }), false);

// Preferências legadas, merge de categorias e prioridade explícita por tipo individual.
const cfgLegacy = policy.normalizeCfg({ incluirOutros: false, notificarCategorias: { velocidade: false } });
assert.equal(cfgLegacy.notificarCategorias.velocidade, false);
assert.equal(cfgLegacy.notificarCategorias.generico, false);
assert.equal(cfgLegacy.notificarCategorias.rpm, true);
assert.equal(cfgLegacy.notificarCategorias.aguardandoCaminhao, true);
const cfgExplicit = policy.normalizeCfg({ incluirOutros: false, notificarCategorias: { generico: true, rpm: false } });
assert.equal(cfgExplicit.notificarCategorias.generico, true);
assert.equal(cfgExplicit.notificarCategorias.rpm, false);
assert.equal(cfgExplicit.notificarCategorias.motorCondicao, true);
assert.equal(policy.notificar({}, { codigo: 5 }), true);
assert.equal(policy.notificar({ notificarCategorias: { velocidade: false }, tiposNotificacao: { 5: true } }, { codigo: 5 }), true);
assert.equal(policy.notificar({ notificarCategorias: { velocidade: false } }, { codigo: 5 }), false);
assert.equal(policy.notificar({ tiposNotificacao: { 5: false } }, { codigo: 5 }), false);
assert.equal(policy.notificar({ tiposNotificacao: { 5: true } }, { codigo: 5 }), true);
assert.equal(policy.notificar({ incluirOutros: false }, { codigo: 777, descricao: 'alerta comum' }), false);
assert.equal(policy.notificar({ incluirOutros: false, notificarCategorias: { generico: true } }, { codigo: 777 }), true);
assert.equal(policy.notificar({ tiposNotificacao: { 2697: false } }, { codigo: 2697, descricao: 'Velocidade' }), false);
assert.equal(policy.notificar({ notificarCategorias: { aguardandoCaminhao: false } }, { e: { tipo: 'Trator', operacao: 'Aguardando Caminhão' } }), false);
assert.equal(policy.notificar({}, { e: { tipo: 'Transbordo', operacao: 'Aguardando Caminhao' } }), true);
assert.equal(policy.notificar({ tiposNotificacao: { 41: false } }, { e: { codigo: 41, tipo: 'Trator', operacao: 'Aguardando Caminhao' } }), false);

// Fala: identificador soletrado; valor da velocidade numérico arredondado; ausência não vira zero.
assert.equal(policy.montarFala({ codigo: 2203, numero: '8833', valor: 85 }), 'Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 2203, numero: '0083', valor: '85.6', operador: 'Ana' }), 'Veículo zero zero oito três excedeu a velocidade a 86 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 2203, numero: '8833', valor: null }), 'Veículo oito oito três três com alarme oficial de velocidade excedida. Verificar.');
for (const value of [undefined, '', '   ', 'N/A', 'null', 'NaN', Infinity, -1]) {
  assert.match(policy.montarFala({ codigo: 5, numero: '12', valor: value }), /com alarme oficial de velocidade excedida/);
}
assert.match(policy.montarFala({ codigo: 5, numero: '12', valor: 0 }), /a 0 quilômetros por hora/);

// Expansões aprovadas pelo usuário no DOCX; códigos sem explicação não recebem tradução presumida.
const falasAprovadas = {
  12744: 'Veículo oito oito três três: sem apontamento. Verificar.',
  10700: 'Veículo oito oito três três: abastecimento de insumo com motor ligado. Verificar.',
  10820: 'Veículo oito oito três três: controle de velocidade do equipamento, velocidade medida de 85 quilômetros por hora. Verificar.',
  10840: 'Veículo oito oito três três: abastecimento de insumo com tempo excedido. Verificar.',
  10860: 'Veículo oito oito três três: aguardando colheitadeira indevidamente. Verificar.',
  11304: 'Veículo oito oito três três: frente de pátio indevida no transbordo. Verificar.',
  11340: 'Veículo oito oito três três: sem operador trabalhando. Verificar.',
  12122: 'Veículo oito oito três três: apontar o centro de custo correto. Verificar.',
  12440: 'Veículo oito oito três três: mudar para a operação mecanizada do caminhão terceiro canavieiro. Verificar.',
  12180: 'Veículo oito oito três três: desligar a chave geral. Verificar.',
  12080: 'Veículo oito oito três três: forçar a balança de entrada. Verificar.',
  12100: 'Veículo oito oito três três: não apontar aguardando carregamento. Verificar.',
  12200: 'Veículo oito oito três três: apontar o centro de custo correto da pipa. Verificar.',
  3483: 'Veículo oito oito três três: aguardando manobra do transbordo. Verificar.',
  11500: 'Veículo oito oito três três: abastecimento de insumo: desligar o motor. Verificar.',
  12500: 'Veículo oito oito três três: sair do apontamento de abastecimento de insumo. Verificar.'
};
for (const [codigo, fala] of Object.entries(falasAprovadas)) {
  assert.equal(policy.montarFala({ tipoAlarme: codigo, numero: '8833', valor: codigo === '10820' ? 85 : null }), fala);
}
assert.equal(
  policy.montarFala({ tipoAlarme: '12600', numero: '8833', valor: 85 }),
  'Veículo oito oito três três: velocidade excedida na usina, referência de 23 quilômetros por hora, velocidade medida de 85 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarFala({ tipoAlarme: '11400', numero: '8833', valor: null }),
  'Veículo oito oito três três: velocidade excedida na oficina, referência de 50 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarFala({ tipoAlarme: '11480', numero: '8833', valor: 85 }),
  'Veículo oito oito três três: velocidade excedida na usina, referência de 23 quilômetros por hora, velocidade medida de 85 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarFala({ tipoAlarme: '12724', numero: '8833', valor: 62 }),
  'Veículo oito oito três três: alerta de velocidade, referência de 60 quilômetros por hora, velocidade medida de 62 quilômetros por hora. Verificar.'
);
assert.equal(policy.montarFala({ tipoAlarme: '3484', numero: '8833', texto: 'SEM APONTAMENTO' }), 'Veículo oito oito três três: SEM APONTAMENTO. Verificar.');

// Caminhão aguardado não inclui operador e usa frente ou fallback.
assert.equal(
  policy.montarFala({ numero: '0083', e: { tipoCompleto: 'Trator', operacao: '123 - Aguardando Caminhão - HD', frente: 'Norte' }, operador: 'Ana' }),
  'Trator zero zero oito três aguardando caminhão. Frente/grupo Norte. Verificar.'
);
assert.equal(
  policy.montarFala({ numero: '12', e: { tipo: 'Transbordo', operacao: 'Aguardando Caminhao' } }),
  'Trator um dois aguardando caminhão. Frente/grupo frente não informada. Verificar.'
);

// Demais mensagens limpam o prefixo de alarme e expandem unidades sem reformular valores.
assert.equal(
  policy.montarFala({ categoria: 'rpm', classe: 'Trator', numero: 'A07', texto: 'Alarme oficial: RPM 1500 e velocidade 42 km/h.' }),
  'Trator A zero sete: rotações por minuto 1500 e velocidade 42 quilômetros por hora. Verificar.'
);
assert.equal(policy.montarFala({ codigo: 777, texto: 'Pressão 12' }), 'Veículo não informado: Pressão 12. Verificar.');

console.log('test-alerts-policy: todos os testes passaram.');

// Contrato real do motor integrado (regra/tipoAlarme, não apenas codigo/categoria).
assert.equal(policy.notificar({ tiposNotificacao: { 5: false } }, { regra: 'velocidade', tipoAlarme: '5' }), false);
assert.equal(policy.notificar({ notificarCategorias: { rpm: false } }, { regra: 'rpm', texto: 'motor em 2000 RPM' }), false);
assert.equal(policy.notificar({ notificarCategorias: { aguardandoCaminhao: false } }, { regra: 'aguardandoCaminhao' }), false);
const speedWhileWaiting = { regra: 'velocidade', tipoAlarme: '5', numero: '8833', valor: 85, e: { tipo: 'Trator', operacao: 'Aguardando Caminhão', frente: 'Frente teste' } };
assert.equal(policy.notificar({ notificarCategorias: { aguardandoCaminhao: false } }, speedWhileWaiting), true);
assert.equal(policy.montarFala(speedWhileWaiting), 'Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.');
console.log('test-alerts-policy: contrato integrado passou.');
