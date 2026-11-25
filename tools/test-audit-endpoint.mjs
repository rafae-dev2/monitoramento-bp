import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://fixture.supabase.co';
process.env.SUPABASE_KEY = 'fixture-only-key';
const { default: handler } = await import('../netlify/functions/session.mjs');

function request(alertas, ip, extraHeaders = {}) {
  return new Request('https://fixture.invalid/.netlify/functions/session?acao=alerta', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...extraHeaders },
    body: JSON.stringify({ alertas, unidade: 'Fixture', usuario: 'Fixture' }),
  });
}

test('grava lote em uma única requisição PostgREST e deduplica reenvio do mesmo eventId sem duplicar no banco', async () => {
  const fetchOriginal = globalThis.fetch;
  const gravacoes = [];
  globalThis.fetch = async (url, opcoes) => {
    gravacoes.push({ url, corpo: JSON.parse(opcoes.body) });
    return new Response('', { status: 201 });
  };
  try {
    const lote = [
      { eventId: 'bulk-1', chave: 'eq-1|velocidade', regra: 'velocidade', equipamento: '8833' },
      { eventId: 'bulk-2', chave: 'eq-2|rpm', regra: 'rpm', equipamento: '4462' },
      { eventId: 'bulk-3', chave: 'eq-3|ocioso', regra: 'ocioso', equipamento: '2211' },
    ];
    const r1 = await handler(request(lote, '198.51.100.10'), {});
    const d1 = await r1.json();
    assert.equal(r1.status, 202);
    assert.equal(d1.ok, true);
    assert.equal(d1.gravados, 3);
    assert.equal(gravacoes.length, 1, '3 alertas devem virar 1 único INSERT em lote no Supabase');
    assert.equal(Array.isArray(gravacoes[0].corpo), true);
    assert.equal(gravacoes[0].corpo.length, 3);
    assert.equal('eventId' in gravacoes[0].corpo[0], false, 'não envia coluna extra incompatível com schema legado');

    // Simula queda de rede após commit: reenviar os mesmos eventIds não toca no banco de novo
    const r2 = await handler(request(lote, '198.51.100.10'), {});
    const d2 = await r2.json();
    assert.equal(r2.status, 202);
    assert.equal(d2.gravados, 3);
    assert.equal(gravacoes.length, 1, 'reenvio idempotente não gera novo INSERT no Supabase Free');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('endpoint faz fallback individual quando o lote falha e comunica gravação parcial (207) sem sucesso falso', async () => {
  const fetchOriginal = globalThis.fetch;
  const gravacoes = [];
  globalThis.fetch = async (url, opcoes) => {
    const parsed = JSON.parse(opcoes.body);
    gravacoes.push({ url, parsed });
    if (Array.isArray(parsed)) return new Response('', { status: 503 }); // lote falha -> aciona isolamento
    return new Response('', { status: gravacoes.length === 2 ? 201 : 503 });
  };
  try {
    const resposta = await handler(request([
      { eventId: 'audit-ok', chave: 'alert-ok' },
      { eventId: 'audit-fail', chave: 'alert-fail' },
    ], '198.51.100.11'), {});
    const dados = await resposta.json();
    assert.equal(resposta.status, 207);
    assert.equal(dados.ok, false);
    assert.equal(dados.recebidos, 2);
    assert.equal(dados.gravados, 1);
    assert.equal(dados.falhas, 1);
    assert.deepEqual(dados.resultados, [
      { eventId: 'audit-ok', ok: true },
      { eventId: 'audit-fail', ok: false },
    ]);
    assert.equal(gravacoes.length, 3); // 1 tentativa em lote + 2 individuais
    assert.ok(gravacoes.every((g) => g.url === 'https://fixture.supabase.co/rest/v1/pwa_alertas'));
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('endpoint rejeita lote acima de 40 antes de qualquer gravação e exige APP_KEY quando configurada', async () => {
  const fetchOriginal = globalThis.fetch;
  let chamadas = 0;
  globalThis.fetch = async () => { chamadas++; return new Response('', { status: 201 }); };
  try {
    const alertas = Array.from({ length: 41 }, (_, i) => ({ eventId: `id-${i}` }));
    const resposta = await handler(request(alertas, '198.51.100.12'), {});
    assert.equal(resposta.status, 413);
    assert.equal(chamadas, 0);

    process.env.APP_KEY = 'segredo-borda';
    const bloqueada = await handler(request([{ eventId: 'x1' }], '198.51.100.13'), {});
    assert.equal(bloqueada.status, 403);
    const bloqueadaDados = await handler(new Request('https://fixture.invalid/.netlify/functions/session?acao=dados&rota=/alarmeOnline', {
      headers: { 'x-forwarded-for': '198.51.100.13' },
    }), {});
    assert.equal(bloqueadaDados.status, 403);
    assert.equal(chamadas, 0);
  } finally {
    delete process.env.APP_KEY;
    globalThis.fetch = fetchOriginal;
  }
});
