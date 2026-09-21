#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_DIR="$ROOT_DIR/deploy/amvera-vpn-node"
BOT_DIR="$NODE_DIR/bot"
UV_BIN="${UV_BIN:-uv}"
EXPECTED_UV_VERSION="${EXPECTED_UV_VERSION:-0.9.5}"

if ! command -v "$UV_BIN" >/dev/null 2>&1; then
  echo "uv ${EXPECTED_UV_VERSION} is required" >&2
  exit 1
fi

actual_uv_version="$("$UV_BIN" --version | awk '{print $2}')"
if [[ "$actual_uv_version" != "$EXPECTED_UV_VERSION" ]]; then
  echo "uv ${EXPECTED_UV_VERSION} is required, got ${actual_uv_version}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/vpn-node-check.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

"$UV_BIN" pip compile \
  "$BOT_DIR/requirements.in" \
  --quiet \
  --python-version 3.12 \
  --generate-hashes \
  --no-header \
  --no-emit-index-url \
  --output-file "$tmp_dir/requirements.txt"

if ! diff -u "$BOT_DIR/requirements.txt" "$tmp_dir/requirements.txt"; then
  echo "requirements.txt is stale; regenerate it with deploy/amvera-vpn-node/update-lock.sh" >&2
  exit 1
fi

"$UV_BIN" venv --python 3.12 "$tmp_dir/venv"
"$UV_BIN" pip install \
  --python "$tmp_dir/venv/bin/python" \
  --require-hashes \
  --no-deps \
  -r "$BOT_DIR/requirements.txt"
"$UV_BIN" pip check --python "$tmp_dir/venv/bin/python"

cp -R "$BOT_DIR" "$tmp_dir/bot"
"$tmp_dir/venv/bin/python" -m grpc_tools.protoc \
  -I"$tmp_dir/bot" \
  --python_out="$tmp_dir/bot" \
  --grpc_python_out="$tmp_dir/bot" \
  "$tmp_dir/bot/command.proto"

cat > "$tmp_dir/xray-config.json" <<'JSON'
{"inbounds":[{"settings":{"clients":[]}}]}
JSON

MGMT_API_SECRET=smoke-test-only \
TELEGRAM_BOT_TOKEN=smoke-test-only \
XRAY_CONFIG_PATH="$tmp_dir/xray-config.json" \
PYTHONPATH="$tmp_dir/bot" \
  "$tmp_dir/venv/bin/python" "$NODE_DIR/smoke_test.py"

"$tmp_dir/venv/bin/python" -m compileall -q "$tmp_dir/bot"