#!/usr/bin/env python3
"""Gera todos os ícones do PWA a partir do logotipo da Branco Peres.

Uso:
    python3 tools/make-icons.py [caminho/para/logo.png]

Entrada esperada: PNG quadrado (ou quase) com o brasão. O script recorta o
brasão, remove o fundo branco se existir e produz:

  icons/logo.png                 original, maior tamanho útil (referência)
  icons/logo-mark.png            só o brasão, fundo transparente (cabeçalho/telas)
  icons/favicon-16.png  -32  -48  aba do navegador
  icons/icon-192.png    icon-512.png                 purpose "any" (transparente)
  icons/maskable-512.png                             purpose "maskable" (fundo branco)
  icons/apple-touch-icon-180.png                     iOS (fundo branco)
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/upload/logo.png"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icons")
os.makedirs(OUT, exist_ok=True)

MARFIM = (252, 252, 250, 255)  # fundo claro de "qualquer" ícone vira transparente


def carregar():
    im = Image.open(SRC).convert("RGBA")
    if im.size[0] != im.size[1]:
        lado = min(im.size)
        x0 = (im.size[0] - lado) // 2
        y0 = (im.size[1] - lado) // 2
        im = im.crop((x0, y0, x0 + lado, y0 + lado))
    return im


def fundo_transparente(im):
    """Torna transparente a moldura clara que encosta na borda da imagem."""
    im = im.copy()
    px = im.load()
    w, h = im.size
    sementes = []
    for x in range(w):
        sementes += [(x, 0), (x, h - 1)]
    for y in range(h):
        sementes += [(0, y), (w - 1, y)]

    def claro(r, g, b):
        return r > 225 and g > 225 and b > 215 and abs(r - b) < 45

    visto = set()
    pilha = [s for s in sementes if s not in visto]
    for s in pilha:
        visto.add(s)
    while pilha:
        x, y = pilha.pop()
        r, g, b, a = px[x, y]
        if a == 0 or not claro(r, g, b):
            continue
        px[x, y] = (r, g, b, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in visto:
                visto.add((nx, ny))
                pilha.append((nx, ny))
    return im


def ajustar(im, lado, margem=0.04, sombra=False):
    """Centraliza o brasão num quadrado `lado` com margem proporcional."""
    branco = fundo_transparente(im)
    caixa = branco.getbbox()
    if caixa:
        branco = branco.crop(caixa)
    if sombra:
        alvo = int(lado * (1 - 2 * margem))
        escala = alvo / max(branco.size)
        novo = branco.resize((max(1, int(branco.width * escala)), max(1, int(branco.height * escala)),), Image.LANCZOS)
        tela = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
        ox, oy = (lado - novo.width) // 2, (lado - novo.height) // 2 + int(lado * 0.015)
        halo = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
        halo.paste((0, 0, 0, 90), (ox, oy, ox + novo.width, oy + novo.height), novo.filter(ImageFilter.GaussianBlur(lado * 0.02)))
        tela.alpha_composite(halo)
        tela.alpha_composite(novo, (ox, oy))
        return tela
    return centralizar(branco, lado, margem)


def centralizar(brasao, lado, margem=0.04):
    alvo = int(lado * (1 - 2 * margem))
    escala = alvo / max(brasao.size)
    novo = brasao.resize((max(1, int(brasao.width * escala)), max(1, int(brasao.height * escala))), Image.LANCZOS)
    tela = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
    tela.paste(novo, ((lado - novo.width) // 2, (lado - novo.height) // 2), novo)
    return tela


def com_fundo(im, lado, cor=MARFIM, margem=0.04):
    fundo = Image.new("RGBA", (lado, lado), cor)
    fundo.alpha_composite(centralizar(im, lado, margem))
    return fundo


def main():
    base = carregar()
    brasao = fundo_transparente(base)
    caixa = brasao.getbbox() or (0, 0, brasao.width, brasao.height)
    brasao = brasao.crop(caixa)

    def save(nome, im):
        p = os.path.join(OUT, nome)
        im.save(p, "PNG", optimize=True)
        print(f"{nome:28} {im.size[0]}x{im.size[1]}  {os.path.getsize(p)//1024} KB")

    # referência + marca para usar dentro do app
    save("logo.png", base.resize((512, 512), Image.LANCZOS))
    save("logo-mark.png", centralizar(brasao, 256, 0.02))

    # favicons: em tamanhos pequenos o brasão quase some -> leve contraste extra
    for t in (16, 32, 48):
        if t <= 16:
            icone = centralizar(brasao, t, 0.0)
        else:
            icone = ajustar(base, t, margem=0.02, sombra=(t >= 48))
        save(f"favicon-{t}.png", icone)

    # ícones "any": transparentes, o launcher aplica a máscara dele
    save("icon-192.png", ajustar(base, 192, margem=0.06))
    save("icon-512.png", ajustar(base, 512, margem=0.06))

    # maskable: fundo branco cheio, brasão dentro da zona segura (~66%)
    # 0,19 de margem => brasão em ~62% do lado, folgado dentro do círculo
    # de segurança de 66% que os launchers do Android recortam.
    for t in (192, 512):
        mask = Image.new("RGBA", (t, t), MARFIM)
        mask.alpha_composite(centralizar(brasao, t, 0.19))
        save(f"maskable-{t}.png" if t == 512 else "maskable-192.png", mask)

    # iOS: sem transparência, brasão grande em fundo claro
    save("apple-touch-icon-180.png", com_fundo(brasao, 180, margem=0.06))
    print("\nbrasão recortado:", brasao.size)


if __name__ == "__main__":
    main()
