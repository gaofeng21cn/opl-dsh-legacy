#!/bin/sh
# Install the packaged OPL DSH application into /Applications.
#
# The bundle must land as a fresh directory: `ditto` merges into an existing
# one and would leave resources the signature does not cover, which macOS then
# reports as "a sealed resource is missing or invalid".
#
# Usage: opl/install-macos.sh [arch]        (default: arm64)
set -eu

ARCH=${1:-arm64}
APP_NAME='OPL DSH.app'
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/../.desktop-build/targets/mac-$ARCH/artifacts/mac-$ARCH" && pwd)
TARGET_APP="/Applications/$APP_NAME"
PREVIOUS_APP="${TMPDIR:-/tmp}/opl-dsh-previous.app"

if [ ! -d "$SOURCE/$APP_NAME" ]; then
  echo "install-macos: package the application first:" >&2
  echo "  pnpm exec electron-builder --config electron-builder.opl.mjs --mac --$ARCH" >&2
  exit 1
fi

osascript -e 'quit app "OPL DSH"' 2>/dev/null || true
sleep 2

rm -rf "$PREVIOUS_APP"
if [ -d "$TARGET_APP" ]; then mv "$TARGET_APP" "$PREVIOUS_APP"; fi

ditto "$SOURCE/$APP_NAME" "$TARGET_APP"
if codesign --verify --strict "$TARGET_APP"; then
  rm -rf "$PREVIOUS_APP"
  echo "install-macos: installed and verified $TARGET_APP"
else
  echo "install-macos: signature verification failed; the previous bundle stays at $PREVIOUS_APP" >&2
  exit 1
fi
