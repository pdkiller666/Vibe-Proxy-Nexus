# Amvera VPN Node — Xray-core (VLESS-XTLS-Reality)

> **Status: not used in production.** The service currently in production is
> `deploy/amvera-all-in-one` — a single container running the web app, API,
> and Xray-core together, with VPN traffic riding VLESS over WebSocket on the
> normal HTTPS domain (no Reality, no separate node, no dedicated IP needed).
> This package is a **future option** for when a single Amvera container is no
> longer enough (e.g. multiple regions, or wanting Reality's stronger
> masking on a node with a Dedicated IPv4). It is not wired to the backend
> today — see "Wiring this up" below for what's still missing.

This directory is a **self-contained deployment package** for a dedicated VPN node
(separate from the main web app). It is meant to be pushed to **Amvera Cloud**
(or any Docker host) as its own container/service — it does **not** run inside
this Replit workspace, because Replit cannot host raw TCP VPN traffic.

## What this is (and isn't)

- **Is:** a single Docker container running `xray-core` (VLESS-XTLS-Reality) plus a
  small, secured HTTP management API that can create/revoke VPN client credentials
  on demand.
- **Is not:** the full 3X-UI web panel from the original spec. The Replit-hosted
  "Vibe Proxy Nexus" web app (in `artifacts/vpn-portal` + `artifacts/api-server`)
  already *is* the admin/user dashboard — a second web panel on the node itself
  would be redundant. Instead, the node exposes a minimal, purpose-built API that
  the Replit backend calls to provision keys. If you want the full 3X-UI panel
  UI as well, it can be added later; this package deliberately keeps the node
  surface small and easy to secure.

## Components (all in one container, supervised by `supervisord`)

1. **`xray`** — the actual proxy process, reading `xray/config.json`.
2. **`mgmt-api`** (`bot/api_server.py`, FastAPI) — a secured HTTP API used by the
   Replit backend to add/remove VLESS clients from the running Xray config and
   hot-reload it. Every request must include the `X-Management-Secret` header
   matching the `MGMT_API_SECRET` environment variable.
3. **`telegram-bot`** (`bot/telegram_bot.py`, optional) — a small aiogram bot for
   manually checking node status from Telegram. Client issuance itself is driven
   by the Replit web app, not the bot, to keep a single source of truth.

## Environment variables (set as Amvera secrets)

| Variable | Purpose |
|---|---|
| `MGMT_API_SECRET` | Shared secret the Replit backend must send as `X-Management-Secret` on every management API call. Generate a long random string. |
| `REALITY_PRIVATE_KEY` | Xray Reality private key (`xray x25519` to generate a keypair). |
| `REALITY_PUBLIC_KEY` | The matching public key — give this to the Replit backend/admin panel for the VPN node record (`publicKey` field). |
| `REALITY_SHORT_ID` | Short ID for Reality (hex string, e.g. 8 chars) — also goes in the VPN node record (`shortId` field). |
| `REALITY_SNI` | The masked destination site the Reality handshake mimics (e.g. `www.microsoft.com`). Must match the VPN node record's `sni` field. |
| `TELEGRAM_BOT_TOKEN` | Optional — only needed if you use the status bot. |
| `TELEGRAM_ADMIN_CHAT_ID` | Optional — restricts the bot to a single admin chat. |
| `PORT` | HTTP port for the management API (Amvera injects this; defaults to 8443 if unset). |

## Wiring this up to the Replit backend

1. Deploy this container to Amvera. Note its public host/IP.
2. In the Vibe Proxy Nexus admin panel (`/admin` → VPN nodes), create a node with:
   - `host` = the Amvera node's public host
   - `sni` = your `REALITY_SNI`
   - `publicKey` = your `REALITY_PUBLIC_KEY`
   - `shortId` = your `REALITY_SHORT_ID`
3. **Not yet wired automatically:** today, `POST /api/vpn-keys` on the Replit
   backend generates a UUID and a VLESS link locally — it does not yet call this
   node's management API to actually register the client with Xray. To make keys
   connectable, add a call from the Replit backend's VPN key creation route to
   `POST https://<node-host>:<port>/clients` (see `bot/api_server.py`) whenever a
   key is issued, and to `DELETE /clients/{uuid}` when a key is revoked. This is
   intentionally left as a follow-up so the node can be deployed and its URL/
   secret obtained first.

## Local test (optional)

```bash
docker build -t vibe-proxy-node .
docker run -p 443:443 -p 8443:8443 \
  -e MGMT_API_SECRET=devsecret \
  -e REALITY_PRIVATE_KEY=... \
  -e REALITY_PUBLIC_KEY=... \
  -e REALITY_SHORT_ID=0a1b2c3d \
  -e REALITY_SNI=www.microsoft.com \
  vibe-proxy-node
```

## Amvera deployment

Amvera reads `amvera.yml` for build/run configuration. Verify the manifest
against the current Amvera Docker-deployment docs before pushing — the format
in this repo is a best-effort starting point, not a guaranteed-current schema.
