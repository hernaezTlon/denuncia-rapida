#!/bin/bash
# Installs a LaunchAgent so Denuncia Rápida starts at login and restarts if it dies.
# This keeps the "Message Yourself" phone flow always available: the Mac only needs
# to be awake — nothing to open, nothing to click.
#
#   npm run install-autostart      # install / update
#   npm run uninstall-autostart    # remove
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LABEL="com.denunciarapida.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/denuncia-rapida.log"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ Auto-arranque desinstalado."
  exit 0
fi

if [ ! -x "$ELECTRON" ]; then
  echo "✗ No encuentro Electron en node_modules. Corré: npm install"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$ELECTRON</string>
    <string>$APP_DIR</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "✓ Denuncia Rápida ahora arranca sola al iniciar sesión y se relanza si se cierra."
echo "  Log: $LOG"
echo "  Para quitar el auto-arranque: npm run uninstall-autostart"
