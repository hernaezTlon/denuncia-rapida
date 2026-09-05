#!/bin/bash
# Deploy to the MacBook Air that runs the app 24/7, then restart it.
# The Air is a git checkout of `main` (origin = GitHub, read-only). Push first, then it pulls.
# Claude's SOS commits land on the Air's main; if the Air is ahead, fetch them with
# scripts/sync-from-air.sh before deploying (this script refuses to clobber them).
# Usage: bash scripts/deploy-air.sh [host]   (default: Tailscale IP; LAN: 192.168.68.54)
set -euo pipefail
HOST="${1:-100.118.102.111}"
USER_AT="hernaez@$HOST"

echo "→ push main"
git push origin main 2>&1 | tail -1

echo "→ pull + npm install + restart on $USER_AT"
ssh "$USER_AT" 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh";
  cd ~/denuncia-rapida || exit 1;
  git checkout -q -- package-lock.json 2>/dev/null || true;
  git fetch -q origin main;
  if ! git merge -q --ff-only origin/main; then
    echo "AIR HAS LOCAL COMMITS (SOS). Run scripts/sync-from-air.sh first:"; git log --oneline origin/main..HEAD; exit 1;
  fi;
  { npm install --no-audit --no-fund 2>&1 | tail -4; test "${PIPESTATUS[0]}" -eq 0 || { echo "NPM INSTALL FAILED"; exit 1; }; };
  launchctl kickstart -k "gui/$(id -u)/com.denunciarapida.app" && echo "restarted";
  sleep 20; tail -8 ~/Library/Logs/denuncia-rapida.log'
