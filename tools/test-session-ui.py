#!/usr/bin/env python3
"""Teste local da recuperação visual da sessão; usa só respostas fixture, sem SGPA real."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class StaticHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'public'), **kwargs)

    def log_message(self, _format, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), StaticHandler)
Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
sessoes = []


def session_route(route):
    sessoes.append(route.request.url)
    indice = len(sessoes)
    if indice == 2:
        route.fulfill(status=401, content_type='application/json', body=json.dumps({'error': 'fixture de sessão expirada'}))
        return
    token = f'token-fixture-{indice}'
    props = {
        'token': token,
        'urlSgpa': 'https://sgpa.fixture.invalid/slf03',
        'cdCliente': 204,
        'cdUnidadeRegional': [1],
        'user': 'fixture-user',
        'descUnidade': 'Unidade fixture',
        'rastroBI': None,
    }
    route.fulfill(status=200, content_type='application/json', body=json.dumps({
        'props': props,
        'mapUrl': 'https://map.fixture.invalid/index.html',
        'portalMap': 'https://portal.fixture.invalid/map',
        'monitplusUrl': 'https://monitplus.fixture.invalid/',
        'who': {'usuario': 'fixture-user', 'unidade': 'Unidade fixture'},
    }))


def launch_chromium(pw):
    import os, shutil
    for cand in (os.environ.get('CHROMIUM_BIN'), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'):
        if cand and shutil.which(cand):
            return pw.chromium.launch(executable_path=cand, args=['--no-sandbox', '--disable-dev-shm-usage'])
    return pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])


try:
    with sync_playwright() as pw:
        browser = launch_chromium(pw)
        context = browser.new_context(viewport={'width': 412, 'height': 915}, locale='pt-BR', service_workers='block')
        context.add_init_script("""(() => {
          window.__swUpdateCalls = 0;
          const handlers = {};
          const registration = {update: () => { window.__swUpdateCalls += 1; return Promise.resolve(); }};
          const serviceWorker = {
            controller: {},
            addEventListener: (name, fn) => { handlers[name] = fn; },
            register: () => Promise.resolve(registration),
            getRegistration: () => Promise.resolve(registration),
          };
          Object.defineProperty(navigator, 'serviceWorker', {configurable:true, value:serviceWorker});
          window.__fireSwControllerChange = () => handlers.controllerchange && handlers.controllerchange();
          window.__fireSwMessage = (data) => handlers.message && handlers.message({data});
        })();""")
        page = context.new_page()
        navegacoes_principais = []
        page.on('framenavigated', lambda frame: navegacoes_principais.append(frame.url) if frame == page.main_frame else None)
        page.route('**/.netlify/functions/session*', session_route)
        page.route('**/alerts.js', lambda route: route.fulfill(
            status=200,
            content_type='application/javascript',
            body='window.__alertCycleCalls=0;window.__alertsStarted=false;window.MonitoramentoAlertas={iniciar:()=>{window.__alertsStarted=true;},atualizarSessao:()=>{},ciclo:()=>{window.__alertCycleCalls+=1;return Promise.resolve();}};',
        ))
        page.route('https://map.fixture.invalid/**', lambda route: route.fulfill(
            status=200,
            content_type='text/html',
            body='<!doctype html><html><body><script>window.addEventListener("message",e=>window.__props=e.data)</script>map fixture</body></html>',
        ))
        page.goto(origin + '/?alertas=1&focusEquipment=8833', wait_until='domcontentloaded')
        page.wait_for_function("document.querySelector('#map').getAttribute('src') === 'https://map.fixture.invalid/index.html'", timeout=5000)
        page.wait_for_function('window.__alertsStarted === true', timeout=5000)
        mapa = next(frame for frame in page.frames if frame.url.startswith('https://map.fixture.invalid/'))
        mapa.wait_for_function("window.__props && window.__props.data.rastroBI.equipment === '8833'", timeout=5000)
        page.evaluate("window.__fireSwMessage({type:'alerta-notificacao',equipamento:'4462'})")
        mapa.wait_for_function("window.__props && window.__props.data.rastroBI.equipment === '4462'", timeout=3000)
        print('OK: clique Push centraliza no mapa incorporado, com foco inicial por URL e sem depender de alerta local ativo.')
        navegacoes_apos_boot = len(navegacoes_principais)
        assert page.locator('#session-status').get_attribute('role') == 'status'
        assert page.locator('#session-status').get_attribute('aria-live') == 'polite'

        page.evaluate("window.dispatchEvent(new Event('online'))")
        page.wait_for_function("!document.querySelector('#session-status').classList.contains('hide')", timeout=3000)
        mensagem = page.locator('#session-status').inner_text()
        assert 'tentará renovar automaticamente' in mensagem and 'Nova sessão' in mensagem, mensagem
        print('OK: falha HTTP 401 mostra instrução acessível e não bloqueante sobre o mapa.')

        page.click('#btn-menu')
        page.click('[data-act="fresh"]')
        page.wait_for_function("document.querySelector('#session-status').classList.contains('hide')", timeout=3000)
        assert len(sessoes) == 3, sessoes
        assert 'fresh=1' in sessoes[1] and 'fresh=1' in sessoes[2], sessoes
        print('OK: Nova sessão recupera a interface e remove o aviso após receber a sessão renovada.')

        page.evaluate("""() => {
          const event = new Event('pageshow');
          Object.defineProperty(event, 'persisted', {value:true});
          window.dispatchEvent(event);
        }""")
        page.wait_for_function("window.__swUpdateCalls >= 3", timeout=3000)
        page.wait_for_function('window.__alertCycleCalls >= 1', timeout=3000)
        page.wait_for_function("document.querySelector('#session-status').classList.contains('hide')", timeout=3000)
        page.wait_for_timeout(100)
        assert len(sessoes) == 4 and 'fresh=1' in sessoes[3], sessoes
        assert page.evaluate('window.__alertCycleCalls') == 1, 'A retomada deve iniciar um novo ciclo da Central'
        assert len(navegacoes_principais) == navegacoes_apos_boot, 'pageshow persistido sincroniza sem recarga redundante'
        print('OK: pageshow do bfcache força revalidação da sessão e verificação do service worker sem recarregar a página')

        navegacoes_antes_update = len(navegacoes_principais)
        with page.expect_navigation(wait_until='domcontentloaded', timeout=5000):
            page.evaluate('window.__fireSwControllerChange()')
        page.wait_for_function("document.querySelector('#map').getAttribute('src') === 'https://map.fixture.invalid/index.html'", timeout=5000)
        assert len(navegacoes_principais) == navegacoes_antes_update + 1, navegacoes_principais
        assert len(sessoes) == 5 and 'fresh=1' not in sessoes[4], sessoes
        print('OK: novo controller do service worker recarrega uma vez e a app volta a solicitar sessão/mapa')
        browser.close()
finally:
    server.shutdown()
    server.server_close()
