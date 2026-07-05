#!/bin/sh
# Renders /etc/xray/config.json from the template, then starts supervisord which
# runs both Xray-core (VPN, port 443) and the Node web+API server (port $PORT).
set -e

export REALITY_SNI="${REALITY_SNI:-www.microsoft.com}"
: "${REALITY_PRIVATE_KEY:?REALITY_PRIVATE_KEY is required}"
: "${REALITY_SHORT_ID:?REALITY_SHORT_ID is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SESSION_SECRET:?SESSION_SECRET is required}"

export PORT="${PORT:-8080}"
export XRAY_CONFIG_PATH="${XRAY_CONFIG_PATH:-/etc/xray/config.json}"

# Render the config only on first boot. On subsequent starts the file already
# exists on the persistent volume (persistenceMount) and contains the live list
# of issued clients — re-rendering would wipe them and silently kill active keys.
# To force a re-render (e.g. after changing Reality keys), delete the file first.
mkdir -p "$(dirname "$XRAY_CONFIG_PATH")"
if [ ! -f "$XRAY_CONFIG_PATH" ]; then
  envsubst '${REALITY_SNI} ${REALITY_PRIVATE_KEY} ${REALITY_SHORT_ID}' \
    < /app/xray/config.json.template > "$XRAY_CONFIG_PATH"
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
