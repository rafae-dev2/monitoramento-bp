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


try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-dev-shm-usage'])
        context = browser.new_context(viewport={'width': 412, 'height': 915}, locale='pt-BR', service_workers='block')
        page = context.new_page()
        page.route('**/.netlify/functions/session*', session_route)
        page.route('https://map.fixture.invalid/**', lambda route: route.fulfill(
            status=200,
            content_type='text/html',
            body='<!doctype html><html><body><script>window.addEventListener("message",e=>window.__props=e.data)</script>map fixture</body></html>',
        ))
        page.goto(origin + '/?alertas=0', wait_until='domcontentloaded')
        page.wait_for_function("document.querySelector('#map').getAttribute('src') === 'https://map.fixture.invalid/index.html'", timeout=5000)
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
        browser.close()
finally:
    server.shutdown()
    server.server_close()
