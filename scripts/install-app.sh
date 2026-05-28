#!/bin/bash
# Creates a macOS .app wrapper for Denuncia Rápida
# Uses osacompile (AppleScript) to create an app with full filesystem access

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Denuncia Rápida"
APP_DIR="$HOME/Applications/$APP_NAME.app"
ELECTRON="$PROJECT_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

# Verify electron is installed
if [ ! -f "$ELECTRON" ]; then
  echo "Error: Electron not found. Run 'npm install' first."
  exit 1
fi

echo "Installing $APP_NAME..."

# Remove old version if exists
rm -rf "$APP_DIR"

# Create the .app using osacompile
# AppleScript apps run shell commands with the user's full permissions,
# avoiding macOS sandbox restrictions that block regular .app bundles
osacompile -o "$APP_DIR" -e "do shell script \"'$ELECTRON' '$PROJECT_DIR' > /dev/null 2>&1 &\""

# Swap in the custom DR plate icon (replaces the default AppleScript applet icon)
ICON_SRC="$PROJECT_DIR/build/icon.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP_DIR/Contents/Resources/applet.icns"
  touch "$APP_DIR"   # nudge Finder/Dock to refresh the icon cache
  echo "Applied custom icon."
else
  echo "Note: build/icon.icns not found — run the icon build to get the custom icon."
fi

# Clear quarantine flag
xattr -cr "$APP_DIR" 2>/dev/null || true

echo ""
echo "Installed to: $APP_DIR"
echo ""
echo "You can now:"
echo "  - Find it in ~/Applications"
echo "  - Search 'Denuncia' in Spotlight"
echo "  - Drag it to the Dock"
echo ""
echo "Done!"
