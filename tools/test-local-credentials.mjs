import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/local.js', import.meta.url), 'utf8');

function makeStorage(initial = []) {
  const values = new Map(initial);
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(key); },
    entries() { return [...values.entries()]; },
  };
}

function createModule({ local = [], session = [] } = {}) {
  const localStorage = makeStorage(local);
  const sessionStorage = makeStorage(session);
  let logins = 0;
  const calls = [];
  const context = {
    window: {},
    localStorage,
    sessionStorage,
    URL,
    Response,
    Date,
    encodeURIComponent,
    fetch: async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      calls.push({ url: url.href, method: init.method || 'GET' });
      if (url.hostname === 'auth-api.saas-solinftec.com' && url.pathname.endsWith('/auth-sgpa/create')) {
        logins += 1;
        return new Response(JSON.stringify({ token: `fixture-token-${logins}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.hostname === 'sgpa-api-br.saas-solinftec.com' && url.pathname.includes('/user/byUsername/')) {
        return new Response(JSON.stringify({ cdGrupo: 17 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.hostname === 'sgpa-api-br.saas-solinftec.com' && url.pathname.endsWith('/unidade')) {
        return new Response(JSON.stringify([{ cdUnidade: 23, descUnidade: 'Unidade fixture' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Chamada fora das fixtures: ${url.origin}${url.pathname}`);
    },
  };
  vm.runInNewContext(source, context, { filename: 'public/local.js' });
  return {
    api: context.window.MonitoramentoLocal,
    localStorage,
    sessionStorage,
    calls,
    logins: () => logins,
  };
}

const localOld = makeStorage([
  ['bperes.cred.v1', JSON.stringify({ user: 'legacy-user', password: 'old-password' })],
  ['bperes.session.v1', JSON.stringify({ session: { props: { token: 'old-token' } }, expiresAt: Date.now() + 10_000 })],
]);
const sessionOld = makeStorage([
  ['bperes.cred.v1', JSON.stringify({ user: 'legacy-session-user', password: 'old-session-password' })],
  ['bperes.session.v1', JSON.stringify({ session: { props: { token: 'old-session-token' } }, expiresAt: Date.now() + 10_000 })],
]);
const migrated = createModule({ local: localOld.entries(), session: sessionOld.entries() });
assert.equal(migrated.localStorage.getItem('bperes.user.v1'), 'legacy-user', 'migração conserva apenas o nome lembrado localmente');
assert.equal(migrated.localStorage.getItem('bperes.cred.v1'), null, 'senha legada é removida do localStorage');
assert.equal(migrated.localStorage.getItem('bperes.session.v1'), null, 'token/sessão legados são removidos do localStorage');
assert.equal(migrated.sessionStorage.getItem('bperes.cred.v1'), null, 'senha legada também é removida do sessionStorage');
assert.equal(migrated.sessionStorage.getItem('bperes.session.v1'), null, 'token/sessão legados também são removidos do sessionStorage');
assert.equal(migrated.api.temCredencial(), false, 'após abrir/recarregar, nome salvo não implica senha disponível');
assert.equal(migrated.api.lerCredencial().user, 'legacy-user');

migrated.api.salvarCredencial('fixture-user', 'fixture-password', true);
assert.equal(migrated.api.temCredencial(), true, 'senha fica disponível em memória na aba aberta');
assert.equal(migrated.localStorage.getItem('bperes.user.v1'), 'fixture-user', 'a opção marcada salva apenas o nome');
assert.equal(migrated.localStorage.entries().length, 1, 'localStorage contém somente a chave do nome de usuário');
assert.equal(migrated.sessionStorage.entries().length, 0, 'sessionStorage não recebe senha nem sessão');

const first = await migrated.api.sessaoLocal(true);
assert.equal(first.props.token, 'fixture-token-1');
assert.equal(first.who.usuario, 'fixture-user');
assert.equal(migrated.calls.length, 3, 'login fixture consulta apenas auth, usuário e unidade');
assert.equal(await migrated.api.sessaoLocal(false), first, 'sessão em memória é reutilizada sem novo login');
assert.equal(migrated.logins(), 1);
const renewed = await migrated.api.sessaoLocal(true);
assert.equal(renewed.props.token, 'fixture-token-2', 'renovação forçada usa a senha ainda em memória');
assert.equal(migrated.logins(), 2);

const persisted = JSON.stringify([...migrated.localStorage.entries(), ...migrated.sessionStorage.entries()]);
assert.doesNotMatch(persisted, /fixture-password|fixture-token|old-password|old-token|session/i, 'senha, token e objeto de sessão não aparecem no storage');

const afterReload = createModule({ local: migrated.localStorage.entries(), session: migrated.sessionStorage.entries() });
assert.equal(afterReload.api.temCredencial(), false, 'após nova página, não há senha em memória');
assert.equal(afterReload.api.lerCredencial().user, 'fixture-user', 'somente o nome opcional continua pré-preenchível');
assert.equal(afterReload.calls.length, 0, 'a migração/abertura não faz chamadas de rede');

afterReload.api.salvarCredencial('temporary-user', 'temporary-password', false);
assert.equal(afterReload.api.temCredencial(), true, 'opção desmarcada mantém credencial apenas na memória da página');
assert.equal(afterReload.localStorage.entries().length, 0, 'opção desmarcada não persiste sequer o nome');
assert.equal(afterReload.sessionStorage.entries().length, 0, 'opção desmarcada não persiste senha, token nem sessão');
afterReload.api.esquecer();
assert.equal(afterReload.api.temCredencial(), false);
assert.equal(afterReload.api.lerCredencial(), null);

console.log('test-local-credentials: migração, persistência do usuário, login/renovação em memória e limpeza passaram.');
