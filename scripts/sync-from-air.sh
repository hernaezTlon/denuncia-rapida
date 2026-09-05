#!/bin/bash
# Bring Claude's SOS commits from the Air (its local `main`) into this checkout and push them.
# The Air has no GitHub credentials, so its commits only travel this way.
# Usage: bash scripts/sync-from-air.sh [host]
set -euo pipefail
HOST="${1:-100.118.102.111}"
AIR_URL="ssh://hernaez@$HOST/Users/hernaez/denuncia-rapida"

echo "→ fetch $AIR_URL main"
git fetch "$AIR_URL" main
echo "→ commits on the Air not on local main:"
git log --oneline HEAD..FETCH_HEAD || true
git merge --ff-only FETCH_HEAD 2>/dev/null || git merge --no-edit FETCH_HEAD
echo "→ push"
git push origin main 2>&1 | tail -1
