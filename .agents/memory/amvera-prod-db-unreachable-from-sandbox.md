---
name: Amvera production DB is not reachable from the Replit sandbox at all
description: Even with a valid PROD_DATABASE_URL secret, connecting to Amvera's managed Postgres from outside Amvera's network fails — the host is internal-only.
---

Amvera's managed PostgreSQL (CloudNativePG-backed) is issued to the app as a
`DATABASE_URL` pointing at an internal cluster-only hostname (e.g.
`cnpg-<project>-db-rw`). This resolves fine from inside the Amvera container
at runtime, but is `ENOTFOUND` from anywhere else, including Replit's agent
sandbox — it is not a public/external endpoint, no matter how correct the
credentials are.

**Why:** CloudNativePG's `-rw`/`-ro` service hostnames are ClusterIP-style
Kubernetes service names, resolvable only inside that cluster's internal DNS.
Amvera does not appear to expose a separate external hostname/port for direct
psql access to this managed DB from outside.

**How to apply:** don't spend another round asking the user for the
connection string again — a secret cannot fix a network-reachability
problem. To verify production data (e.g. this project's `vpn_keys` traffic
counters), the options are: (1) have the user check via Amvera's own
DB console/dashboard if it has a query tool, (2) go through the app's own
authenticated HTTP API/admin panel over the public domain (reachable
normally, since that's how any browser reaches it), or (3) ask the user to
run and report a value themselves. Do not assume a "give me the DB URL as a
secret" plan will work here before testing reachability once.
