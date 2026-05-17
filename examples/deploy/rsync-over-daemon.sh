#!/usr/bin/env bash
# Deploy via rsync daemon (no SSH).
#
# On the web host, /etc/rsyncd.conf needs an exposed module — see
# example below. The advantage over SSH: no per-file SSH cipher
# overhead, slightly faster on slow CPUs. Cost: rsyncd is unauthenticated
# by default; restrict by IP or wire up auth (see rsyncd.conf docs).
#
# Web host: /etc/rsyncd.conf
# -------------------------------------------------------------
# uid = www-data
# gid = www-data
# read only = no
# list = no
#
# [gallery]
#     path = /var/www/html/gallery
#     hosts allow = 192.168.0.0/16
#     auth users = deploy
#     secrets file = /etc/rsyncd.secrets
# -------------------------------------------------------------
#
# Web host: /etc/rsyncd.secrets (chmod 600)
#     deploy:s3cret
#
# Web host: systemctl enable --now rsync

set -euo pipefail

SRC="${SRC:-$HOME/photo-gallery/dist/}"
DEST="${DEST:-rsync://deploy@192.168.3.10/gallery/}"

# Password file with the deploy secret (chmod 600). Or use
# RSYNC_PASSWORD env var if you prefer.
PASSWORD_FILE="${PASSWORD_FILE:-$HOME/.rsync-gallery.secret}"

rsync -avh --progress --delete \
  --password-file="${PASSWORD_FILE}" \
  --exclude='.cache/' \
  --exclude='originals' \
  "${SRC}" "${DEST}"
