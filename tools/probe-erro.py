#!/usr/bin/env python3
"""Descobre de onde vem o 'Access is denied for ... localStorage'.

Abre o site duas vezes: uma normal e outra bloqueando o micro-frontend do mapa
(solinftec-frontends) e o portal. Se o erro só aparece com o iframe do fornecedor,
ele não vem do nosso código.

Uso: BASE_URL=https://sgpa-solinftec-bpa.netlify.app/ python3 tools/probe-erro.py
"""
import os
import sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "https://sgpa-solinftec-bpa.netlify.app/")
ESPERA = int(os.environ.get("ESPERA", "45"))
BLOQUEIO = ("solinftec-frontends.saas-solinftec.com", "branco-peres-cana.saas-solinftec.com")


EXECUTAVEL = os.environ.get("CHROMIUM", "/usr/bin/chromium")


def roda(bloqueia: bool) -> list[str]:
    erros: list[str] = []
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=EXECUTAVEL, args=["--no-sandbox"])
        ctx = br.new_context(viewport={"width": 1366, "height": 850}, locale="pt-BR")
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: erros.append(str(e)[:200]))

        def rota(r):
            u = r.request.url
            if bloqueia and any(h in u for h in BLOQUEIO):
                return r.abort()
            return r.continue_()

        ctx.route("**/*", rota)
        pg.goto(BASE, wait_until="domcontentloaded", timeout=90_000)
        pg.wait_for_timeout(ESPERA * 1000)
        # pergunta ao documento principal se ele mesmo consegue usar o storage
        try:
            ok = pg.evaluate("() => { try { return typeof localStorage } catch (e) { return 'NEGADO: ' + e.message } }")
        except Exception as exc:  # noqa: BLE001
            ok = f"avaliacao falhou: {exc}"
        frames = []
        for f in pg.frames:
            try:
                frames.append(f.url[:90])
            except Exception:  # noqa: BLE001
                frames.append("<fechado>")
        ctx.close()
        br.close()
    print(f"--- bloqueio de iframe do fornecedor: {'SIM' if bloqueia else 'NAO'} ---")
    print(f"  localStorage no documento principal: {ok}")
    print(f"  frames: {len(frames)}")
    for u in frames:
        print(f"    - {u}")
    print(f"  pageerror: {len(erros)}")
    for e in dict.fromkeys(erros):
        print(f"    * {e}")
    return erros


com = roda(False)
sem = roda(True)
print("\n== conclusao ==")
if com and not sem:
    print("o erro vem do iframe do FORNECEDOR (mapa/portal), nao do nosso shell")
elif com and sem:
    print("o erro aparece nos dois modos -> verificar nosso codigo (shell/local/alerts)")
elif not com:
    print("nenhum erro reproduzido nesta rodada")
