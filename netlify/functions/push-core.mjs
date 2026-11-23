import AlertasPolicy from '../../public/alerts-policy.js';

const MAX_PREFERENCES_TEXT = 4000;
const MAX_GROUPS = 200;
const MAX_MAP_SELECTION = 30;

export function normalizeAlertResponse(response) {
  let rows = null;
  if (Array.isArray(response)) rows = response;
  else if (response && Array.isArray(response.data)) rows = response.data;
  else if (response && response.data && Array.isArray(response.data.data)) rows = response.data.data;
  else if (response && response.data && Array.isArray(response.data.content)) rows = response.data.content;
  else if (response && Array.isArray(response.content)) rows = response.content;
  else if (response && Array.isArray(response.result)) rows = response.result;

  if (!rows) throw new Error('SGPA returned an unexpected active alarm response');

  const alarms = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('SGPA active alarm response contains an invalid record');
    }
    if (isClosed(row.fgOnline)) continue;
    const alarm = normalizeOfficialAlarm(row);
    if (!alarm) throw new Error('SGPA active alarm record is missing equipment or alarm type');
    alarms.push(alarm);
  }

  return deduplicateAlarmRows(alarms);
}

export function normalizeOfficialAlarm(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  if (isClosed(row.fgOnline)) return null;

  const equipmentId = nonEmpty(row.cdEquipamento);
  const typeId = nonEmpty(row.cdTpAlarme);
  if (!equipmentId || !typeId) return null;

  const equipmentDescription = nonEmpty(row.descEquipamento) || equipmentId;
  const parts = splitEquipmentDescription(equipmentDescription, equipmentId);
  const typeDescription = nonEmpty(row.descTpAlarme) || nonEmpty(row.descAlarme) || `Alarme SGPA ${typeId}`;
  const category = AlertasPolicy.categoria(typeId, typeDescription);
  const rawValue = firstNonEmpty(row.vlAlarme, row.vlAlarmeMaximoAtingido);
  const value = numericValue(rawValue);
  const externalId = nonEmpty(row.cdId);
  const startedAt = alarmTime(row);
  const front = firstNonEmpty(row.descGrupoEquipamento, row.descFrente, row.descGrupo, row.frente) || '';
  const operation = firstNonEmpty(row.descOperacao, row.operacao) || '';
  const operator = firstNonEmpty(row.nomeOperador, row.descOperador, row.descFuncionario) || '';
  const keyParts = [equipmentId, typeId, externalId || 'active'];
  const alert = {
    regra: category,
    tipoAlarme: typeId,
    codigo: typeId,
    descricao: typeDescription,
    texto: typeDescription,
    numero: parts.number,
    classe: 'Veículo',
    valor: value,
    e: {
      id: equipmentId,
      numero: parts.number,
      nome: parts.name,
      classe: 'Veículo',
      tipo: nonEmpty(row.descTpEquipamento) || '',
      frente: String(front),
      operacao: String(operation),
      operador: String(operator),
    },
  };

  return {
    alarmKey: keyParts.join('|').slice(0, 300),
    externalId,
    equipmentId,
    number: parts.number,
    equipmentDescription,
    typeId,
    typeDescription,
    category,
    front: String(front),
    operation: String(operation),
    operator: String(operator),
    value,
    startedAt,
    payload: {
      title: 'Alarme oficial SGPA',
      body: AlertasPolicy.montarFala(alert),
      equipmentId,
      typeId,
      typeDescription,
      category,
      number: parts.number,
      front: String(front),
      operation: String(operation),
      operator: String(operator),
      value,
      official: true,
    },
  };
}

export function toDatabaseAlarm(alarm) {
  return {
    alarmKey: alarm.alarmKey,
    externalId: alarm.externalId || alarm.alarmKey || 'active',
    payload: alarm.payload,
    startedAt: alarm.startedAt,
  };
}

export function normalizePushPreferences(value) {
  const source = isPlainObject(value) ? value : {};
  const normalized = AlertasPolicy.normalizeCfg(source);
  const categories = {};
  for (const [key, enabled] of Object.entries(normalized.notificarCategorias || {})) {
    if (typeof enabled === 'boolean') categories[String(key).slice(0, 48)] = enabled;
  }
  const types = {};
  for (const [key, enabled] of Object.entries(normalized.tiposNotificacao || {})) {
    if (typeof enabled === 'boolean' && String(key).length <= 48) types[String(key)] = enabled;
  }
  const fronts = Array.isArray(source.frentes)
    ? source.frentes.filter((v) => typeof v === 'string').map((v) => v.trim().slice(0, 160)).filter(Boolean).slice(0, MAX_GROUPS)
    : [];
  const mapSelection = Array.isArray(source.selecaoMapa)
    ? source.selecaoMapa.filter((v) => typeof v === 'string' || typeof v === 'number').map((v) => String(v).trim().slice(0, 64)).filter(Boolean).slice(0, MAX_MAP_SELECTION)
    : [];
  const equipmentList = typeof source.equipamentos === 'string' ? source.equipamentos.slice(0, MAX_PREFERENCES_TEXT) : '';

  return {
    notificarCategorias: categories,
    tiposNotificacao: types,
    frentes: fronts,
    equipamentos: equipmentList,
    seguirSelecaoMapa: source.seguirSelecaoMapa === true,
    selecaoMapa: [...new Set(mapSelection)],
  };
}

export function acceptsDeviceAlarm(preferences, payload) {
  if (!payload || payload.official !== true || !payload.equipmentId || !payload.typeId) return false;
  const prefs = normalizePushPreferences(preferences);
  const alarm = {
    regra: payload.category,
    categoria: payload.category,
    tipoAlarme: payload.typeId,
    codigo: payload.typeId,
    descricao: payload.typeDescription,
    texto: payload.typeDescription,
    numero: payload.number || payload.equipmentId,
    e: {
      id: String(payload.equipmentId),
      numero: String(payload.number || payload.equipmentId),
      frente: String(payload.front || ''),
      operacao: String(payload.operation || ''),
    },
  };

  if (!AlertasPolicy.notificar(prefs, alarm)) return false;

  const selectedFronts = prefs.frentes.map(normalizeText).filter(Boolean);
  if (selectedFronts.length && !selectedFronts.includes(normalizeText(payload.front))) return false;

  const selectedEquipments = String(prefs.equipamentos || '')
    .split(/[^0-9A-Za-z]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (selectedEquipments.length) {
    const targets = ` ${String(payload.number || '')} ${String(payload.equipmentId)} `;
    if (!selectedEquipments.some((item) => targets.includes(` ${item} `))) return false;
  }

  const mapSelection = prefs.selecaoMapa;
  if (prefs.seguirSelecaoMapa && mapSelection.length) {
    if (!mapSelection.includes(String(payload.equipmentId)) && !mapSelection.includes(String(payload.number || ''))) return false;
  }

  return true;
}

export function buildPushPayload(payload, occurrenceId) {
  const equipmentId = String(payload && payload.equipmentId || '').slice(0, 64);
  const body = String(payload && payload.body || 'Alarme oficial SGPA. Verificar.').slice(0, 320);
  const id = String(occurrenceId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return {
    title: 'Alarme oficial SGPA',
    body,
    tag: id ? `sgpa-${id}`.slice(0, 120) : `sgpa-${equipmentId}`,
    url: '/',
    data: {
      equipmentId,
      occurrenceId: id,
      typeId: String(payload && payload.typeId || '').slice(0, 48),
    },
  };
}

function deduplicateAlarmRows(alarms) {
  const unique = new Map();
  for (const alarm of alarms) {
    const prior = unique.get(alarm.alarmKey);
    if (!prior || (alarm.startedAt && (!prior.startedAt || alarm.startedAt > prior.startedAt))) {
      unique.set(alarm.alarmKey, alarm);
    }
  }
  return [...unique.values()];
}

function splitEquipmentDescription(description, id) {
  const text = String(description || '').trim();
  const match = text.match(/^(\d{3,8})\s*[-–]\s*(.*)$/);
  return match
    ? { number: match[1], name: match[2] || text }
    : { number: String(id || text), name: text || String(id || '—') };
}

function alarmTime(row) {
  const utc = Number(row.dtHrUTC);
  if (Number.isFinite(utc) && utc > 0) {
    const milliseconds = utc > 1e12 ? utc : utc * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (Array.isArray(row.dtHrLocal) && row.dtHrLocal.length >= 6) {
    const [year, month, day, hour, minute, second] = row.dtHrLocal.map(Number);
    if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;
    const local = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}-03:00`;
    const date = new Date(local);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function numericValue(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value).trim().replace(',', '.');
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isClosed(value) {
  return value === false || value === 0 || /^(false|f|0)$/i.test(String(value));
}

function nonEmpty(value) {
  if (value == null) return '';
  const text = String(value).trim();
  return text && !/^(?:null|undefined|n\/a|na)$/i.test(text) ? text : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = nonEmpty(value);
    if (text) return text;
  }
  return '';
}

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function pad(value) {
  return String(value).padStart(2, '0');
}
