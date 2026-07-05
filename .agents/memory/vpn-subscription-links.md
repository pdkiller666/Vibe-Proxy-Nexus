---
name: VPN subscription URL design (stateless, branded)
description: How and why the project issues a self-updating subscription URL instead of raw vless links, and how the token is authenticated without a DB migration.
---

The project issues users a single subscription URL (`/api/sub/<token>`) instead
of relying on them to paste/manage individual `vless://` links, mirroring how
commercial VLESS providers (the ones with "Автообновление" in Happ) work.

**Why:** users compared our tunnel to premium providers and wanted (1) a path
to add more nodes/protocols later without reissuing keys, and (2) protection
against users mangling their own config. A subscription is the standard answer
to both: the client app periodically re-fetches the URL and overwrites
whatever the user edited locally, and adding a node/key server-side just shows
up on the next refresh — no new import step for the user.

**Token design:** stateless HMAC (`userId.hmacSha256(userId, SESSION_SECRET)`)
rather than a random token stored in the DB. Avoids a schema migration, is
stable across deploys, and is unforgeable without the session secret.
`timingSafeEqual` is used for comparison. See
`artifacts/api-server/src/lib/subscription.ts`.

**Response format:** body is base64 of newline-joined `vless://` links (the
de facto subscription format most clients — Happ, v2rayNG, v2rayN — expect).
Branding is conveyed via headers: `Profile-Title: base64:<...>` (group name
shown in the app) and `Profile-Update-Interval` (hours). `Subscription-Userinfo`
carries `expire=<unix>` from the user's active subscription `endsAt` when present.

**Related:** default VPN key labels changed from `${node.name} — ${user.email}`
to `${BRAND_NAME} — ${node.name}` — the label is shown as the profile name
inside client apps, so it should never contain the user's email.
