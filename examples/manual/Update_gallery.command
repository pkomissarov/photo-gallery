#!/usr/bin/env bash
# Update_gallery.command — double-clickable build + deploy for macOS.
#
# Setup:
#   1. Copy this file to your Desktop (or anywhere handy).
#   2. chmod +x ~/Desktop/Update_gallery.command
#   3. Edit the paths below to match your setup.
#   4. Double-click: macOS opens Terminal, runs the script, leaves the
#      window open at the end so you can read the output.
#
# What it does:
#   - build.sh runs the indexer (finds new/changed photos, generates
#     WebP thumbs in 4 sizes, updates manifest, removes orphaned thumbs
#     for photos you deleted from the library)
#   - build.sh copies the static frontend into the output dir
#   - rsync ships the diff to your web server
#
# Also used as the program for examples/schedule/macos-launchd.plist
# when you want this on a schedule instead of by hand.

set -e

# ---- edit these ----
PROJECT_DIR="${PROJECT_DIR:-$HOME/photo-gallery}"
INPUT="${INPUT:-/Volumes/photo}"
OUTPUT="${OUTPUT:-$PROJECT_DIR/dist}"
DEPLOY_DEST="${DEPLOY_DEST:-root@192.168.3.10:/var/www/html/gallery/}"
# ---------------------

echo "==> $(date)  building gallery"
"${PROJECT_DIR}/build.sh" "${INPUT}" "${OUTPUT}"

echo "==> $(date)  deploying"
rsync -avh --progress --delete \
  --exclude='.cache/' \
  --exclude='originals' \
  "${OUTPUT}/" "${DEPLOY_DEST}"

echo "==> $(date)  done"

# Comment out the line below if you're calling this from launchd —
# it's only useful when double-clicking, so the Terminal window
# doesn't disappear immediately.
[[ -t 1 ]] && { echo; echo "Press any key to close..."; read -n 1 -s; }
