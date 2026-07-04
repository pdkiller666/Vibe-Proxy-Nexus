#!/bin/sh
# Renders /etc/xray/config.json from the template, then starts supervisord which
# runs both Xray-core (VPN, port 443) and the Node web+API server (port $PORT).
set -e

: "${REALITY_SNI:?REALITY_SNI is required}"
: "${REALITY_PRIVATE_KEY:?REALITY_PRIVATE_KEY is required}"
: "${REALITY_SHORT_ID:?REALITY_SHORT_ID is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"

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

exec supervisord -c /app/supervisord.conf
