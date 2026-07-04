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

# Baked into the static frontend bundle by Vite at build time.
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_CLERK_PROXY_URL=/api/__clerk

COPY . .

RUN pnpm install --frozen-lockfile

# Frontend: Vite requires PORT + BASE_PATH at build time; served at domain root.
RUN PORT=3000 BASE_PATH=/ \
    VITE_CLERK_PUBLISHABLE_KEY="$VITE_CLERK_PUBLISHABLE_KEY" \
    VITE_CLERK_PROXY_URL="$VITE_CLERK_PROXY_URL" \
    pnpm --filter @workspace/vpn-portal run build

# Backend: esbuild bundle -> artifacts/api-server/dist/index.mjs (self-contained).
RUN pnpm --filter @workspace/api-server run build

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

# Deployment glue.
COPY deploy/amvera-all-in-one/xray-config.json.template ./xray/config.json.template
COPY deploy/amvera-all-in-one/supervisord.conf ./supervisord.conf
COPY deploy/amvera-all-in-one/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=production
ENV STATIC_DIR=/app/public
ENV XRAY_CONFIG_PATH=/etc/xray/config.json
ENV PORT=8080

# 443 = Xray (VPN); 8080 = web interface + API.
EXPOSE 443 8080

ENTRYPOINT ["/app/entrypoint.sh"]
