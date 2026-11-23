#!/usr/bin/env python3
"""Teste de fumaça da Central de Alertas com dados AO VIVO do portal.

Roda contra o emulador local (tools/serve.mjs), deixa o motor ler a telemetria
real do tenant, exercita as regras e salva evidências (pop-up, central,
histórico, tela de regras) + um relatório de texto.

Uso:
  PORT=8080 python3 tools/teste-alertas.py            # desktop
  PORT=8080 MODELO=celular python3 tools/teste-alertas.py
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

PORT = os.environ.get("PORT", "8080")
MODELO = os.environ.get("MODELO", "desktop")
BASE = f"http://127.0.0.1:{PORT}/"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("EVIDENCIAS") or os.path.join(REPO, "docs", "out")
os.makedirs(OUT, exist_ok=True)

logs: list[str] = []
erros: list[str] = []
rel: list[str] = []


def saida(txt: str = "") -> None:
    print(txt)
    rel.append(txt)


def espera_motor(pg, timeout: int = 120) -> None:
    pg.wait_for_function(
        "() => window.MonitoramentoAlertas && MonitoramentoAlertas.estado().ligado === true",
        timeout=timeout * 1000,
    )


def main() -> int:
    celular = MODELO == "celular"
    viewport = {"width": 412, "height": 915} if celular else {"width": 1512, "height": 950}
    sufixo = "celular" if celular else "desktop"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/usr/bin/chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
        )
        page = browser.new_page(
            viewport=viewport,
            locale="pt-BR",
            is_mobile=celular,
            has_touch=celular,
            device_scale_factor=2 if celular else 1,
        )
        page.on("console", lambda m: logs.append(f"{m.type}: {m.text[:200]}"))
        page.on("pageerror", lambda e: erros.append(str(e)[:400]))
        page.on("response", lambda r: logs.append(f"http {r.status} {r.request.method} {r.url.split('?')[0]}") if r.status >= 400 else None)

        saida(f"→ abrindo {BASE} ({sufixo})")
        page.goto(BASE, wait_until="domcontentloaded", timeout=90_000)
        espera_motor(page)
        saida("✓ motor ligado (sessão do portal obtida e telemetria chegando)")
        time.sleep(16)

        est = page.evaluate(
            """() => { let ls = 'ok'; try { localStorage.setItem('bperes.teste', '1'); ls = localStorage.getItem('bperes.teste'); localStorage.removeItem('bperes.teste'); } catch (e) { ls = 'ERRO: ' + e.message } return Object.assign({ localStorage: ls }, MonitoramentoAlertas.estado()) }"""
        )
        saida(f"  localStorage={est.get('localStorage')} vigiados={est['monitorados']} stream={est['stream']} quadros={est['quadros']} fonte={est['fonte']} erros={est['erros']}")
        ativos = page.evaluate(
            "() => MonitoramentoAlertas.ativos().map(a => a.numero + ' | ' + a.nome + ' | ' + a.texto + ' | ' + a.fonte)"
        )
        saida(f"  alertas no 1º ciclo: {len(ativos)}")
        for a in ativos[:6]:
            saida("   • " + a)

        saida("  pop-ups logo após o 1º ciclo: " + str(page.locator("#toasts .alerta").count()))
        page.screenshot(path=os.path.join(OUT, f"alerta-{sufixo}-01b-popup-inicial.png"))

        # limiares de demonstração: mostram as 4 regras trabalhando juntas
        page.evaluate(
            """() => MonitoramentoAlertas.configurar({
                 limiteVelocidade: 20, limiteRpm: 1300, rpmOcioso: 900, minutosTurno: 1,
                 minutosOcioso: 1, cooldownMin: 5, amostras: 1, intervaloSeg: 30, maxPorCiclo: 4
               })"""
        )
        page.evaluate("() => MonitoramentoAlertas.ciclo()")
        saida("→ limiares de demonstração aplicados; aguardando 80 s (a regra de troca de turno usa tempo de 1 min)")
        time.sleep(80)

        est2 = page.evaluate("() => MonitoramentoAlertas.estado()")
        grupos = page.evaluate(
            """() => { const g = {}; MonitoramentoAlertas.ativos().forEach(a => { g[a.regra] = (g[a.regra] || 0) + 1 }); return g; }"""
        )
        falas = page.evaluate("() => MonitoramentoAlertas.ativos().slice(0, 3).map(a => a.fala)")
        saida(f"✓ vigiados={est2['monitorados']} ativos={sum(grupos.values())} por_regra={json.dumps(grupos)} stream={est2['stream']}")
        for f in falas:
            saida("   🗣️ " + f)

        saida("  pop-ups na tela: " + str(page.locator("#toasts .alerta").count()))
        page.screenshot(path=os.path.join(OUT, f"alerta-{sufixo}-01-popup.png"))

        page.evaluate("() => MonitoramentoAlertas.testar()")
        time.sleep(2)
        page.screenshot(path=os.path.join(OUT, f"alerta-{sufixo}-02-teste-voz.png"))

        page.click("#btn-alertas")
        time.sleep(1.4)
        page.screenshot(path=os.path.join(OUT, f"alerta-{sufixo}-03-central.png"))
        saida("  histórico gravado no aparelho: " + str(page.evaluate("() => MonitoramentoAlertas.historico().length")) + " eventos")

        page.click("#alertas-painel .aba[data-aba='historico']")
        time.sleep(1)
        page.screenshot(path=os.path.join(OUT, f"alerta-{sufixo}-04-historico.png"))

        page.click("#btn-cfg")
        time.sleep(1.2)
        page.screenshot(path=os.path.join(OUT, f"alerta-{sufixo}-05-regras.png"))
        saida("  frentes listadas na config: " + str(page.evaluate("() => document.querySelectorAll('#cfg-frentes .chip').length")))
        saida("  vozes pt-BR no navegador: " + str(page.evaluate("() => speechSynthesis.getVoices().filter(v => /^pt/i.test(v.lang)).length")))

        browser.close()

    criticos = [l for l in logs if l.startswith("error:") or l.startswith("http 4") or l.startswith("http 5")]
    saida("--- requisições com erro ---")
    unicos = {}
    for c in criticos:
        unicos[c] = unicos.get(c, 0) + 1
    for c, n in sorted(unicos.items(), key=lambda x: -x[1])[:10]:
        saida(f"  {n}× {c}")
    if criticos:
        saida("  (algumas rotas do próprio portal/mapa também são limitadas por IP: 10/min)")
    else:
        saida("  nenhuma")
    if erros:
        saida("--- pageerror ---")
        for e in erros[:6]:
            saida("  " + e)

    nome = os.path.join(OUT, f"alerta-relatorio-{sufixo}.txt")
    with open(nome, "w", encoding="utf-8") as f:
        f.write("\n".join(rel) + "\n\n=== console ===\n" + "\n".join(logs[-400:]))
    saida(f"\nrelatório: {nome}")
    return 1 if erros else 0


if __name__ == "__main__":
    sys.exit(main())
