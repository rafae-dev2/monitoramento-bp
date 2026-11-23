#!/usr/bin/env python3
"""
Sanitiza uma cópia do projeto antes de publicar (GitHub público, zip para terceiros).

Por que este script existe: o projeto mexe com a API de monitoramento de um fornecedor e
com dados de terceiros (nome do operador de cada máquina, posição no campo). Isso não pode
ir para um repositório público nem para o histórico do git.

Ele faz quatro coisas, nesta ordem:
  1. levanta os segredos **a partir do ambiente local** (`~/.solinf_creds`, `SOLINF_USER`,
     `SOLINF_PASS`, `AUDIT_SENHA`) — nada de senha ou usuário escrito dentro do código;
  2. coleta nomes reais de pessoas lendo os dumps da API que ficaram fora do git
     (pasta `DOSSIES`, padrão `/home/ubuntu/solinftec/docs`), filtrando o que não é nome;
  3. apaga do staging tudo que só faz sentido local: dumps de API, prints com dado pessoal,
     APK, keystore, logs, relatórios de teste;
  4. substitui, nos arquivos de texto que sobraram, segredo -> `[REDADATADO]` e
     pessoa -> `OPERADOR-01`, `OPERADOR-02`... e depois re-verifica o resultado.

Uso:
    python3 tools/sanitizar.py <pasta-do-staging>

Variáveis que alteram o comportamento:
    DOSSIES         pasta com os dumps locais (fora do git)  [padrão: ~/solinftec/docs]
    NOMES_PROIBIDOS arquivo de texto, um nome por linha, para forçar substituições extras
    SOLINF_USER/SOLINF_PASS/AUDIT_SENHA  segredos a caçar (também lidos de ~/.solinf_creds)

Ele imprime uma linha por arquivo tocado e sai com código 1 se ainda encontrar segredo.
Rode antes de qualquer push público, e rode de novo depois de mexer em docs/.
"""
from __future__ import annotations
import json
import os
import re
import sys
from pathlib import Path

# ------------------------------------------------------------------ segredos locais
def _parse_env_arquivo(caminho: Path) -> dict[str, str]:
    saida: dict[str, str] = {}
    if not caminho.exists():
        return saida
    for linha in caminho.read_text(encoding="utf-8", errors="ignore").splitlines():
        linha = linha.strip().removeprefix("export ").strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, valor = linha.split("=", 1)
        saida[chave.strip().lower()] = valor.strip().strip('"').strip("'")
    return saida


CREDENCIAIS = _parse_env_arquivo(Path(os.environ.get("CREDENCIAIS", Path.home() / ".solinf_creds")))


def cred(chave: str) -> str:
    return os.environ.get(chave.upper()) or CREDENCIAIS.get(chave.lower()) or ""


SENHA = cred("solinf_pass") or cred("senha") or os.environ.get("AUDIT_SENHA", "")
USUARIO = cred("solinf_user") or cred("usuario")
SUPABASE_KEY = cred("supabase_key")

# Padrões genéricos: sempre ativos, não dependem de segredo nenhum.
GENERICOS = [
    ("token de sessão (UUID longo)", re.compile(r"\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b", re.I)),
    ("sequência hex longa", re.compile(r"\b[a-f0-9]{32,}\b", re.I)),
    ("JWT (access/refresh token)", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{5,}){1,2}")),
    ("service_role do Supabase", re.compile(r"\bsb[dr]_?secret_?[A-Za-z0-9_-]{8,}")),
    ("chave privada", re.compile(r"BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY")),
    ("senha de keystore embutida", re.compile(r"\$\{KS_PASS:-[^}]{3,}\}|(?:KS_PASS|KS_PASS_FILE|storepass|keypass|passwd|password|senha)[^\S\n]{0,2}[:=][^\S\n]{0,2}[^\w\s]{0,2}(?!\$|%|<|process|os\.|REDADAT)[A-Za-z0-9@#$%^&*._!-]{6,}", re.I)),
]

PROIBIDOS: list[tuple[str, re.Pattern]] = list(GENERICOS)
if SENHA:
    PROIBIDOS.insert(0, ("senha do portal", re.compile(re.escape(SENHA))))
if USUARIO:
    PROIBIDOS.insert(1, ("usuario do portal", re.compile(re.escape(USUARIO) + r"(?![A-Za-z0-9])")))
if SUPABASE_KEY:
    PROIBIDOS.insert(2, ("chave do Supabase", re.compile(re.escape(SUPABASE_KEY))))

# ------------------------------------------------------------- arquivos que ficam fora
EXCLUIR_SUFIXO = (".jks", ".keystore", ".apk", ".zip", ".env", ".bak", ".log", ".p12")


def deve_sumir(rel: str) -> bool:
    """O que nunca vai para o repositório público (por caminho, não por sorteio de texto)."""
    if any(rel.endswith(x) for x in EXCLUIR_SUFIXO):
        return True
    if rel in {"tools/sanitizar.py", "tools/prepara-repo-publico.sh"}:
        return False
    if re.search(r"node_modules|\.netlify|/build/|/out/|^out/|dist/|__pycache__", rel):
        return True
    if re.search(r"estatistica-monitoramento|alarme|regra-expressao|tipo-alarme|actual-state|filtr2|^est2", rel, re.I):
        return True
    if rel.startswith("docs/"):
        if rel.endswith((".png", ".jpg", ".jpeg", ".webp", ".pdf")):      # prints com dado pessoal
            return True
        if rel.endswith((".txt", ".log")):                                  # relatórios de teste
            return True
        if rel.endswith(".json") and not rel.endswith("mapa-dados-ao-vivo.json"):
            return True                                                     # dumps da API do fornecedor
    return False


# Arquivos de ferramenta: têm regex de segredo dentro; não são reescritos nem varridos.
FERRAMENTAS = {"tools/sanitizar.py", "tools/prepara-repo-publico.sh"}

CAMPOS_PESSOA = ("descOperador", "nomeOperador", "operador", "descAtualizador",
                 "descUsuario", "descFuncionario", "descOperadorCb", "responsavel",
                 "descContato", "nomeCompleto")
EXT_TEXTO = {".md", ".txt", ".js", ".mjs", ".css", ".html", ".py", ".java", ".xml",
             ".json", ".toml", ".webmanifest", ".sh", ".yml", ".yaml", ".sql", "",
             ".example", ".conf", ".ini"}

# Palavras que aparecem em campo de operador mas NÃO são nome de pessoa. Sem essa lista,
# o substituto reescreveria código funcional (ex.: o regex que detecta operador indefinido).
NAO_SAO_NOMES = {
    "desconhecido", "indefinido", "indefinidos", "generico", "generica", "genericos",
    "operador", "operadores", "sem", "nao", "define", "definido", "usuario", "teste",
    "branco", "peres", "unidade", "canavieiro", "terceiro", "proprio", "mineiro",
    "todo", "todos", "novo", "velho", "primeiro", "segundo", "quarto", "geral",
    "sudeste", "nordeste", "centro", "oeste", "leste", "general", "gerente", "tratorista",
    "maquinista", "ajudante", "mecanico", "supervisor", "encarregado", "frota", "sistema",
    "sistemas", "solinftec", "monitoramento", "operacao", "manutencao", "contratado",
    "monitor", "alerta", "alertas", "veiculo", "trator", "caminhao", "colhedora",
}


def eh_pessoa(nome: str) -> bool:
    """Aceita só o que parece nome humano de verdade: 2+ tokens, sem palavra técnica."""
    tokens = [t for t in re.split(r"[\s.,'/-]+", nome) if t]
    if len(tokens) < 2:
        return False
    if {t.lower() for t in tokens} & NAO_SAO_NOMES:
        return False
    if nome.strip().upper().startswith(("*", "N/D", "NAO_", "SEM_")):
        return False
    return True


def coletar_nomes(dossies: Path) -> list[str]:
    nomes: set[str] = set()

    def varrer(obj):
        if isinstance(obj, dict):
            for chave, valor in obj.items():
                if chave in CAMPOS_PESSOA and isinstance(valor, str):
                    limpo = re.sub(r"^\s*\d+\s*-\s*", "", valor).strip()
                    if 3 < len(limpo) < 70 and eh_pessoa(limpo):
                        nomes.add(limpo)
                else:
                    varrer(valor)
        elif isinstance(obj, list):
            for item in obj:
                varrer(item)

    for arquivo in sorted(dossies.glob("*.json")):
        try:
            varrer(json.loads(arquivo.read_text(encoding="utf-8", errors="ignore")))
        except Exception:
            continue
    # relatórios de teste: linhas "operador Fulano de Tal,"
    for arquivo in sorted(dossies.glob("*.txt")):
        for linha in arquivo.read_text(encoding="utf-8", errors="ignore").splitlines():
            for achado in re.findall(r"operador ([^,]+),", linha):
                limpo = achado.strip()
                if eh_pessoa(limpo):
                    nomes.add(limpo)
    # lista manual (ex.: o nome de quem escreveu o exemplo de fala)
    extras = os.environ.get("NOMES_PROIBIDOS", "")
    if extras and Path(extras).exists():
        for linha in Path(extras).read_text(encoding="utf-8").splitlines():
            if linha.strip() and not linha.startswith("#") and eh_pessoa(linha.strip()):
                nomes.add(linha.strip())
    return sorted(nomes, key=len, reverse=True)


def montar_tabela(nomes: list[str]) -> list[tuple[re.Pattern, str]]:
    tabela: list[tuple[re.Pattern, str]] = []
    for i, nome in enumerate(nomes, 1):
        apelido = f"OPERADOR-{i:02d}"
        partes = [p for p in nome.split() if len(p) > 2]
        variantes = {nome, " ".join(partes[:2]), " ".join(partes[:3])}
        for v in sorted({x for x in variantes if len(x) >= 5}, key=len, reverse=True):
            tabela.append((re.compile(r"\b" + re.escape(v).replace(r"\ ", r"\s+") + r"\b"), apelido))
    tabela.sort(key=lambda par: len(par[0].pattern), reverse=True)
    return tabela


def main(staging: str) -> int:
    raiz = Path(staging).resolve()
    if not raiz.is_dir():
        print(f"staging inexistente: {raiz}")
        return 2
    dossies = Path(os.environ.get("DOSSIES", Path.home() / "solinftec/docs"))
    nomes = coletar_nomes(dossies)
    tabela = montar_tabela(nomes)
    print(f"segredos conhecidos: senha={'sim' if SENHA else 'não'} "
          f"usuario={'sim' if USUARIO else 'não'} chaveSupabase={'sim' if SUPABASE_KEY else 'não'}")
    print(f"nomes reais identificados em {dossies}: {len(nomes)}")
    if not tabela:
        print("  (nenhum nome para substituir — ok, mas confira DOSSIES)")

    removidos = alterados = tocados = 0
    for caminho in sorted(raiz.rglob("*")):
        if not caminho.is_file():
            continue
        rel = caminho.relative_to(raiz).as_posix()
        tocados += 1
        if rel in FERRAMENTAS:            # as ferramentas contêm padrões de detecção, não segredos
            continue
        if deve_sumir(rel):
            caminho.unlink()
            removidos += 1
            print(f"  removido: {rel}")
            continue
        if caminho.suffix.lower() not in EXT_TEXTO:
            continue
        try:
            texto = caminho.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        original = texto
        for rotulo, padrao in PROIBIDOS:
            texto = padrao.sub("[REDADATADO]" if "usuario" not in rotulo else "SEU-USUARIO-DO-PORTAL", texto)
        for padrao, apelido in tabela:
            texto = padrao.sub(apelido, texto)
        if texto != original:
            caminho.write_text(texto, encoding="utf-8")
            alterados += 1
            print(f"  sanitizado: {rel}")

    for pasta in sorted((p for p in raiz.rglob("*") if p.is_dir()), reverse=True):
        try:
            if not any(pasta.iterdir()):
                pasta.rmdir()
        except OSError:
            pass

    sobra = []
    for caminho in raiz.rglob("*"):
        if not caminho.is_file():
            continue
        if caminho.suffix.lower() not in EXT_TEXTO and not caminho.name.startswith("."):
            continue
        if caminho.relative_to(raiz).as_posix() in FERRAMENTAS:
            continue
        conteudo = caminho.read_text(encoding="utf-8", errors="ignore")
        for rotulo, padrao in PROIBIDOS:
            if padrao.search(conteudo):
                sobra.append((rotulo, caminho.relative_to(raiz).as_posix()))
        for padrao, _ in tabela:
            if padrao.search(conteudo):
                sobra.append(("nome de pessoa", caminho.relative_to(raiz).as_posix()))
                break

    print(f"\narquivos verificados: {tocados} | removidos: {removidos} | reescritos: {alterados}")
    if sobra:
        print("AINDA CONTÉM DADO SENSÍVEL:")
        for rotulo, arq in sobra:
            print(f"  {rotulo}: {arq}")
        return 1
    print("segredos e nomes: nenhum (ok)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "."))
