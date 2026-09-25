#!/bin/sh
# Generates the Xray config from the WebSocket template and, when explicitly
# enabled, adds a separate VLESS+Reality TCP inbound. The latter is opt-in:
# existing deployments remain byte-for-byte WS compatible.
# starts supervisord. Unlike the previous Reality setup, the WS template has
# no env-var substitutions — Xray listens on 127.0.0.1:10000 (plain WS) and
# TLS termination is handled by the external Nginx/Caddy on the VPS host:
#
#   server {
#       listen 443 ssl http2;
#       server_name <your-domain>;
#       ssl_certificate     /path/to/cert.pem;
#       ssl_certificate_key /path/to/key.pem;
#       location /vpnws {
#           proxy_pass http://127.0.0.1:10000;
#           proxy_http_version 1.1;
#           proxy_set_header Upgrade $http_upgrade;
#           proxy_set_header Connection "Upgrade";
#           proxy_set_header Host $host;
#       }
#   }
#
# Xray Stats gRPC API is on 127.0.0.1:10085 (internal only).
set -e

: "${MGMT_API_SECRET:?MGMT_API_SECRET is required}"

if [ "${REALITY_ENABLED:-false}" = "true" ]; then
  : "${REALITY_PRIVATE_KEY:?REALITY_PRIVATE_KEY is required when REALITY_ENABLED=true}"
  : "${REALITY_SHORT_ID:?REALITY_SHORT_ID is required when REALITY_ENABLED=true}"
  : "${REALITY_SERVER_NAME:?REALITY_SERVER_NAME is required when REALITY_ENABLED=true}"
  : "${REALITY_DEST:?REALITY_DEST is required when REALITY_ENABLED=true}"
  case "$REALITY_PRIVATE_KEY" in *[!A-Za-z0-9_-]*|"") echo "REALITY_PRIVATE_KEY must be an Xray base64url key" >&2; exit 1;; esac
  case "$REALITY_SHORT_ID" in *[!0-9a-fA-F]*|"") echo "REALITY_SHORT_ID must be 1-16 hexadecimal characters" >&2; exit 1;; esac
  if [ "${#REALITY_SHORT_ID}" -gt 16 ] || [ "${#REALITY_PRIVATE_KEY}" -lt 32 ]; then
    echo "Invalid Reality key or short ID length" >&2; exit 1
  fi
  reality_dest_host=${REALITY_DEST%:*}
  reality_dest_port=${REALITY_DEST##*:}
  case "$REALITY_DEST" in *:* ) ;; *) echo "REALITY_DEST must be host:port" >&2; exit 1;; esac
  case "$reality_dest_host" in ""|*[!A-Za-z0-9.-]*) echo "REALITY_DEST host is invalid" >&2; exit 1;; esac
  case "$reality_dest_port" in ""|*[!0-9]*) echo "REALITY_DEST port must be numeric" >&2; exit 1;; esac
  case "$REALITY_SERVER_NAME" in *[!A-Za-z0-9.-]*) echo "REALITY_SERVER_NAME must be a DNS name" >&2; exit 1;; esac
  if [ -z "$REALITY_SERVER_NAME" ]; then
    echo "REALITY_SERVER_NAME must be a DNS name" >&2
    exit 1
  fi
fi

# Reality owns the public TCP 8443 by default. Move the management API to
# 8444 only for this opt-in mode; existing WS nodes retain PORT=8443.
if [ "${REALITY_ENABLED:-false}" = "true" ]; then
  export REALITY_PORT="${REALITY_PORT:-8443}"
  export PORT="${PORT:-8444}"
  case "$REALITY_PORT" in ""|*[!0-9]*) echo "REALITY_PORT must be numeric" >&2; exit 1;; esac
  if [ "$PORT" = "$REALITY_PORT" ]; then
    echo "PORT and REALITY_PORT conflict; set the management API to another port (8444 by default)" >&2
    exit 1
  fi
else
  export PORT="${PORT:-8443}"
fi

mkdir -p "$(dirname "${XRAY_CONFIG_PATH:-/etc/xray/config.json}")"

if [ -f "${XRAY_CONFIG_PATH:-/etc/xray/config.json}" ]; then
  # Preserve the live client list from the previous config on the persistent
  # volume so existing keys keep working across container restarts/redeploys.
  node -e '
    const fs = require("fs");
    const prevPath = process.argv[1];
    const tmplPath = process.argv[2];
    try {
      const next = JSON.parse(fs.readFileSync(tmplPath, "utf-8"));
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
       const oldByTag = new Map((prev?.inbounds || []).map(i => [i.tag, i]));
       for (const inbound of next.inbounds || []) {
         const old = oldByTag.get(inbound.tag);
         const oldClients = old?.settings?.clients;
         if (!Array.isArray(oldClients)) continue;
         const seenIds = new Set();
         inbound.settings.clients = oldClients.filter(c => {
           if (!c.id || seenIds.has(c.id)) return false;
           seenIds.add(c.id);
           return true;
         });
       }
       if (process.env.REALITY_ENABLED === "true") {
         const reality = {
           tag: "vless-reality", listen: "0.0.0.0",
           port: Number(process.env.REALITY_PORT || 8443), protocol: "vless",
           settings: {
             clients: oldByTag.get("vless-reality")?.settings?.clients || [],
             decryption: "none"
           },
           streamSettings: {
             network: "tcp", security: "reality",
             realitySettings: {
               show: false, dest: process.env.REALITY_DEST, xver: 0,
               serverNames: [process.env.REALITY_SERVER_NAME],
               privateKey: process.env.REALITY_PRIVATE_KEY,
               shortIds: [process.env.REALITY_SHORT_ID]
             },
             tcpSettings: { header: { type: "none" } }
           },
           sniffing: { enabled: false }
         };
         const existing = next.inbounds.findIndex(i => i.tag === reality.tag);
         if (existing >= 0) next.inbounds[existing] = reality;
         else next.inbounds.push(reality);
       }
      fs.writeFileSync(prevPath + ".new", JSON.stringify(next, null, 2));
    } catch {
      fs.copyFileSync(tmplPath, prevPath + ".new");
    }
    fs.renameSync(prevPath + ".new", prevPath);
  ' "${XRAY_CONFIG_PATH:-/etc/xray/config.json}" /app/xray/config.json.template
else
  cp /app/xray/config.json.template "${XRAY_CONFIG_PATH:-/etc/xray/config.json}"
fi

# The persistent-file path above adds Reality while preserving clients. On the
# first boot there is no previous config, so add the opt-in inbound now.
if [ "${REALITY_ENABLED:-false}" = "true" ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!c.inbounds.some(i => i.tag === "vless-reality")) {
      c.inbounds.push({
        tag: "vless-reality", listen: "0.0.0.0",
        port: Number(process.env.REALITY_PORT || 8443), protocol: "vless",
        settings: { clients: [], decryption: "none" },
        streamSettings: {
          network: "tcp", security: "reality",
          realitySettings: {
            show: false, dest: process.env.REALITY_DEST, xver: 0,
            serverNames: [process.env.REALITY_SERVER_NAME],
            privateKey: process.env.REALITY_PRIVATE_KEY,
            shortIds: [process.env.REALITY_SHORT_ID]
          },
          tcpSettings: { header: { type: "none" } }
        },
        sniffing: { enabled: false }
      });
      fs.writeFileSync(p + ".new", JSON.stringify(c, null, 2));
      fs.renameSync(p + ".new", p);
    }
  ' "${XRAY_CONFIG_PATH:-/etc/xray/config.json}"
fi

exec supervisord -c /app/supervisord.conf
