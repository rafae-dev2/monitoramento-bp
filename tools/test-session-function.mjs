import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (!mode) {
  for (const scenario of ['fresh-inflight', 'unauthorized-concurrent', 'gemini-ai-tts', 'gemini-aq-key-fallback']) {
    const output = execFileSync(process.execPath, [thisFile, scenario], { encoding: 'utf8' });
    process.stdout.write(output);
  }
  console.log('test-session-function: todos os cenários passaram.');
  process.exit(0);
}

process.env.AUTH_API = 'https://auth.fixture.invalid/api';
process.env.SGPA_API = 'https://sgpa.fixture.invalid/slf';
process.env.MAP_URL = 'https://map.fixture.invalid/index.html';
process.env.PORTAL_URL = 'https://portal.fixture.invalid';
process.env.CLIENT_NAME = 'fixture';
process.env.CLIENT_OWNER = 'fixture';
process.env.SOLINF_USER = 'fixture-user';
process.env.SOLINF_PASS = 'fixture-password';
process.env.PROPS_TTL_SECONDS = '432000';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
if (mode === 'gemini-ai-tts') process.env.GEMINI_API_KEY = 'AIzaSyFixtureKeyForUnitTestOnly123456';
else if (mode === 'gemini-aq-key-fallback') process.env.GEMINI_API_KEY = 'GEMINI_API_KEY="AQ.FixtureUnitTestOnlyKey0000000000000000"';
else delete process.env.GEMINI_API_KEY;
delete process.env.APP_KEY;

const { default: handler } = await import('../netlify/functions/session.mjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let logins = 0;
const requisicoesDados = [];
const chamadasGemini = [];

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));

  if (url.hostname === 'generativelanguage.googleapis.com' || url.hostname === 'aiplatform.googleapis.com') {
    const body = JSON.parse(String(init.body || '{}'));
    chamadasGemini.push({ host: url.hostname, path: url.pathname, apiKey: headers.get('x-goog-api-key'), body });
    if (mode === 'gemini-aq-key-fallback' && url.hostname === 'generativelanguage.googleapis.com') {
      return json({ error: { code: 401, message: 'ACCESS_TOKEN_TYPE_UNSUPPORTED', status: 'UNAUTHENTICATED' } }, 401);
    }
    if (url.pathname.includes('tts')) {
      const pcmDummy = Buffer.alloc(480, 0).toString('base64');
      return json({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmDummy } }],
          },
        }],
      });
    }
    return json({
      candidates: [{
        content: {
          parts: [
            { text: 'pensamento interno oculto', thought: true },
            { text: '• Diagnóstico Causa-Raiz:\n  - Frente 3 com falta de caminhão.\n• Ações Imediatas — Controle Coa:\n  - Alinhar transbordos.\n• Ações Imediatas — Controle Flow:\n  - Despachar 2 canavieiros.' },
          ],
        },
      }],
    });
  }

  if (url.hostname === 'auth.fixture.invalid' && url.pathname.endsWith('/auth-sgpa/create')) {
    logins += 1;
    const token = `fixture-token-${logins}`;
    if (mode === 'fresh-inflight' && logins === 1) await wait(80);
    return json({ token });
  }

  if (url.hostname === 'sgpa.fixture.invalid' && url.pathname.endsWith('/user/byUsername/fixture-user')) {
    const token = headers.get('X-Auth-Token');
    return json({ cdGrupo: token === 'fixture-token-1' ? 11 : 22 });
  }

  if (url.hostname === 'sgpa.fixture.invalid' && url.pathname.endsWith('/unidade')) {
    const token = headers.get('X-Auth-Token');
    const unidade = token === 'fixture-token-1' ? 11 : 22;
    return json([{ cdUnidade: unidade, descUnidade: `Unidade ${unidade}` }]);
  }

  if (url.hostname === 'sgpa.fixture.invalid' && url.pathname.endsWith('/estatistica/monitoramento')) {
    const token = headers.get('X-Auth-Token');
    requisicoesDados.push({ token, unidade: url.searchParams.get('buId') });
    if (mode === 'unauthorized-concurrent' && token === 'fixture-token-1') {
      await wait(35);
      return json({ erro: 'sessão expirada fixture' }, 401);
    }
    return json([{ cdEquipamento: 'fixture-equipment', token, unidade: url.searchParams.get('buId') }]);
  }

  throw new Error(`Chamada não prevista no teste: ${init.method || 'GET'} ${url.href}`);
};

const request = (query = '', init = {}) => new Request(
  `https://pwa.fixture.invalid/.netlify/functions/session${query}`,
  Object.assign({ method: 'GET', headers: { 'x-forwarded-for': `test-${mode}` } }, init),
);

if (mode === 'fresh-inflight') {
  const emAndamento = handler(request(), {});
  await wait(10);
  const forcadas = Array.from({ length: 5 }, () => handler(request('?fresh=1'), {}));
  const respostas = await Promise.all([emAndamento, ...forcadas]);
  const corpos = await Promise.all(respostas.map((res) => res.json()));
  assert.equal(respostas.every((res) => res.status === 200), true, 'todas as respostas devem ser 200');
  assert.equal(corpos[0].props.token, 'fixture-token-1', 'a obtenção inicial termina com o primeiro token');
  assert.equal(new Set(corpos.slice(1).map((body) => body.props.token)).size, 1, 'refresh concorrente deve compartilhar uma sessão');
  assert.equal(corpos[1].props.token, 'fixture-token-2', 'refresh deve ocorrer depois da sessão inicial em andamento');
  assert.equal(logins, 2, 'uma sessão inicial e somente uma renovação forçada');
  console.log('OK: cinco pedidos fresh=1 durante uma obtenção em andamento compartilharam uma única renovação.');
} else if (mode === 'unauthorized-concurrent') {
  const inicial = await handler(request(), {});
  assert.equal(inicial.status, 200);
  const corpoInicial = await inicial.json();
  assert.equal(corpoInicial.props.token, 'fixture-token-1');

  const rota = encodeURIComponent('/estatistica/monitoramento');
  const respostas = await Promise.all(
    Array.from({ length: 6 }, () => handler(request(`?acao=dados&rota=${rota}`), {})),
  );
  const corpos = await Promise.all(respostas.map((res) => res.json()));
  assert.equal(respostas.every((res) => res.status === 200), true, 'todos os retries devem responder 200');
  assert.equal(corpos.every((body) => body.dados[0].token === 'fixture-token-2'), true, 'cada resposta deve usar o token renovado');
  assert.equal(corpos.every((body) => body.dados[0].unidade === '22'), true, 'cada retry deve usar a unidade da sessão renovada');
  assert.equal(logins, 2, 'seis respostas 401 concorrentes devem compartilhar uma única renovação');
  assert.equal(requisicoesDados.filter((r) => r.token === 'fixture-token-1').length, 6, 'cada chamada inicial usou a sessão expirada');
  assert.equal(requisicoesDados.filter((r) => r.token === 'fixture-token-2' && r.unidade === '22').length, 6, 'cada retry usou token e unidade novos');
  console.log('OK: seis HTTP 401 concorrentes compartilharam uma renovação e repetiram a rota com a unidade nova.');
} else if (mode === 'gemini-ai-tts') {
  const stRes = await handler(request('?acao=ia_status'), {});
  const stBody = await stRes.json();
  assert.equal(stRes.status, 200);
  assert.equal(stBody.servidorConfigurado, true);
  assert.equal(Array.isArray(stBody.vozes) && stBody.vozes.some((v) => v.id === 'Kore'), true);

  const ttsRes = await handler(request('?acao=ia_voz', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-gemini' },
    body: JSON.stringify({ texto: 'Atenção Coa: Colhedora operando na Frente 1.', voz: 'Kore', estilo: 'comando' }),
  }), {});
  const ttsBody = await ttsRes.json();
  assert.equal(ttsRes.status, 200);
  assert.equal(ttsBody.ok, true);
  assert.equal(ttsBody.voz, 'Kore');
  assert.equal(ttsBody.mimeType, 'audio/wav');
  const wavBuf = Buffer.from(ttsBody.audioBase64, 'base64');
  assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF', 'PCM 24kHz do Gemini deve sair empacotado com cabeçalho RIFF/WAV');

  const iaRes = await handler(request('?acao=ia_raciocinio', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-gemini' },
    body: JSON.stringify({ pergunta: 'Qual o gargalo atual?', contexto: { unidade: 'Branco Peres' } }),
  }), {});
  const iaBody = await iaRes.json();
  assert.equal(iaRes.status, 200);
  assert.equal(iaBody.ok, true);
  assert.equal(iaBody.origem, 'gemini');
  assert.doesNotMatch(iaBody.analise, /pensamento interno oculto/, 'partes thought:true do Gemini 2.5 Thinking não devem vazar no texto final');
  assert.match(iaBody.analise, /Diagnóstico Causa-Raiz/);
  console.log('OK: rotas ia_status, ia_voz (WAV 24kHz vozes brasileiras Gemini) e ia_raciocinio (Gemini 2.5 Thinking) validadas.');
} else if (mode === 'gemini-aq-key-fallback') {
  const stRes = await handler(request('?acao=ia_status'), {});
  const stText = await stRes.text();
  assert.equal(stText.includes('FixtureUnitTestOnlyKey'), false, 'ia_status jamais pode vazar a chave secreta');
  const stBody = JSON.parse(stText);
  assert.equal(stRes.status, 200);
  assert.equal(stBody.servidorConfigurado, true);
  assert.equal(stBody.formatoChave, 'AQ');

  const ttsRes = await handler(request('?acao=ia_voz', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-gemini-aq' },
    body: JSON.stringify({ texto: 'Atenção Flow: Caminhão bombeiro em deslocamento.', voz: 'Puck', estilo: 'urgente' }),
  }), {});
  const ttsBody = await ttsRes.json();
  assert.equal(ttsRes.status, 200);
  assert.equal(ttsBody.ok, true);
  assert.equal(ttsBody.voz, 'Puck');
  assert.equal(chamadasGemini.length, 2, 'primeira chamada tenta Studio (401) e faz fallback automático para Vertex Express (200)');
  assert.equal(chamadasGemini[0].host, 'generativelanguage.googleapis.com');
  assert.equal(chamadasGemini[1].host, 'aiplatform.googleapis.com');
  assert.equal(chamadasGemini[1].apiKey, 'AQ.FixtureUnitTestOnlyKey0000000000000000', 'sanitizador deve remover prefixo GEMINI_API_KEY= e aspas');

  const iaRes = await handler(request('?acao=ia_raciocinio', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-gemini-aq' },
    body: JSON.stringify({ pergunta: 'Diagnóstico rápido', contexto: { unidade: 'Branco Peres' } }),
  }), {});
  const iaBody = await iaRes.json();
  assert.equal(iaRes.status, 200);
  assert.equal(iaBody.ok, true);
  assert.equal(chamadasGemini.length, 3, 'segunda chamada na mesma instância já usa direto a superfície Vertex Express memoizada');
  assert.equal(chamadasGemini[2].host, 'aiplatform.googleapis.com');
  console.log('OK: chave AQ. sanitizada + fallback adaptativo AI Studio -> Vertex Express + cache por chave validados.');
} else {
  throw new Error(`Cenário desconhecido: ${mode}`);
}
