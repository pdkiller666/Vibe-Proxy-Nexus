#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BOT_DIR="$ROOT_DIR/deploy/amvera-vpn-node/bot"
UV_BIN="${UV_BIN:-uv}"

if ! command -v "$UV_BIN" >/dev/null 2>&1; then
  echo "uv is required to run the local management API contract test" >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/vpn-node-contract.XXXXXX")"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

"$UV_BIN" venv --python 3.12 "$tmp_dir/venv"
"$UV_BIN" pip install \
  --python "$tmp_dir/venv/bin/python" \
  --require-hashes \
  --no-deps \
  -r "$BOT_DIR/requirements.txt"

cp -R "$BOT_DIR" "$tmp_dir/bot"
"$tmp_dir/venv/bin/python" -m grpc_tools.protoc \
  -I"$tmp_dir/bot" \
  --python_out="$tmp_dir/bot" \
  --grpc_python_out="$tmp_dir/bot" \
  "$tmp_dir/bot/command.proto"

mkdir -p "$tmp_dir/bin"
cat > "$tmp_dir/bin/xray" <<'XRAY'
#!/usr/bin/env sh
printf '%s\n' 'Password (PublicKey): contract-test-public-key'
XRAY
cat > "$tmp_dir/bin/supervisorctl" <<'SUPERVISOR'
#!/usr/bin/env sh
exit 0
SUPERVISOR
chmod +x "$tmp_dir/bin/xray" "$tmp_dir/bin/supervisorctl"

cat > "$tmp_dir/xray-config.json" <<'JSON'
{
  "inbounds": [
    {
      "tag": "vless-ws",
      "port": 8443,
      "settings": {"clients": []},
      "streamSettings": {"network": "ws", "security": "none"}
    },
    {
      "tag": "vless-reality",
      "port": 443,
      "settings": {"clients": []},
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "privateKey": "contract-private-key-never-return-this",
          "dest": "example.org:443",
          "serverNames": ["reality.contract.test"],
          "shortIds": ["0123456789abcdef"]
        }
      }
    }
  ]
}
JSON

port="$("$tmp_dir/venv/bin/python" - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"

(
  cd "$tmp_dir/bot"
  MGMT_API_SECRET="contract-test-secret" \
  TELEGRAM_BOT_TOKEN="contract-test-only" \
  XRAY_CONFIG_PATH="$tmp_dir/xray-config.json" \
  XRAY_BINARY="$tmp_dir/bin/xray" \
  PATH="$tmp_dir/bin:$PATH" \
  PYTHONPATH="$tmp_dir/bot" \
    "$tmp_dir/venv/bin/python" -m uvicorn api_server:app \
      --host 127.0.0.1 --port "$port" --log-level warning
) >"$tmp_dir/api.log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:$port/health" >/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$ready" != "1" ]]; then
  cat "$tmp_dir/api.log" >&2
  echo "Local vpn-node management API did not start" >&2
  exit 1
fi

cd "$ROOT_DIR"
VPN_NODE_CONTRACT_URL="http://127.0.0.1:$port" \
VPN_NODE_CONTRACT_SECRET="contract-test-secret" \
  pnpm --filter @workspace/api-server exec vitest run src/lib/remoteNode.contract.test.ts
