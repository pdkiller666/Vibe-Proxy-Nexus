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

ARG XRAY_VERSION=26.3.27

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

# NOTE: supervisord runs as PID 1 and must stay root to manage child processes
# and drop to per-program users (via supervisord.conf `user=` directives).
# Adding USER node here breaks supervisord with "Can't drop privilege as nonroot
# user". To run the API and Node processes as non-root without changing the init
# model, configure `user=node` on each [program:*] section in supervisord.conf
# instead — that is the correct per-process approach when the init is root.

# 8080 = web interface + API + VPN WebSocket proxy. Xray listens only on the
# container-internal loopback (127.0.0.1:10000), reached via the Node WS proxy.
EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
