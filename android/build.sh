#!/usr/bin/env bash
# ==============================================================================
#  Build do Monitoramento BP (APK) sem Android Studio.
#  Toolchain: aapt2 nativo ARM64 (Commit451/android-arm-build-tools),
#             d8 + apksigner (build-tools 34), javac 21, android.jar API 34.
#
#  Uso:  ./build.sh            -> gera out/MonitoramentoBP.apk
#        ./build.sh release    -> assina com o keystore próprio (reutilizável)
# ==============================================================================
set -euo pipefail

SDK="${ANDROID_HOME:-/home/ubuntu/android}"
AAPT2="${SDK}/tools/aapt2"
ANDROID_JAR="${SDK}/platform/android-34/android.jar"
BT="${SDK}/sdk/android-14"
# D8 do build-tools 34 (R8 8.2.2-dev) tem um NPE conhecido com classes
# anonimas; usamos um R8 standalone mais novo do repositorio do Google.
D8_JAR="${R8_JAR:-${SDK}/r8.jar}"
D8_MAIN="com.android.tools.r8.D8"
APKSIGNER_JAR="${BT}/lib/apksigner.jar"

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="${HERE}/build"
OUT="${HERE}/out"
PKG="br.com.bperes.monitoramento"
MIN_API=21
TARGET_API=34
VCODE=5
VNAME=1.4
MODO="${1:-debug}"

KEYSTORE="${KEYSTORE:-${HERE}/keystore/monitoramento-release.jks}"
# a senha do keystore NÃO fica no repositório: exporte KS_PASS antes de buildar
KS_PASS="${KS_PASS:-}"
KS_ALIAS="${KS_ALIAS:-monitoramento}"

echo "== 0. preparacao =="
if [ ! -e "$D8_JAR" ]; then
  mkdir -p "$(dirname "$D8_JAR")"
  echo "baixando R8 8.13.25 -> $D8_JAR"
  curl -fsSL -o "$D8_JAR" https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.13.25/r8-8.13.25.jar
fi
for f in "$AAPT2" "$ANDROID_JAR" "$D8_JAR" "$APKSIGNER_JAR"; do
  [ -e "$f" ] || { echo "faltando: $f"; exit 1; }
done
rm -rf "$BUILD"; mkdir -p "$BUILD/classes" "$BUILD/gen" "$BUILD/dex" "$OUT"

echo "== 1. compilar recursos =="
"$AAPT2" compile --dir "${HERE}/res" -o "${BUILD}/res.zip"

echo "== 2. linkar (gera APK base + R.java) =="
"$AAPT2" link \
  -o "${BUILD}/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "${HERE}/AndroidManifest.xml" \
  --java "${BUILD}/gen" \
  --auto-add-overlay \
  --min-sdk-version "$MIN_API" \
  --target-sdk-version "$TARGET_API" \
  --version-code "$VCODE" \
  --version-name "$VNAME" \
  "${BUILD}/res.zip"

echo "== 3. compilar Java =="
find "${HERE}/src" "${BUILD}/gen" -name '*.java' > "${BUILD}/fontes.txt"
javac --release 8 -encoding UTF-8 -Xlint:-options -nowarn \
  -classpath "$ANDROID_JAR" \
  -d "${BUILD}/classes" @"${BUILD}/fontes.txt"

echo "== 4. dex (d8) =="
jar --create --file "${BUILD}/classes.jar" -C "${BUILD}/classes" .
java -cp "$D8_JAR" "$D8_MAIN" \
  --release --min-api "$MIN_API" --lib "$ANDROID_JAR" \
  --output "${BUILD}/dex" \
  "${BUILD}/classes.jar"
[ -s "${BUILD}/dex/classes.dex" ] || { echo "d8 nao gerou classes.dex"; exit 1; }
echo "   classes.dex: $(stat -c%s "${BUILD}/dex/classes.dex") bytes"

echo "== 5. injetar classes.dex no APK =="
python3 - "$BUILD/base.apk" "$BUILD/dex/classes.dex" <<'PY'
import shutil, sys, zipfile
base, dex = sys.argv[1], sys.argv[2]
com = base + '.completo'
shutil.copyfile(base, com)
with zipfile.ZipFile(com, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
shutil.move(com, base)
print("   ok")
PY

echo "== 6. zipalign =="
"${SDK}/tools/zipalign" -f -p 4 "${BUILD}/base.apk" "${BUILD}/aligned.apk"

echo "== 7. keystore =="
if [ -z "$KS_PASS" ]; then
  echo "defina KS_PASS (senha do keystore) antes de ./build.sh release"; exit 1
fi
if [ ! -e "$KEYSTORE" ]; then
  mkdir -p "$(dirname "$KEYSTORE")"
  keytool -genkeypair -v -keystore "$KEYSTORE" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Monitoramento BP, OU=Operacao, O=Branco Peres, L=Belo Horizonte, ST=MG, C=BR" >/dev/null 2>&1
  echo "   keystore criado em $KEYSTORE"
fi

echo "== 8. assinar (v1+v2+v3) =="
java -jar "$APKSIGNER_JAR" sign \
  --ks "$KEYSTORE" --ks-key-alias "$KS_ALIAS" --ks-pass "pass:$KS_PASS" \
  --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "${OUT}/MonitoramentoBP.apk" "${BUILD}/aligned.apk"

echo "== 9. verificar =="
java -jar "$APKSIGNER_JAR" verify --print-certs "${OUT}/MonitoramentoBP.apk" | head -6
"$AAPT2" dump badging "${OUT}/MonitoramentoBP.apk" | grep -E "^(package|application-label|sdkVersion|targetSdkVersion|launchable-activity|application-icon-480)" | sed 's/^/   /'

echo
echo "APK pronto: ${OUT}/MonitoramentoBP.apk  ($(du -h "${OUT}/MonitoramentoBP.apk" | cut -f1))"
