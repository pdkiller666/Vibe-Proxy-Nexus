# Vibe Proxy Nexus

Приватный VPN-сервис по приглашениям (VLESS поверх WebSocket/TLS, на Xray-core) — веб-панель для управления подписками, оплатой через СБП и выдачей ключей доступа.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/vpn-portal run dev` — run the web portal (frontend)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `./deploy.sh "Сообщение на русском о том, что изменилось"` — deploy to production (pushes to GitHub, which triggers Amvera's auto-build). Main agent's shell blocks `git push`, so this is the only way to ship.
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite, wouter, TanStack Query, custom email+password auth (session cookie)
- VPN: Xray-core (VLESS), transport is WebSocket riding on the normal HTTPS domain (not raw TCP — see Architecture decisions)

## Where things live

- `artifacts/api-server` — Express backend: routes under `src/routes/` (and `src/routes/admin/`), auth in `src/lib/auth.ts` + `src/lib/session.ts`, VLESS link generation in `src/lib/vless.ts`, subscription-URL tokens in `src/lib/subscription.ts`, local Xray config management in `src/lib/xray.ts`, subscription auto-expiry/key-revocation job in `src/lib/subscriptionLifecycle.ts`.
- `artifacts/vpn-portal` — React/Vite frontend. Pages in `src/pages/` (home, sign-in/up, forgot/reset-password, dashboard, plans, checkout, keys, payments, admin, not-found). Shared query client in `src/lib/query-client.ts`.
- `deploy/amvera-all-in-one/` — the Docker deployment package actually used in production (Xray-core + Node server + Postgres schema push, all in one container). See its README for details.
- `deploy/amvera-vpn-node/` — self-contained package for a FUTURE multi-region setup (separate VPN nodes + secured management API). Not used today.

## Architecture decisions

- **Deployment target is Amvera Cloud, all-in-one**: the whole project (React frontend + Express API + Xray-core VPN) ships as a single Docker image and runs in one Amvera container, managed by `supervisord`. Replit is the dev environment only. Only Postgres stays external. See `deploy/amvera-all-in-one/`.
- **VPN transport is VLESS over WebSocket, not raw TCP or Reality.** Amvera's edge (Traefik/Envoy) always terminates TLS itself and only forwards plain HTTP(S)/WebSocket to the container on the app's single public port (8080). Raw-TCP VLESS and Reality are both incompatible with that (Reality needs to own the TLS handshake; raw TCP through Amvera's ingress gets corrupted). The working setup: Xray listens on `127.0.0.1:10000` for plain VLESS+WS (`security: none`), and the Node server itself proxies the `/vpnws` WebSocket upgrade to it (see `src/index.ts`). Clients connect with `security=tls&type=ws&sni=<web domain>` — a completely standard HTTPS/WebSocket connection from the outside. See `.agents/memory/amvera-raw-tcp-port.md`.
- **Self-updating subscription URL** (added July 2026): instead of making users paste/manage individual `vless://` links, `GET /api/vpn-keys/subscription-url` returns one stable URL (`/api/sub/<token>`, stateless HMAC-signed, no DB row) that VPN client apps (Happ, v2rayNG, etc.) re-fetch periodically. It returns base64 of all the user's active links plus branded headers (`Profile-Title`, `Profile-Update-Interval`, `Subscription-Userinfo`). This is what lets the panel add/rotate nodes later without users re-importing anything, and stops users from hand-editing their own config. See `.agents/memory/vpn-subscription-links.md`.
- All-in-one wiring: in production the Express process serves BOTH `/api/*` and the built React SPA (gated by `STATIC_DIR`). Because Xray runs in the same container, the backend manages the Xray client list directly on disk (gated by `XRAY_CONFIG_PATH`) and reloads via `supervisorctl restart xray` — no separate management API. Both gates are unset in Replit dev, so dev behavior is unchanged (Vite serves the frontend; keys are generated locally but not connectable).
- `app.set("trust proxy", 1)` (single hop) is required so `req.protocol` correctly reports `https` behind Amvera's edge (otherwise generated absolute URLs, like the subscription URL, would render as `http://`). Deliberately not `trust proxy: true` — that would let clients spoof `X-Forwarded-For` and weaken IP-based login rate limiting.
- **Billing lifecycle (added July 2026):** `startSubscriptionExpiryJob()` (in `src/lib/subscriptionLifecycle.ts`, started from `app.ts` alongside the session-cleanup job) periodically expires overdue subscriptions and revokes a user's VPN keys — but only if they have no *other* still-active subscription (a user can hold multiple overlapping subscription rows via early renewal). Admin payment confirm/reject (`admin/payments.ts`) is wrapped in a `db.transaction()`, is idempotent (status checked in the `WHERE` clause, so double-clicking confirm is a no-op / 409), and chains renewal from the end of the current active subscription rather than from "now" (so renewing early doesn't waste paid days). Lazy-expiry (`endsAt > now`) is also checked defense-in-depth in `meResponse.ts`, `vpnKeys.ts`, and `subscription.ts` — a subscription past its end date never grants key issuance or listing even if the cleanup job hasn't run yet.
- **VPN node capacity limits (added July 2026):** `vpn_nodes.maxUsers` (nullable = unlimited) caps how many non-revoked VPN keys a node will serve. Enforced in `POST /api/vpn-keys`: explicit `nodeId` on a full node returns `409`, and auto-selection (no `nodeId`) skips full nodes entirely. Every node response (public list, admin create/update) includes a computed `activeUserCount` (count of non-revoked keys) so the admin panel can show occupancy against the cap.
- Payment MVP is manual SBP (Russian bank transfer): users mark a payment as paid with a note, an admin manually confirms/rejects it in `/admin`. The schema already has a `yookassa` provider value for a future automatic gateway, but no such integration exists yet — see `.agents/memory/payments-manual-sbp.md`.
- No transactional email provider is configured: password-reset links are returned directly in the API/UI response rather than emailed (see `.agents/memory/no-email-provider.md`).
- `deploy/amvera-vpn-node/` (Xray + secured management API, `X-Management-Secret`) is kept for a FUTURE multi-region setup where VPN nodes live on separate machines and the panel stays central. Not used by the all-in-one deployment.

## Product

- Invite-only VPN reselling: users sign up with email+password, pick a plan, pay via SBP transfer, get a subscription activated by an admin, then issue/revoke VLESS keys (or use the one-click subscription link) from a dashboard. Subscriptions auto-expire and revoke keys when they lapse; renewing before expiry chains the new period onto the current one instead of restarting the clock.
- Profile page (`/profile`): user can change their own name, email (requires current password, checks email uniqueness), and password (requires current password, invalidates other sessions).
- Admin panel (`/admin`, gated by role): pending payments queue (confirm/reject, transactional + idempotent), plans CRUD, VPN nodes CRUD (with optional per-node user capacity `maxUsers` and live `activeUserCount`), user role management, SBP payment settings, password-reset link generation for users, and an analytics summary (users online now, new users last 7/30 days, plan distribution, 14-day revenue chart). "Online" is computed from `users.lastActiveAt`, touched at most once/minute per session and considered online within a 5-minute window.

> **Note on "invite-only" positioning:** the sign-in/sign-up copy says "доступ только по приглашению", but there is currently no actual invite mechanism — anyone can self-register via `/sign-up` with just an email+password. See "Open product question" below.

## User preferences

- Agent must communicate with the user only in Russian (chat replies), not just UI copy.
- All UI copy must be in Russian.
- Visual identity: technical, precise, quietly confident — not corporate SaaS blue, not playful. Bold, deliberate color choice (industrial orange accent). No emojis.
- Every deploy commit message (the message passed to `./deploy.sh "..."`) must be written in Russian and clearly describe what changed, since the user reads deploy history in Amvera/GitHub to track what was shipped.

## Open product question

The product currently *says* "invite-only" (premium, not-for-everyone positioning) but *does* nothing to enforce it — `/sign-up` is a plain open self-registration form with no invite code, waitlist, referral gate, or manual approval step. This is a real gap between messaging and mechanics worth resolving deliberately (not fixed yet — no code changed, agent flagged it for the user to decide direction):
- **Cheapest fix, keeps the promise literal:** require an invite code at signup (a `invite_codes` table admins generate, single-use or capped-use, checked in `POST /api/auth/register`).
- **Softer/more common for paid products:** drop "invite-only" from the copy and lean on the premium feel elsewhere (price, design, limited node capacity, waitlist for full nodes) — arguably closer to what's actually built today.
- **Middle ground:** keep open self-registration but gate the *paid/working* part behind manual admin activation (closer to how payments already work) and rename the copy to reflect "заявка на доступ" instead of "приглашение".

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Product overview for humans (features, stack, screenshots) — `README.md`
- Full repo map and API/schema reference — `PROJECT_MAP.md`
- Production deployment details — `deploy/amvera-all-in-one/README.md`
