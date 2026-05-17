#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="${1:-}"
OUTPUT="${2:-${SCRIPT_DIR}/dist}"

if [[ -z "${INPUT}" ]]; then
  echo "Usage: $0 <input-dir> [output-dir]"
  echo "  input-dir   source photos (read-only)"
  echo "  output-dir  build target (default: ./dist)"
  exit 2
fi

NODE_BIN="$(command -v node || true)"
if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
  NODE_BIN=/opt/homebrew/opt/node@22/bin/node
fi
if [[ -z "${NODE_BIN}" ]]; then
  echo "Node not found in PATH" >&2
  exit 1
fi

echo "==> Indexing"
"${NODE_BIN}" "${SCRIPT_DIR}/indexer/indexer.js" --input "${INPUT}" --output "${OUTPUT}"

echo "==> Copying frontend"
rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '/manifest.json' \
  --exclude '/thumbs/' \
  --exclude '/.cache/' \
  --exclude '/originals' \
  "${SCRIPT_DIR}/frontend/" "${OUTPUT}/"

echo "==> Linking originals (local-only convenience)"
ln -sfn "${INPUT}" "${OUTPUT}/originals"

echo "==> Done. Output at ${OUTPUT}"
