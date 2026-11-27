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
for (const code of [2849, 2851]) {
  assert.equal(policy.alarmeTrocaDeTurno(code, ''), true);
  assert.equal(policy.notificar({}, { codigo: code }), false);
}
assert.equal(policy.alarmeTrocaDeTurno('9999', 'TROCA DE TURNO EXCEDIDA'), true);
assert.equal(policy.notificar({ tiposNotificacao: { 2849: true } }, { codigo: 2849, descricao: 'Troca de Turno' }), false);
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

// Frente dividida só corresponde ao apontamento confirmado e a trator/transbordo.
assert.equal(policy.frenteDividida({ tipo: 'TRATOR', operacao: '009 - Frente DIVIDIDA', operacaoConfirmada: true }), true);
assert.equal(policy.frenteDividida({ tipoCompleto: 'Transbordo agrícola', operacao: '', descOperacao: 'Frente dividida', operacaoConfirmada: true }), true);
assert.equal(policy.frenteDividida({ tipo: 'Caminhão canavieiro', operacao: 'Frente dividida', operacaoConfirmada: true }), false);
assert.equal(policy.frenteDividida({ tipo: 'Caminhão', nome: 'Trator fixture', operacao: 'Frente dividida', operacaoConfirmada: true }), false);
assert.equal(policy.frenteDividida({ tipo: 'Trator', operacao: 'Frente dividida', operacaoConfirmada: false }), false);
assert.equal(policy.frenteDividida({ tipo: 'Trator', operacao: 'Frente dividida - teste', operacaoConfirmada: true }), false);

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
assert.equal(cfgLegacy.notificarCategorias.frenteDividida, true);
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
assert.equal(policy.notificar({}, { regra: 'frenteDividida' }), true);
assert.equal(policy.notificar({ notificarCategorias: { frenteDividida: false } }, { regra: 'frenteDividida' }), false);
assert.equal(policy.notificar({ tiposNotificacao: { 41: false } }, { e: { codigo: 41, tipo: 'Trator', operacao: 'Aguardando Caminhao' } }), false);
assert.equal(policy.limiteRefeicao({ refeicaoGrupos: { APOIO: 30, 'Frente 1': 60 } }, { frente: 'Frente 1', grupoEquipamento: 'APOIO' }), 30);
assert.equal(policy.limiteRefeicao({ refeicaoGrupos: { 'Frente 1': 60 } }, { frente: 'Frente 1', grupoEquipamento: 'Caminhões Canavieiro Terc' }), 60);

// Fala: identificador soletrado; prefixo Atenção Flow vs Atenção Coa com pronúncia natural sem soletrar.
assert.equal(policy.montarFala({ codigo: 2203, numero: '8833', valor: 85 }), 'Atenção Flow: Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 2203, numero: '0083', valor: '85.6', operador: 'Ana' }), 'Atenção Flow: Veículo zero zero oito três excedeu a velocidade a 86 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 2203, numero: '8833', valor: null }), 'Atenção Flow: Veículo oito oito três três com alarme oficial de velocidade excedida. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, classe: 'Trator', numero: '32308', valor: null }), 'Atenção Coa: Trator três dois três zero oito com alarme oficial de velocidade excedida. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, classe: 'Trator', numero: '32277', valor: 36 }), 'Atenção Coa: Trator três dois dois sete sete excedeu a velocidade a 36 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, numero: '32308', valor: 36, e: { tipo: 'TRATOR DE PNEU LEVE' } }), 'Atenção Coa: Trator três dois três zero oito excedeu a velocidade a 36 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, classe: 'Veículo', numero: '6614', valor: 60 }), 'Atenção Flow: Veículo seis seis um quatro excedeu a velocidade a 60 quilômetros por hora. Verificar.');
for (const value of [undefined, '', '   ', 'N/A', 'null', 'NaN', Infinity, -1]) {
  assert.match(policy.montarFala({ codigo: 5, numero: '12', valor: value }), /com alarme oficial de velocidade excedida/);
}
assert.match(policy.montarFala({ codigo: 5, numero: '12', valor: 0 }), /a 0 quilômetros por hora/);

// Expansões aprovadas pelo usuário no DOCX; códigos sem explicação não recebem tradução presumida.
const falasAprovadas = {
  12744: 'Atenção Flow: Veículo oito oito três três: sem apontamento. Verificar.',
  10700: 'Atenção Flow: Veículo oito oito três três: abastecimento de insumo com motor ligado. Verificar.',
  10820: 'Atenção Flow: Veículo oito oito três três: controle de velocidade do equipamento, velocidade medida de 85 quilômetros por hora. Verificar.',
  10840: 'Atenção Flow: Veículo oito oito três três: abastecimento de insumo com tempo excedido. Verificar.',
  10860: 'Atenção Flow: Veículo oito oito três três: aguardando colheitadeira indevidamente. Verificar.',
  11304: 'Atenção Flow: Veículo oito oito três três: frente de pátio indevida no transbordo. Verificar.',
  11340: 'Atenção Flow: Veículo oito oito três três: sem operador trabalhando. Verificar.',
  12122: 'Atenção Flow: Veículo oito oito três três: apontar o centro de custo correto. Verificar.',
  12440: 'Atenção Flow: Veículo oito oito três três: mudar para a operação mecanizada do caminhão terceiro canavieiro. Verificar.',
  12180: 'Atenção Flow: Veículo oito oito três três: desligar a chave geral. Verificar.',
  12080: 'Atenção Flow: Veículo oito oito três três: forçar a balança de entrada. Verificar.',
  12100: 'Atenção Flow: Veículo oito oito três três: não apontar aguardando carregamento. Verificar.',
  12200: 'Atenção Flow: Veículo oito oito três três: apontar o centro de custo correto da pipa. Verificar.',
  3483: 'Atenção Flow: Veículo oito oito três três: aguardando manobra do transbordo. Verificar.',
  11500: 'Atenção Flow: Veículo oito oito três três: abastecimento de insumo: desligar o motor. Verificar.',
  12500: 'Atenção Flow: Veículo oito oito três três: sair do apontamento de abastecimento de insumo. Verificar.'
};
for (const [codigo, fala] of Object.entries(falasAprovadas)) {
  assert.equal(policy.montarFala({ tipoAlarme: codigo, numero: '8833', valor: codigo === '10820' ? 85 : null }), fala);
}
assert.equal(
  policy.montarFala({ tipoAlarme: '12600', numero: '8833', valor: 85 }),
  'Atenção Flow: Veículo oito oito três três: velocidade excedida na usina, referência de 23 quilômetros por hora, velocidade medida de 85 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarFala({ tipoAlarme: '11400', numero: '8833', valor: null }),
  'Atenção Flow: Veículo oito oito três três: velocidade excedida na oficina, referência de 50 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarFala({ tipoAlarme: '11480', numero: '8833', valor: 85 }),
  'Atenção Flow: Veículo oito oito três três: velocidade excedida na usina, referência de 23 quilômetros por hora, velocidade medida de 85 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarFala({ tipoAlarme: '12724', numero: '8833', valor: 62 }),
  'Atenção Flow: Veículo oito oito três três: alerta de velocidade, referência de 60 quilômetros por hora, velocidade medida de 62 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarFala({ tipoAlarme: '10820', classe: 'Trator', numero: '32308', valor: 85 }),
  'Atenção Coa: Trator três dois três zero oito: controle de velocidade do equipamento, velocidade medida de 85 quilômetros por hora. Verificar.'
);
assert.equal(policy.montarFala({ tipoAlarme: '3484', numero: '8833', texto: 'SEM APONTAMENTO' }), 'Atenção Flow: Veículo oito oito três três: SEM APONTAMENTO. Verificar.');

// Caminhão aguardado não inclui operador e usa frente ou fallback.
assert.equal(policy.caminhaoCanavieiroTerceiro({ tipo: 'CAMINHÕES CANAVIEIRO TERC' }), true);
assert.equal(policy.caminhaoCanavieiroTerceiro({ tipo: 'CAMINHÕES CANAVAREIRO TERC' }), true);
assert.equal(policy.caminhaoCanavieiroTerceiro({ tipo: 'CAMINHAO CANAVIEIRO', grupoEquipamento: 'Caminhões Canavieiro Terc' }), true, 'campos reais do equipamento 4468');
for (const tipo of ['CAMINHÕES CAÇAMBAS', 'CAMINHÕES MUNCK', 'CAMINHÕES BOMBEIROS', 'CAMINHÃO CANAVIEIRO']) {
  assert.equal(policy.caminhaoCanavieiroTerceiro({ tipo }), false, tipo + ' não entra no esquema da frente de colheita');
}
for (const tipo of ['CAMINHÕES CAÇAMBAS', 'CAMINHÕES MUNCK', 'CAMINHÕES BOMBEIROS']) {
  assert.equal(policy.caminhaoCanavieiroTerceiro({ tipo, grupoEquipamento: 'Caminhões Canavieiro Terc' }), false, tipo + ' continua excluído apesar do nome cadastral do grupo');
}
assert.equal(
  policy.montarFala({ numero: '0083', e: { tipoCompleto: 'Trator', operacao: '123 - Aguardando Caminhão - HD', frente: 'Norte' }, operador: 'Ana' }),
  'Atenção Coa: Trator zero zero oito três aguardando caminhão. Frente/grupo Norte. Verificar.'
);
assert.equal(
  policy.montarFala({ numero: '12', e: { tipo: 'Transbordo', operacao: 'Aguardando Caminhao' } }),
  'Atenção Coa: Trator um dois aguardando caminhão. Frente/grupo frente não informada. Verificar.'
);
assert.equal(
  policy.montarFala({
    regra: 'paradaImprodutiva', paradaId: 'aguardandoCarregamento', paradaNome: 'Aguardando carregamento (caminhão)',
    numero: '4426', classe: 'Caminhão', valor: 31,
    e: { tipo: 'CAMINHÕES CANAVIEIRO TERC', frente: 'Frente 1', grupoEquipamento: 'Caminhões Canavieiro Terc' }
  }),
  'Atenção Flow: Caminhão quatro quatro dois seis aguardando carregamento há 31 minutos, se encontra na Frente 1. Verificar.'
);
const falaFazendaFundo25 = policy.montarFala({
  regra: 'paradaImprodutiva', paradaId: 'aguardandoCarregamento', paradaNome: 'Aguardando carregamento (caminhão)',
  numero: '4426', classe: 'Caminhão', valor: 31,
  e: { tipo: 'CAMINHÕES CANAVIEIRO TERC', frente: 'Fazenda Fundo 25' }
});
assert.equal(falaFazendaFundo25, 'Atenção Flow: Caminhão quatro quatro dois seis aguardando carregamento há 31 minutos, se encontra na Fazenda Fundo 25. Verificar.');
assert.doesNotMatch(falaFazendaFundo25, /dentro da usina/i);
const semFrenteColheita = policy.montarFala({
  regra: 'paradaImprodutiva', paradaId: 'aguardandoCarregamento', paradaNome: 'Aguardando carregamento (caminhão)',
  numero: '4426', classe: 'Caminhão', valor: 31,
  e: { tipo: 'CAMINHÕES CANAVIEIRO TERC', grupoEquipamento: 'Frente 3' }
});
assert.match(semFrenteColheita, /frente de colheita não informada/);
assert.doesNotMatch(semFrenteColheita, /Frente 3/);
for (const tipo of ['CAMINHÕES CAÇAMBAS', 'CAMINHÕES MUNCK', 'CAMINHÕES BOMBEIROS']) {
  const fala = policy.montarFala({
    regra: 'paradaImprodutiva', paradaId: 'aguardandoCarregamento', paradaNome: 'Aguardando carregamento (caminhão)',
    numero: '4426', classe: 'Caminhão', valor: 31,
    e: { tipo, frente: 'Frente 1', grupoEquipamento: tipo }
  });
  assert.equal(fala, 'Atenção Flow: Caminhão quatro quatro dois seis em Aguardando carregamento há 31 minutos. Verificar.');
  assert.doesNotMatch(fala, /Frente 1|frente de colheita|Frente\/grupo/);
}

// Demais mensagens limpam o prefixo de alarme e expandem unidades sem reformular valores.
assert.equal(
  policy.montarFala({ categoria: 'rpm', classe: 'Trator', numero: 'A07', texto: 'Alarme oficial: RPM 1500 e velocidade 42 km/h.' }),
  'Atenção Coa: Trator A zero sete: rotações por minuto 1500 e velocidade 42 quilômetros por hora. Verificar.'
);
assert.equal(policy.montarFala({ codigo: 777, texto: 'Pressão 12' }), 'Atenção Flow: Veículo não informado: Pressão 12. Verificar.');

console.log('test-alerts-policy: todos os testes passaram.');

// Contrato real do motor integrado (regra/tipoAlarme, não apenas codigo/categoria).
assert.equal(policy.notificar({ tiposNotificacao: { 5: false } }, { regra: 'velocidade', tipoAlarme: '5' }), false);
assert.equal(policy.notificar({ notificarCategorias: { rpm: false } }, { regra: 'rpm', texto: 'motor em 2000 RPM' }), false);
assert.equal(policy.notificar({ notificarCategorias: { aguardandoCaminhao: false } }, { regra: 'aguardandoCaminhao' }), false);
const speedWhileWaiting = { regra: 'velocidade', tipoAlarme: '5', numero: '8833', valor: 85, e: { tipo: 'Trator', operacao: 'Aguardando Caminhão', frente: 'Frente teste' } };
assert.equal(policy.notificar({ notificarCategorias: { aguardandoCaminhao: false } }, speedWhileWaiting), true);
assert.equal(policy.montarFala(speedWhileWaiting), 'Atenção Coa: Trator oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.');
assert.equal(policy.aplicarGlossario('Veículo Caminhões Canavieiro Terc'), 'Veículo Caminhões Canavieiro Terceiro');
assert.equal(policy.aplicarGlossario('Terc', { glossarioFala: 'Terc=Terceiro' }), 'Terceiro');
assert.equal(policy.notificar({}, { regra: 'aguardandoBasculamento' }), true);
assert.equal(policy.notificar({ notificarCategorias: { aguardandoBasculamento: false } }, { regra: 'aguardandoBasculamento' }), false);
assert.equal(
  policy.montarFala({
    regra: 'aguardandoBasculamento', numero: '8833', caminhoes: ['4451'],
    e: { frente: 'Caminhões Canavieiro Terc' }
  }),
  'Atenção Coa: Trator oito oito três três: aguardando basculamento, inferido pelo aplicativo porque o caminhão quatro quatro cinco um está aguardando carregamento na mesma frente. Frente/grupo Caminhões Canavieiro Terceiro. No SGPA, o apontamento permanece Aguardando Caminhão. Verificar.'
);
assert.equal(
  policy.montarFala({
    regra: 'frenteDividida', classe: 'Transbordo', numero: '8833',
    e: { tipo: 'Transbordo', operacao: '123 - Frente dividida', frente: 'Frente Norte' }
  }),
  'Atenção Coa: Transbordo oito oito três três apontou Frente dividida. Frente/grupo Frente Norte. Verificar a sequência de chamada da colhedora no sistema FUT.'
);

// Inteligência COA v3.0.0: emergência, qualidade de colheita, Raio-X CTT + balanceamento, WhatsApp e Passagem de Turno.
assert.equal(policy.categoria('desconhecido', 'Combate a Incêndio'), 'emergencia');
assert.equal(policy.ehAlertaSeguranca('emergencia'), true);
assert.equal(policy.ehAlertaSeguranca('velocidade'), true);
assert.equal(policy.ehAlertaSeguranca('paradaImprodutiva'), false);
assert.ok(policy.emergenciaOperacional({ operacaoConfirmada: true, operacao: '999 - Combate a Incêndio' }));
assert.equal(policy.emergenciaOperacional({ tipo: 'CAMINHÃO BOMBEIRO', velocidade: 48 }), null, 'Velocidade pura nunca dispara alerta local sem alarme oficial SGPA ou apontamento de incêndio');
assert.equal(policy.emergenciaOperacional({ tipo: 'CAMINHÃO BOMBEIRO', velocidade: 0, operacaoConfirmada: true, operacao: 'Aguardando Carregamento' }), null);
assert.equal(policy.colheitaAcimaDaFaixa({ tipo: 'COLHEDORA', operacaoConfirmada: true, operacao: '101 - Colheita Mecanizada', velocidade: 8.4 }, 7.5), false, 'Velocidade é exclusivamente alarme oficial SGPA');
assert.equal(policy.colheitaAcimaDaFaixa({ tipo: 'COLHEDORA', operacaoConfirmada: true, operacao: '101 - Colheita Mecanizada', velocidade: 6.2 }, 7.5), false);
assert.equal(policy.colheitaAcimaDaFaixa({ tipo: 'COLHEDORA', operacaoConfirmada: true, operacao: '200 - Deslocamento', velocidade: 15 }, 7.5), false);
assert.equal(policy.paradaImprodutiva({ operacao: '410 - Manutenção Mecânica' }).id, 'emManutencao');

const ctt = policy.analisarFrentesCtt([
  { id: 'C1', numero: '57838', tipo: 'COLHEDORA', frente: 'Frente 1', operacaoConfirmada: true, operacao: 'Colheita', velocidade: 5.5, atraso: 10 },
  { id: 'T1', numero: '7001', tipo: 'TRANSBORDO', frente: 'Frente 1', operacaoConfirmada: true, operacao: 'Transbordo', atraso: 10 },
  { id: 'K1', numero: '4401', tipo: 'CAMINHÕES CANAVIEIRO TERC', frente: 'Frente 1', operacaoConfirmada: true, operacao: 'Aguardando Carregamento', atraso: 10 },
  { id: 'K2', numero: '4402', tipo: 'CAMINHÕES CANAVIEIRO TERC', frente: 'Frente 1', operacaoConfirmada: true, operacao: 'Aguardando Carregamento', atraso: 10 },
  { id: 'K3', numero: '4403', tipo: 'CAMINHÕES CANAVIEIRO TERC', frente: 'Frente 1', operacaoConfirmada: true, operacao: 'Aguardando Carregamento', atraso: 10 },
  { id: 'C2', numero: '57839', tipo: 'COLHEDORA', frente: 'Frente 3', operacaoConfirmada: true, operacao: 'Colheita', velocidade: 5.2, atraso: 10 },
  { id: 'T2', numero: '7002', tipo: 'TRANSBORDO', frente: 'Frente 3', operacaoConfirmada: true, operacao: '905 - Aguardando Caminhão', atraso: 10 },
  { id: 'M1', numero: '9010', tipo: 'TRATOR', frente: 'Frente 3', operacaoConfirmada: true, operacao: 'Sem Apontamento', atraso: 2100 },
], { minutosFrotaMuda: 25, filaMaxFrente: 4 });
assert.equal(ctt.frentes.length, 2);
assert.equal(ctt.frotasMudas.length, 1);
assert.equal(ctt.frotasMudas[0].numero, '9010');
assert.equal(ctt.sugestoesBalanceamento.length, 1);
assert.match(ctt.sugestoesBalanceamento[0].texto, /Frente 1.*Frente 3/);

const whats = policy.textoCobrancaWhatsApp({
  regra: 'semApontamento', nome: 'Sem apontamento', classe: 'Trator', numero: '4576',
  operador: 'Marcelo Vian', texto: 'sem apontamento há 5 minutos', e: { frente: 'Frente 2', operacao: '953 - Sem Apontamento' }
}, 'Usina Branco Peres', { tag: 'Cobrado no rádio', nota: 'operador corrigindo' });
assert.match(whats, /COA Usina Branco Peres.*Frente 2.*Trator 4576.*Cobrado no rádio/s);

const boletim = policy.gerarBoletimPassagemTurno({
  unidade: 'Usina Branco Peres', usuario: 'coa.operador', resumoCtt: ctt,
  ativos: [{ chave: '57838|sgpa:5', severidade: 3, classe: 'Colhedora', numero: '57838', nome: 'Velocidade', regra: 'velocidade', ts: Date.now() - 600000, e: { frente: 'Frente 1' } }],
  hist: [{ ts: Date.now() - 60000, equipamento: '57838', frente: 'Frente 1', regra: 'velocidade', nomeAlarme: 'Velocidade' }],
  tratativas: { '57838|sgpa:5': { tag: 'Cobrado no rádio', nota: 'reduziu' } },
  ociosidadeTurno: [{ numero: '4576', classe: 'Trator', frente: 'Frente 2', segAcumulados: 900 }],
});
assert.match(boletim.texto, /PASSAGEM DE TURNO COA/);
assert.match(boletim.texto, /Colhedora 57838/);
assert.match(boletim.texto, /DESPERDÍCIO DE DIESEL/);

// Inteligência COA v4.0.0: falso apontamento, taxímetro R$, termômetro de moenda, Uber do Comboio, 30-30-30, bate-volta, preditiva, DDS e Alô COA.
const incColh = policy.inconsistenciaApontamento({ tipo: 'COLHEDORA', operacaoConfirmada: true, operacao: '101 - Colheita Mecanizada', velocidade: 0, rpm: 800, motor: true });
assert.ok(incColh && incColh.subtipo === 'colheitaParada');
const incMov = policy.inconsistenciaApontamento({ tipo: 'TRATOR', operacaoConfirmada: true, operacao: '953 - Sem Apontamento', velocidade: 24, rpm: 1650, motor: true });
assert.ok(incMov && incMov.subtipo === 'paradaEmMovimento');
assert.equal(policy.inconsistenciaApontamento({ tipo: 'TRATOR', operacaoConfirmada: true, operacao: '905 - Aguardando Caminhão', velocidade: 85, rpm: 0, motor: false }), null);

assert.equal(policy.custoHoraEquipamento({ tipo: 'COLHEDORA' }, {}).valorHora, 850);
assert.equal(policy.caminhaoEmBateVolta({ tipo: 'CAMINHÃO CANAVIEIRO', operacaoConfirmada: true, operacao: '305 - Transporte de Cana' }), true);
assert.equal(policy.caminhaoEmBateVolta({ tipo: 'CAMINHÃO BOMBEIRO', operacaoConfirmada: true, operacao: '305 - Transporte' }), false);

const agoraRef = Date.now();
const rec = policy.detectarFalhaRecorrente('C1', [
  { ts: agoraRef - 10 * 60000, chave: 'C1|rpm', equipamento: '57838', regra: 'rpm', nomeAlarme: 'RPM MAXIMA' },
  { ts: agoraRef - 40 * 60000, chave: 'C1|parada:aguardMecanico', equipamento: '57838', regra: 'paradaImprodutiva', nomeAlarme: 'Aguardando mecânico' },
  { ts: agoraRef - 90 * 60000, chave: 'C1|motorCondicao', equipamento: '57838', regra: 'motorCondicao', nomeAlarme: 'Temperatura Motor' },
], agoraRef, 240, 3);
assert.ok(rec && rec.ocorrencias === 3);

const moenda = policy.calcularTermometroMoenda(ctt, { metaMoagemTonHora: 400, tonHoraPorColhedora: 70 });
assert.equal(moenda.entregaTonHora, 140);
assert.equal(moenda.status, 'risco');

const fila = policy.calcularFilaComboioApoio([
  { id: 'CB1', numero: '9920', nome: 'Caminhão Comboio', tipo: 'CAMINHÃO COMBOIO', frente: 'Frente 1', geohash: '6u18n7m0', ativo: 'T' },
  { id: 'OF1', numero: '9930', nome: 'Oficina Volante', tipo: 'OFICINA VOLANTE', frente: 'Frente 3', geohash: '6u18n7k0', ativo: 'T' },
  { id: 'TR1', numero: '7001', nome: 'Transbordo BP', tipo: 'TRANSBORDO', frente: 'Frente 1', operacaoConfirmada: true, operacao: '940 - Aguardando Comboio', operacaoTs: agoraRef - 20 * 60000, geohash: '6u18n7m5', ativo: 'T' },
  { id: 'CH1', numero: '57838', nome: 'Colhedora JD', tipo: 'COLHEDORA', frente: 'Frente 1', operacaoConfirmada: true, operacao: '940 - Aguardando Comboio', operacaoTs: agoraRef - 15 * 60000, geohash: '6u18n7m2', ativo: 'T' },
], {}, agoraRef);
assert.equal(fila.chamados.length, 2);
assert.equal(fila.chamados[0].numero, '57838', 'Colhedora tem prioridade #1 sobre transbordo pelo peso produtivo/R$');
assert.equal(fila.chamados[0].apoioNumero, '9920');
assert.ok(fila.chamados[0].distanciaKm !== null && fila.chamados[0].distanciaKm >= 0);
assert.match(fila.chamados[0].textoDespacho, /DESPACHO COMBOIO #1/);

const r30 = policy.avaliarRiscoIncendio303030({ tempC: 34, umidadePct: 24, ventoKmH: 33, chuvaMm: 0 }, [{ id: 'B1', numero: '9911', frente: 'Frente 1', geohash: '6u18n7m0' }], policy.decodificarGeohash('6u18n7m5'), 'Frente 1');
assert.equal(r30.bandeira, 'vermelha');
assert.equal(r30.fatores303030, 3);
assert.equal(r30.bombeiroProximo.numero, '9911');

const dds = policy.gerarPlacarPositivoTurno({
  resumoCtt: ctt,
  frota: [
    { id: 'C2', numero: '57839', frente: 'Frente 3', operador: 'Carlos Eduardo' },
    { id: 'C1', numero: '57838', frente: 'Frente 1', operador: 'Infrator Teste' },
  ],
  hist: [{ ts: agoraRef - 5000, operador: 'Infrator Teste', regra: 'velocidade' }],
  ociososMapa: { C2: { segAcumulados: 60 } },
  agoraMs: agoraRef,
});
assert.ok(dds.frenteDestaque);
assert.equal(dds.operadoresDestaque.length, 1);
assert.equal(dds.operadoresDestaque[0].operador, 'Carlos Eduardo');

assert.equal(policy.interpretarComandoCoa('fila de comboio').acao, 'comboio');
assert.equal(policy.interpretarComandoCoa('onde está a 57838').frota, '57838');
assert.equal(policy.interpretarComandoCoa('risco de moenda').acao, 'moenda');
assert.equal(policy.interpretarComandoCoa('modo chuva frente 2').frente, 'Frente 2');
assert.equal(policy.interpretarComandoCoa('alertas pendentes').acao, 'pendentes');
assert.equal(policy.interpretarComandoCoa('fixar painel').acao, 'fixar');

// Pacote Pente-Fino COA v5.0 + Refinamentos v5.1/v5.2 + v6.1 Flow Urgente (23 categorias).
assert.equal(policy.CATEGORIAS.length, 23);
assert.equal(policy.CATEGORIAS.includes('turno'), false);
assert.equal(policy.CATEGORIAS.includes('qualidadeColheita'), false);
assert.equal(policy.PARADAS.length, 26);
assert.equal(policy.ehAlertaSeguranca('abastecimentoMotorLigado'), true);
assert.equal(policy.ehAlertaSeguranca('chaveGeralLigada'), false);
assert.equal(policy.paradaImprodutiva({ operacao: '3520 - Troca de Facas' }).id, 'trocaFacas');
assert.equal(policy.paradaImprodutiva({ operacao: '3500 - Lavagem de Equipamento' }).id, 'lavagemEquipamento');
assert.equal(policy.paradaImprodutiva({ operacao: 'Trocando Julieta' }).id, 'trocaJulietaEngate');
assert.equal(policy.paradaImprodutiva({ operacao: 'Fila Balança Entrada' }).id, 'filaBalancaPatio');
assert.equal(policy.paradaImprodutiva({ operacao: 'Abastecimento de Combustível' }).id, 'abastLubrifExcedido');

assert.ok(policy.operandoSemOperador({ operador: '', operadorBruto: '9999 - Sem Operador', operacao: '101 - Colheita', motor: true, rpm: 1800, velocidade: 6.2 }));
assert.equal(policy.operandoSemOperador({ operador: 'Carlos Eduardo', operadorBruto: 'Carlos Eduardo', operacao: '101 - Colheita', motor: true, rpm: 1800, velocidade: 6.2 }), null);
assert.equal(policy.operandoSemOperador({ operador: '', operadorBruto: '', operacao: '925 - Troca de Turno', cdOperacao: '925', motor: true, rpm: 1400, velocidade: 6 }), null);

assert.ok(policy.meiaChaveParada({ motor: true, rpm: 0, velocidade: 0, operacao: '940 - Aguardando Comboio' }));
assert.equal(policy.meiaChaveParada({ motor: true, rpm: 820, velocidade: 0 }), null);
assert.equal(policy.meiaChaveParada({ motor: false, rpm: 0, velocidade: 0 }), null);

assert.ok(policy.abastecendoComMotorLigado({ operacaoConfirmada: true, operacao: 'Abastecimento de Insumo', motor: true, rpm: 1250 }));
assert.equal(policy.abastecendoComMotorLigado({ operacaoConfirmada: true, operacao: '940 - Aguardando Comboio', motor: true, rpm: 1250 }), null);
assert.equal(policy.abastecendoComMotorLigado({ operacaoConfirmada: true, operacao: 'Abastecimento de Insumo', motor: true, rpm: 0 }), null);

const serrote = policy.avaliarMicroParadas([
  { duracaoMin: 4, fimMs: agoraRef - 45 * 60000 },
  { duracaoMin: 5, fimMs: agoraRef - 32 * 60000 },
  { duracaoMin: 3.5, fimMs: agoraRef - 18 * 60000 },
  { duracaoMin: 4.5, fimMs: agoraRef - 5 * 60000 },
], agoraRef, 60, 4, 16);
assert.ok(serrote && serrote.episodios === 4 && serrote.minutosPerdidos === 17);

assert.match(policy.montarFala({ regra: 'abastecimentoMotorLigado', classe: 'Colhedora', numero: '57838', valor: 1300 }, {}), /^Atenção Coa: alerta de segurança, Colhedora .*com motor ligado/i);
assert.match(policy.montarFala({ regra: 'microParadasCronicas', classe: 'Colhedora', numero: '57838', valor: 18 }, {}), /^Atenção Coa.*Colhedora .*micro-paradas/i);

// v5.1.0 + v5.2.0: Bombeiro cadastrado como TRATOR DE PNEU LEVE no SGPA -> sempre fala Caminhão e setor FLOW (e só dispara emergência com apontamento/alarme de incêndio, nunca por velocidade pura).
const bombeiroErradoPortal = {
  id: 'BOMB-01',
  numero: '9911',
  nome: '9911 - Trator de Pneu Leve',
  tipo: 'TRATOR DE PNEU LEVE',
  grupoEquipamento: 'CAMINHÕES BOMBEIROS',
  frente: 'Apoio Incêndio',
  operacao: 'Aguardando Caminhão',
  operacaoConfirmada: true,
  velocidade: 52,
};
assert.equal(policy.ehGrupoBombeiro(null, bombeiroErradoPortal), true);
assert.equal(policy.classeEquipamentoFalado(null, bombeiroErradoPortal), 'Caminhão');
assert.equal(policy.setorControle(null, bombeiroErradoPortal), 'FLOW');
assert.equal(policy.aguardandoCaminhao(bombeiroErradoPortal), false, 'Bombeiro com tipo errado TRATOR DE PNEU LEVE não entra em regra de Trator');
assert.equal(policy.emergenciaOperacional(bombeiroErradoPortal), null, 'Velocidade sozinha em Bombeiro não dispara emergência local');
const falaVelBombeiro = policy.montarFala({ codigo: 5, numero: '9911', valor: 74, e: bombeiroErradoPortal });
assert.equal(falaVelBombeiro, 'Atenção Flow: Caminhão nove nove um um excedeu a velocidade a 74 quilômetros por hora. Verificar.');
assert.doesNotMatch(falaVelBombeiro, /trator|bombeir/i);
assert.doesNotMatch(falaVelBombeiro, /C O A|F L O W|\bCOA\b|\bFLOW\b/);
const emgBombeiro = policy.emergenciaOperacional(Object.assign({}, bombeiroErradoPortal, { operacao: '999 - Combate a Incêndio' }));
assert.ok(emgBombeiro && /Combate a Incêndio/.test(emgBombeiro.motivo));
const falaEmgBombeiro = policy.montarFala({ regra: 'emergencia', numero: '9911', texto: emgBombeiro.motivo, e: bombeiroErradoPortal });
assert.match(falaEmgBombeiro, /^Atenção Flow, emergência! Caminhão nove nove um um/);
assert.doesNotMatch(falaEmgBombeiro, /trator|bombeir|C O A|F L O W|\bCOA\b|\bFLOW\b/);

// v5.2.0: Frota Muda elegível (ignora máquinas encostadas > 3h como 383 min e paradas em Chuva/Clima/Oficina).
assert.equal(policy.frotaMudaElegivel({ ativo: 'T', atraso: 35 * 60, operacao: '953 - Sem Apontamento', velocidade: 0 }, 25), true);
assert.equal(policy.frotaMudaElegivel({ ativo: 'T', atraso: 383 * 60, operacao: '976 - Transbordo Alocado', velocidade: 0 }, 25), false, '383 min (> 3h) é máquina encostada/desligada, não deve alertar Frota Muda');
assert.equal(policy.frotaMudaElegivel({ ativo: 'T', atraso: 40 * 60, operacao: '902 - Chuva - HR', grupoOperacao: 'CLIMA', estadoOperacional: 'PARADA', velocidade: 0 }, 25), false, 'Parada de Chuva/CLIMA não deve alertar Frota Muda');
assert.equal(policy.frotaMudaElegivel({ ativo: 'T', atraso: 45 * 60, operacao: '410 - Manutenção Oficina', velocidade: 0 }, 25), false, 'Em manutenção/oficina parada não deve alertar Frota Muda');

// v5.1.0: Diferenciação Controle FLOW (caminhões + veículos leves) vs COA (tratores, transbordos, colhedoras e linha amarela).
const vlPortal = { numero: '1102', nome: '1102 - Utilitário', tipo: 'TRATOR DE PNEU LEVE', grupoEquipamento: 'VEÍCULOS LEVES' };
assert.equal(policy.classeEquipamentoFalado(null, vlPortal), 'Veículo');
assert.equal(policy.setorControle(null, vlPortal), 'FLOW');
assert.match(policy.montarFala({ codigo: 12724, numero: '1102', valor: 68, e: vlPortal }), /^Atenção Flow: Veículo um um zero dois/);

const linhaAmarela = { numero: '3510', nome: '3510 - Motoniveladora', tipo: 'MOTONIVELADORA', grupoEquipamento: 'LINHA AMARELA' };
assert.equal(policy.classeEquipamentoFalado(null, linhaAmarela), 'Máquina');
assert.equal(policy.setorControle(null, linhaAmarela), 'COA');
assert.match(policy.montarFala({ codigo: 11, numero: '3510', texto: 'motor ocioso', e: linhaAmarela }), /^Atenção Coa: Máquina três cinco um zero/);

assert.equal(policy.aplicarGlossario('Atenção C O A e F L O W'), 'Atenção Coa e Flow');
assert.equal(policy.interpretarComandoCoa('alertas flow').acao, 'flow');

// v6.0.0: Modo Somente Críticos + marcação individual SGPA + Grupos de Equipamentos + Vozes Gemini Brasil + Motor Causal IA.
assert.equal(policy.notificar({ somenteCriticos: true }, { regra: 'refeicao', severidade: 2 }), false, 'Modo Somente Críticos silencia refeição (sev 2)');
assert.equal(policy.notificar({ somenteCriticos: true }, { regra: 'velocidade', severidade: 3, codigo: '5' }), true, 'Modo Somente Críticos mantém Velocidade SGPA');
assert.equal(policy.notificar({ somenteCriticos: true, tiposCriticos: { '12744': true } }, { codigo: '12744', descricao: 'SEM APONTAMENTO', severidade: 1 }), true, 'Código SGPA marcado com ⭐ Crítico passa no Modo Somente Críticos');
assert.equal(policy.grupoEquipamentoPermitido({ gruposEquipamento: ['COLHEDORAS'] }, { tipo: 'COLHEDORA', nome: '57838 - Colhedora JD' }), true);
assert.equal(policy.grupoEquipamentoPermitido({ gruposEquipamento: ['COLHEDORAS'] }, { tipo: 'CAMINHÃO CANAVIEIRO', nome: '4401 - Caminhão' }), false);
assert.equal(policy.grupoEquipamentoPermitido({ setorMonitorado: 'FLOW' }, { tipo: 'TRATOR DE PNEU LEVE', grupoEquipamento: 'CAMINHÕES BOMBEIROS' }), true);
assert.equal(policy.grupoEquipamentoPermitido({ setorMonitorado: 'FLOW' }, { tipo: 'COLHEDORA', grupoEquipamento: 'Frente 1' }), false);
assert.ok(Array.isArray(policy.VOZES_GEMINI_BR) && policy.VOZES_GEMINI_BR.length >= 12);
const diagIa = policy.raciocinarOperacaoCoa({
  ativos: [{ numero: '7002', classe: 'Transbordo', setor: 'COA', regra: 'aguardandoCaminhao', severidade: 2, texto: 'aguardando caminhão' }],
  resumoCtt: { frentes: [{ frente: 'Frente 3', colhedorasTotal: 2, colhedorasColhendo: 2, transbordos905: 3, caminhoesFila: 0 }], sugestoesBalanceamento: [] },
  moenda: { entregaTonHora: 280, metaTonHora: 420, pctMeta: 67, status: 'risco', deficitTonHora: 140 },
  custoTurno: { totalRs: 4200 },
}, 'Qual o gargalo da Frente 3?');
assert.equal(diagIa.ok, true);
assert.match(diagIa.analise, /Frente 3 sofre fome logística.*Ações Imediatas — Controle Coa.*Ações Imediatas — Controle Flow/s);

// v6.1.0: Controle FLOW Urgente — 1 caminhão carregando e 0 no aguarde (Frente 1, Frente 2 e Frente 3 individual).
assert.equal(policy.frenteColheitaPrincipal('Frente 1'), 'Frente 1');
assert.equal(policy.frenteColheitaPrincipal('Frente de Colheita 02'), 'Frente 2');
assert.equal(policy.frenteColheitaPrincipal('FRENTE 3'), 'Frente 3');
assert.equal(policy.frenteColheitaPrincipal('Apoio Plantio'), '');
assert.equal(policy.ehCaminhaoCanavieiro({ tipo: 'CAMINHÃO CANAVIEIRO', nome: '4502 - Caminhão' }), true);
assert.equal(policy.ehCaminhaoCanavieiro({ tipo: 'CAMINHÃO BOMBEIRO', grupoEquipamento: 'CAMINHÕES BOMBEIROS' }), false);
assert.equal(policy.caminhaoEmCarregamento({ tipo: 'CAMINHÃO CANAVIEIRO', operacao: '201 - Carregando Cana' }), true);
assert.equal(policy.caminhaoEmCarregamento({ tipo: 'CAMINHÃO CANAVIEIRO', operacao: '205 - Aguardando Carregamento' }), false);
assert.equal(policy.caminhaoNoAguarde({ tipo: 'CAMINHÃO CANAVIEIRO', operacao: '205 - Aguardando Carregamento' }), true);
assert.equal(policy.setorControle({ regra: 'flowUltimoCaminhao' }, { frente: 'Frente 1' }), 'FLOW');
assert.equal(policy.notificar({ somenteCriticos: true }, { regra: 'flowUltimoCaminhao', severidade: 4 }), true, 'Flow urgente último caminhão deve passar mesmo no Modo Somente Críticos');
const falaFlowUrg = policy.montarFala({ regra: 'flowUltimoCaminhao', caminhoes: ['4502'], e: { frente: 'Frente 2' } });
assert.equal(falaFlowUrg, 'Atenção Flow, urgente! Frente 2 com apenas um caminhão carregando, caminhão quatro cinco zero dois, e nenhum caminhão no aguarde. Avaliar e enviar outro caminhão imediatamente.');

// v6.2.0: Integração direta Monitoramento BP <-> Sistema de Chamados (montarRascunhoChamado p/ COA e FLOW).
assert.equal(policy.mapearFrenteChamado('Frente 1', ''), '1');
assert.equal(policy.mapearFrenteChamado('Frente de Colheita 03', ''), '3');
assert.equal(policy.mapearFrenteChamado('', 'CAMINHÃO COMBOIO'), 'Comboio');
assert.equal(policy.mapearFrenteChamado('', 'MANUTENÇÃO MECÂNICA'), 'Oficina');
assert.deepEqual(policy.mapearCodigoChamado({ regra: 'velocidade', texto: '88 km/h' }), { codigo: '20000', descricao: 'VELOCIDADE A CIMA', erro: 'Erro Operacional' });
assert.deepEqual(policy.mapearCodigoChamado({ regra: 'semApontamento' }), { codigo: '953', descricao: 'Sem Apontamento', erro: 'Erro Operacional' });
assert.deepEqual(policy.mapearCodigoChamado({ regra: 'ocioso' }), { codigo: '40000', descricao: 'MOTOR OCIOSO', erro: 'Incoerente' });
assert.deepEqual(policy.mapearCodigoChamado({ regra: 'flowUltimoCaminhao' }), { codigo: '908', descricao: 'Aguardando Carregamento - HD', erro: 'Nenhum' });

const empacotadoFlow = policy.montarRascunhoChamado({
  chave: 'CR-02|5',
  regra: 'velocidade',
  severidade: 3,
  numero: '4410',
  classe: 'Caminhão',
  setor: 'FLOW',
  nomeAlarme: 'VELOCIDADE EXCEDIDA',
  texto: '88 km/h',
  operador: '1055 - João de Souza',
  ts: new Date('2026-11-26T14:30:00-03:00').getTime(),
  e: { frente: 'Frente 1', grupoEquipamento: 'CAMINHÕES CANAVIEIRO' },
}, { lideresFrente: 'Frente 1=Claudecir Aparecido' });
assert.equal(empacotadoFlow.rascunho.FROTA, '4410');
assert.equal(empacotadoFlow.rascunho.FRENTE, '1');
assert.equal(empacotadoFlow.rascunho.CODIGO, '20000');
assert.equal(empacotadoFlow.rascunho.DESCRICAO, 'VELOCIDADE A CIMA');
assert.equal(empacotadoFlow.rascunho.OPERADOR, 'JOÃO DE SOUZA');
assert.equal(empacotadoFlow.rascunho.LIDER, 'CLAUDECIR APARECIDO');
assert.equal(empacotadoFlow.rascunho.IMPACTANTE, 'Crítico');
assert.equal(empacotadoFlow.rascunho.CARGO, 'CONTROLADOR DE FLUXO');
assert.match(empacotadoFlow.rascunho.OBSERVACOES, /Controle FLOW.*4410.*Frente 1.*JOÃO DE SOUZA/s);

const empacotadoUltimoCam = policy.montarRascunhoChamado({
  chave: 'flow-frente:frente 2|flowUltimoCaminhao',
  regra: 'flowUltimoCaminhao',
  severidade: 4,
  caminhoes: ['4502'],
  e: { frente: 'Frente 2' },
}, {});
assert.equal(empacotadoUltimoCam.rascunho.FROTA, '4502');
assert.equal(empacotadoUltimoCam.rascunho.FRENTE, '2');
assert.equal(empacotadoUltimoCam.rascunho.CODIGO, '908');
assert.equal(empacotadoUltimoCam.rascunho.IMPACTANTE, 'Crítico');

// v6.4.0: Pronúncia fonética anti-soletração (COA -> côa, Flow -> flôu) e frotas numéricas nas notificações Push.
assert.equal(
  policy.normalizarPronunciaSetor('Atenção C.O.A. e F.L.O.W.: C O A / F L O W / COA / FLOW / coa / flow'),
  'Atenção Coa e Flow: Coa / Flow / Coa / Flow / Coa / Flow'
);
assert.equal(
  policy.paraFoneticaVoz('Atenção Coa e C.O.A.: falar com o Flow (F L O W) agora.'),
  'Atenção côa e côa: falar com o flôu (flôu) agora.'
);
assert.doesNotMatch(policy.paraFoneticaVoz('COA C-O-A FLOW F-L-O-W'), /\bCOA\b|\bFLOW\b|C\s*O\s*A|F\s*L\s*O\s*W/i);
assert.equal(
  policy.garantirFrotaEmNumeros('Atenção Flow: Caminhão oito oito três três e Trator zero zero oito três com apenas um caminhão carregando.'),
  'Atenção Flow: Caminhão 8833 e Trator 0083 com apenas um caminhão carregando.'
);
assert.equal(
  policy.montarTituloPush({ numero: '8833', classe: 'Caminhão', e: { tipo: 'CAMINHÃO CANAVIEIRO' } }),
  'Alarme oficial SGPA · Caminhão 8833'
);
assert.equal(
  policy.montarTextoPush({ regra: 'velocidade', numero: '8833', valor: 85, e: { tipo: 'CAMINHÃO CANAVIEIRO' } }),
  'Atenção Flow: Caminhão 8833 excedeu a velocidade a 85 quilômetros por hora. Verificar.'
);
assert.equal(
  policy.montarTextoPush({
    regra: 'flowUltimoCaminhao',
    caminhoes: ['4468'],
    e: { frente: 'Frente 2' },
  }),
  'Atenção Flow, urgente! Frente 2 com apenas um caminhão carregando, caminhão 4468, e nenhum caminhão no aguarde. Avaliar e enviar outro caminhão imediatamente.'
);

console.log('test-alerts-policy: contrato integrado e inteligência COA v3.0 + v4.0 + v5.0 + v5.1 + v5.2 + v6.0 + v6.1 + v6.2 + v6.4 passaram.');
