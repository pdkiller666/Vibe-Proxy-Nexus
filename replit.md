# Vibe Proxy Nexus

Приватный VPN-сервис по приглашениям (VLESS-XTLS-Reality на Xray-core) — веб-панель для управления подписками, оплатой через СБП и выдачей ключей доступа.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/vpn-portal run dev` — run the web portal (frontend)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite, wouter, TanStack Query, Clerk (auth)

## Where things live

- `artifacts/api-server` — Express backend: routes under `src/routes/`, auth in `src/lib/auth.ts`, VLESS link generation in `src/lib/vless.ts`.
- `artifacts/vpn-portal` — React/Vite frontend. Pages in `src/pages/` (dashboard, plans, checkout, payments, keys, admin). Shared query client in `src/lib/query-client.ts`.
- `deploy/amvera-vpn-node/` — self-contained Docker deployment package for the actual VPN node (Xray-core + secured management API + optional Telegram status bot), meant to be deployed to Amvera Cloud, not run in this Replit workspace. See its README for details.

## Architecture decisions

- **Deployment target is Amvera Cloud, all-in-one**: the whole project (React frontend + Express API + Xray-core VPN) ships as a single Docker image and runs in one Amvera container. Replit is the dev environment only. Postgres and Clerk stay external. See `deploy/amvera-all-in-one/`.
- All-in-one wiring: in production the Express process serves BOTH `/api/*` and the built React SPA (gated by `STATIC_DIR`). Because Xray runs in the same container, the backend manages the Xray client list directly on disk (gated by `XRAY_CONFIG_PATH`) and reloads via `supervisorctl restart xray` — no separate management API. Both gates are unset in Replit dev, so dev behavior is unchanged (Vite serves the frontend; keys are generated locally but not connectable).
- Payment MVP is manual SBP (Russian bank transfer): users mark a payment as paid with a note, an admin manually confirms/rejects it in `/admin`, no automatic payment gateway.
- `deploy/amvera-vpn-node/` (Xray + secured management API, `X-Management-Secret`) is kept for a FUTURE multi-region setup where VPN nodes live on separate machines and the panel stays central. Not used by the all-in-one deployment.

## Product

- Invite-only VPN reselling: users sign up (Clerk), pick a plan, pay via SBP transfer, get a subscription activated by an admin, then issue/revoke VLESS-XTLS-Reality keys from a dashboard.
- Admin panel (`/admin`, gated by role): pending payments queue (confirm/reject), plans CRUD, VPN nodes CRUD, user role management, SBP payment settings.

## User preferences

- All UI copy must be in Russian.
- Visual identity: technical, precise, quietly confident — not corporate SaaS blue, not playful. Bold, deliberate color choice (industrial orange accent). No emojis.

## Gotchas

- Clerk's built-in `<SignIn>`/`<SignUp>` components default to English even when you pass custom `localization` overrides for just a couple of strings — you must import and spread the official `ruRU` dict from `@clerk/localizations` as the base, then merge in custom title/subtitle overrides on top.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
