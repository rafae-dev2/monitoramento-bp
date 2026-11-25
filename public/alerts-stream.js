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
let sequencia = 0;
let buf = '';
let caixa = [];
let timerEscoar = null;
let timerAbertura = null;
let decoder = null;

async function abrir(msg) {
  fechar();
  const id = ++sequencia;
  ativo = true;
  buf = '';
  caixa = [];
  decoder = new TextDecoder();
  ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const controlador = ctl;
  const atual = () => id === sequencia && ativo;
  self.postMessage({ type: 'estado', status: 'conectando' });
  if (controlador) {
    timerAbertura = setTimeout(() => {
      if (atual()) controlador.abort();
    }, 30000);
  }
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
      signal: controlador ? controlador.signal : undefined,
      cache: 'no-store',
    });
    if (!atual()) return;
    if (timerAbertura) clearTimeout(timerAbertura);
    timerAbertura = null;
    if (!res.ok) {
      const erro = new Error('HTTP ' + res.status);
      erro.statusCode = res.status;
      throw erro;
    }
    if (!res.body || !res.body.getReader) {
      // Compatibilidade: mesmo a resposta de leitura única passa pelo flush final.
      buf += await res.text();
      if (!atual()) return;
      finalizarBuffer();
      ativo = false;
      self.postMessage({ type: 'estado', status: 'fechado' });
      return;
    }
    self.postMessage({ type: 'estado', status: 'ao vivo' });
    const leitor = res.body.getReader();
    while (atual()) {
      const { done, value } = await leitor.read();
      if (!atual()) break;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const cortes = buf.split('\n');
      buf = cortes.pop() || '';
      if (cortes.length) processar(cortes.join('\n'));
    }
    if (atual()) {
      finalizarBuffer();
      ativo = false;
      self.postMessage({ type: 'estado', status: 'fechado' });
    }
  } catch (e) {
    if (atual()) {
      finalizarBuffer();
      ativo = false;
      self.postMessage({ type: 'estado', status: 'erro', statusCode: Number(e && e.statusCode) || 0, mensagem: String((e && e.message) || e) });
    }
  } finally {
    if (id === sequencia) {
      if (timerAbertura) clearTimeout(timerAbertura);
      timerAbertura = null;
      ctl = null;
      decoder = null;
    }
  }
}

function processar(texto) {
  let invalidas = 0;
  for (const linha of texto.split('\n')) {
    const t = linha.trim();
    if (!t) continue;
    const json = t.startsWith('data:') ? t.slice(5).trim() : t;
    // Ignora comentários e campos SSE; só conta como malformado o que se parece com JSON.
    if (!json.startsWith('{') && !json.startsWith('[')) continue;
    let obj = null;
    try {
      obj = JSON.parse(json);
    } catch {
      invalidas++;
      continue;
    }
    if (obj && obj.cdEquipamento) caixa.push(obj);
    if (Array.isArray(obj)) for (const x of obj) if (x && x.cdEquipamento) caixa.push(x);
  }
  if (invalidas) self.postMessage({ type: 'aviso', mensagem: `${invalidas} linha(s) NDJSON inválida(s) recebida(s); confira a conexão com o portal.` });
  escoar();
}

function escoar(imediato = false) {
  if (imediato) {
    if (timerEscoar) clearTimeout(timerEscoar);
    timerEscoar = null;
    if (!caixa.length) return;
    const itens = caixa;
    caixa = [];
    self.postMessage({ type: 'quadros', itens });
    return;
  }
  if (!caixa.length || timerEscoar) return;
  timerEscoar = setTimeout(() => {
    timerEscoar = null;
    if (!caixa.length) return;
    const itens = caixa;
    caixa = [];
    self.postMessage({ type: 'quadros', itens });
  }, 150);
}

function finalizarBuffer() {
  if (decoder) {
    try { buf += decoder.decode(); } catch { /* flush parcial de bytes */ }
  }
  if (buf.trim()) processar(buf); // inclui a última linha mesmo sem \n no EOF.
  buf = '';
  escoar(true); // não deixa o timer de agrupamento perder quadros no fechamento.
}

function fechar() {
  const tinhaDados = ativo || !!buf || caixa.length > 0;
  ativo = false;
  sequencia++;
  if (timerAbertura) clearTimeout(timerAbertura);
  timerAbertura = null;
  finalizarBuffer();
  if (ctl) {
    try { ctl.abort(); } catch { /* já encerrado */ }
    ctl = null;
  }
  decoder = null;
  if (tinhaDados) self.postMessage({ type: 'estado', status: 'fechado' });
}

let timerRelogio = null;
let intervaloRelogioMs = 0;

function agendarPulso() {
  if (!intervaloRelogioMs) return;
  timerRelogio = setTimeout(() => {
    timerRelogio = null;
    if (!intervaloRelogioMs) return;
    self.postMessage({ type: 'pulso', ts: Date.now() });
    agendarPulso();
  }, intervaloRelogioMs);
}

function iniciarRelogio(ms) {
  pararRelogio();
  const n = Number(ms);
  intervaloRelogioMs = Number.isFinite(n) && n >= 250 ? Math.round(n) : 5000;
  agendarPulso();
}

function pararRelogio() {
  intervaloRelogioMs = 0;
  if (timerRelogio) {
    clearTimeout(timerRelogio);
    timerRelogio = null;
  }
}

self.onmessage = (ev) => {
  const m = (ev && ev.data) || {};
  if (m.type === 'abrir') abrir(m);
  else if (m.type === 'fechar') fechar();
  else if (m.type === 'relogio') iniciarRelogio(m.intervaloMs);
  else if (m.type === 'parar-relogio') pararRelogio();
};
