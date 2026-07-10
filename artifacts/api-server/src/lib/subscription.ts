import { createHmac, timingSafeEqual } from "node:crypto";
import { getSessionSecret } from "./session";
import { resolvePublicAddress } from "./domain";

/**
 * Human/brand-facing name shown as the subscription group title in client
 * apps (Happ, v2rayNG, v2rayN, etc). Keeping this in one place means every
 * issued key and the subscription itself stay consistently branded.
 */
export const BRAND_NAME = "VPNexus";

/**
 * How often (in hours) client apps should auto-refresh the subscription.
 * Advertised via the `profile-update-interval` header, the same convention
 * used by commercial VLESS subscription providers.
 */
export const SUBSCRIPTION_UPDATE_INTERVAL_HOURS = 3;

/**
 * Subscription tokens are stateless and HMAC-signed (userId.signature)
 * instead of a random value stored in the database. This keeps them stable
 * across restarts and deploys without requiring a schema migration, while
 * still being unforgeable without the session secret: nobody can mint a
 * working subscription URL for another user's keys, and nobody can tamper
 * with the userId portion without invalidating the signature.
 */
function sign(userId: number): string {
  return createHmac("sha256", getSessionSecret()).update(String(userId)).digest("hex").slice(0, 32);
}

export function buildSubscriptionToken(userId: number): string {
  return `${userId}.${sign(userId)}`;
}

export function verifySubscriptionToken(token: string): number | null {
  const [userIdPart, signaturePart] = token.split(".");
  if (!userIdPart || !signaturePart) return null;

  const userId = Number(userIdPart);
  if (!Number.isInteger(userId) || userId <= 0) return null;

  const expected = sign(userId);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signaturePart, "utf8");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }

  return userId;
}

/**
 * Builds the self-updating subscription URL. Prefers the primary public
 * domain (vpnexus.pro) when it's healthy, so users never see the technical
 * Amvera hostname; falls back to whatever host the request actually came in
 * on (which keeps working even if vpnexus.pro's DNS/cert breaks, since the
 * request reaching us at all proves that host currently resolves).
 */
export async function buildSubscriptionUrl(
  req: { protocol: string; get(name: string): string | undefined },
  userId: number,
): Promise<string> {
  const token = buildSubscriptionToken(userId);
  const requestHost = req.get("host") ?? "";
  const address = await resolvePublicAddress({ host: requestHost, sni: requestHost });
  return `${req.protocol}://${address.host}/api/sub/${token}`;
}
