#!/usr/bin/env python3
"""Monta a chapa de evidência da Central de Alertas (4 telas + título Branco Peres)."""
import os
from PIL import Image, ImageDraw, ImageFont

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.dirname(AQUI)
DOCS = os.path.join(RAIZ, 'docs')
FORA = '/home/ubuntu/solinftec/docs/out'
SAIDA = os.path.join(DOCS, 'chapa-central-de-alertas.png')

VERDE = (0, 122, 61)
VERDE_CLARO = (0, 168, 84)
GRAFITE = (24, 28, 31)
TXT = (240, 244, 246)
CINZA = (150, 160, 168)

PAINEL = 1000
ALTURA_IMG = 640
MARGEM = 28
TITULO = 150


def fonte(pt, bold=False):
    nomes = (
        '/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf' % ('-Bold' if bold else ''),
        '/usr/share/fonts/truetype/liberation/LiberationSans%s-Bold.ttf' % ('' if bold else 'Regular'),
    )
    for n in nomes:
        if os.path.exists(n):
            try:
                return ImageFont.truetype(n, pt)
            except Exception:
                pass
    return ImageFont.load_default()


def carregar(nome):
    for base in (DOCS, FORA):
        p = os.path.join(base, nome)
        if os.path.exists(p):
            return Image.open(p).convert('RGB')
    raise SystemExit('faltando: ' + nome)


recado = [
    ('alerta-celular-popup.png', 'Celular — pop-ups com a frase falada'),
    ('alerta-desktop-central.png', 'Desktop — central com a frota vigiada'),
    ('alerta-celular-central.png', 'Celular — ativos por severidade'),
    ('alerta-desktop-regras.png', 'Desktop — tela de Regras'),
]

largura_painel = PAINEL - 2 * MARGEM
col_w = (largura_painel - MARGEM) // 2
linha_h = ALTURA_IMG


def cabeca(img, txt, sub):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, img.width, TITULO], fill=VERDE)
    d.rectangle([0, TITULO - 6, img.width, TITULO], fill=VERDE_CLARO)
    d.text((MARGEM, 34), txt, font=fonte(40, True), fill=(255, 255, 255))
    d.text((MARGEM, 92), sub, font=fonte(20), fill=(226, 242, 231))
    return img


def bloco(nome, legenda):
    im = carregar(nome)
    im.thumbnail((col_w, linha_h), Image.LANCZOS)
    painel = Image.new('RGB', (col_w, linha_h + 56), GRAFITE)
    x = (col_w - im.width) // 2
    painel.paste(im, (x, 12))
    d = ImageDraw.Draw(painel)

    pt = 19
    while pt > 12 and d.textlength(legenda, font=fonte(pt, True)) > col_w - 32:
        pt -= 1
    d.text((16, linha_h + 22), legenda, font=fonte(pt, True), fill=TXT)
    return painel


total = TITULO + 2 * (linha_h + 56) + 3 * MARGEM + 90
tela = Image.new('RGB', (PAINEL, total), (245, 246, 247))
d = ImageDraw.Draw(tela)

# fundo com textura simples de duas colunas
for i, (nome, legenda) in enumerate(recado):
    r, c = divmod(i, 2)
    y = TITULO + MARGEM + r * (linha_h + 56 + MARGEM)
    x = MARGEM + c * (col_w + MARGEM)
    tela.paste(bloco(nome, legenda), (x, y))

d = ImageDraw.Draw(tela)
rodape = ('Regras ativas: velocidade ≥ 51 km/h · RPM máxima do motor · troca de turno > 4 min · motor ocioso > 5 min. '
          'Alerta com pop-up, som e voz no navegador e no APK. Branco Peres — Agronegócio.')
import textwrap
rodape = '\n'.join(textwrap.wrap(rodape, width=96))
d.multiline_text((MARGEM, total - 86), rodape, font=fonte(17), fill=(70, 80, 88), spacing=8)

# título
cabeca(tela.crop((0, 0, PAINEL, TITULO)), '', '')  # garante antialias das faixas
d.rectangle([0, 0, PAINEL, TITULO], fill=VERDE)
d.rectangle([0, TITULO - 6, PAINEL, TITULO], fill=VERDE_CLARO)
d.text((MARGEM, 34), 'Monitoramento BP — Central de Alertas', font=fonte(38, True), fill=(255, 255, 255))
d.text((MARGEM, 92), 'validado com a frota real do tenant · 23/11/2026', font=fonte(20), fill=(226, 242, 231))

tela.save(SAIDA, optimize=True)
print('gravado:', SAIDA, tela.size)
