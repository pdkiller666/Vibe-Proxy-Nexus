/**
 * Primary/fallback public domain resolution.
 *
 * We now have two domains pointed at the same Amvera container: the pretty
 * public one (admin-configurable, defaults to vpnexus.pro) and Amvera's own
 * technical subdomain. The technical domain must stay hidden from users by
 * default but always keep working as a safety net — if the public domain's
 * DNS/cert/CDN ever breaks (or it gets blocked and the admin hasn't had time
 * to change it yet), VPN clients and the subscription link must keep
 * functioning by silently falling back to the technical domain, without any
 * user/client action.
 *
 * This is a single-edge design (one physical backend): both domains resolve
 * to the exact same server, so swapping which hostname we hand out is safe
 * as long as Amvera has both attached as custom domains with valid TLS.
 */

import { db, paymentSettingsTable } from "@workspace/db";

const DEFAULT_PRIMARY_DOMAIN = "vpnexus.pro";

const SETTINGS_CACHE_TTL_MS = 15_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const HEALTH_CACHE_TTL_MS = 60_000;

let cachedDomain: string = DEFAULT_PRIMARY_DOMAIN;
let cachedDomainAt = 0;
let domainInFlight: Promise<string> | null = null;

async function fetchPrimaryDomainFromSettings(): Promise<string> {
  try {
    const [settings] = await db.select({ primaryDomain: paymentSettingsTable.primaryDomain }).from(paymentSettingsTable).limit(1);
    return settings?.primaryDomain?.trim() || process.env.PRIMARY_PUBLIC_DOMAIN?.trim() || DEFAULT_PRIMARY_DOMAIN;
  } catch {
    // DB hiccup: keep using whatever we last resolved rather than blocking
    // link generation on it.
    return cachedDomain;
  }
}

/**
 * The current primary public domain, admin-editable via payment settings
 * (falls back to PRIMARY_PUBLIC_DOMAIN env var, then the hardcoded default).
 * Cached for SETTINGS_CACHE_TTL_MS so an admin edit takes effect within ~15s
 * without adding a DB round-trip to every request.
 */
export async function getPrimaryPublicDomain(): Promise<string> {
  const now = Date.now();
  if (now - cachedDomainAt < SETTINGS_CACHE_TTL_MS) {
    return cachedDomain;
  }
  if (!domainInFlight) {
    domainInFlight = fetchPrimaryDomainFromSettings().finally(() => {
      domainInFlight = null;
    });
  }
  cachedDomain = await domainInFlight;
  cachedDomainAt = Date.now();
  return cachedDomain;
}

let cachedHealthy: boolean | null = null;
let cachedHealthyDomain = "";
let cachedAt = 0;
// Prevents a burst of concurrent requests from firing N parallel health
// checks while the cache is cold/expired — they all await the same promise.
let inFlight: Promise<boolean> | null = null;

async function checkDomainHealthy(domain: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${domain}/api/healthz`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cached health check for the primary public domain. Cached for
 * HEALTH_CACHE_TTL_MS so we don't add a network round-trip to every
 * subscription/key request — a 60s-stale "healthy" verdict is an acceptable
 * tradeoff for keeping this fast and cheap. Cache is invalidated
 * automatically if the configured domain changes.
 */
export async function isPrimaryDomainHealthy(): Promise<boolean> {
  const domain = await getPrimaryPublicDomain();
  const now = Date.now();
  if (cachedHealthy !== null && domain === cachedHealthyDomain && now - cachedAt < HEALTH_CACHE_TTL_MS) {
    return cachedHealthy;
  }
  if (!inFlight) {
    inFlight = checkDomainHealthy(domain).finally(() => {
      inFlight = null;
    });
  }
  cachedHealthy = await inFlight;
  cachedHealthyDomain = domain;
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
  const [domain, healthy] = await Promise.all([getPrimaryPublicDomain(), isPrimaryDomainHealthy()]);
  if (healthy) {
    return { host: domain, sni: domain };
  }
  return fallback;
}
