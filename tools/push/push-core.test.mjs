import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsDeviceAlarm, buildPushPayload, normalizeAlertResponse, normalizePushPreferences, toDatabaseAlarm } from '../../netlify/lib/push-core.mjs';

const speedFixture = {
  cdId: 4674575,
  dtHrUTC: 1795426792,
  cdEquipamento: '8833',
  descEquipamento: '8833 - Caminhão canavieiro',
  cdTpAlarme: 2203,
  descTpAlarme: 'VELOCIDADE EXCEDIDA',
  fgOnline: true,
  vlAlarme: '85',
  descGrupoEquipamento: 'Frente 4',
  descOperacao: 'Transporte',
  nomeOperador: 'Operador 08',
};

const defaults = {
  notificarCategorias: { velocidade: true },
  tiposNotificacao: {},
  frentes: [],
  equipamentos: '',
  glossarioFala: '',
  seguirSelecaoMapa: false,
  selecaoMapa: [],
};

test('normaliza apenas alarmes SGPA ativos, pronuncia a classe real do equipamento e preserva identificadores', () => {
  const alarms = normalizeAlertResponse([speedFixture]);
  assert.equal(alarms.length, 1);
  const alarm = alarms[0];
  assert.equal(alarm.equipmentId, '8833');
  assert.equal(alarm.typeId, '2203');
  assert.equal(alarm.category, 'velocidade');
  assert.equal(alarm.value, 85);
  assert.equal(alarm.payload.title, 'Alarme oficial SGPA · Caminhão 8833');
  assert.match(alarm.payload.body, /^Atenção Flow: Caminhão 8833/);
  assert.doesNotMatch(alarm.payload.body, /oito oito três três/i);
  assert.match(alarm.payload.body, /85 quilômetros por hora/);
  assert.equal(alarm.payload.official, true);
  assert.deepEqual(toDatabaseAlarm(alarm).alarmKey, '8833|2203|4674575');

  const tractorAlarms = normalizeAlertResponse([{
    ...speedFixture,
    cdEquipamento: '0083',
    descEquipamento: '0083 - Trator John Deere',
    descTpEquipamento: 'TRATOR',
  }]);
  assert.equal(tractorAlarms[0].payload.title, 'Alarme oficial SGPA · Trator 0083');
  assert.match(tractorAlarms[0].payload.body, /^Atenção Coa: Trator 0083/);
  assert.doesNotMatch(tractorAlarms[0].payload.body, /zero zero oito três/i);

  const bombeiroAlarms = normalizeAlertResponse([{
    ...speedFixture,
    cdEquipamento: '9911',
    descEquipamento: '9911 - Trator de Pneu Leve',
    descTpEquipamento: 'TRATOR DE PNEU LEVE',
    descGrupoEquipamento: 'CAMINHÕES BOMBEIROS',
  }]);
  assert.equal(bombeiroAlarms[0].payload.title, 'Alarme oficial SGPA · Caminhão 9911');
  assert.match(bombeiroAlarms[0].payload.body, /^Atenção Flow: Caminhão 9911/);
  assert.doesNotMatch(bombeiroAlarms[0].payload.body, /nove nove um um|trator|bombeir/i);

  const turnoIgnored = normalizeAlertResponse([
    { ...speedFixture, cdId: 771, cdTpAlarme: 2849, descTpAlarme: 'TROCA DE TURNO' },
    { ...speedFixture, cdId: 772, cdTpAlarme: 2851, descTpAlarme: 'TROCA DE TURNO EXCEDIDA' },
  ]);
  assert.equal(turnoIgnored.length, 0);
});

test('ignora alarme fechado e deduplica repetição idêntica da resposta SGPA', () => {
  const alarms = normalizeAlertResponse([speedFixture, speedFixture, { ...speedFixture, fgOnline: false, cdId: 991 }]);
  assert.equal(alarms.length, 1);
});

test('falha fechada se o SGPA mudar o formato e evita resolver todos os alarmes por resposta inválida', () => {
  assert.throws(() => normalizeAlertResponse({ unexpected: [] }), /unexpected active alarm response/);
  assert.throws(() => normalizeAlertResponse([{ fgOnline: true, cdEquipamento: '8833' }]), /missing equipment or alarm type/);
});

test('tipo ligado individualmente prevalece sobre categoria desligada; tipo explicitamente desligado prevalece sobre categoria ligada', () => {
  assert.equal(acceptsDeviceAlarm({
    ...defaults,
    notificarCategorias: { velocidade: false },
    tiposNotificacao: { '2203': true },
  }, normalizeAlertResponse([speedFixture])[0].payload), true);

  assert.equal(acceptsDeviceAlarm({
    ...defaults,
    notificarCategorias: { velocidade: true },
    tiposNotificacao: { '2203': false },
  }, normalizeAlertResponse([speedFixture])[0].payload), false);

  assert.equal(acceptsDeviceAlarm({
    ...defaults,
    notificarCategorias: { velocidade: false },
  }, normalizeAlertResponse([speedFixture])[0].payload), false);
});

test('aplica filtros de frentes, equipamentos e seleção do mapa por dispositivo', () => {
  const payload = normalizeAlertResponse([speedFixture])[0].payload;
  assert.equal(acceptsDeviceAlarm({ ...defaults, frentes: ['Frente 4'] }, payload), true);
  assert.equal(acceptsDeviceAlarm({ ...defaults, frentes: ['Frente 5'] }, payload), false);
  assert.equal(acceptsDeviceAlarm({ ...defaults, equipamentos: '8833 4462' }, payload), true);
  assert.equal(acceptsDeviceAlarm({ ...defaults, equipamentos: '74073' }, payload), false);
  assert.equal(acceptsDeviceAlarm({ ...defaults, seguirSelecaoMapa: true, selecaoMapa: ['8833'] }, payload), true);
  assert.equal(acceptsDeviceAlarm({ ...defaults, seguirSelecaoMapa: true, selecaoMapa: ['4462'] }, payload), false);
});

test('rejeita qualquer payload que não prove origem oficial SGPA', () => {
  assert.equal(acceptsDeviceAlarm(defaults, { ...normalizeAlertResponse([speedFixture])[0].payload, official: false }), false);
  assert.equal(acceptsDeviceAlarm(defaults, { equipmentId: '8833', typeId: '2203', body: 'calculado localmente' }), false);
});

test('payload Push mantém navegação interna, chave de deduplicação, converte legado por extenso em números e aplica glossário', () => {
  const prefs = normalizePushPreferences({ glossarioFala: 'excedeu=ultrapassou' });
  const payload = buildPushPayload(normalizeAlertResponse([speedFixture])[0].payload, 'abc-123', prefs);
  assert.equal(payload.url, '/');
  assert.equal(payload.data.equipmentId, '8833');
  assert.equal(payload.data.occurrenceId, 'abc-123');
  assert.equal(payload.data.typeId, '2203');
  assert.equal(payload.data.alertKey, '8833|sgpa:2203');
  assert.equal(payload.tag, 'sgpa-abc-123');
  assert.match(payload.body, /Caminhão 8833 ultrapassou a velocidade/);

  const legado = buildPushPayload({
    title: 'Alarme · Trator três dois dois sete cinco',
    body: 'Atenção Coa: Trator três dois dois sete cinco sem comunicação.',
    equipmentId: '32275',
    typeId: '99',
    official: true,
  }, 'occ-leg', {});
  assert.equal(legado.title, 'Alarme · Trator 32275');
  assert.equal(legado.body, 'Atenção Coa: Trator 32275 sem comunicação.');
});
