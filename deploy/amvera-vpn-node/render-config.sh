#!/bin/sh
# Copies the Xray WebSocket config template to /etc/xray/config.json and
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

export PORT="${PORT:-8443}"

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
      const prevClients = prev?.inbounds?.[0]?.settings?.clients;
      if (Array.isArray(prevClients) && prevClients.length > 0) {
        const seenIds = new Set();
        next.inbounds[0].settings.clients = prevClients.filter(c => {
          if (!c.id || seenIds.has(c.id)) return false;
          seenIds.add(c.id);
          return true;
        });
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

exec supervisord -c /app/supervisord.conf
