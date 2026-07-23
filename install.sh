#!/usr/bin/env bash
# Installs (or updates) Grimoire on Linux: downloads the latest AppImage,
# makes it executable, and adds it to your application menu with an icon.
# No sudo needed — everything lives under your home directory.
#
#   curl -fsSL https://raw.githubusercontent.com/dontshome/grimoire/main/install.sh | bash
#
set -euo pipefail

APP_DIR="$HOME/Applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
DESKTOP_DIR="$HOME/.local/share/applications"
APPIMAGE_PATH="$APP_DIR/Grimoire.AppImage"

echo "Looking up the latest Grimoire release..."
RELEASE_JSON=$(curl -fsSL https://api.github.com/repos/dontshome/grimoire/releases/latest)
DOWNLOAD_URL=$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*\.AppImage"' | grep -o 'https://[^"]*')

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Couldn't find a Linux AppImage in the latest release. Please download it manually from:"
  echo "  https://github.com/dontshome/grimoire/releases"
  exit 1
fi

mkdir -p "$APP_DIR" "$ICON_DIR" "$DESKTOP_DIR"

echo "Downloading $(basename "$DOWNLOAD_URL")..."
curl -fsSL -o "$APPIMAGE_PATH" "$DOWNLOAD_URL"
chmod +x "$APPIMAGE_PATH"

if [ ! -f "$ICON_DIR/grimoire.png" ]; then
  echo "Adding the app icon..."
  curl -fsSL -o "$ICON_DIR/grimoire.png" \
    https://raw.githubusercontent.com/dontshome/grimoire/main/build/icon.png
fi

echo "Adding Grimoire to your application menu..."
cat > "$DESKTOP_DIR/grimoire.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Grimoire
Comment=World of Warcraft addon manager — CurseForge and Wago in one place
Exec=$APPIMAGE_PATH %U
Icon=grimoire
Terminal=false
Categories=Game;
StartupWMClass=grimoire
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi

echo ""
echo "Done! Grimoire is installed at $APPIMAGE_PATH"
echo "You'll find it in your application menu, or run it directly with:"
echo "  $APPIMAGE_PATH"
echo ""
echo "To update later, just run this same command again."
