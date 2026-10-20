#!/bin/zsh
set -euo pipefail
FARO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if ! CLAUDE_BIN="${FARO_CLAUDE:-$(command -v claude)}"; then
  echo "No encuentro el comando 'claude' en el PATH. Instala Claude Code e inicia sesión ('claude login') antes de instalar Faro." >&2
  exit 1
fi
if [[ -n "${FARO_NODE:-}" ]]; then
  NODE_BIN="$FARO_NODE"
else
  # La versión sale de .nvmrc en cada instalación: el plist nunca se queda con una versión escrita a mano.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  set +u
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
  NODE_BIN="$(nvm which "$(cat "$FARO_DIR/.nvmrc")" 2>/dev/null || true)"
  set -u
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "No encuentro Node 22 (de .nvmrc). Instálalo con 'nvm install 22' o indica el binario con FARO_NODE=/ruta/a/node." >&2
  exit 1
fi
if ! NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"; then
  echo "No se pudo ejecutar Node en $NODE_BIN" >&2
  exit 1
fi
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "Faro necesita Node 22; este es Node $NODE_MAJOR ($NODE_BIN)." >&2
  exit 1
fi
LABEL="com.faro.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PLIST_XML=$(cat <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$FARO_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string><string>--import</string><string>tsx</string><string>src/server/main.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):$(dirname "$CLAUDE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.faro/logs/out.log</string>
  <key>StandardErrorPath</key><string>$HOME/.faro/logs/err.log</string>
</dict>
</plist>
PLISTEOF
)

if [[ "${FARO_DRY_RUN:-}" == "1" ]]; then
  print -r -- "$PLIST_XML"
  exit 0
fi
mkdir -p "$HOME/.faro/logs" "$HOME/Library/LaunchAgents"
print -r -- "$PLIST_XML" > "$PLIST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout vuelve antes de que el servicio termine de descargarse; bootstrap fallaría con «Input/output error».
for _ in {1..20}; do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Faro instalado y arrancado: http://127.0.0.1:3200 (logs en ~/.faro/logs)"
