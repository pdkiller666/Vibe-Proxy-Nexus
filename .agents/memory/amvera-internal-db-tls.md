---
name: Amvera internal DB TLS verification breaks every query
description: CloudNativePG-style internal Postgres hosts (e.g. cnpg-<cluster>-rw) use self-signed certs; sslmode=require in the connection string now triggers full cert verification and fails silently on every query.
---

On Amvera (and similar CloudNativePG-backed managed Postgres), the app's
`DATABASE_URL` often points at an internal service hostname like
`cnpg-<cluster>-rw`. That instance presents a self-signed / private-CA
certificate.

Recent `pg` / `pg-connection-string` versions upgrade `sslmode=require` (and
`prefer`, `verify-ca`) to full certificate-chain verification instead of the
old "encrypt but don't verify" behavior. Against a self-signed cert this
fails, and because it fails identically for *every* query, the symptom looks
like the whole app is broken: login fails, every list endpoint 500s, generic
"Failed query" in logs with no "relation does not exist" or other specific
cause — easy to misdiagnose as a missing schema/table problem instead.

**Why:** the pg client rejects the TLS handshake before the query even runs,
so every route touching the DB fails the same generic way.

**How to apply:** when a query fails with an opaque error against a managed
Postgres reachable only via an internal hostname, suspect TLS verification
before suspecting schema/data. Fix by parsing the connection string, treating
any `sslmode` other than `disable` as "encrypt, but don't verify"
(`ssl: { rejectUnauthorized: false }`), and stripping `sslmode` from the
connection string itself so it doesn't fight with the explicit `ssl` option.
Apply the same fix to both the runtime `pg.Pool` and any `drizzle-kit`
config used for schema push — both hit the same cert wall independently.

**Also applies to `heal-schema.mjs`:** it uses a bare `pg.Client` with
`connectionString: DATABASE_URL`. Passing the raw URL with `sslmode=require`
still present causes pg to override `rejectUnauthorized: false` — the
sslmode in the URL wins over the `ssl:{}` object. Fix: parse the URL,
delete `sslmode` from searchParams, pass `parsedUrl.toString()` as the
connection string, and set `ssl: { rejectUnauthorized: false }` separately.
This mirrors `lib/db/src/ssl.ts::resolvePgConnection()` exactly.
