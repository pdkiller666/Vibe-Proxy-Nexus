import { and, asc, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
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
      .where(and(eq(vpnNodesTable.id, preferNodeId), eq(vpnNodesTable.isActive, true), nodeHasCapacity))
      .then((rows) => rows.map((r) => r.node));

    if (!node) {
      const [exists] = await db
        .select({ id: vpnNodesTable.id })
        .from(vpnNodesTable)
        .where(and(eq(vpnNodesTable.id, preferNodeId), eq(vpnNodesTable.isActive, true)));
      return {
        ok: false,
        status: exists ? 409 : 404,
        error: exists ? "Selected VPN node has reached its user capacity" : "No available VPN node found",
      };
    }

    const [{ slotCount }] = await db
      .select({ slotCount: count() })
      .from(vpnKeysTable)
      .where(and(eq(vpnKeysTable.userId, userId), eq(vpnKeysTable.nodeId, node.id), isNull(vpnKeysTable.revokedAt)));

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
      .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)))
      .groupBy(vpnKeysTable.nodeId);

    const userCountMap = new Map(userKeyCounts.map((r) => [r.nodeId, r.cnt]));
    node = candidateNodes.find((n) => (userCountMap.get(n.id) ?? 0) < totalSlots);

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
      await addXrayClient(uuid, label);
    } catch (err) {
      logger.error({ err }, "issueKeyForUser: failed to register client with local Xray");
      return { ok: false, status: 502, error: "Failed to provision VPN key on the node" };
    }
  }

  let key: typeof vpnKeysTable.$inferSelect | undefined;
  try {
    [key] = await db
      .insert(vpnKeysTable)
      .values({ userId, nodeId: node.id, uuid, label, vlessLink, deepLink })
      .returning();
  } catch (err) {
    logger.error({ err }, "issueKeyForUser: failed to persist VPN key");
  }

  if (!key) {
    if (isLocalXrayEnabled()) {
      try {
        await removeXrayClient(uuid);
      } catch (err) {
        logger.error({ err, uuid }, "issueKeyForUser: failed to roll back orphaned Xray client");
      }
    }
    return { ok: false, status: 500, error: "Failed to issue VPN key" };
  }

  return { ok: true, key, nodeName: node.name };
}

/**
 * Resolves devicesIncluded + extraDeviceSlots for a user who has an active
 * subscription. Returns null if no active subscription exists.
 */
export async function resolveTotalSlots(
  userId: number,
  extraDeviceSlots: number,
): Promise<number | null> {
  const [activeWithPlan] = await db
    .select({ devicesIncluded: plansTable.devicesIncluded })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(
      and(
        eq(subscriptionsTable.userId, userId),
        eq(subscriptionsTable.status, "active"),
        or(isNull(subscriptionsTable.endsAt), gt(subscriptionsTable.endsAt, new Date())),
      ),
    );

  if (!activeWithPlan) return null;
  return activeWithPlan.devicesIncluded + extraDeviceSlots;
}
