#!/bin/sh
# Renders /etc/xray/config.json from the template, then starts supervisord which
# runs both Xray-core (VPN) and the Node web+API server (port $PORT).
set -e

# Xray listens for plain VLESS over WebSocket (security "none") on the
# container-internal loopback (127.0.0.1:10000). Amvera's edge (Traefik)
# terminates TLS with a real Let's Encrypt cert for the web domain and forwards
# the HTTP/WebSocket upgrade to the Node server, which proxies the upgrade to
# Xray. Clients connect with security=tls + type=ws + sni=<web domain> and speak
# VLESS over that standard HTTPS/WebSocket tunnel. Raw-TCP VLESS through Amvera's
# TCP ingress does NOT work and Reality is incompatible with edge TLS
# termination (see .agents/memory/amvera-raw-tcp-port.md).
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SESSION_SECRET:?SESSION_SECRET is required}"

export PORT="${PORT:-8080}"
export XRAY_CONFIG_PATH="${XRAY_CONFIG_PATH:-/etc/xray/config.json}"

# Always re-render the config from the template (so template changes take effect
# on redeploy), but preserve the live list of issued clients from the previous
# config on the persistent volume so existing keys keep working.
mkdir -p "$(dirname "$XRAY_CONFIG_PATH")"
RENDERED="$(cat /app/xray/config.json.template)"
if [ -f "$XRAY_CONFIG_PATH" ]; then
  printf '%s' "$RENDERED" | node -e '
    const fs = require("fs");
    const next = JSON.parse(fs.readFileSync(0, "utf-8"));
    const prevPath = process.argv[1];
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
      const prevClients = prev?.inbounds?.[0]?.settings?.clients;
      if (Array.isArray(prevClients)) {
        // Deduplicate by email (keep first occurrence of each email).
        // Xray rejects a config that has two clients with the same email
        // and refuses to start — duplicates can appear if a key-issuance
        // request wrote to disk but then failed before the live reload,
        // and the user retried with the same label (same email, new UUID).
        const seenEmails = new Set();
        const seenIds = new Set();
        const unique = prevClients.filter(c => {
          if (!c.id || seenIds.has(c.id)) return false;
          if (c.email && seenEmails.has(c.email)) return false;
          seenIds.add(c.id);
          if (c.email) seenEmails.add(c.email);
          return true;
        });
        next.inbounds[0].settings.clients = unique;
      }
    } catch {
      // No valid previous config to preserve clients from; start fresh.
    }
    fs.writeFileSync(prevPath + ".new", JSON.stringify(next, null, 2));
  ' "$XRAY_CONFIG_PATH"
  mv "${XRAY_CONFIG_PATH}.new" "$XRAY_CONFIG_PATH"
else
  printf '%s' "$RENDERED" > "$XRAY_CONFIG_PATH"
fi

# Push DB schema in the background (idempotent: no-op if schema already
# matches). Uses the self-contained @workspace/db deploy (schema +
# drizzle-kit) baked into the image at build time. --force skips the
# interactive confirmation prompt for destructive changes, since there is no
# TTY in production.
#
# This runs in the BACKGROUND, not before supervisord: schema introspection
# over the network can legitimately take 60-90+ seconds, and blocking startup
# on it made Amvera's health check time out -> kill the container -> restart
# -> hang again, i.e. a permanent 503 crash loop. The app must come up
# immediately; the schema push just catches up whenever it finishes. stdin is
# closed so it can never hang on an unexpected interactive prompt.
(
  echo "Pushing database schema in the background..."
  if timeout 150 /app/db-migrate/node_modules/.bin/drizzle-kit push --force --config /app/db-migrate/drizzle.config.ts < /dev/null; then
    echo "Database schema is up to date."
  else
    echo "WARNING: schema push failed or timed out — app is running against the existing schema."
  fi
) &

exec supervisord -c /app/supervisord.conf
