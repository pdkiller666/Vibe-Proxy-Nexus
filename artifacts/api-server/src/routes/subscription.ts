import { Router, type IRouter } from "express";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, vpnKeysTable } from "@workspace/db";
import { BRAND_NAME, SUBSCRIPTION_UPDATE_INTERVAL_HOURS, verifySubscriptionToken } from "../lib/subscription";
import { subscriptionRateLimit } from "../lib/rateLimit";

const router: IRouter = Router();

// Public, token-authenticated endpoint consumed by VPN client apps (Happ,
// v2rayNG, v2rayN, ...) rather than by our own frontend. Clients add this URL
// once and re-fetch it on a schedule, so any config the user pastes/edits
// locally gets silently overwritten with our source of truth on next refresh —
// this is what actually protects the config, not "encryption" of the link
// itself (VLESS already runs over TLS). Rate-limited since it has no session
// auth by design — see subscriptionRateLimit for the reasoning.
router.get("/sub/:token", subscriptionRateLimit, async (req, res): Promise<void> => {
  const tokenParam = req.params.token;
  const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
  const userId = token ? verifySubscriptionToken(token) : null;
  if (!userId) {
    res.status(404).send("Not found");
    return;
  }

  // Gate the served keys on a currently-valid subscription (not just the
  // "active" status string, which can lag behind endsAt until the periodic
  // expiry sweep runs — see subscriptionLifecycle.ts). Without this check, a
  // user whose subscription lapsed keeps pulling working keys from this
  // public, token-only endpoint until the sweep catches up and revokes them.
  const [activeSubscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(
      and(
        eq(subscriptionsTable.userId, userId),
        eq(subscriptionsTable.status, "active"),
        or(isNull(subscriptionsTable.endsAt), gt(subscriptionsTable.endsAt, new Date())),
      ),
    )
    .orderBy(desc(subscriptionsTable.endsAt))
    .limit(1);

  const keys = activeSubscription
    ? await db
        .select()
        .from(vpnKeysTable)
        .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)))
    : [];

  const body = Buffer.from(keys.map((key) => key.vlessLink).join("\n"), "utf8").toString("base64");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Profile-Title", `base64:${Buffer.from(BRAND_NAME, "utf8").toString("base64")}`);
  res.setHeader("Profile-Update-Interval", String(SUBSCRIPTION_UPDATE_INTERVAL_HOURS));
  // Deep link to the user's personal cabinet, shown by Happ/v2rayNG next to
  // the subscription group. Built from the request host rather than a
  // hardcoded domain so it stays correct across the prod domain and any
  // future custom domain, without needing a config change.
  res.setHeader("Profile-Web-Page-Url", `${req.protocol}://${req.get("host")}/dashboard`);
  if (activeSubscription) {
    // Report real consumption for the current billing period (not lifetime —
    // period counters reset on renewal, matching what the admin/user panels
    // show as "this period's" usage). "download" carries the client's actual
    // downstream traffic; "upload" the client's outbound. total=0 means
    // "unlimited" to Happ/v2rayNG's progress bar, so only send a nonzero cap
    // when the plan actually has one. Sent even when the subscription has no
    // endsAt (e.g. hourly plans) — omitting "expire" there is fine, but
    // omitting the whole header made the usage bar disappear entirely.
    const periodUpBytes = keys.reduce((sum, key) => sum + key.periodUpBytes, 0);
    const periodDownBytes = keys.reduce((sum, key) => sum + key.periodDownBytes, 0);

    let totalBytes = 0;
    if (activeSubscription.planId) {
      const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, activeSubscription.planId));
      if (plan?.trafficLimitGb) {
        totalBytes = plan.trafficLimitGb * 1024 * 1024 * 1024;
      }
    }

    const parts = [`upload=${periodUpBytes}`, `download=${periodDownBytes}`, `total=${totalBytes}`];
    if (activeSubscription.endsAt) {
      parts.push(`expire=${Math.floor(activeSubscription.endsAt.getTime() / 1000)}`);
    }
    res.setHeader("Subscription-Userinfo", parts.join("; "));
  }
  res.send(body);
});

export default router;
