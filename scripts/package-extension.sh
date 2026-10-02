#!/bin/sh
# package-extension.sh — build a clean Chrome Web Store ZIP for AutoZoom.
#
# Ships ONLY what Chrome needs to run the extension:
#   manifest.json, icons/, src/
# Everything else (tests, scripts, docs, package.json, dotfiles, agent
# folders) is excluded. Outputs:
#   dist/unpacked/              plain copy — use this for "Load unpacked"
#   dist/autozoom-v<version>.zip  Chrome Web Store upload
#
# Why dist/unpacked/: Chrome refuses to load the repo root unpacked because it
# contains a directory whose name starts with "_" (_agents/ — names beginning
# with an underscore are reserved for Chrome, e.g. _locales). The copy has no
# such entries.
#
# Usage: sh scripts/package-extension.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./manifest.json').version")"
NAME="autozoom"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/${NAME}-v${VERSION}.zip"

UNPACKED="$OUT_DIR/unpacked"

mkdir -p "$OUT_DIR"
rm -f "$OUT"
rm -rf "$UNPACKED"

# Sanity: every icon referenced by the manifest must exist.
for f in $(node -p "const m=require('./manifest.json');[...Object.values(m.icons||{}),...Object.values(m.action?.default_icon||{})].join(' ')"); do
  [ -f "$f" ] || { echo "Missing icon file: $f" >&2; exit 1; }
done

# 1) Loadable folder (no tests, docs, dotfiles or reserved "_" names).
mkdir -p "$UNPACKED"
cp manifest.json "$UNPACKED/"
cp -R icons "$UNPACKED/icons"
cp -R src "$UNPACKED/src"
find "$UNPACKED" \( -name '.DS_Store' -o -name '*.map' -o -name '*.test.*' -o -name '*.spec.*' -o -name '.*' \) -type f -delete
if find "$UNPACKED" -name '_*' | grep -q .; then
  echo "Refusing: reserved '_' name inside $UNPACKED" >&2; exit 1
fi
echo "Unpacked folder: $UNPACKED  (chrome://extensions → Load unpacked → select this folder)"

# 2) Web Store ZIP.
zip -r -X -q "$OUT" manifest.json icons src \
  -x '*.DS_Store' \
  -x '*.map' \
  -x '*.test.*' \
  -x '*.spec.*' \
  -x '*/.*' \
  -x '__MACOSX/*'

echo "Packaged: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Contents:"
unzip -l "$OUT" | awk 'NR>3 && $4 != "" {print "  " $4}' | sed '$d' | sed '$d'
