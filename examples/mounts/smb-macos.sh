#!/usr/bin/env bash
# Mount a SMB/CIFS share on macOS. Easiest way is Finder's Cmd+K and
# pasting smb://host/share — it'll mount at /Volumes/share automatically.
# This script is for headless / scripted setups.

set -euo pipefail

USER="${USER:-guest}"
HOST="${HOST:-192.168.3.10}"
SHARE="${SHARE:-photo}"
MOUNT_POINT="${MOUNT_POINT:-/Volumes/photo}"

mkdir -p "${MOUNT_POINT}"

# smb://user[:password]@host/share
# Empty password = prompts. Use :guest for guest mounts.
mount_smbfs "//${USER}@${HOST}/${SHARE}" "${MOUNT_POINT}"

echo "Mounted //${HOST}/${SHARE} at ${MOUNT_POINT}"
ls "${MOUNT_POINT}" | head -5
