#!/bin/sh
# Renders /etc/xray/config.json from the template using envsubst, then starts
# supervisord (which in turn runs xray, the management API, and the bot).
set -e

: "${REALITY_SNI:?REALITY_SNI is required}"
: "${REALITY_PRIVATE_KEY:?REALITY_PRIVATE_KEY is required}"
: "${REALITY_SHORT_ID:?REALITY_SHORT_ID is required}"
: "${MGMT_API_SECRET:?MGMT_API_SECRET is required}"

export PORT="${PORT:-8443}"

mkdir -p /etc/xray
envsubst '${REALITY_SNI} ${REALITY_PRIVATE_KEY} ${REALITY_SHORT_ID}' \
  < /app/xray/config.json.template > /etc/xray/config.json

exec supervisord -c /app/supervisord.conf
