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

  // Atomic slot-check + DB insert, serialized by pessimistic row locks.
  //
  // Both the user's subscription (per-user slot limit) and the target node
  // (capacity) are locked FOR UPDATE so that concurrent calls for the same
  // user or node block here until we commit — eliminating the TOCTOU between
  // the outer checks above and the INSERT below.
  //
  // Xray provisioning runs after the commit so the DB lock is held as briefly
  // as possible. If Xray fails we immediately mark the committed key revoked;
  // that leaves the DB as the authoritative source of truth (key non-existent
  // from the user's perspective) rather than an orphaned Xray client.
  // eslint-disable-next-line prefer-const
  let key!: typeof vpnKeysTable.$inferSelect;
  try {
    key = await db.transaction(async (tx) => {
      // Lock the user's active subscription to serialize concurrent issuance
      // for this user. Any concurrent issueKeyForUser for the same user will
      // block at this point until we commit, so its subsequent count query
      // reflects our already-inserted key.
      await tx.execute(
        sql`SELECT id FROM subscriptions WHERE user_id = ${userId} AND status = 'active' LIMIT 1 FOR UPDATE`,
      );

      // Re-count inside the lock — the safe, authoritative slot count.
      const [{ slotCount }] = await tx
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
        throw Object.assign(new Error("SLOTS_EXCEEDED"), { slotCount, totalSlots });
      }

      // Lock the node row to serialize capacity checks across concurrent callers.
      await tx.execute(sql`SELECT id FROM vpn_nodes WHERE id = ${node.id} FOR UPDATE`);

      // Re-count node capacity inside the lock (only when there is a limit).
      if (node.maxUsers !== null) {
        const [{ nodeCount }] = await tx
          .select({ nodeCount: count() })
          .from(vpnKeysTable)
          .where(and(eq(vpnKeysTable.nodeId, node.id), isNull(vpnKeysTable.revokedAt)));
        if (nodeCount >= node.maxUsers) throw new Error("NODE_FULL");
      }

      const [row] = await tx
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
      if (!row) throw new Error("INSERT_FAILED");
      return row;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "SLOTS_EXCEEDED") {
      const e = err as Error & { slotCount: number; totalSlots: number };
      return {
        ok: false,
        status: 409,
        error: `Все слоты устройств заняты (${e.slotCount} из ${e.totalSlots}). Обратитесь к администратору для расширения.`,
      };
    }
    if (err instanceof Error && err.message === "NODE_FULL") {
      return { ok: false, status: 409, error: "Selected VPN node has reached its user capacity" };
    }
    logger.error({ err }, "issueKeyForUser: failed to persist VPN key");
    return { ok: false, status: 500, error: "Failed to issue VPN key" };
  }

  // Provision the Xray client after committing — lock released before the
  // network call. Failure: immediately revoke the DB row (compensating write)
  // so the user never sees a "working" key that can't actually connect.
  if (isLocalXrayEnabled()) {
    try {
      // Use UUID (not label) as the Xray "email" tag — labels can collide
      // across users and corrupt Xray's per-user dedup and traffic attribution.
      await addXrayClient(uuid, uuid);
    } catch (err) {
      logger.error({ err }, "issueKeyForUser: Xray provisioning failed; revoking committed DB key");
      try {
        await db
          .update(vpnKeysTable)
          .set({ revokedAt: new Date(), revokedReason: "admin" })
          .where(eq(vpnKeysTable.id, key.id));
      } catch (dbErr) {
        logger.error({ dbErr, uuid }, "issueKeyForUser: DB revoke also failed — orphaned key in DB");
      }
      return { ok: false, status: 502, error: "Failed to provision VPN key on the node" };
    }
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
 * True when the user's active subscription has been flagged by
 * enforceTrafficLimits() as having exceeded its traffic cap for the current
 * period (see subscriptions.trafficLimitExceededAt schema comment).
 *
 * Callers must check this before issuing a brand new key: without it, a user
 * whose keys were just revoked for exceeding the limit could free up a
 * device slot and issue a fresh key (which starts at 0 period bytes),
 * silently bypassing the cap until the new key alone re-exceeds it.
 */
export async function isTrafficLimitBlocked(userId: number): Promise<boolean> {
  const [activeSub] = await db
    .select({ trafficLimitExceededAt: subscriptionsTable.trafficLimitExceededAt })
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  return Boolean(activeSub?.trafficLimitExceededAt);
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
