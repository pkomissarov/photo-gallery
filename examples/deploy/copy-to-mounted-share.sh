#!/usr/bin/env bash
# Deploy by writing directly to a network share already mounted on the
# build host (SMB, NFS, AFP, whatever Finder/file manager handles).
#
# This sidesteps SSH entirely but is the SLOWEST option for many small
# files — each thumbnail is a separate write over the network. On a
# weak NAS, 20 GB of thumbs over SMB can take 1.5–3× longer than rsync
# over SSH. Use this only when SSH isn't an option, or when you've
# already got a writable mount and don't want extra plumbing.
#
# Prerequisites:
#   - Mount the web host's gallery dir somewhere local. Examples:
#       macOS Finder: Cmd+K → smb://nas/gallery → mounts at /Volumes/gallery
#       macOS NFS:    sudo mount -t nfs -o resvport host:/srv/gallery /Volumes/gallery
#       Linux:        sudo mount -t cifs //nas/gallery /mnt/gallery -o user=...
#
# Notes:
#   - We use rsync even for local copy so we get --delete and partial
#     resume. /bin/cp would also work but doesn't clean up orphans.
#   - --no-times skips fsync delays SMB triggers on every mtime change.

set -euo pipefail

SRC="${SRC:-$HOME/photo-gallery/dist/}"
DEST="${DEST:-/Volumes/gallery/}"

if ! mountpoint -q "${DEST%/}" 2>/dev/null && [[ ! -d "${DEST}" ]]; then
    echo "Destination ${DEST} is not mounted. Mount it first." >&2
    exit 1
fi

rsync -avh --progress --delete --no-times \
  --exclude='.cache/' \
  --exclude='originals' \
  "${SRC}" "${DEST}"
