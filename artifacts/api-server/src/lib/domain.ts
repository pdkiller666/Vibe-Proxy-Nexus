/**
 * Primary/fallback public domain resolution.
 *
 * We now have two domains pointed at the same Amvera container: the pretty
 * public one (vpnexus.pro) and Amvera's own technical subdomain. The
 * technical domain must stay hidden from users by default but always keep
 * working as a safety net — if vpnexus.pro's DNS/cert/CDN ever breaks, VPN
 * clients and the subscription link must keep functioning by silently
 * falling back to the technical domain, without any user/client action.
 *
 * This is a single-edge design (one physical backend): both domains resolve
 * to the exact same server, so swapping which hostname we hand out is safe
 * as long as Amvera has both attached as custom domains with valid TLS.
 */

const DEFAULT_PRIMARY_DOMAIN = "vpnexus.pro";

export const PRIMARY_PUBLIC_DOMAIN = process.env.PRIMARY_PUBLIC_DOMAIN?.trim() || DEFAULT_PRIMARY_DOMAIN;

const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const HEALTH_CACHE_TTL_MS = 60_000;

let cachedHealthy: boolean | null = null;
let cachedAt = 0;
// Prevents a burst of concurrent requests from firing N parallel health
// checks while the cache is cold/expired — they all await the same promise.
let inFlight: Promise<boolean> | null = null;

async function checkPrimaryDomainHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${PRIMARY_PUBLIC_DOMAIN}/api/healthz`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cached, non-blocking-ish health check for the primary public domain.
 * Cached for HEALTH_CACHE_TTL_MS so we don't add a network round-trip to
 * every subscription/key request — a 60s-stale "healthy" verdict is an
 * acceptable tradeoff for keeping this fast and cheap.
 */
export async function isPrimaryDomainHealthy(): Promise<boolean> {
  const now = Date.now();
  if (cachedHealthy !== null && now - cachedAt < HEALTH_CACHE_TTL_MS) {
    return cachedHealthy;
  }
  if (!inFlight) {
    inFlight = checkPrimaryDomainHealthy().finally(() => {
      inFlight = null;
    });
  }
  cachedHealthy = await inFlight;
  cachedAt = Date.now();
  return cachedHealthy;
}

export interface DomainAddress {
  host: string;
  sni: string;
}

/**
 * Resolves which domain to hand out in a client-facing link: the primary
 * public domain if it's currently healthy, otherwise the given fallback
 * (the node's own technical Amvera host/SNI, or the request's own host as a
 * last resort). Never throws — health-check failures degrade to the
 * fallback, which is always the currently-working technical domain.
 */
export async function resolvePublicAddress(fallback: DomainAddress): Promise<DomainAddress> {
  const healthy = await isPrimaryDomainHealthy();
  if (healthy) {
    return { host: PRIMARY_PUBLIC_DOMAIN, sni: PRIMARY_PUBLIC_DOMAIN };
  }
  return fallback;
}
