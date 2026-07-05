#!/bin/sh
# Renders /etc/xray/config.json from the template, then starts supervisord which
# runs both Xray-core (VPN, port 443) and the Node web+API server (port $PORT).
set -e

# REALITY_DEST is the real HTTPS site Xray "steals" a genuine TLS handshake
# from (camouflage). REALITY_SNI is the domain name Xray accepts from clients'
# ClientHello (serverNames) — it defaults to REALITY_DEST, but on Amvera
# without Dedicated IPv4 it MUST be set to the platform's own TCP-SNI domain
# (Настройки -> Домены -> тип MONGO/POSTGRES/REDIS), e.g.
# "myapp.user.tcp-waw0.amvera.tech", since Amvera's TCP ingress routes
# purely by the SNI it sees on ports 5432/27017/6379. See
# .agents/memory/amvera-raw-tcp-port.md.
export REALITY_DEST="${REALITY_DEST:-www.microsoft.com}"
export REALITY_SNI="${REALITY_SNI:-$REALITY_DEST}"
: "${REALITY_PRIVATE_KEY:?REALITY_PRIVATE_KEY is required}"
: "${REALITY_SHORT_ID:?REALITY_SHORT_ID is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SESSION_SECRET:?SESSION_SECRET is required}"

export PORT="${PORT:-8080}"
export XRAY_CONFIG_PATH="${XRAY_CONFIG_PATH:-/etc/xray/config.json}"

# Always re-render the config from the template (so changes to REALITY_SNI /
# REALITY_DEST / keys take effect on redeploy), but preserve the live list of
# issued clients from the previous config on the persistent volume so
# existing keys keep working.
mkdir -p "$(dirname "$XRAY_CONFIG_PATH")"
RENDERED="$(envsubst '${REALITY_SNI} ${REALITY_DEST} ${REALITY_PRIVATE_KEY} ${REALITY_SHORT_ID}' \
  < /app/xray/config.json.template)"
if [ -f "$XRAY_CONFIG_PATH" ]; then
  printf '%s' "$RENDERED" | node -e '
    const fs = require("fs");
    const next = JSON.parse(fs.readFileSync(0, "utf-8"));
    const prevPath = process.argv[1];
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf-8"));
      const prevClients = prev?.inbounds?.[0]?.settings?.clients;
      if (Array.isArray(prevClients)) {
        next.inbounds[0].settings.clients = prevClients;
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
