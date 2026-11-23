import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (!mode) {
  for (const scenario of ['fresh-inflight', 'unauthorized-concurrent']) {
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
delete process.env.APP_KEY;

const { default: handler } = await import('../netlify/functions/session.mjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let logins = 0;
const requisicoesDados = [];

function json(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));

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

const request = (query = '') => new Request(
  `https://pwa.fixture.invalid/.netlify/functions/session${query}`,
  { method: 'GET', headers: { 'x-forwarded-for': `test-${mode}` } },
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
} else {
  throw new Error(`Cenário desconhecido: ${mode}`);
}
