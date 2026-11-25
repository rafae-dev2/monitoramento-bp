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

// Fala: identificador soletrado; valor da velocidade numérico arredondado; ausência não vira zero.
assert.equal(policy.montarFala({ codigo: 2203, numero: '8833', valor: 85 }), 'Veículo oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 2203, numero: '0083', valor: '85.6', operador: 'Ana' }), 'Veículo zero zero oito três excedeu a velocidade a 86 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 2203, numero: '8833', valor: null }), 'Veículo oito oito três três com alarme oficial de velocidade excedida. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, classe: 'Trator', numero: '32308', valor: null }), 'Trator três dois três zero oito com alarme oficial de velocidade excedida. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, classe: 'Trator', numero: '32277', valor: 36 }), 'Trator três dois dois sete sete excedeu a velocidade a 36 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, numero: '32308', valor: 36, e: { tipo: 'TRATOR DE PNEU LEVE' } }), 'Trator três dois três zero oito excedeu a velocidade a 36 quilômetros por hora. Verificar.');
assert.equal(policy.montarFala({ codigo: 5, classe: 'Veículo', numero: '6614', valor: 60 }), 'Veículo seis seis um quatro excedeu a velocidade a 60 quilômetros por hora. Verificar.');
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
assert.equal(
  policy.montarFala({ tipoAlarme: '10820', classe: 'Trator', numero: '32308', valor: 85 }),
  'Trator três dois três zero oito: controle de velocidade do equipamento, velocidade medida de 85 quilômetros por hora. Verificar.'
);
assert.equal(policy.montarFala({ tipoAlarme: '3484', numero: '8833', texto: 'SEM APONTAMENTO' }), 'Veículo oito oito três três: SEM APONTAMENTO. Verificar.');

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
  'Trator zero zero oito três aguardando caminhão. Frente/grupo Norte. Verificar.'
);
assert.equal(
  policy.montarFala({ numero: '12', e: { tipo: 'Transbordo', operacao: 'Aguardando Caminhao' } }),
  'Trator um dois aguardando caminhão. Frente/grupo frente não informada. Verificar.'
);
assert.equal(
  policy.montarFala({
    regra: 'paradaImprodutiva', paradaId: 'aguardandoCarregamento', paradaNome: 'Aguardando carregamento (caminhão)',
    numero: '4426', classe: 'Caminhão', valor: 31,
    e: { tipo: 'CAMINHÕES CANAVIEIRO TERC', frente: 'Frente 1', grupoEquipamento: 'Caminhões Canavieiro Terc' }
  }),
  'Caminhão quatro quatro dois seis aguardando carregamento há 31 minutos, se encontra na Frente 1. Verificar.'
);
const falaFazendaFundo25 = policy.montarFala({
  regra: 'paradaImprodutiva', paradaId: 'aguardandoCarregamento', paradaNome: 'Aguardando carregamento (caminhão)',
  numero: '4426', classe: 'Caminhão', valor: 31,
  e: { tipo: 'CAMINHÕES CANAVIEIRO TERC', frente: 'Fazenda Fundo 25' }
});
assert.equal(falaFazendaFundo25, 'Caminhão quatro quatro dois seis aguardando carregamento há 31 minutos, se encontra na Fazenda Fundo 25. Verificar.');
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
  assert.equal(fala, 'Caminhão quatro quatro dois seis em Aguardando carregamento há 31 minutos. Verificar.');
  assert.doesNotMatch(fala, /Frente 1|frente de colheita|Frente\/grupo/);
}

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
assert.equal(policy.montarFala(speedWhileWaiting), 'Trator oito oito três três excedeu a velocidade a 85 quilômetros por hora. Verificar.');
assert.equal(policy.aplicarGlossario('Veículo Caminhões Canavieiro Terc'), 'Veículo Caminhões Canavieiro Terceiro');
assert.equal(policy.aplicarGlossario('Terc', { glossarioFala: 'Terc=Terceiro' }), 'Terceiro');
assert.equal(policy.notificar({}, { regra: 'aguardandoBasculamento' }), true);
assert.equal(policy.notificar({ notificarCategorias: { aguardandoBasculamento: false } }, { regra: 'aguardandoBasculamento' }), false);
assert.equal(
  policy.montarFala({
    regra: 'aguardandoBasculamento', numero: '8833', caminhoes: ['4451'],
    e: { frente: 'Caminhões Canavieiro Terc' }
  }),
  'Trator oito oito três três: aguardando basculamento, inferido pelo aplicativo porque o caminhão quatro quatro cinco um está aguardando carregamento na mesma frente. Frente/grupo Caminhões Canavieiro Terceiro. No SGPA, o apontamento permanece Aguardando Caminhão. Verificar.'
);
assert.equal(
  policy.montarFala({
    regra: 'frenteDividida', classe: 'Transbordo', numero: '8833',
    e: { tipo: 'Transbordo', operacao: '123 - Frente dividida', frente: 'Frente Norte' }
  }),
  'Atenção COA: Transbordo oito oito três três apontou Frente dividida. Frente/grupo Frente Norte. Verificar a sequência de chamada da colhedora no sistema FUT.'
);

// Inteligência COA v3.0.0: emergência, qualidade de colheita, Raio-X CTT + balanceamento, WhatsApp e Passagem de Turno.
assert.equal(policy.categoria('desconhecido', 'Combate a Incêndio'), 'emergencia');
assert.equal(policy.ehAlertaSeguranca('emergencia'), true);
assert.equal(policy.ehAlertaSeguranca('velocidade'), true);
assert.equal(policy.ehAlertaSeguranca('paradaImprodutiva'), false);
assert.ok(policy.emergenciaOperacional({ operacaoConfirmada: true, operacao: '999 - Combate a Incêndio' }));
assert.ok(policy.emergenciaOperacional({ tipo: 'CAMINHÃO BOMBEIRO', velocidade: 48 }));
assert.equal(policy.emergenciaOperacional({ tipo: 'CAMINHÃO BOMBEIRO', velocidade: 0, operacaoConfirmada: true, operacao: 'Aguardando Carregamento' }), null);
assert.equal(policy.colheitaAcimaDaFaixa({ tipo: 'COLHEDORA', operacaoConfirmada: true, operacao: '101 - Colheita Mecanizada', velocidade: 8.4 }, 7.5), true);
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
console.log('test-alerts-policy: contrato integrado e inteligência COA v3.0 passaram.');
