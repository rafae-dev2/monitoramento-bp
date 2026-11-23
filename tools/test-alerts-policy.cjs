'use strict';

const assert = require('node:assert/strict');
const policy = require('../public/alerts-policy.js');

// UMD/normalização básica.
assert.equal(typeof policy.norm, 'function');
assert.equal(policy.norm('  Aguardando   CAMINHÃO\t'), 'aguardando caminhao');
assert.equal(policy.norm(null), '');

// IDs conhecidos, códigos de condição do motor e detecção conservadora de desconhecidos.
assert.equal(policy.categoria(5, ''), 'velocidade');
for (const code of [2203, 2685, 1641, 10820]) assert.equal(policy.categoria(code, ''), 'velocidade');
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

// Preferências legadas, merge de categorias, tipos individuais e AND obrigatório.
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
assert.equal(policy.notificar({ notificarCategorias: { velocidade: false }, tiposNotificacao: { 5: true } }, { codigo: 5 }), false);
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
