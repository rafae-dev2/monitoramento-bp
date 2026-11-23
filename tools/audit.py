#!/usr/bin/env python3
"""Audita o zip do PWA: contagem de arquivos, presenca de senha literal,
referencias quebradas em index.html/styles.css/sw.js/manifest e versao do shell."""
import os, re, sys, zipfile, pathlib, json

ZIP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                   else '/home/ubuntu/netlify/MonitoramentoBP-PWA-Netlify.zip')
# A senha nunca é escrita aqui: passe pelo ambiente na hora de auditar.
SENHA = os.environ.get('AUDIT_SENHA', '')

z = zipfile.ZipFile(ZIP)
nomes = [n for n in z.namelist() if not n.endswith('/')]
print(f'arquivos no zip: {len(nomes)}')
print(f'tamanho do zip: {ZIP.stat().st_size/1024:.0f} KB')

# 1) senha literal em qualquer texto
hits = []
for n in nomes:
    if not n.endswith(('.js', '.mjs', '.html', '.css', '.md', '.json', '.webmanifest', '.toml', '.txt', '.py')):
        continue
    try:
        txt = z.read(n).decode('utf-8', 'replace')
    except Exception as e:
        hits.append((n, f'erro {e}'))
        continue
    if SENHA in txt:
        hits.append((n, 'SENHA LITERAL'))
print('senha literal:', ('ausente (ok)' if not hits else hits) if SENHA else 'não verificada (defina AUDIT_SENHA)')

base = 'monitoramento-pwa/public/'
def read(p):
    return z.read(base + p).decode('utf-8', 'replace')

html, css, sw, mf = read('index.html'), read('styles.css'), read('sw.js'), read('manifest.webmanifest')

refs = set(re.findall(r'(?:href|src)="(/[^"]+)"', html))
refs |= set(re.findall(r'url\("?(/[^)"]+)"?\)', css))
refs |= set(re.findall(r"'(/[^']+)'\s*\]", sw) or re.findall(r'"(/[^"]+)"', sw))
refs |= set(re.findall(r'"src":\s*"([^"]+)"', mf))
local = [r for r in sorted(refs) if r.startswith('/')]
faltando = [r for r in local if (base + r.lstrip('/')) not in z.namelist()]
print(f'referencias locais: {len(local)} | quebradas: {faltando or "nenhuma (ok)"}')
print('shell:', re.search(r"SHELL\s*=\s*'([^']+)'", sw).group(1))

# manifest valido?
man = json.loads(mf)
print('manifest:', man['short_name'], '|', man['name'], '|', len(man['icons']), 'icones',
      sorted({(i.get('purpose', ''), i['sizes']) for i in man['icons']}))

# icons presentes no zip
icos = sorted(n.split('/')[-1] for n in nomes if '/icons/' in n)
print('icone no zip:', len(icos), icos)
