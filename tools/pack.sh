#!/usr/bin/env bash
# Empacota o projeto para envio ao Netlify (drag & drop) e grava o zip ao lado do projeto.
# Uso: ./tools/pack.sh [caminho-do-zip]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-/home/ubuntu/netlify/MonitoramentoBP-PWA-Netlify.zip}"
rm -f "$OUT"
( cd "$(dirname "$HERE")" && zip -qr "$OUT" "$(basename "$HERE")" \
    -x '*/node_modules/*' -x '*/.netlify/*' -x '*/.git/*' \
    -x '*/out/*' -x '*/build/*' -x '*.jks' -x '*.bak' -x '*/__pycache__/*' )
echo "zip: $OUT"
python3 -c "import os,sys;p=sys.argv[1];print(f'{os.path.getsize(p)/1024:.0f} KB')" "$OUT"
python3 "$(dirname "$0")/audit.py" "$OUT"
