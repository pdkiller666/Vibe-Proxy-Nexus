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

**Token design:** stateless HMAC (`userId.hmac(userId, sessionSecret)`) rather
than a random token stored in the DB. Avoids a schema migration, is stable
across deploys, and is unforgeable without the session secret. Compared with
a constant-time equality check to avoid timing attacks. Tradeoff: a leaked
subscription URL cannot be individually revoked (only global secret rotation
invalidates all tokens) — acceptable for now, but a per-user salt/version
would be needed to support per-user revocation later.

**Response format:** body is base64 of newline-joined `vless://` links (the
de facto subscription format most clients — Happ, v2rayNG, v2rayN — expect).
Branding is conveyed via response headers rather than the link bodies
themselves (profile title, update interval, userinfo/expiry).

**Related:** default VPN key labels changed from including the user's email
to a brand-name-based label — the label is shown as the profile name inside
client apps, so it should never contain the user's email.

**Reverse proxy gotcha:** Amvera's edge terminates TLS and forwards plain
HTTP internally, so any server-generated absolute URL (like this
subscription URL) needs Express's `trust proxy` set, or it will render as
`http://` even on a public HTTPS domain. Set it to `1` (single hop), not
`true` — trusting an unbounded chain lets clients spoof `X-Forwarded-For`
and weaken IP-based logic (e.g. login rate limiting).
