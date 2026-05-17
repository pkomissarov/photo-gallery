#!/usr/bin/env bash
# Mount an NFS-exported photo library on macOS.
#
# The NAS side needs an entry in /etc/exports like:
#   /srv/nfs/photo  192.168.0.0/16(no_root_squash,rw,insecure)
# and `exportfs -ra` to apply. The `insecure` flag is what lets macOS
# mount the share without privileged-port headaches.

set -euo pipefail

HOST="${HOST:-192.168.3.10}"
EXPORT_PATH="${EXPORT_PATH:-/srv/nfs/photo}"
MOUNT_POINT="${MOUNT_POINT:-/Volumes/photo}"

sudo mkdir -p "${MOUNT_POINT}"

# macOS-specific quirks worth knowing about:
#   vers=3       — older NAS images usually only have v3 enabled
#   ro           — index pipeline only reads, never writes
#   resvport     — use a privileged port (safer with `insecure` on server)
#   rsize/wsize  — bigger blocks for fewer round-trips on small files
#   nolocks      — macOS NFS locking against older Linux is flaky
#   intr         — Ctrl+C interrupts hangs cleanly
sudo mount -t nfs \
    -o vers=3,ro,resvport,rsize=131072,wsize=131072,nolocks,intr \
    "${HOST}:${EXPORT_PATH}" "${MOUNT_POINT}"

echo "Mounted ${HOST}:${EXPORT_PATH} at ${MOUNT_POINT}"
ls "${MOUNT_POINT}" | head -5
