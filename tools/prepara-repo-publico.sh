#!/usr/bin/env bash
# ==============================================================================
#  Monta a versão PÚBLICA do projeto (staging sanitizado, pronta para push).
#
#  Uso:  ./tools/prepara-repo-publico.sh [pasta-de-saida]
#        padrão: /home/ubuntu/github/monitoramento-bp
#
#  O que ele faz, na ordem:
#    1. copia código do PWA, fontes do APK e dossiês técnicos para o staging;
#    2. roda tools/sanitizar.py (tira segredos do ambiente, nomes de pessoas, prints, dumps);
#    3. escreve LICENSE, SECURITY.md e as seções 14-17 do README (modelos em repo-publico/);
#    4. troca o print do README por uma nota de privacidade;
#    5. refina .gitignore e remove a senha de keystore que estava hardcoded no build.sh;
#    6. valida sintaxe e procura credencial literal. Se algo falhar, sai com código != 0.
#
#  Depois disto: git init + push. Nunca faça push direto da pasta de trabalho do PWA.
# ==============================================================================
set -euo pipefail

ST="${1:-/home/ubuntu/github/monitoramento-bp}"
PWA="$(cd "$(dirname "$0")/.." && pwd)"
AND="${AND:-/home/ubuntu/solinftec/build-android/MonitoramentoBP-Android}"
DOC="${DOC:-/home/ubuntu/solinftec/docs}"

echo "== 1. montagem =="
rm -rf "$ST"
mkdir -p "$ST/docs" "$ST/android" "$ST/repo-publico"
cd "$PWA"
cp -r public netlify supabase tools repo-publico "$ST"/
cp netlify.toml .gitignore .env.example README.md "$ST"/
[ -f docs/RELATORIO-CENTRAL-DE-ALERTAS.md ] && cp docs/RELATORIO-CENTRAL-DE-ALERTAS.md "$ST"/docs/ || true
cp "$DOC"/NOTAS-ALERTAS.md "$DOC"/NOTAS-ALERTAS-2.md "$DOC"/mapa-dados-ao-vivo.json "$ST"/docs/ 2>/dev/null || true
cp -r "$AND"/apk/src "$AND"/apk/res "$AND"/apk/AndroidManifest.xml "$AND"/apk/build.sh "$ST"/android/
cp "$AND"/LEIA-ME-ANDROID.md "$AND"/INSTALACAO-RAPIDA.txt "$ST"/android/ 2>/dev/null || true
echo "   staging: $ST"

echo "== 2. senha do keystore fora do código =="
echo "==   (antes de sanitizar, para o detector não achar o que já vai sumir)"
cd "$ST"
python3 - <<'PY'
import re
p = 'android/build.sh'
t = open(p, encoding='utf-8').read()
if 'KS_PASS="${KS_PASS:-}"' not in t:
    t = re.sub(r'KS_PASS="\$\{KS_PASS:-[^"]*\}"',
               '# a senha do keystore NÃO fica no repositório: exporte KS_PASS antes de buildar\n'
               'KS_PASS="${KS_PASS:-}"', t, count=1)
if 'defina KS_PASS' not in t:
    t = t.replace('if [ ! -e "$KEYSTORE" ]; then',
                  'if [ -z "$KS_PASS" ]; then\n'
                  '  echo "defina KS_PASS (senha do keystore) antes de ./build.sh release"; exit 1\n'
                  'fi\n'
                  'if [ ! -e "$KEYSTORE" ]; then', 1)
open(p, 'w', encoding='utf-8').write(t)

p = 'android/LEIA-ME-ANDROID.md'
t = open(p, encoding='utf-8').read()
t = re.sub(r'\(senha: [^)]+\)', '(senha: só no seu cofre de senhas)', t)
open(p, 'w', encoding='utf-8').write(t)
print('   build.sh e LEIA-ME-ANDROID limpos')
PY

echo "== 2. sanitizar (segredos + dado pessoal) =="
cd "$ST"
python3 tools/sanitizar.py .

echo "== 3. caminhos portáveis (o teste escreve dentro do repo) =="
python3 - <<'PY3'
from pathlib import Path
import re
alvos = {
    'tools/teste-alertas.py': (
        r'os\.path\.abspath\(os\.environ\.get\("EVIDENCIAS", "[^"]*"\)\)',
        'os.environ.get("EVIDENCIAS") or os.path.join(REPO, "docs", "out")'),
}
for nome, (padrao, troca) in alvos.items():
    p = Path(nome)
    if not p.exists():
        continue
    t = p.read_text(encoding='utf-8')
    novo = re.sub(padrao, troca, t, count=1)
    if 'REPO,' in novo and "REPO =" not in novo and "REPO =" not in novo.split("OUT")[0]:
        # garante a constante REPO definida no topo
        novo = novo.replace("os.path.dirname(os.path.abspath(__file__))", "os.path.dirname(os.path.abspath(__file__))", 1)
    if novo != t:
        p.write_text(novo, encoding='utf-8')
        print("   ajustado:", nome)
PY3
sed -i 's#^REPO = .*#REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # raiz do repo#' tools/teste-alertas.py 2>/dev/null || true
grep -q "^REPO = " tools/teste-alertas.py || sed -i '0,/^OUT = /s//REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\nOUT = /' tools/teste-alertas.py
python3 -c "import ast;ast.parse(open('tools/teste-alertas.py',encoding='utf-8').read());print('   teste OK')"

echo "== 4. LICENSE, SECURITY e README público =="
cp repo-publico/LICENSE LICENSE
cp repo-publico/SECURITY.md SECURITY.md
python3 - <<'PY'
import re
nota = open('repo-publico/README-NOTA-IMAGENS.md', encoding='utf-8').read().strip()
fim = open('repo-publico/README-FIM.md', encoding='utf-8').read()
t = open('README.md', encoding='utf-8').read()
# troca qualquer imagem de evidência pela nota de privacidade
t = re.sub(r'!\[[^\]]*\]\(docs/[^)]+\)', nota, t)
# remove links soltos para evidências que não vão a público
t = re.sub(r'\]\(docs/(?:evidencia|alerta|chapa)[^)]*\)', '](docs/)', t)
if '## 14. Estrutura do repositório' not in t:
    t = t.rstrip() + '\n' + fim
open('README.md', 'w', encoding='utf-8').write(t)
print('   README:', len(t.splitlines()), 'linhas')
PY

echo "== 5. .gitignore reforçado =="
python3 - <<'PY'
bloco = """
# --- segredos e artefatos locais (nunca publicar) ---
.env
.env.local
*.jks
*.keystore
*.apk
*.zip
android/out/
android/build/
netlify/functions/.netlify/

# --- evidência com dado pessoal (print, dump de API, relatório de teste) ---
docs/evidencia-*.png
docs/alerta-*.png
docs/chapa-*.png
docs/*relatorio*.txt
docs/*.json
!docs/mapa-dados-ao-vivo.json
out/
*.log
__pycache__/
"""
p = '.gitignore'
t = open(p, encoding='utf-8').read()
if 'nunca publicar' not in t:
    t = t.rstrip() + '\n' + bloco
open(p, 'w', encoding='utf-8').write(t)
print('   .gitignore:', len(t.splitlines()), 'linhas')
PY

echo "== 6. validação =="
cd "$ST"
python3 - <<'PYCHK'
import os, re, sys, pathlib

def do_arquivo(chave):
    cred = pathlib.Path(os.environ.get("CREDENCIAIS", str(pathlib.Path.home() / ".solinf_creds")))
    if not cred.exists():
        return ""
    for linha in cred.read_text(errors="ignore").splitlines():
        if linha.strip().lower().startswith(chave):
            return linha.split("=", 1)[1].strip().strip('"').strip("'")
    return ""

segredos = {}
for rotulo, var, chave in (("senha do portal", "SOLINF_PASS", "solinf_pass"),
                           ("usuario do portal", "SOLINF_USER", "solinf_user"),
                           ("chave do supabase", "SUPABASE_KEY", "supabase_key")):
    valor = os.environ.get(var) or do_arquivo(chave)
    if valor and len(valor) >= 4:
        segredos[rotulo] = valor
# padrões genéricos, sempre checados
GENERICOS = {
    "keystore/senha hardcoded": re.compile(r"\$\{KS_PASS:-[^}]{3,}\}|(?:KS_PASS|KS_PASS_FILE|storepass|keypass|passwd|password|senha)[^\S\n]{0,2}[:=][^\S\n]{0,2}[^\w\s]{0,2}(?!\$|%|<|process|os\.|REDADAT)[A-Za-z0-9@#$%^&*._!-]{6,}", re.I),
    "token/jwt no texto": re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b"),
    "chave privada": re.compile(r"BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"),
}

ruim = []
for f in sorted(pathlib.Path(".").rglob("*")):
    if not f.is_file() or "/.git/" in str(f):
        continue
    if f.name in {"sanitizar.py", "prepara-repo-publico.sh"}:
        continue
    try:
        t = f.read_text(encoding="utf-8")
    except Exception:
        continue
    for rotulo, valor in segredos.items():
        if valor in t:
            ruim.append(f"{rotulo}: {f}")
    for rotulo, padrao in GENERICOS.items():
        if padrao.search(t):
            ruim.append(f"{rotulo}: {f}")

if ruim:
    print("   !! PROBLEMA:")
    for linha in ruim[:12]:
        print("     ", linha)
    sys.exit(1)
print(f"   segredos do ambiente: {len(segredos)} checados, nenhum no staging (ok)")
PYCHK

node --check public/alerts.js
node --check public/alerts-stream.js
node --check public/app.js
node --check public/local.js
node --check netlify/functions/session.mjs
python3 -c "import ast;[ast.parse(open(f).read()) for f in ['tools/sanitizar.py','tools/teste-alertas.py','tools/chapa-alertas.py','tools/marca-sheet.py','tools/make-icons.py']];print('   python OK')"
bash -n android/build.sh
grep -q "desconhecido|indefinido" public/alerts.js && echo "   código funcional preservado"
test -f LICENSE && test -f SECURITY.md && test -f docs/NOTAS-ALERTAS.md && echo "   LICENSE/SECURITY/dossiês presentes"
echo "   arquivos: $(find . -type f | wc -l) | tamanho: $(du -sh . | cut -f1)"
echo
echo "Pronto. Para publicar:"
echo "  cd $ST && git init -b main && git add -A && git commit -m '...' && \\"
echo "  gh repo create monitoramento-bp --public --source=. --push"