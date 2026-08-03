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
import { buildServingVlessLink, flagEmojiForNode } from "../lib/vless";
import { getPrimaryPublicDomain, resolvePublicAddress } from "../lib/domain";
import { subscriptionRateLimit } from "../lib/rateLimit";
import {
  buildXrayClientConfig,
  isIpAddress,
  type XrayOutboundParams,
} from "../lib/xrayClientConfig";

const router: IRouter = Router();

// Public, token-authenticated endpoint consumed by VPN client apps (Happ,
// v2rayNG, v2rayN, ...) rather than by our own frontend. Clients add this URL
// once and re-fetch it on a schedule, so any config the user pastes/edits
// locally gets silently overwritten with our source of truth on next refresh —
// this is what actually protects the config, not "encryption" of the link
// itself (VLESS already runs over TLS). Rate-limited since it has no session
// auth by design — see subscriptionRateLimit for the reasoning.
//
// Supported response formats via ?format= query param:
//   (default) – Base64-encoded list of VLESS URIs (SIP008-style). Works with
//               all VLESS-compatible clients (Happ, v2rayNG, v2rayN, …).
//   "xray"    – Full Xray client JSON config with Russian-bypass routing rules.
//               Import once in Happ / v2rayN via "Import config from URL" to
//               get automatic split-tunneling for domestic Russian services.
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

    // ── Shared metadata (used by both response formats) ───────────────────────

    // Resolve the public domain once, used for the Profile-Web-Page-Url header.
    const requestHost = req.get("host") ?? "";
    const webPageAddress = await resolvePublicAddress({
      host: requestHost,
      sni: requestHost,
    });

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
    const cabinetText = `Управляйте ключами и тарифом в личном кабинете ${BRAND_NAME}`;
    let announceText = cabinetText;
    if (activePlan?.billingType === "hourly") {
      const [user] = await db
        .select({ balanceKopecks: usersTable.balanceKopecks })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      if (user) {
        const balanceRub = (user.balanceKopecks / 100).toFixed(2);
        const hoursLeft =
          activePlan.hourlyRateKopecks && activePlan.hourlyRateKopecks > 0
            ? user.balanceKopecks / activePlan.hourlyRateKopecks
            : Infinity;
        if (hoursLeft < 3) {
          announceText = `⚠️ Баланс почти исчерпан — осталось менее 3 ч работы VPN! Пополните баланс. Баланс: ${balanceRub} ₽`;
        } else if (hoursLeft < 24) {
          announceText = `⚠️ Баланс заканчивается — осталось ~${Math.floor(hoursLeft)} ч. Пополните баланс. Баланс: ${balanceRub} ₽`;
        } else {
          announceText = `Баланс: ${balanceRub} ₽. ${cabinetText}`;
        }
      }
    } else if (activeSubscription?.endsAt) {
      const msLeft = activeSubscription.endsAt.getTime() - Date.now();
      const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
      if (daysLeft <= 1) {
        announceText = `⚠️ Подписка истекает сегодня! Продлите прямо сейчас. ${cabinetText}`;
      } else if (daysLeft <= 5) {
        announceText = `⚠️ Подписка истекает через ${daysLeft} дн. Не забудьте продлить. ${cabinetText}`;
      }
    }

    // ── Common response headers (for both formats) ────────────────────────────

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

    // ── Profile-Update-Url: auto-migrate clients when primary domain changes ──
    //
    // When the admin changes primaryDomain (e.g. domain got blocked), clients
    // that still have the old URL baked in will reach us on the old host. We
    // respond with Profile-Update-Url pointing to the current primary domain so
    // compatible clients (v2rayN, v2rayNG, Happ) silently update their stored
    // subscription URL on the next refresh — zero user action required.
    //
    // This only fires when the client is already reaching us (old domain not
    // yet fully blocked at their ISP), so it covers the typical gradual-rollout
    // blocking window. Clients that can no longer reach the old host at all are
    // unaffected by this header (they never receive it), which is unavoidable.
    {
      const currentPrimaryDomain = await getPrimaryPublicDomain();
      const requestHost = req.get("host") ?? "";
      // Normalise: strip port suffix if present (e.g. "vpnexus.pro:443" → "vpnexus.pro")
      const requestHostName = requestHost.replace(/:\d+$/, "");
      if (
        currentPrimaryDomain &&
        requestHostName &&
        requestHostName !== currentPrimaryDomain
      ) {
        res.setHeader(
          "Profile-Update-Url",
          `${req.protocol}://${currentPrimaryDomain}/api/sub/${token}`,
        );
      }
    }

    // ── Format branch ─────────────────────────────────────────────────────────

    const format =
      typeof req.query.format === "string" ? req.query.format : null;

    // Optional per-device filter: ?key=<vpnKeyId>
    // When supplied together with ?format=xray, the response contains only the
    // Xray outbound for that specific key instead of all active keys. This lets
    // each device have its own subscription URL with RF-bypass routing baked in,
    // so users only need a single link per device instead of two.
    //
    // Relocation safety: if the requested key was revoked due to relocation
    // (revokedReason='user'), we fall back to the newest active key with the
    // same label — since relocation always preserves the label, the per-device
    // URL keeps working seamlessly after the user relocates to a different node.
    const keyIdParam =
      typeof req.query.key === "string" ? parseInt(req.query.key, 10) : null;

    if (format === "xray") {
      // Determine which keys to include in the Xray config.
      let xrayKeyRows = keyRows;

      if (keyIdParam !== null && !isNaN(keyIdParam)) {
        // Fast path: requested key is already in the active keyRows set.
        const directMatch = keyRows.find((r) => r.key.id === keyIdParam);

        if (directMatch) {
          xrayKeyRows = [directMatch];
        } else {
          // Slow path: key may have been relocated (revoked). Look it up by id
          // (ownership-scoped) to get its label, then find the replacement.
          const [relocatedKey] = await db
            .select({ label: vpnKeysTable.label })
            .from(vpnKeysTable)
            .where(
              and(
                eq(vpnKeysTable.id, keyIdParam),
                eq(vpnKeysTable.userId, userId),
              ),
            )
            .limit(1);

          if (relocatedKey) {
            // Find the current active key with the same label (the one that
            // replaced the relocated key). Returns empty if the user deleted
            // the key entirely — correct: no proxy in that case.
            const labelMatch = keyRows.find(
              (r) => r.key.label === relocatedKey.label,
            );
            xrayKeyRows = labelMatch ? [labelMatch] : [];
          } else {
            // Key doesn't exist or belongs to a different user — return a
            // config with no proxy so traffic goes direct (safe default).
            xrayKeyRows = [];
          }
        }
      }

      // Build Xray client JSON config with Russian-bypass routing rules.
      // Each selected key becomes a separate VLESS outbound; the first is
      // tagged "proxy" (the catch-all target), additional ones "proxy-2" etc.
      // We apply the same domain-failover logic as for plain VLESS links so
      // the primary public domain is preferred where available.
      const outboundParams: XrayOutboundParams[] = await Promise.all(
        xrayKeyRows.map(async ({ key, node }) => {
          const isLocalNode = !node.managementApiUrl;
          const resolved = isLocalNode
            ? await resolvePublicAddress({
                host: node.host || node.sni,
                sni: node.sni,
              })
            : { host: node.host || node.sni, sni: node.sni };

          const flag = flagEmojiForNode(node);
          const label = flag ? `${flag} ${key.label}` : key.label;

          return {
            uuid:       key.uuid,
            label,
            address:    resolved.host,
            sni:        resolved.sni || resolved.host,
            port:       node.port ?? 443,
            isIpNode:
              isIpAddress(resolved.host) || isIpAddress(node.sni),
            certSha256: node.certSha256 ?? null,
          };
        }),
      );

      // When the response is scoped to a single key (?key=<id>), label the
      // subscription group in Happ/v2rayN with the device name so the user
      // can clearly tell which subscription belongs to which device.
      let xrayRemarks: string | undefined;
      if (keyIdParam !== null && !isNaN(keyIdParam) && xrayKeyRows.length === 1) {
        const { key, node } = xrayKeyRows[0];
        const flag = flagEmojiForNode(node);
        const deviceLabel = flag ? `${flag} ${key.label}` : key.label;
        xrayRemarks = deviceLabel;
        // Override the Profile-Title header so the Happ subscription *group*
        // is also named after the device (e.g. "VPNexus — Смартфон Pura 80").
        res.setHeader(
          "Profile-Title",
          `base64:${Buffer.from(`${BRAND_NAME} — ${deviceLabel}`, "utf8").toString("base64")}`,
        );
      }

      const config = buildXrayClientConfig(outboundParams, { remarks: xrayRemarks });
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.json(config);
      return;
    }

    // ── Default: Base64-encoded VLESS URI list (SIP008 style) ─────────────────

    // Regenerate each link per-request so already-issued keys transparently
    // start using the primary public domain (or fall back to the technical
    // one) without needing to be re-issued.
    const vlessLinks = await Promise.all(
      keyRows.map(({ key, node }) =>
        buildServingVlessLink(node, key.uuid, key.label),
      ),
    );

    const body = Buffer.from(vlessLinks.join("\n"), "utf8").toString("base64");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(body);
  },
);

export default router;
