import { Router, type IRouter } from "express";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import {
  BRAND_NAME,
  SUBSCRIPTION_UPDATE_INTERVAL_HOURS,
  verifySubscriptionToken,
} from "../lib/subscription";
import { buildServingVlessLink } from "../lib/vless";
import { resolvePublicAddress } from "../lib/domain";
import { subscriptionRateLimit } from "../lib/rateLimit";

const router: IRouter = Router();

// Public, token-authenticated endpoint consumed by VPN client apps (Happ,
// v2rayNG, v2rayN, ...) rather than by our own frontend. Clients add this URL
// once and re-fetch it on a schedule, so any config the user pastes/edits
// locally gets silently overwritten with our source of truth on next refresh —
// this is what actually protects the config, not "encryption" of the link
// itself (VLESS already runs over TLS). Rate-limited since it has no session
// auth by design — see subscriptionRateLimit for the reasoning.
router.get(
  "/sub/:token",
  subscriptionRateLimit,
  async (req, res): Promise<void> => {
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
          or(
            isNull(subscriptionsTable.endsAt),
            gt(subscriptionsTable.endsAt, new Date()),
          ),
        ),
      )
      .orderBy(desc(subscriptionsTable.endsAt))
      .limit(1);

    const keyRows = activeSubscription
      ? await db
          .select({ key: vpnKeysTable, node: vpnNodesTable })
          .from(vpnKeysTable)
          .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
          .where(
            and(
              eq(vpnKeysTable.userId, userId),
              isNull(vpnKeysTable.revokedAt),
            ),
          )
      : [];

    const keys = keyRows.map((row) => row.key);

    // Regenerate each link per-request so already-issued keys transparently
    // start using the primary public domain (or fall back to the technical
    // one) without needing to be re-issued.
    const vlessLinks = await Promise.all(
      keyRows.map(({ key, node }) =>
        buildServingVlessLink(node, key.uuid, key.label),
      ),
    );

    // Resolve the public domain once, used for the Profile-Web-Page-Url header.
    const requestHost = req.get("host") ?? "";
    const webPageAddress = await resolvePublicAddress({
      host: requestHost,
      sni: requestHost,
    });

    const body = Buffer.from(vlessLinks.join("\n"), "utf8").toString("base64");

    // Show the user's actual plan name in the client's subscription group title
    // (falls back to the bare brand name if there's no active plan/subscription)
    // so the user can tell at a glance which tariff is currently applied.
    const activePlan = activeSubscription?.planId
      ? (
          await db
            .select()
            .from(plansTable)
            .where(eq(plansTable.id, activeSubscription.planId))
        )[0]
      : undefined;
    const profileTitle = activePlan?.name
      ? `${BRAND_NAME} — ${activePlan.name}`
      : BRAND_NAME;

    // Hourly plans have no fixed "expire" date (see Subscription-Userinfo
    // below), so there's nothing for Happ's built-in expiry line to show.
    // Surface the user's wallet balance instead — via the Announce banner,
    // since that's the only free-text slot Happ exposes; Subscription-Userinfo
    // itself is a fixed upload/download/total/expire format Happ parses
    // strictly and can't carry arbitrary fields like a money balance.
    let announceText = `Управляйте ключами и тарифом в личном кабинете ${BRAND_NAME}`;
    if (activePlan?.billingType === "hourly") {
      const [user] = await db
        .select({ balanceKopecks: usersTable.balanceKopecks })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      if (user) {
        const balanceRub = (user.balanceKopecks / 100).toFixed(2);
        announceText = `Баланс: ${balanceRub} ₽. ${announceText}`;
      }
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Profile-Title",
      `base64:${Buffer.from(profileTitle, "utf8").toString("base64")}`,
    );
    res.setHeader(
      "Profile-Update-Interval",
      String(SUBSCRIPTION_UPDATE_INTERVAL_HOURS),
    );
    // Deep link to the user's personal cabinet, shown by Happ/v2rayNG next to
    // the subscription group. Prefers the primary public domain (vpnexus.pro)
    // when healthy, falling back to whatever host the request actually came
    // in on so it keeps working even if vpnexus.pro's DNS/cert breaks.
    res.setHeader(
      "Profile-Web-Page-Url",
      `${req.protocol}://${webPageAddress.host}/dashboard`,
    );
    // Native Happ "announcement" card: shows our text with a "Узнать больше"
    // button that opens Profile-Web-Page-Url above. This is the client's
    // built-in mechanism for surfacing the personal cabinet link — unlike the
    // fake vless entry this replaces, it can't be mistaken for a real
    // server/device since it renders as a distinct info card, not a list item.
    res.setHeader(
      "Announce",
      `base64:${Buffer.from(announceText, "utf8").toString("base64")}`,
    );
    if (activeSubscription) {
      // Report real consumption for the current billing period (not lifetime —
      // period counters reset on renewal, matching what the admin/user panels
      // show as "this period's" usage). "download" carries the client's actual
      // downstream traffic; "upload" the client's outbound. total=0 means
      // "unlimited" to Happ/v2rayNG's progress bar, so only send a nonzero cap
      // when the plan actually has one. Sent even when the subscription has no
      // endsAt (e.g. hourly plans) — omitting "expire" there is fine, but
      // omitting the whole header made the usage bar disappear entirely.
      const periodUpBytes = keys.reduce(
        (sum, key) => sum + key.periodUpBytes,
        0,
      );
      const periodDownBytes = keys.reduce(
        (sum, key) => sum + key.periodDownBytes,
        0,
      );

      const totalBytes = activePlan?.trafficLimitGb
        ? activePlan.trafficLimitGb * 1024 * 1024 * 1024
        : 0;

      const parts = [
        `upload=${periodUpBytes}`,
        `download=${periodDownBytes}`,
        `total=${totalBytes}`,
      ];
      if (activeSubscription.endsAt) {
        parts.push(
          `expire=${Math.floor(activeSubscription.endsAt.getTime() / 1000)}`,
        );
      }
      res.setHeader("Subscription-Userinfo", parts.join("; "));
    }
    res.send(body);
  },
);

export default router;
