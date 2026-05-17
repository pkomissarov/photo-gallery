#!/usr/bin/env bash
# Mount a directory over SSH using sshfs (macFUSE).
#
# Install:  brew install macfuse  &&  brew install --cask sshfs
# (macFUSE needs a system-extension approval in System Settings → Privacy)
#
# Slowest of the three options — every readdir is a network round-trip.
# Reserve for cases where SSH is the only way in (firewall, VPN, etc.).

set -euo pipefail

USER="${USER:-root}"
HOST="${HOST:-192.168.3.10}"
REMOTE_PATH="${REMOTE_PATH:-/data/photo}"
MOUNT_POINT="${MOUNT_POINT:-/Volumes/photo}"

mkdir -p "${MOUNT_POINT}"

sshfs \
    "${USER}@${HOST}:${REMOTE_PATH}" \
    "${MOUNT_POINT}" \
    -o reconnect,defer_permissions,volname=photo,auto_cache,kernel_cache,compression=no

echo "Mounted ${USER}@${HOST}:${REMOTE_PATH} at ${MOUNT_POINT}"
ls "${MOUNT_POINT}" | head -5
