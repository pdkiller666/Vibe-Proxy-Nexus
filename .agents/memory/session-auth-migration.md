---
name: Session auth vs Clerk
description: This project replaced Clerk with custom email+password auth backed by DB sessions; historical Clerk-specific notes no longer apply.
---

Auth in this project is custom email+password with session tokens stored in a
Postgres `sessions` table (not JWT), set via a signed httpOnly cookie.
Passwords are hashed with Node's built-in `scrypt` (no extra dependency).

**Why:** Clerk was removed entirely per user request; DB-backed session tokens
were chosen over JWT for easy server-side revocation (logout deletes the row).

**How to apply:** Do not reach for Clerk APIs, `@clerk/*` packages, or
Clerk-specific gotchas (e.g. localization dict merging) in this project —
they no longer apply. Auth-related code lives in
`artifacts/api-server/src/lib/session.ts`, `lib/auth.ts`, `lib/password.ts`,
and `artifacts/vpn-portal/src/pages/sign-in.tsx` / `sign-up.tsx`.
