---
name: VPN key issuance requires a seeded vpn_nodes row
description: This project's key-issuance endpoint silently 404s with "No available VPN node found" whenever the vpn_nodes table is empty — a separate concern from DB connectivity or subscription status.
---

Issuing a VPN key requires: an active subscription AND at least one
`is_active = true` row in `vpn_nodes`. The two failure modes look similar to
users ("не удалось выпустить ключ") but have unrelated causes — always check
`select count(*) from vpn_nodes` separately from subscription/auth checks.

**Why:** the all-in-one Amvera deployment runs Xray-core in the same
container as the API, configured from `REALITY_SNI` / `REALITY_PUBLIC_KEY` /
`REALITY_SHORT_ID` env vars — but nothing auto-seeds a matching `vpn_nodes`
row pointing at itself. The app and the Xray process are wired together only
through env vars; the DB row is a manual step.

**How to apply:** for the all-in-one deployment, seed one `vpn_nodes` row
with `host` = the container's public domain, `sni`/`public_key`/`short_id`
copied verbatim from the `REALITY_*` env vars, port fixed at 443. Do this any
time a fresh environment/DB is provisioned, not just once.
