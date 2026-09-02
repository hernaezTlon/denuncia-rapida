#!/bin/bash
# Deploy this checkout to the MacBook Air that runs the app 24/7, then restart it.
# Usage: bash scripts/deploy-air.sh [host]   (default: Tailscale IP; LAN: 192.168.68.54)
set -euo pipefail
HOST="${1:-100.118.102.111}"
USER_AT="hernaez@$HOST"
SRC="$(cd "$(dirname "$0")/.." && pwd)/"

echo "→ rsync to $USER_AT:~/denuncia-rapida/"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist --exclude '.DS_Store' \
  "$SRC" "$USER_AT:~/denuncia-rapida/"

echo "→ npm install + restart launchd agent"
ssh "$USER_AT" 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh";
  cd ~/denuncia-rapida && npm install --no-audit --no-fund 2>&1 | tail -2;
  launchctl kickstart -k "gui/$(id -u)/com.denunciarapida.app" && echo "restarted";
  sleep 20; tail -8 ~/Library/Logs/denuncia-rapida.log'
