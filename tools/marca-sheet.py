#!/usr/bin/env python3
"""Monta uma chapa de prova da marca: logo original, ícones gerados, recorte de launcher
e o cabeçalho real renderizado no celular/desktop."""
from PIL import Image, ImageDraw, ImageFont
import sys

IC = '/home/ubuntu/netlify/monitoramento-pwa/public/icons/'
DOC = '/home/ubuntu/netlify/monitoramento-pwa/docs/'
OUT = sys.argv[1] if len(sys.argv) > 1 else '/home/ubuntu/solinftec/Monitoramento-marca-aplicada.png'


def mk(p, size=None, resample=Image.LANCZOS):
    im = Image.open(p).convert('RGBA')
    if size:
        im = im.resize(size, resample)
    return im


def circle(im):
    w = im.width
    m = Image.new('L', (w, w), 0)
    ImageDraw.Draw(m).ellipse((0, 0, w, w), fill=255)
    out = Image.new('RGBA', (w, w), (0, 0, 0, 0))
    out.paste(im, (0, 0), m)
    return out


def squircle(im, radius=None):
    w = im.width
    m = Image.new('L', (w, w), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, w - 1), radius=w // 5, fill=255)
    out = Image.new('RGBA', (w, w), (0, 0, 0, 0))
    out.paste(im, (0, 0), m)
    return out


logo = mk('/home/ubuntu/upload/logo.png', (128, 128))
mark = mk(IC + 'logo-mark.png', (128, 128))
mask = circle(mk(IC + 'maskable-192.png', (128, 128)))
any_ = squircle(mk(IC + 'icon-192.png', (128, 128)))
fav = mk(IC + 'favicon-32.png', (64, 64), Image.NEAREST)
apple = squircle(mk(IC + 'apple-touch-icon-180.png', (128, 128)), 22)
apk = circle(mk('/tmp/apkicon/res_mipmap-xxxhdpi-v4_ic_launcher.png', (128, 128)))
cel = mk(DOC + 'evidencia-marca-celular.png').crop((0, 0, 390, 844)).resize((273, 591))
desk = mk(DOC + 'evidencia-marca-desktop.png').crop((0, 0, 1366, 768)).resize((820, 461))

W, H = 1180, 1074
sheet = Image.new('RGBA', (W, H), (247, 247, 249, 255))
d = ImageDraw.Draw(sheet)
F = {}
def font(sz, bold=False):
    key = (sz, bold)
    if key not in F:
        p = '/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf' % ('-Bold' if bold else '')
        try:
            F[key] = ImageFont.truetype(p, sz)
        except OSError:
            F[key] = ImageFont.load_default()
    return F[key]


d.text((32, 26), 'Marca Branco Peres aplicada ao app, ao PWA e ao APK', font=font(26, True), fill=(28, 30, 40, 255))
d.text((32, 62), 'paleta extraída do próprio brasão:  vermelho #d82424  ·  verde #006c30  ·  amarelo #f0cc0c  ·  marfim #fcfcfa',
       font=font(17), fill=(90, 94, 105, 255))

# faixa de swatches
for i, c in enumerate([(0xd8, 0x24, 0x24), (0x00, 0x6c, 0x30), (0xf0, 0xcc, 0x0c), (0xfc, 0xfc, 0xfa)]):
    x = 32 + i * 74
    d.rounded_rectangle((x, 92, x + 62, 116), radius=6, fill=c + (255,), outline=(190, 192, 200, 255))

tiles = [('logo original', logo, (255, 255, 255, 255)),
         ('logo-mark\n(cabeçalho)', mark, (255, 255, 255, 255)),
         ('any 192\n(PWA)', any_, (255, 255, 255, 255)),
         ('maskable\n(zona segura)', mask, (28, 30, 38, 255)),
         ('APK launcher', apk, (28, 30, 38, 255)),
         ('apple-touch', apple, (28, 30, 38, 255)),
         ('favicon 32', fav, (255, 255, 255, 255))]
x = 32
y0 = 148
for nome, im, bg in tiles:
    box = 128
    d.rounded_rectangle((x, y0, x + box, y0 + box), radius=12, fill=bg, outline=(214, 216, 222, 255))
    sheet.alpha_composite(im, (x + (box - im.width) // 2, y0 + (box - im.height) // 2))
    for j, ln in enumerate(nome.split('\n')):
        d.text((x, y0 + box + 8 + j * 19), ln, font=font(15), fill=(70, 74, 84, 255))
    x += box + 28

# recorte do cabeçalho real (desktop)
hd = desk.crop((0, 0, 820, 46))
d.rounded_rectangle((32, 330, 32 + 820, 330 + 46), radius=8, fill=(28, 30, 38, 255))
sheet.alpha_composite(hd, (32, 330))
d.text((32, 384), 'barra do app em desktop: brasão + “Monitoramento BP” + filete tricolor no rodapé da barra',
       font=font(16), fill=(70, 74, 84, 255))

# telas
d.text((32, 420), 'celular 390×844', font=font(17, True), fill=(28, 30, 40, 255))
d.text((340, 420), 'desktop 1366×768 (abertura direto no mapa, com o brasão no carregamento)',
       font=font(17, True), fill=(28, 30, 40, 255))
sheet.alpha_composite(cel, (32, 448))
sheet.alpha_composite(desk, (340, 448))
d.rectangle((32, 448, 32 + 273, 448 + 591), outline=(200, 202, 210, 255))
d.rectangle((340, 448, 340 + 820, 448 + 461), outline=(200, 202, 210, 255))
d.text((340, 448 + 470), 'ícones do portal em cache são do Service Worker bperes-shell-v9 —\n'
                      'reimplantar o zip no Netlify é o que faz a marca aparecer no site publicado',
       font=font(15), fill=(110, 114, 124, 255))
sheet.convert('RGB').save(OUT, optimize=True)
print('chapa:', OUT, sheet.size)
