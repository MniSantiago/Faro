#!/usr/bin/env bash
# Regenera docs/demo.gif: arranca un Faro de demostración nuevo (puerto 3299, agente simulado, carpeta temporal),
# graba el recorrido con Playwright, lo para y convierte el vídeo en GIF con ffmpeg.
# Necesita ffmpeg y Playwright instalado aparte (no es dependencia del proyecto):
#   npm i --prefix /tmp/pw playwright@1.60.0 && npx --prefix /tmp/pw playwright install chromium
#   PLAYWRIGHT_FROM=/tmp/pw scripts/demo/gif.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${PLAYWRIGHT_FROM:?Pon en PLAYWRIGHT_FROM la carpeta donde instalaste playwright}"
work=$(mktemp -d "${TMPDIR:-/tmp}/faro-demo-XXXXXX")
export FARO_DEMO_PORT=${FARO_DEMO_PORT:-3299} FARO_DEMO_PACE=${FARO_DEMO_PACE:-0.7}

./node_modules/.bin/tsx scripts/demo/start.ts "$work/faro" > "$work/server.log" 2>&1 &
demo=$!
trap 'kill $demo 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  grep -q '\[demo\] listo' "$work/server.log" && break
  kill -0 $demo 2>/dev/null || { cat "$work/server.log"; exit 1; }
  sleep 1
done
grep -q '\[demo\] listo' "$work/server.log" || { cat "$work/server.log"; exit 1; }

FARO_DEMO_URL="http://127.0.0.1:$FARO_DEMO_PORT" PLAYWRIGHT_FROM="${PLAYWRIGHT_FROM%/}/" node scripts/demo/record.mjs "$work/video"
kill $demo; wait $demo 2>/dev/null || true

video=$(ls "$work"/video/*.webm)
mkdir -p docs
ffmpeg -loglevel error -y -i "$video" \
  -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  docs/demo.gif
cp "$video" "$work/demo.webm"
echo "docs/demo.gif ($(du -h docs/demo.gif | cut -f1)); vídeo en $work/demo.webm"
