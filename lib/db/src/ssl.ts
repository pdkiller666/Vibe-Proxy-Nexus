/**
 * Some managed Postgres providers (e.g. Amvera's internal CloudNativePG
 * service, reachable at a hostname like `cnpg-<cluster>-rw`) present
 * certificates signed by a private CA that isn't in the default trust store.
 *
 * With `sslmode=require` (a common default in provider-generated connection
 * strings), recent versions of `pg`/`pg-connection-string` upgrade that to
 * full certificate-chain verification instead of the old "encrypt but don't
 * verify" behavior. Against a self-signed/private-CA cert, that verification
 * fails with "self-signed certificate in certificate chain" — and because
 * this happens on every single query, the app looks completely broken (every
 * route errors, login fails, schema push fails) even though the database
 * itself is healthy and reachable.
 *
 * We still want the connection encrypted, just without strict CA
 * verification, since we're trusting the connection string itself (it
 * already carries a password) and typically connecting over a private
 * network. `sslmode=disable` is respected as-is (no TLS at all, e.g. local
 * dev Postgres).
 */
export function resolvePgConnection(databaseUrl: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
} {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get("sslmode");
  const needsSsl = sslMode !== "disable";

  url.searchParams.delete("sslmode");

  return {
    connectionString: url.toString(),
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  };
}
