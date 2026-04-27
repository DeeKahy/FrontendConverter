#!/usr/bin/env bash
# Download FFmpeg UMD files into vendor/ffmpeg/ so the app can serve them
# same-origin. This avoids the cross-origin Worker / SharedArrayBuffer
# headaches you hit when hosting on GitHub Pages.
#
# Run once after cloning, then commit the vendor/ folder.
#
#   ./scripts/fetch-vendor.sh
#
# Total download: ~30 MB (most of which is ffmpeg-core.wasm).

set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR=vendor/ffmpeg
mkdir -p "$VENDOR"

# Pinned versions — bump deliberately, not casually. The three packages must
# stay compatible with each other (see https://github.com/ffmpegwasm/ffmpeg.wasm).
FFMPEG_VER="0.12.10"
UTIL_VER="0.12.1"
CORE_VER="0.12.6"

fetch() {
  local url="$1" out="$2"
  printf "  %-46s → %s\n" "$(basename "$url")" "$out"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    echo "Need curl or wget on PATH" >&2
    exit 1
  fi
}

echo "Fetching FFmpeg vendor files into $VENDOR/ ..."
fetch "https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd/ffmpeg.js"      "$VENDOR/ffmpeg.js"
fetch "https://unpkg.com/@ffmpeg/util@${UTIL_VER}/dist/umd/index.js"          "$VENDOR/util.js"
fetch "https://unpkg.com/@ffmpeg/core@${CORE_VER}/dist/umd/ffmpeg-core.js"    "$VENDOR/ffmpeg-core.js"
fetch "https://unpkg.com/@ffmpeg/core@${CORE_VER}/dist/umd/ffmpeg-core.wasm"  "$VENDOR/ffmpeg-core.wasm"

# Drop a manifest so we can detect version drift later.
cat > "$VENDOR/MANIFEST.json" <<EOF
{
  "@ffmpeg/ffmpeg": "${FFMPEG_VER}",
  "@ffmpeg/util":   "${UTIL_VER}",
  "@ffmpeg/core":   "${CORE_VER}",
  "fetched_at":     "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo
echo "Done. Total size:"
du -sh "$VENDOR" | sed 's/^/  /'
echo
echo "Next: git add vendor/ && git commit -m 'vendor ffmpeg' && git push"
