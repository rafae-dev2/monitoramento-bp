#!/usr/bin/env python3
"""Audita o zip do PWA: contagem de arquivos, presença de senha literal,
referências quebradas em index.html/styles.css/alerts.css/sw.js/manifest,
alinhamento de versão (package.json × alerts.js) e versão do shell."""
import json
import os
import pathlib
import re
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
ZIP = pathlib.Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else (ROOT.parent / "MonitoramentoBP-PWA-Netlify.zip")
)
# A senha nunca é escrita aqui: passe pelo ambiente na hora de auditar.
SENHA = os.environ.get("AUDIT_SENHA", "")

z = zipfile.ZipFile(ZIP)
nomes = [n for n in z.namelist() if not n.endswith("/")]
print(f"arquivos no zip: {len(nomes)}")
print(f"tamanho do zip: {ZIP.stat().st_size / 1024:.0f} KB")

# Descobre dinamicamente o prefixo raiz dentro do zip (ex.: monitoramento-bp/public/ ou public/)
index_candidates = [n for n in nomes if n.endswith("public/index.html")]
if not index_candidates:
    print("ERRO: public/index.html não encontrado no zip")
    sys.exit(1)
base = index_candidates[0][: -len("index.html")]
root_prefix = base[: -len("public/")]

# 1) senha literal ou chave formato Google API (AIza... / AQ....) em qualquer texto
hits = []
RX_CHAVE_GOOGLE = re.compile(r"(?:AIza[0-9A-Za-z_-]{15,}|AQ\.[0-9A-Za-z._-]{15,})")
for n in nomes:
    if not n.endswith((".js", ".mjs", ".cjs", ".html", ".css", ".md", ".json", ".webmanifest", ".toml", ".txt", ".py", ".sh")):
        continue
    try:
        txt = z.read(n).decode("utf-8", "replace")
    except Exception as e:
        hits.append((n, f"erro {e}"))
        continue
    if SENHA and SENHA in txt:
        hits.append((n, "SENHA LITERAL"))
    if RX_CHAVE_GOOGLE.search(txt):
        hits.append((n, "PADRAO CHAVE GOOGLE (AIza/AQ.)"))
print("segredos/chaves literais:", "ausentes (ok)" if not hits else hits)


def read(p: str) -> str:
    return z.read(base + p).decode("utf-8", "replace")


html = read("index.html")
css = read("styles.css")
alerts_css = read("alerts.css")
sw = read("sw.js")
mf = read("manifest.webmanifest")
alerts_js = read("alerts.js")
pkg = json.loads(z.read(root_prefix + "package.json").decode("utf-8"))

# Extrai todas as referências locais reais (incluindo todos os itens de ASSETS no sw.js)
refs = set(re.findall(r'(?:href|src)="(/[^"]+)"', html))
for folha in (css, alerts_css):
    refs |= set(re.findall(r'url\(["\']?(/[^)"\']+)["\']?\)', folha))
bloco_assets = re.search(r"ASSETS\s*=\s*\[(.*?)\]", sw, re.S)
if bloco_assets:
    refs |= set(re.findall(r"""['"](/[^'"]+)['"]""", bloco_assets.group(1)))
refs |= set(re.findall(r"""icon:\s*['"](/[^'"]+)['"]|badge:\s*['"](/[^'"]+)['"]""", sw) and [])
for m in re.finditer(r"""(?:icon|badge):\s*['"](/[^'"]+)['"]""", sw):
    refs.add(m.group(1))
refs |= set(re.findall(r'"src":\s*"([^"]+)"', mf))

local = [r for r in sorted(refs) if r.startswith("/") and r != "/"]
faltando = [r for r in local if (base + r.lstrip("/")) not in z.namelist()]
print(f'referencias locais: {len(local)} | quebradas: {faltando or "nenhuma (ok)"}')

shell_match = re.search(r"SHELL\s*=\s*'([^']+)'", sw)
shell_ver = shell_match.group(1) if shell_match else "AUSENTE"
versao_js_match = re.search(r"VERSAO\s*=\s*'([^']+)'", alerts_js)
versao_js = versao_js_match.group(1) if versao_js_match else "AUSENTE"
versao_pkg = pkg.get("version", "AUSENTE")
print(f"shell: {shell_ver} | versao package.json={versao_pkg} alerts.js={versao_js}")

# Verifica que há apenas 3 entrypoints reais em netlify/functions/
funcoes = sorted(
    n.split("/")[-1]
    for n in nomes
    if n.startswith(root_prefix + "netlify/functions/") and n.endswith((".js", ".mjs"))
    and len(n[len(root_prefix + "netlify/functions/"):].split("/")) == 1
)
print(f"netlify functions ({len(funcoes)}): {funcoes}")

# manifest válido?
man = json.loads(mf)
print(
    "manifest:",
    man["short_name"],
    "|",
    man["name"],
    "|",
    len(man["icons"]),
    "icones",
    sorted({(i.get("purpose", ""), i["sizes"]) for i in man["icons"]}),
)

icos = sorted(n.split("/")[-1] for n in nomes if "/icons/" in n)
print("icone no zip:", len(icos), icos)

if hits or faltando or versao_pkg != versao_js or len(funcoes) != 3:
    print("FALHA DE AUDITORIA:", {"hits": hits, "faltando": faltando, "versoes": (versao_pkg, versao_js), "funcoes": funcoes})
    sys.exit(1)
