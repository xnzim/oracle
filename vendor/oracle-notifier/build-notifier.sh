#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ICON_SRC=../assets-oracle-icon.png
APP=OracleNotifier.app
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
ICONSET=OracleIcon.iconset
ICNS=OracleIcon.icns
IDENTITY="Developer ID Application: Peter Steinberger (Y5PE65HELJ)"

rm -rf "$APP" "$ICONSET" "$ICNS"
mkdir -p "$MACOS" "$RESOURCES"

# Build ICNS from PNG
mkdir "$ICONSET"
for sz in 16 32 64 128 256 512; do
  sips -z $sz $sz "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
  sips -z $((sz*2)) $((sz*2)) "$ICON_SRC" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns --output "$ICNS" "$ICONSET"
mv "$ICNS" "$RESOURCES/OracleIcon.icns"
rm -rf "$ICONSET"

# Write Info.plist
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.steipete.oracle.notifier</string>
  <key>CFBundleName</key>
  <string>OracleNotifier</string>
  <key>CFBundleDisplayName</key>
  <string>Oracle Notifier</string>
  <key>CFBundleExecutable</key>
  <string>OracleNotifier</string>
  <key>CFBundleIconFile</key>
  <string>OracleIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
PLIST

# Compile Swift helper (arm64)
swiftc -target arm64-apple-macos13 -o "$MACOS/OracleNotifier" OracleNotifier.swift -framework Foundation -framework UserNotifications

# Sign (ad-hoc or Developer ID if available)
codesign --force --deep --options runtime --sign "$IDENTITY" "$APP" || codesign --force --deep --options runtime --sign - "$APP"

echo "Built $APP"
