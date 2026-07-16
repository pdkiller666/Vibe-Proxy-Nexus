# syntax=docker/dockerfile:1
#
# All-in-one image for Amvera Cloud: builds the React frontend + Express API,
# and runs them together with Xray-core (VPN) in a single container.
# Build context must be the repository root.

########## Builder ##########
FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

COPY . .

RUN pnpm install --frozen-lockfile

# Frontend: Vite requires PORT + BASE_PATH at build time; served at domain root.
RUN PORT=3000 BASE_PATH=/ \
    pnpm --filter @workspace/vpn-portal run build

# Backend: esbuild bundle -> artifacts/api-server/dist/index.mjs (self-contained).
RUN pnpm --filter @workspace/api-server run build

# Self-contained deploy of @workspace/db (schema + drizzle-kit) for the
# runtime image, so it can push schema changes on boot without DATABASE_URL
# being available at build time.
RUN pnpm --filter @workspace/db deploy --legacy /tmp/db-deploy

########## Runtime ##########
FROM node:24-bookworm-slim AS runtime

ARG XRAY_VERSION=1.8.24

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        unzip \
        gettext-base \
        ca-certificates \
        supervisor \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/xray.zip \
        "https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/Xray-linux-64.zip" \
    && unzip /tmp/xray.zip -d /usr/local/bin xray \
    && chmod +x /usr/local/bin/xray \
    && rm -rf /tmp/xray.zip

WORKDIR /app

# Built artifacts from the builder stage.
COPY --from=builder /repo/artifacts/api-server/dist ./server
COPY --from=builder /repo/artifacts/vpn-portal/dist/public ./public

# Self-contained @workspace/db (schema + drizzle-kit) used by entrypoint.sh to
# push schema changes on every boot.
COPY --from=builder /tmp/db-deploy ./db-migrate
COPY deploy/amvera-all-in-one/heal-schema.mjs ./db-migrate/heal-schema.mjs

# Deployment glue.
COPY deploy/amvera-all-in-one/xray-config.json.template ./xray/config.json.template
COPY deploy/amvera-all-in-one/supervisord.conf ./supervisord.conf
COPY deploy/amvera-all-in-one/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production
ENV STATIC_DIR=/app/public
ENV XRAY_CONFIG_PATH=/etc/xray/config.json
ENV PORT=8080

# Run as the built-in non-root node user (uid 1000) that the node:24-bookworm-slim
# base image ships. Neither the API server (port 8080) nor Xray (loopback 10000)
# requires a privileged port, so no CAP_NET_BIND_SERVICE is needed.
# Supervisor (PID 1) also runs as node; its socket/pidfile are owned by this user.
RUN chown -R node:node /app
USER node

# 8080 = web interface + API + VPN WebSocket proxy. Xray listens only on the
# container-internal loopback (127.0.0.1:10000), reached via the Node WS proxy.
EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
