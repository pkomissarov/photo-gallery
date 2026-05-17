#!/usr/bin/env bash
# Deploy via rsync over SSH. Most common case: build host has SSH access
# to the web host (NAS or VPS), rsync handles the rest.
#
# Edit DEST and run from anywhere.
#
# First deploy: full transfer of dist/. Subsequent deploys: only the diff
# is shipped (typically a few MB after a re-index of new photos).

set -euo pipefail

SRC="${SRC:-$HOME/photo-gallery/dist/}"
DEST="${DEST:-root@192.168.3.10:/var/www/html/gallery/}"

rsync -avh --progress --delete \
  --exclude='.cache/' \
  --exclude='originals' \
  "${SRC}" "${DEST}"
