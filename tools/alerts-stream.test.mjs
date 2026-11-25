import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/alerts-stream.js', import.meta.url), 'utf8');

function criarWorker(fetchImpl) {
  const mensagens = [];
  const self = {
    onmessage: null,
    postMessage(mensagem) { mensagens.push(structuredClone(mensagem)); },
  };
  vm.runInNewContext(source, {
    self,
    fetch: fetchImpl,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    JSON,
  }, { filename: 'public/alerts-stream.js' });
  return {
    mensagens,
    enviar(data) { self.onmessage({ data }); },
  };
}

async function esperar(mensagens, condicao, descricao) {
  for (let i = 0; i < 200; i++) {
    if (condicao()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timeout aguardando ${descricao}`);
}

const abrir = { type: 'abrir', url: 'https://fixture.invalid/stream', token: 'fixture-token', corpo: {} };

test('processa a última linha JSON válida quando o stream termina sem quebra de linha', async () => {
  const quadro = { type: 'monitoramento', cdEquipamento: 'EOF-01', cdOperacao: 905 };
  const bytes = new TextEncoder().encode(JSON.stringify(quadro));
  const worker = criarWorker(async () => new Response(bytes, { status: 200 }));
  worker.enviar(abrir);
  await esperar(worker.mensagens, () => worker.mensagens.some((m) => m.type === 'estado' && m.status === 'fechado'), 'EOF');
  const lotes = worker.mensagens.filter((m) => m.type === 'quadros').flatMap((m) => m.itens);
  assert.deepEqual(lotes, [quadro]);
});

test('drena quadros já recebidos antes de fechar e abortar o stream', async () => {
  const quadro = { type: 'monitoramento', cdEquipamento: 'CLOSE-01', cdOperacao: 905 };
  let controlador;
  const corpo = new ReadableStream({
    start(c) {
      controlador = c;
      c.enqueue(new TextEncoder().encode(JSON.stringify(quadro) + '\n'));
    },
  });
  const worker = criarWorker(async (_url, opcoes) => {
    opcoes.signal.addEventListener('abort', () => {
      try { controlador.close(); } catch { /* stream já fechado */ }
    });
    return new Response(corpo, { status: 200 });
  });
  worker.enviar(abrir);
  await esperar(worker.mensagens, () => worker.mensagens.some((m) => m.type === 'estado' && m.status === 'ao vivo'), 'abertura do stream');
  await new Promise((resolve) => setTimeout(resolve, 20)); // antes do timer de agrupamento de 150 ms
  worker.enviar({ type: 'fechar' });
  await esperar(worker.mensagens, () => worker.mensagens.some((m) => m.type === 'estado' && m.status === 'fechado'), 'ack de fechamento');
  const lotes = worker.mensagens.filter((m) => m.type === 'quadros').flatMap((m) => m.itens);
  assert.deepEqual(lotes, [quadro]);
});
