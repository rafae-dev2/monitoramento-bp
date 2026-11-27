import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (!mode) {
  for (const scenario of ['fresh-inflight', 'unauthorized-concurrent', 'gemini-ai-tts', 'gemini-aq-key-fallback', 'presets-cloud-and-alert-narrator']) {
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
process.env.SUPABASE_URL = mode === 'presets-cloud-and-alert-narrator' ? 'https://supabase.fixture.invalid' : '';
process.env.SUPABASE_KEY = mode === 'presets-cloud-and-alert-narrator' ? 'anon-fixture-key' : '';
const DUMMY_STD_KEY = ['fixture', 'gemini', 'std', 'mock', '1234567890'].join('-');
const DUMMY_AQ_KEY = ['AQ', ['fixture', 'mock', 'only', '1234567890'].join('_')].join('.');
if (mode === 'gemini-ai-tts' || mode === 'presets-cloud-and-alert-narrator') process.env.GEMINI_API_KEY = DUMMY_STD_KEY;
else if (mode === 'gemini-aq-key-fallback') process.env.GEMINI_API_KEY = `GEMINI_API_KEY="${DUMMY_AQ_KEY}"`;
else delete process.env.GEMINI_API_KEY;
delete process.env.APP_KEY;

const { default: handler } = await import('../netlify/functions/session.mjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let logins = 0;
const requisicoesDados = [];
const chamadasGemini = [];
const bancoPresets = new Map();
const chamadasRpcPresets = [];

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));

  if (url.hostname === 'supabase.fixture.invalid' && url.pathname.endsWith('/rest/v1/rpc/pwa_presets_rpc')) {
    const body = JSON.parse(String(init.body || '{}'));
    chamadasRpcPresets.push(body);
    const act = body.p_action;
    const d = body.p_data || {};
    if (act === 'salvar') {
      const row = {
        codigo: d.codigo,
        nome: d.nome,
        setor: d.setor || 'COA',
        operador: d.operador || '',
        descricao: d.descricao || '',
        versao: d.versao || '6.5.0',
        checksum: d.checksum || '',
        config: d.config || {},
        updated_at: '2026-11-27T14:00:00Z',
      };
      bancoPresets.set(d.codigo, row);
      return json({ ok: true, preset: Object.assign({}, row, { config: undefined }) });
    }
    if (act === 'carregar') {
      const row = bancoPresets.get(d.codigo);
      if (!row) return json({ ok: false, erro: 'Preset não encontrado' });
      return json({ ok: true, preset: row });
    }
    if (act === 'listar') {
      const presets = Array.from(bancoPresets.values()).map((r) => ({
        codigo: r.codigo, nome: r.nome, setor: r.setor, operador: r.operador, checksum: r.checksum, updated_at: r.updated_at,
      }));
      return json({ ok: true, presets });
    }
    if (act === 'excluir') {
      const removido = bancoPresets.delete(d.codigo);
      return json({ ok: true, removido });
    }
  }

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
    if (body?.generationConfig?.responseMimeType === 'application/json') {
      return json({
        candidates: [{
          content: {
            parts: [
              { text: 'raciocínio interno sobre fila zero na Frente 2', thought: true },
              {
                text: JSON.stringify({
                  falaInteligente: 'Atenção côa: Transbordo 32275 em 905 há 18 minutos na Frente 2, sem caminhão na fila e 2 colhedoras em 125. Acione o flôu para redirecionar canavieiro imediatamente.',
                  causaRaiz: 'Falta de caminhão canavieiro na Frente 2 travando transbordo carregado e parando colhedoras',
                  acaoImediata: 'Acionar controle flôu para despachar canavieiro vazio à Frente 2',
                  nivelUrgencia: 'critico',
                }),
              },
            ],
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
  assert.equal(stText.includes(DUMMY_AQ_KEY), false, 'ia_status jamais pode vazar a chave secreta');
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
  assert.equal(chamadasGemini[1].apiKey, DUMMY_AQ_KEY, 'sanitizador deve remover prefixo GEMINI_API_KEY= e aspas');

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
} else if (mode === 'presets-cloud-and-alert-narrator') {
  const locRes = await handler(request('?acao=ia_locucao_alerta', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-narrador' },
    body: JSON.stringify({
      voz: 'Kore',
      sintetizarAudio: true,
      alerta: {
        titulo: 'Transbordo 32275 — Transbordo Aguardando (905) há 18 min',
        corpo: 'Frente 2 • sem caminhão na fila',
        fala: 'Atenção côa: Transbordo 32275 aguardando descarga há 18 minutos na Frente 2.',
        sev: 3,
        cat: 'transbordo',
        frente: 2,
      },
      contextoFrente: { frente: 2, colhedorasOperando: 0, colhedorasAguardandoTransbordo: 2, transbordos905: 2, filaCaminhoes: 0 },
    }),
  }), {});
  const locBody = await locRes.json();
  assert.equal(locRes.status, 200);
  assert.equal(locBody.ok, true);
  assert.match(locBody.falaInteligente, /Transbordo 32275/);
  assert.match(locBody.falaInteligente, /côa/);
  assert.match(locBody.causaRaiz, /Falta de caminhão canavieiro/);
  assert.match(locBody.acaoImediata, /flôu/);
  assert.equal(locBody.nivelUrgencia, 'critica');
  assert.equal(locBody.mimeType, 'audio/wav');
  assert.equal(Buffer.from(locBody.audioBase64, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(chamadasGemini.length, 2, 'ia_locucao_alerta deve encadear Gemini 2.5 Thinking JSON + Gemini TTS 24kHz em uma única ida ao servidor');

  const saveRes = await handler(request('?acao=preset_nuvem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-preset' },
    body: JSON.stringify({
      operacao: 'salvar',
      codigo: 'COA Turno A',
      nome: 'Preset COA Turno A',
      setor: 'COA',
      operador: 'Rafael Turno A',
      descricao: 'Refinado para colheita noturna',
      checksum: 'a1b2c3d4e5f60718',
      config: {
        frentes: [1, 2, 3],
        tiposNotificacao: { '905': true, '125': true, '402': false },
        tiposCriticos: { '905': true },
        geminiKey: 'segredo-jamais-persistir',
        token: 'token-jamais-persistir',
        password: 'senha-jamais-persistir',
      },
    }),
  }), {});
  const saveBody = await saveRes.json();
  assert.equal(saveRes.status, 200);
  assert.equal(saveBody.ok, true);
  assert.equal(saveBody.codigo, 'COA-TURNO-A');
  const gravadoNoRpc = chamadasRpcPresets.find((c) => c.p_action === 'salvar');
  assert.ok(gravadoNoRpc, 'deve invocar pwa_presets_rpc com salvar');
  assert.equal('geminiKey' in gravadoNoRpc.p_data.config, false, 'servidor deve remover geminiKey antes do banco');
  assert.equal('token' in gravadoNoRpc.p_data.config, false, 'servidor deve remover token antes do banco');
  assert.equal('password' in gravadoNoRpc.p_data.config, false, 'servidor deve remover password antes do banco');
  assert.deepEqual(gravadoNoRpc.p_data.config.tiposNotificacao, { '905': true, '125': true, '402': false });

  const listRes = await handler(request('?acao=preset_nuvem'), {});
  const listBody = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(listBody.ok, true);
  assert.equal(listBody.presets.some((p) => p.codigo === 'COA-TURNO-A' && p.setor === 'COA'), true);

  const loadRes = await handler(request('?acao=preset_nuvem&codigo=coa-turno-a'), {});
  const loadBody = await loadRes.json();
  assert.equal(loadRes.status, 200);
  assert.equal(loadBody.ok, true);
  assert.equal(loadBody.preset.nome, 'Preset COA Turno A');
  assert.deepEqual(loadBody.preset.config.tiposCriticos, { '905': true });

  const delRes = await handler(request('?acao=preset_nuvem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': 'test-preset' },
    body: JSON.stringify({ subacao: 'excluir', codigo: 'coa-turno-a' }),
  }), {});
  const delBody = await delRes.json();
  assert.equal(delRes.status, 200);
  assert.equal(delBody.ok, true);
  assert.equal(bancoPresets.has('COA-TURNO-A'), false);
  console.log('OK: ia_locucao_alerta (raciocínio Gemini + WAV 24kHz) e preset_nuvem (Supabase RPC sanitizado) validados.');
} else {
  throw new Error(`Cenário desconhecido: ${mode}`);
}
