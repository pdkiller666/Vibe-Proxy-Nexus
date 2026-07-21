# Vibe Proxy Nexus

Приватный VPN-сервис по приглашениям (VLESS поверх WebSocket/TLS, на Xray-core) — веб-панель для управления подписками, оплатой через СБП/ЮMoney и выдачей ключей доступа.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port from $PORT)
- `pnpm --filter @workspace/vpn-portal run dev` — run the web portal (frontend)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/db exec tsc -p .` — rebuild the db package after editing its schema (required before typecheck sees new types)
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

- `artifacts/api-server` — Express backend: routes under `src/routes/` (and `src/routes/admin/`), auth in `src/lib/auth.ts` + `src/lib/session.ts`, VLESS link generation in `src/lib/vless.ts`, subscription-URL tokens in `src/lib/subscription.ts`, local Xray config management in `src/lib/xray.ts`, traffic polling + key revocation from `src/lib/trafficPolling.ts`, hourly balance billing from `src/lib/hourlyBilling.ts`, subscription auto-expiry/key-revocation in `src/lib/subscriptionLifecycle.ts`, YooMoney webhook in `src/routes/yoomoney.ts`.
- `artifacts/vpn-portal` — React/Vite frontend. Pages in `src/pages/` (home, sign-in/up, forgot/reset-password, dashboard, plans, checkout, balance-topup, slot-checkout, traffic-checkout, keys, payments, support, profile, admin, not-found). Shared query client in `src/lib/query-client.ts`.
- `deploy/amvera-all-in-one/` — the Docker deployment package actually used in production (Xray-core + Node server + Postgres schema push, all in one container). See its README for details.
- `deploy/amvera-vpn-node/` — self-contained package for a FUTURE multi-region setup (separate VPN nodes + secured management API). Not used today.

## Architecture decisions

- **Deployment target is Amvera Cloud, all-in-one**: the whole project (React frontend + Express API + Xray-core VPN) ships as a single Docker image and runs in one Amvera container, managed by `supervisord`. Replit is the dev environment only. Only Postgres stays external. See `deploy/amvera-all-in-one/`.
- **VPN transport is VLESS over WebSocket, not raw TCP or Reality.** Amvera's edge (Traefik/Envoy) always terminates TLS itself and only forwards plain HTTP(S)/WebSocket to the container on the app's single public port (8080). Raw-TCP VLESS and Reality are both incompatible with that. The working setup: Xray listens on `127.0.0.1:10000` for plain VLESS+WS (`security: none`), and the Node server itself proxies the `/vpnws` WebSocket upgrade to it (see `src/index.ts`). Clients connect with `security=tls&type=ws&sni=<web domain>` — a completely standard HTTPS/WebSocket connection from the outside. See `.agents/memory/amvera-raw-tcp-port.md`.
- **Self-updating subscription URL**: instead of making users paste/manage individual `vless://` links, `GET /api/vpn-keys/subscription-url` returns one stable URL (`/api/sub/<token>`, stateless HMAC-signed, no DB row) that VPN client apps (Happ, v2rayNG, etc.) re-fetch every 3 hours (`SUBSCRIPTION_UPDATE_INTERVAL_HOURS`). Returns base64 of all active links plus branded headers (`Profile-Title`, `Profile-Update-Interval`, `Subscription-Userinfo`, `Announce`). See `.agents/memory/vpn-subscription-links.md`.
- **Happ Announce warnings**: `GET /api/sub/:token` sets the `Announce` response header (base64 text card shown inside Happ). Logic: for hourly plans — shows balance and warning if < 24 h or < 3 h remaining; for non-hourly — prepends expiry warning if subscription ends within 5 days or today. This is the only in-client notification channel available; push/email are absent.
- **Dashboard low-balance banners**: `dashboard.tsx` computes `hoursLeft = balanceKopecks / hourlyRateKopecks` for hourly users and renders an orange banner (3–24 h left) or red alert (< 3 h left) above the subscription hero block. For monthly users `isExpiringSoon` (≤ 5 days left) renders an orange banner. All conditions are false while `me` is loading, so no flicker.
- **Invite-only registration**: `/sign-up` requires a valid `?ref=CODE` referral code in the URL; without it registration is blocked. Every user has a unique `referral_code`; the seed admin's code is the root. Registration via open `/sign-up` without code returns 400.
- **Referral commission**: when admin confirms a `subscription` payment, the payer's referrer (if any) gets `referralCommissionPercent`% of the payment credited to their `balance_kopecks` automatically. Rate is 0 by default (disabled); admin sets it in payment settings.
- **Balance and top-up**: users hold an internal `balance_kopecks` wallet. Balance is topped up via `POST /api/balance-topup-order` → admin confirms → `balance_kopecks` += amount. Balance is spent by: hourly plan billing (deducted every 5 min while traffic flows) and extra device slot purchases (when price > 0). All balance changes are logged to `balance_transactions` (types: `topup`, `debit`, `referral`, `refund`). Balance history is shown on the Payments page.
- **Extra device slots**: each plan has `devicesIncluded` (base slots). Active `subscriptions` row tracks `extraDeviceSlots` (starts 0; increments when admin confirms an `extra_device_slot` payment). Total slots = `plan.devicesIncluded + subscription.extraDeviceSlots`. Slots are tied to the subscription period — reset to 0 on renewal of monthly plans (new row created). Hourly plans reuse the same subscription row for their full continuous lifetime, so their slots persist.
- **Hourly billing**: `billingType: "hourly"` plans charge `hourlyRateKopecks` from balance every 5 minutes, but only if there was VPN traffic in the last 15 minutes (`IDLE_GRACE_MS`). Implemented in `src/lib/hourlyBilling.ts`, started from `app.ts`. No payment record is created — balance debit is logged to `balance_transactions`. If balance runs out, the subscription is expired and keys revoked.
- **Traffic tracking**: `startTrafficPollingJob()` (in `src/lib/trafficPolling.ts`) polls Xray's gRPC Stats API every 60 seconds using `QueryStats(reset: false)` + per-key `lastSeen*` to derive deltas without race conditions. Deltas are added to `trafficUpBytes`/`trafficDownBytes` (lifetime) and `periodUpBytes`/`periodDownBytes` (current period, reset on subscription renewal). `lastTrafficAt` is set on each key whenever a nonzero delta is observed — used by hourly billing as the "is this device connected right now?" signal, and by the admin panel for the VPN activity status.
- **Three-state activity status**: admin panel shows `activityStatus` per user: `"site"` (lastActiveAt within 5 min) / `"vpn"` (vpnLastActiveAt within 10 min, based on max(lastTrafficAt) across keys) / `"offline"`. When both are active, the **more recent** signal wins — avoids showing "on site" when a user closed their browser 4 min ago but is actively using VPN right now.
- **All-in-one wiring**: in production the Express process serves BOTH `/api/*` and the built React SPA (gated by `STATIC_DIR`). Because Xray runs in the same container, the backend manages the Xray client list directly on disk (gated by `XRAY_CONFIG_PATH`) and reloads via `supervisorctl restart xray`. Both gates are unset in Replit dev.
- `app.set("trust proxy", 1)` (single hop) is required so `req.protocol` correctly reports `https` behind Amvera's edge. Deliberately not `trust proxy: true` — that would let clients spoof `X-Forwarded-For` and weaken IP-based login rate limiting.
- **Billing lifecycle**: `startSubscriptionExpiryJob()` (in `src/lib/subscriptionLifecycle.ts`) periodically expires overdue subscriptions and revokes a user's VPN keys — but only if they have no other still-active subscription (a user can hold multiple overlapping subscription rows via early renewal). Admin payment confirm is wrapped in `db.transaction()`, idempotent, and chains renewal from the end of the current active subscription. Lazy-expiry (`endsAt > now`) is also checked defense-in-depth in `meResponse.ts`, `vpnKeys.ts`, and `subscription.ts`.
- **VPN node capacity limits**: `vpn_nodes.maxUsers` (nullable = unlimited) caps how many non-revoked VPN keys a node will serve. Enforced in `POST /api/vpn-keys`. Every node response includes computed `activeUserCount`.
- **Payment methods**: (1) **ЮMoney (YooMoney)** — card/SberPay via QuickPay redirect + HMAC webhook at `POST /api/yoomoney/notification`; automatic confirmation on valid webhook. (2) **СБП (ручной перевод)** — пользователь отправляет деньги вручную, загружает скриншот перевода (обязательно), добавляет комментарий (необязательно), нажимает «Я оплатил(а)». Администратор вручную подтверждает или отклоняет. Enum `provider` включает `freekassa` как legacy-значение (интеграция удалена в июле 2026).
- **SBP settings (admin-configurable)**: `sbpPaymentUrl` — прямая ссылка на платёж в СБП-приложении банка (если не задана, используется fallback); `showManualSbpDetails` — toggle: показывать ли блок с номером телефона/банком/получателем (по умолчанию скрыт); `sbpQrCodeData`/`sbpQrCodeMimeType` — QR-код (хранится в Postgres как base64, клиентам отдаётся через `GET /api/payment-settings/sbp-qr-image`, наличие сигнализируется полем `hasSbpQr: boolean`).
- No transactional email provider is configured: password-reset links are returned directly in the API/UI response. See `.agents/memory/no-email-provider.md`.
- `deploy/amvera-vpn-node/` is kept for a FUTURE multi-region setup. Not used by the all-in-one deployment.
- **Primary domain hotswap**: `payment_settings.primaryDomain` — if non-empty, used in generated vless/subscription links instead of the request's own hostname. Admin can change it instantly if the main domain gets blocked, without redeploying.
- **Trial period**: `payment_settings.trialEnabled` / `trialDays` — if enabled, `POST /auth/register` automatically creates an `active` subscription (cheapest active plan, `endsAt` = now + `trialDays`) and auto-issues the user's first VPN key right after signup, so a new user can connect without paying first. Trial creation failures are caught and logged, never block registration. Silently skipped if no active plans exist.
- **heal-schema.mjs**: runs before `drizzle-kit push` on every container start. Contains idempotent DDL patches (`ADD COLUMN IF NOT EXISTS`, unique indexes, FK ON DELETE rules, DROP COLUMN blocks) that drizzle-kit cannot apply unattended. All PL/pgSQL anonymous blocks use `DO $$ … $$` dollar-quoting (single `$` is invalid — PostgreSQL parses it as a positional parameter placeholder).

## Product

- Invite-only VPN reselling: users sign up via referral link (`/sign-up?ref=CODE`), pick a plan, pay via YooMoney (card/SberPay, auto-confirmed) or SBP manual transfer (screenshot required, admin-confirmed), get a subscription activated, then issue/revoke VLESS keys (or use the one-click subscription link) from a dashboard. Subscriptions auto-expire and revoke keys when they lapse; renewing before expiry chains the new period.
- Profile page (`/profile`): user can change their own name, email (requires current password, checks uniqueness), and password (requires current password, invalidates other sessions).
- Support (`/support`): user creates a ticket with a subject; threaded messaging between user and admin; statuses: open / answered / closed.
- Plans page (`/plans`): snap-carousel on mobile; selected plan highlighted with ring+shadow; active subscription plan highlighted in green with «Активный» badge and disabled button «Текущий тариф» — prevents accidental re-subscription.
- Payments page (`/payments`): shows balance widget (with top-up), **balance transaction history**, and payment history list.
- Dashboard (`/dashboard`): subscription status, balance, quick actions, referral section, traffic usage. Low-balance banners: orange (3–24 h left) and red critical (< 3 h left) for hourly plans; expiry banner (≤ 5 days) for monthly plans.
- Admin panel (`/admin`, gated by role): pending payments queue (confirm/reject with screenshot preview), plans CRUD, VPN nodes CRUD, user management (activity status, reset password, extra device slots, subscription override), payment settings (SBP URL, phone/bank/recipient toggle, QR code upload, extra slot price, referral commission %, min hourly top-up, primary domain), support ticket queue, analytics.

## Codegen rule

Never hand-edit `lib/api-zod/src/generated/` or `lib/api-client-react/src/generated/`. Exception: when orval codegen is unavailable (no generate script in api-zod), edit the zod file directly AND update openapi.yaml in sync. Never name a component schema `<operationId>Body/Params/Response/QueryParams` — orval generates those identifiers automatically and they will collide. See `.agents/memory/openapi-spec-drift.md`.

## User preferences

- Agent must communicate with the user only in Russian (chat replies), not just UI copy.
- All UI copy must be in Russian.
- Visual identity: technical, precise, quietly confident — not corporate SaaS blue, not playful. Bold, deliberate color choice (industrial orange accent). No emojis.
- Every deploy commit message (the message passed to `./deploy.sh "..."`) must be written in Russian and clearly describe what changed, since the user reads deploy history in Amvera/GitHub to track what was shipped.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Product overview for humans (features, stack, screenshots) — `README.md`
- Full repo map and API/schema reference — `PROJECT_MAP.md`
- Production deployment details — `deploy/amvera-all-in-one/README.md`
