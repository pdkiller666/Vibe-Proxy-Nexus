#!/usr/bin/env bash
set -euo pipefail

NODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UV_BIN="${UV_BIN:-uv}"
EXPECTED_UV_VERSION="${EXPECTED_UV_VERSION:-0.9.5}"

actual_uv_version="$("$UV_BIN" --version | awk '{print $2}')"
if [[ "$actual_uv_version" != "$EXPECTED_UV_VERSION" ]]; then
  echo "uv ${EXPECTED_UV_VERSION} is required, got ${actual_uv_version}" >&2
  exit 1
fi

"$UV_BIN" pip compile \
  "$NODE_DIR/bot/requirements.in" \
  --upgrade \
  --quiet \
  --python-version 3.12 \
  --generate-hashes \
  --no-header \
  --no-emit-index-url \
  --output-file "$NODE_DIR/bot/requirements.txt"