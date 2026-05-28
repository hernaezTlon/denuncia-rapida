#!/bin/bash
# Rebuilds the app icon from assets/icon.svg
#   -> assets/icon.png  (1024, used by BrowserWindow + dock)
#   -> build/icon.icns  (macOS app bundle icon)
# Requires: macOS (sips, iconutil) + sharp (already a dependency).

set -e
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

mkdir -p build/icon.iconset

echo "Rendering SVG -> 1024 PNG…"
node -e "
const sharp = require('sharp');
sharp('assets/icon.svg', { density: 300 })
  .resize(1024, 1024).png().toFile('assets/icon.png')
  .then(() => console.log('  assets/icon.png'))
  .catch(e => { console.error(e.message); process.exit(1); });
"

echo "Building iconset…"
ICO=build/icon.iconset
sips -z 16 16   assets/icon.png --out $ICO/icon_16x16.png      >/dev/null
sips -z 32 32   assets/icon.png --out $ICO/icon_16x16@2x.png   >/dev/null
sips -z 32 32   assets/icon.png --out $ICO/icon_32x32.png      >/dev/null
sips -z 64 64   assets/icon.png --out $ICO/icon_32x32@2x.png   >/dev/null
sips -z 128 128 assets/icon.png --out $ICO/icon_128x128.png    >/dev/null
sips -z 256 256 assets/icon.png --out $ICO/icon_128x128@2x.png >/dev/null
sips -z 256 256 assets/icon.png --out $ICO/icon_256x256.png    >/dev/null
sips -z 512 512 assets/icon.png --out $ICO/icon_256x256@2x.png >/dev/null
sips -z 512 512 assets/icon.png --out $ICO/icon_512x512.png    >/dev/null
cp assets/icon.png $ICO/icon_512x512@2x.png

iconutil -c icns build/icon.iconset -o build/icon.icns
echo "Done -> build/icon.icns"
