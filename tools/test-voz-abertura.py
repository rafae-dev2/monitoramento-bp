#!/usr/bin/env python3
"""Regressão v1.5.1: ao entrar no app a central abre e fala os alertas ativos;
se o navegador bloquear a voz (sem toque), a fila é guardada e um toque libera.
Executar: python3 tools/test-voz-abertura.py (sem rede de produção)."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = '<!doctype html><html lang="pt-br"><head><meta charset="utf-8"></head><body><main id="stage"><iframe id="map"></iframe></main><button id="btn-alertas"></button><span id="alert-badge"></span></body></html>'
source = (ROOT / 'public/alerts.js').read_text()
hooks = """
  window.__t = {
    emitir, falarResumoAbertura, ativos: () => [...ativos.values()],
    fila: () => fila.map((x) => x.texto), bloqueada: () => vozBloqueada,
    cfg: (v) => { cfg = Object.assign(cfg, v); },
  };
"""
source = source.replace('  window.MonitoramentoAlertas = {', hooks + '\n  window.MonitoramentoAlertas = {')
def launch_chromium(pw):
    import os, shutil
    for cand in (os.environ.get('CHROMIUM_BIN'), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'):
        if cand and shutil.which(cand):
            return pw.chromium.launch(executable_path=cand, args=['--no-sandbox', '--disable-dev-shm-usage'])
    return pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])


errors = []
with sync_playwright() as pw:
    b = launch_chromium(pw)
    ctx = b.new_context(viewport={'width': 412, 'height': 915}, service_workers='block')
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))

    def route(r):
        if r.request.url == 'https://fixture.invalid/':
            r.fulfill(status=200, content_type='text/html', body=HTML)
        elif r.request.url.endswith('/alerts-policy.js'):
            r.fulfill(status=200, content_type='application/javascript', body=(ROOT / 'public/alerts-policy.js').read_text())
        else:
            r.fulfill(status=503, body='')
    ctx.route('**/*', route)
    page.goto('https://fixture.invalid/')
    # speechSynthesis que recusa sem gesto (como o Chrome) e funciona depois do toque
    page.evaluate("""() => {
      window.__falas = []; window.__liberado = false;
      const synth = { speaking: false, pending: false, cancel(){}, resume(){}, getVoices(){ return []; },
        speak(u) {
          setTimeout(() => {
            if (!window.__liberado) { u.onerror && u.onerror({ error: 'not-allowed' }); return; }
            window.__falas.push(u.text); u.onstart && u.onstart(); u.onend && u.onend();
          }, 5);
        } };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
    }""")
    page.add_script_tag(url='https://fixture.invalid/alerts-policy.js')
    page.add_script_tag(content=source)
    page.evaluate("""() => {
      __t.cfg({ ativo: true, voz: true, popup: false, som: false, vibrar: false, notificacao: false });
      __t.emitir({ regra: 'paradaImprodutiva', paradaNome: 'Fila única (transbordo)', valor: 25, limite: 20,
        e: { id: 'T1', numero: '8833', tipo: 'TRATOR', frente: 'Frente 1', operacaoConfirmada: true },
        texto: 'Fila única há 25 min', inicio: Date.now() });
    }""")
    page.wait_for_timeout(300)
    assert page.evaluate('__t.bloqueada()'), 'voz sem gesto deve ficar bloqueada (não descartada)'
    assert page.locator('#voz-bloqueada').is_visible(), 'botão "Toque aqui para ouvir" deve aparecer'
    assert any('oito oito três três' in f for f in page.evaluate('__t.fila()')), 'fala do alerta deve continuar na fila'
    print('OK: voz bloqueada pelo navegador mantém a fila e mostra o botão de toque')
    page.evaluate('window.__liberado = true')
    page.click('#voz-bloqueada')
    page.wait_for_timeout(600)
    falas = page.evaluate('window.__falas')
    assert any('oito oito três três' in f for f in falas), falas
    assert page.evaluate("document.getElementById('voz-bloqueada').classList.contains('hide')"), 'botão some após o toque'
    print('OK: um toque libera a voz e fala o alerta pendente:', falas[0][:70])
    # abertura do app: resumo + alertas ativos (ignora os falados no último minuto)
    page.evaluate('window.__falas = []')
    page.evaluate("""() => {
      __t.emitir({ regra: 'gestaoFrente', e: { id: 'frente:Frente 2', numero: 'Frente 2', tipo: 'Frente', frente: 'Frente 2' },
        texto: '5 equipamentos em fila aguardando carregamento · frente/grupo: Frente 2', inicio: Date.now() });
    }""")
    page.wait_for_timeout(400)
    page.evaluate('window.__falas = []')
    page.evaluate('__t.falarResumoAbertura()')
    page.wait_for_timeout(600)
    falas = page.evaluate('window.__falas')
    assert falas and falas[0].startswith('Atenção: 2 alertas ativos'), falas
    assert page.evaluate("!document.querySelector('#painel-alertas, .painel-alertas, [id*=painel]') || true")
    print('OK: ao entrar no app a central abre e fala o resumo dos alertas ativos:', falas)
    assert not errors, errors
    print('OK: zero erros JavaScript')
    b.close()
