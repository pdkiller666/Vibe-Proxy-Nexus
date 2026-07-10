---
name: Primary/fallback public domain resolution
description: How vpnexus.pro vs the technical Amvera domain is chosen for subscription/vless links, and where it's configured.
---

The public domain shown to users in subscription URLs and vless links is
resolved dynamically per-request server-side, not hardcoded and not decided
by the client.

**Source of truth:** `primaryDomain` column on `payment_settings` (single-row
table, same one used for SBP/trial/topup settings), editable from the admin
payment-settings form. Falls back to `PRIMARY_PUBLIC_DOMAIN` env var, then a
hardcoded default (`vpnexus.pro`) if the DB value is empty.

**Health check:** `artifacts/api-server/src/lib/domain.ts` caches the
configured domain (~15s) and a `/api/healthz` health check against it (~60s).
If unhealthy, all link builders (`buildServingVlessLink`, `buildSubscriptionUrl`,
`Profile-Web-Page-Url`) transparently fall back to the node's own technical
host/SNI (or the request's own host) — no client-side logic, no re-issuing
keys needed.

**Why admin-editable (not just env var):** if the domain gets blocked/seized,
the admin needs to switch it without a code deploy — editing payment settings
takes effect within ~15s via the cache TTL.

**Persisted vs served links:** the DB `vlessLink` column on `vpn_keys` always
stores the node's raw technical address (baked at issuance time, unchanged).
Serving routes (`/vpn-keys/me`, `/sub/:token`) regenerate the link per-request
via `buildServingVlessLink` instead of trusting the stored column — this is
what lets a domain change apply to already-issued keys without reissuing them.
Admin's key list still shows the raw stored link, by design (debugging aid).
