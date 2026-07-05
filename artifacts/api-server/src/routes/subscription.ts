import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, subscriptionsTable, vpnKeysTable } from "@workspace/db";
import { BRAND_NAME, SUBSCRIPTION_UPDATE_INTERVAL_HOURS, verifySubscriptionToken } from "../lib/subscription";

const router: IRouter = Router();

// Public, token-authenticated endpoint consumed by VPN client apps (Happ,
// v2rayNG, v2rayN, ...) rather than by our own frontend. Clients add this URL
// once and re-fetch it on a schedule, so any config the user pastes/edits
// locally gets silently overwritten with our source of truth on next refresh —
// this is what actually protects the config, not "encryption" of the link
// itself (VLESS already runs over TLS).
router.get("/sub/:token", async (req, res): Promise<void> => {
  const userId = verifySubscriptionToken(req.params.token);
  if (!userId) {
    res.status(404).send("Not found");
    return;
  }

  const keys = await db
    .select()
    .from(vpnKeysTable)
    .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)));

  const [activeSubscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")));

  const body = Buffer.from(keys.map((key) => key.vlessLink).join("\n"), "utf8").toString("base64");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Profile-Title", `base64:${Buffer.from(BRAND_NAME, "utf8").toString("base64")}`);
  res.setHeader("Profile-Update-Interval", String(SUBSCRIPTION_UPDATE_INTERVAL_HOURS));
  if (activeSubscription?.endsAt) {
    const expireUnix = Math.floor(activeSubscription.endsAt.getTime() / 1000);
    res.setHeader("Subscription-Userinfo", `upload=0; download=0; total=0; expire=${expireUnix}`);
  }
  res.send(body);
});

export default router;
