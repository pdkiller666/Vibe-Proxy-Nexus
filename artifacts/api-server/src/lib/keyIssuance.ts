import { and, asc, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  db,
  plansTable,
  subscriptionsTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { buildDeepLink, buildVlessLink, generateKeyUuid } from "./vless";
import { addXrayClient, isLocalXrayEnabled, removeXrayClient } from "./xray";
import { BRAND_NAME } from "./subscription";
import { logger } from "./logger";

export type IssueKeyResult =
  | { ok: true; key: typeof vpnKeysTable.$inferSelect; nodeName: string }
  | { ok: false; status: number; error: string };

/**
 * Core key-issuance logic shared between the user-facing POST /vpn-keys route
 * and the automatic key created on registration.
 *
 * @param userId        - The user to issue the key for.
 * @param totalSlots    - devicesIncluded + extraDeviceSlots for this user.
 * @param preferNodeId  - Optional explicit node id (undefined → auto-select).
 * @param preferLabel   - Optional label override (undefined → branded default).
 */
export async function issueKeyForUser(
  userId: number,
  totalSlots: number,
  preferNodeId?: number,
  preferLabel?: string,
  description?: string,
): Promise<IssueKeyResult> {
  const activeCounts = db
    .select({
      nodeId: vpnKeysTable.nodeId,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(vpnKeysTable)
    .where(isNull(vpnKeysTable.revokedAt))
    .groupBy(vpnKeysTable.nodeId)
    .as("active_counts");

  const nodeHasCapacity = or(
    isNull(vpnNodesTable.maxUsers),
    sql`coalesce(${activeCounts.count}, 0) < ${vpnNodesTable.maxUsers}`,
  );

  let node: typeof vpnNodesTable.$inferSelect | undefined;

  if (preferNodeId !== undefined) {
    [node] = await db
      .select({ node: vpnNodesTable })
      .from(vpnNodesTable)
      .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
      .where(
        and(
          eq(vpnNodesTable.id, preferNodeId),
          eq(vpnNodesTable.isActive, true),
          nodeHasCapacity,
        ),
      )
      .then((rows) => rows.map((r) => r.node));

    if (!node) {
      const [exists] = await db
        .select({ id: vpnNodesTable.id })
        .from(vpnNodesTable)
        .where(
          and(
            eq(vpnNodesTable.id, preferNodeId),
            eq(vpnNodesTable.isActive, true),
          ),
        );
      return {
        ok: false,
        status: exists ? 409 : 404,
        error: exists
          ? "Selected VPN node has reached its user capacity"
          : "No available VPN node found",
      };
    }

    const [{ slotCount }] = await db
      .select({ slotCount: count() })
      .from(vpnKeysTable)
      .where(
        and(
          eq(vpnKeysTable.userId, userId),
          eq(vpnKeysTable.nodeId, node.id),
          isNull(vpnKeysTable.revokedAt),
        ),
      );

    if (slotCount >= totalSlots) {
      return {
        ok: false,
        status: 409,
        error: `Все слоты устройств заняты (${slotCount} из ${totalSlots}). Обратитесь к администратору для расширения.`,
      };
    }
  } else {
    const candidateNodes = await db
      .select({ node: vpnNodesTable })
      .from(vpnNodesTable)
      .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
      .where(and(eq(vpnNodesTable.isActive, true), nodeHasCapacity))
      .orderBy(asc(vpnNodesTable.id))
      .then((rows) => rows.map((r) => r.node));

    if (candidateNodes.length === 0) {
      return { ok: false, status: 404, error: "No available VPN node found" };
    }

    const userKeyCounts = await db
      .select({ nodeId: vpnKeysTable.nodeId, cnt: count() })
      .from(vpnKeysTable)
      .where(
        and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)),
      )
      .groupBy(vpnKeysTable.nodeId);

    const userCountMap = new Map(userKeyCounts.map((r) => [r.nodeId, r.cnt]));
    node = candidateNodes.find(
      (n) => (userCountMap.get(n.id) ?? 0) < totalSlots,
    );

    if (!node) {
      return {
        ok: false,
        status: 409,
        error: `Все слоты устройств заняты (${totalSlots} из ${totalSlots}). Обратитесь к администратору для расширения.`,
      };
    }
  }

  const uuid = generateKeyUuid();
  const label = preferLabel?.trim() || `${BRAND_NAME} — ${node.name}`;
  const vlessLink = buildVlessLink(node, uuid, label);
  const deepLink = buildDeepLink(vlessLink);

  if (isLocalXrayEnabled()) {
    try {
      // Use the key's UUID (not the display label) as the Xray client
      // "email" — labels are user-chosen/branded text and can collide across
      // keys or users, which would both corrupt Xray's per-user config
      // dedup-by-email logic and misattribute traffic stats. The UUID is
      // guaranteed unique per key.
      await addXrayClient(uuid, uuid);
    } catch (err) {
      logger.error(
        { err },
        "issueKeyForUser: failed to register client with local Xray",
      );
      return {
        ok: false,
        status: 502,
        error: "Failed to provision VPN key on the node",
      };
    }
  }

  let key: typeof vpnKeysTable.$inferSelect | undefined;
  try {
    [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId: node.id,
        uuid,
        label,
        description: description?.trim() || null,
        vlessLink,
        deepLink,
      })
      .returning();
  } catch (err) {
    logger.error({ err }, "issueKeyForUser: failed to persist VPN key");
  }

  if (!key) {
    if (isLocalXrayEnabled()) {
      try {
        await removeXrayClient(uuid);
      } catch (err) {
        logger.error(
          { err, uuid },
          "issueKeyForUser: failed to roll back orphaned Xray client",
        );
      }
    }
    return { ok: false, status: 500, error: "Failed to issue VPN key" };
  }

  return { ok: true, key, nodeName: node.name };
}

/**
 * Resolves devicesIncluded + extraDeviceSlots for a user who has an active
 * subscription. extraDeviceSlots lives on the subscription row itself (see
 * schema comment) — a user with no active subscription has no slots at all,
 * including any they previously purchased under an expired/switched
 * subscription. Returns null if no active subscription exists.
 */
export async function resolveTotalSlots(
  userId: number,
): Promise<number | null> {
  const [activeWithPlan] = await db
    .select({
      devicesIncluded: plansTable.devicesIncluded,
      extraDeviceSlots: subscriptionsTable.extraDeviceSlots,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
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
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  if (!activeWithPlan) return null;
  return activeWithPlan.devicesIncluded + activeWithPlan.extraDeviceSlots;
}

/**
 * Guarantees a just-activated subscriber has at least one usable VPN key —
 * the same guarantee registration gives trial users via the auto-issue in
 * auth.ts. Without this, a user whose trial key was revoked (e.g. by the
 * grace-period sweep in subscriptionLifecycle.ts) while their manual-payment
 * confirmation was pending ends up with an active paid subscription and zero
 * keys, forced to figure out "Добавить устройство" on their own.
 *
 * No-ops if the user already has any non-revoked key (covers the common case
 * of renewing/switching plans without ever losing the trial key) or if slot
 * resolution / issuance fails — this runs after the payment is already
 * confirmed, so a key-issuance hiccup must never surface as a payment error.
 */
export async function ensureActiveKeyForUser(userId: number): Promise<void> {
  try {
    const [{ activeKeyCount }] = await db
      .select({ activeKeyCount: count() })
      .from(vpnKeysTable)
      .where(
        and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)),
      );

    if (activeKeyCount > 0) return;

    const totalSlots = await resolveTotalSlots(userId);
    if (totalSlots === null || totalSlots <= 0) return;

    const result = await issueKeyForUser(userId, totalSlots);
    if (result.ok) {
      logger.info(
        { userId, keyId: result.key.id },
        "Auto-issued VPN key after subscription activation (user had none)",
      );
    } else {
      logger.warn(
        { userId, error: result.error },
        "Could not auto-issue VPN key after subscription activation",
      );
    }
  } catch (err) {
    logger.error({ err, userId }, "ensureActiveKeyForUser failed");
  }
}
