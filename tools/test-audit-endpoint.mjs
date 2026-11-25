import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://fixture.supabase.co';
process.env.SUPABASE_KEY = 'fixture-only-key';
const { default: handler } = await import('../netlify/functions/session.mjs');

function request(alertas, ip) {
  return new Request('https://fixture.invalid/.netlify/functions/session?acao=alerta', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ alertas, unidade: 'Fixture', usuario: 'Fixture' }),
  });
}

test('endpoint confirma cada evento e comunica gravação parcial sem sucesso falso', async () => {
  const fetchOriginal = globalThis.fetch;
  const gravacoes = [];
  globalThis.fetch = async (url, opcoes) => {
    gravacoes.push({ url, linha: JSON.parse(opcoes.body) });
    return new Response('', { status: gravacoes.length === 1 ? 201 : 503 });
  };
  try {
    const resposta = await handler(request([
      { eventId: 'audit-ok', chave: 'alert-ok' },
      { eventId: 'audit-fail', chave: 'alert-fail' },
    ], '198.51.100.11'));
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
    assert.equal(gravacoes.length, 2);
    assert.ok(gravacoes.every((g) => g.url === 'https://fixture.supabase.co/rest/v1/pwa_alertas'));
    assert.equal('eventId' in gravacoes[0].linha, false); // não requer coluna/migration em produção nesta etapa
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});

test('endpoint rejeita lote acima de 40 antes de qualquer gravação', async () => {
  const fetchOriginal = globalThis.fetch;
  let chamadas = 0;
  globalThis.fetch = async () => { chamadas++; return new Response('', { status: 201 }); };
  try {
    const alertas = Array.from({ length: 41 }, (_, i) => ({ eventId: `id-${i}` }));
    const resposta = await handler(request(alertas, '198.51.100.12'));
    assert.equal(resposta.status, 413);
    assert.equal(chamadas, 0);
  } finally {
    globalThis.fetch = fetchOriginal;
  }
});
