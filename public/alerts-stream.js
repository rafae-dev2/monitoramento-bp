/* Monitoramento BP — worker do stream ao vivo
 *
 * Mantém aberta a conexão NDJSON que o próprio micro-frontend do mapa usa
 * (POST /monitoramento/v2/subscribe-live). Cada linha é um evento:
 *   {type:'monitoramento', cdEquipamento, geohash, cdOperacao, descOperacao,
 *    cdOperador, descOperador, cdEstado, fgTpAlerta, vlDirecao, dtHrLocal, deleted}
 *   {type:'alarme', cdEquipamento, descAlarme, cdTpAlarme, vlPeso, fgOnline, ...}
 *
 * Rodar aqui fora do fio principal tem dois ganhos: a leitura não para quando o
 * navegador reduz o ritmo de timers em aba escondida, e o parser não trava o mapa.
 */

let ctl = null;
let ativo = false;
let buf = '';
let caixa = [];
let escorrendo = null;

async function abrir(msg) {
  fechar();
  ativo = true;
  ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  self.postMessage({ type: 'estado', status: 'conectando' });
  try {
    const res = await fetch(msg.url, {
      method: 'POST',
      headers: {
        'X-Auth-Token': msg.token,
        'content-type': 'application/x-ndjson',
        'request-origin': 'sgp-front',
        accept: 'application/x-ndjson, application/json',
      },
      body: JSON.stringify(msg.corpo),
      signal: ctl ? ctl.signal : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      const erro = new Error('HTTP ' + res.status);
      erro.statusCode = res.status;
      throw erro;
    }
    if (!res.body || !res.body.getReader) {
      // navegadores sem streaming de corpo: cai para leitura única do texto
      const txt = await res.text();
      processar(txt);
      self.postMessage({ type: 'estado', status: 'fechado' });
      return;
    }
    self.postMessage({ type: 'estado', status: 'ao vivo' });
    const leitor = res.body.getReader();
    const dec = new TextDecoder();
    while (ativo) {
      const { done, value } = await leitor.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const cortes = buf.split('\n');
      buf = cortes.pop() || '';
      if (cortes.length) processar(cortes.join('\n'));
    }
    self.postMessage({ type: 'estado', status: 'fechado' });
  } catch (e) {
    if (ativo) self.postMessage({ type: 'estado', status: 'erro', statusCode: Number(e && e.statusCode) || 0, mensagem: String((e && e.message) || e) });
  } finally {
    escorrendo = null;
  }
}

function processar(texto) {
  for (const linha of texto.split('\n')) {
    const t = linha.trim();
    if (!t) continue;
    let obj = null;
    try {
      obj = JSON.parse(t.startsWith('data:') ? t.slice(5).trim() : t);
    } catch {
      continue; // linha parcial ou não JSON
    }
    if (obj && obj.cdEquipamento) caixa.push(obj);
    if (Array.isArray(obj)) for (const x of obj) if (x && x.cdEquipamento) caixa.push(x);
  }
  escoar();
}

function escoar() {
  if (!caixa.length || escorrendo) return;
  escorrendo = setTimeout(() => {
    escorrendo = null;
    if (!caixa.length) return;
    const itens = caixa;
    caixa = [];
    self.postMessage({ type: 'quadros', itens });
  }, 150);
}

function fechar() {
  ativo = false;
  buf = '';
  caixa = [];
  if (escorrendo) clearTimeout(escorrendo);
  escorrendo = null;
  if (ctl) {
    try {
      ctl.abort();
    } catch {
      /* já encerrado */
    }
    ctl = null;
  }
}

self.onmessage = (ev) => {
  const m = (ev && ev.data) || {};
  if (m.type === 'abrir') abrir(m);
  else if (m.type === 'fechar') fechar();
};
