import { createHmac } from "node:crypto";

export type VpnSessionLimitMode = "off" | "canary" | "all";

/**
 * `sid` is intentionally opaque and short enough to be safe in a URL query
 * parameter and as an Nginx limit_conn key. It is derived from the key UUID,
 * so refreshing a subscription never changes the active-session identity.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;

function readMode(env: NodeJS.ProcessEnv): VpnSessionLimitMode {
  const configured = env["VPN_SESSION_LIMIT_MODE"]?.trim().toLowerCase();
  if (configured === "canary" || configured === "all") return configured;
  return "off";
}

function readCanaryUuids(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env["VPN_SESSION_LIMIT_CANARY_UUIDS"] ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The default is deliberately fail-closed: no generated link gets a `sid`
 * until an operator explicitly selects canary or all-key enforcement.
 */
export function isVpnSessionLimitEnabledForUuid(
  uuid: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const mode = readMode(env);
  if (mode === "all") return true;
  return mode === "canary" && readCanaryUuids(env).has(uuid.toLowerCase());
}

/**
 * Produces the stable identity shared by every copy of a key's VLESS link.
 * The purpose-separated HMAC uses the project's already-required session
 * secret; introducing a second independently rotated secret would make an
 * existing key's session identity unstable.
 */
export function buildVpnSessionId(
  uuid: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isVpnSessionLimitEnabledForUuid(uuid, env)) return null;

  const secret = env["SESSION_SECRET"];
  if (!secret) {
    throw new Error(
      "VPN session limiting is enabled but SESSION_SECRET is missing.",
    );
  }

  return createHmac("sha256", secret)
    .update(`vpn-session-id:v1:${uuid.toLowerCase()}`)
    .digest("base64url")
    .slice(0, 32);
}

/**
 * Adds the stable session identity to a WebSocket path only for an enabled
 * key. Legacy links keep the exact `/vpnws` path and remain unrestricted.
 */
export function buildVpnWebSocketPath(
  basePath: string,
  uuid: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const sid = buildVpnSessionId(uuid, env);
  return sid ? `${basePath}?sid=${sid}` : basePath;
}

/**
 * Extracts a generated `sid` from an incoming upgrade request. Invalid or
 * absent values intentionally behave as a legacy connection, which prevents a
 * malformed client URL from being mistaken for a canary connection. This is a
 * soft-migration boundary: while legacy links remain accepted, an HTTP proxy
 * cannot distinguish a canary UUID whose holder manually removed `sid` without
 * parsing the VLESS handshake (explicitly out of scope for this rollout).
 */
export function getVpnSessionIdFromRequestUrl(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null;

  try {
    const sid = new URL(requestUrl, "http://relay.invalid").searchParams.get("sid");
    return sid && SESSION_ID_PATTERN.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

/**
 * Keeps an active-session reservation attached to the actual socket object.
 * Releasing the same socket repeatedly is safe, which matters because either
 * half of a proxied tunnel may emit both `error` and `close`.
 */
export class VpnSessionRegistry<T extends object> {
  private readonly activeBySessionId = new Map<string, Set<T>>();

  tryAcquire(sessionId: string, connection: T): boolean {
    const active = this.activeBySessionId.get(sessionId);
    if (active && active.size > 0) return false;

    this.activeBySessionId.set(sessionId, new Set([connection]));
    return true;
  }

  release(sessionId: string, connection: T): void {
    const active = this.activeBySessionId.get(sessionId);
    if (!active) return;

    active.delete(connection);
    if (active.size === 0) this.activeBySessionId.delete(sessionId);
  }

  count(sessionId: string): number {
    return this.activeBySessionId.get(sessionId)?.size ?? 0;
  }
}