#!/usr/bin/env bash
#
# Regenerate the README hero card from the text-free orchard source art.
#
# Composites the "Pardes" wordmark and the byline onto assets/pardes-card-source.png
# and writes the result to assets/pardes-card.png. Edit WORDMARK / BYLINE below and
# re-run to update the text — the source art is never modified.
#
# Requires ImageMagick 7 (`magick`). Fonts default to macOS system paths; override
# them with the NY / AV environment variables if you're on another OS.
#
#   ./script/render-card.sh
#   BYLINE="A new tagline" ./script/render-card.sh
#
set -euo pipefail

# --- editable content -------------------------------------------------------
WORDMARK="Pardes"
BYLINE="A calm-coding marketplace of plugins and skills for coding agents"

# --- fonts (override via env on non-macOS) ----------------------------------
NY="${NY:-/System/Library/Fonts/NewYork.ttf}"          # wordmark — a serif display face
AV="${AV:-/System/Library/Fonts/Avenir Next.ttc}"      # byline — a clean sans

# --- layout knobs -----------------------------------------------------------
SRC_W=1360            # source art width (px); the geometry below is tuned to it
WORDMARK_SIZE=104     # wordmark point size
WORDMARK_FILL="#2e4636"
BYLINE_SIZE=28
BYLINE_FILL="#3f5749"
BYLINE_KERNING=1.5
SHIFT=24              # horizontal nudge right of centre (px)
BASELINE=592          # wordmark baseline from the top (px)
BYLINE_Y=22           # byline offset up from the bottom edge (px)
OUT_SIZE="1280x640"   # final card dimensions

# --- paths ------------------------------------------------------------------
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/assets/pardes-card-source.png"
out="$root/assets/pardes-card.png"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- render -----------------------------------------------------------------
# Pre-render the wordmark to a trimmed transparent PNG so we can place it by its
# real pixel bounds (gravity-based placement drifts as the text length changes).
magick -background none -fill "$WORDMARK_FILL" -font "$NY" \
  -pointsize "$WORDMARK_SIZE" "label:$WORDMARK" -trim +repage "$tmp/wm.png"

wm_dims="$(magick "$tmp/wm.png" -format "%w %h" info:)"
read -r wmW wmH <<<"$wm_dims"
cx=$((SRC_W / 2))
wmX=$((cx + SHIFT - wmW / 2))
wmY=$((BASELINE - wmH))

magick "$src" \
  "$tmp/wm.png" -geometry "+${wmX}+${wmY}" -composite \
  -font "$AV" -fill "$BYLINE_FILL" -pointsize "$BYLINE_SIZE" -kerning "$BYLINE_KERNING" \
  -gravity South -annotate "+${SHIFT}+${BYLINE_Y}" "$BYLINE" \
  -resize "$OUT_SIZE" "$out"

echo "wrote $out (${OUT_SIZE})"
