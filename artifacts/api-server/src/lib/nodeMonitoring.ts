/**
 * Background job that periodically checks the health and resource usage of all
 * active VPN nodes and writes SystemEvents when something is wrong.
 *
 * Alert / action types:
 *  - "node_overloaded"   — CPU > 90% or RAM > 90% on a single poll
 *  - "node_unreachable"  — node failed to respond 3 polls in a row
 *                          → isActive is set to false and all active keys on
 *                            that node are migrated to other nodes automatically
 *  - "node_recovered"    — a previously auto-deactivated node came back up
 *                          → isActive is restored to true
 *
 * "node_overloaded" is deduplicated: a new event is only inserted when there is
 * no existing unacknowledged event of the same type for the same node.
 *
 * "node_unreachable" is emitted once on deactivation. Because the node is then
 * set to isActive=false it drops out of the active-node query on the next cycle,
 * so no redundant events are produced. Inactive nodes with consecutiveFailures > 0
 * (auto-deactivated, not manually disabled) are still probed every cycle so we
 * can detect recovery.
 *
 * Recovery: once a node responds successfully after being auto-deactivated, a
 * "node_recovered" event is written and isActive is restored to true. The
 * consecutiveFailures counter is reset to 0 on any successful poll.
 */

import { and, asc, eq, gt, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db, jobsDb, systemEventsTable, vpnKeysTable, vpnNodesTable, nodeMetricSnapshotsTable } from "@workspace/db";
import { logger } from "./logger";
import { issueKeyForUser, resolveTotalSlots } from "./keyIssuance";
import { removeXrayClient, isLocalXrayEnabled } from "./xray";
import { removeRemoteXrayClient } from "./remoteNode";
import { getLocalSystemStatus, type SystemStatus } from "./sysStatus";

const NODE_MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const CPU_THRESHOLD_PERCENT = 90;
const RAM_THRESHOLD_PERCENT = 90;
const FAILURE_ALERT_THRESHOLD = 3;

// ─── Metric snapshot helpers (shared with vpnNodes route) ─────────────────────
// Write at most one snapshot per 5 minutes per node to keep the table size sane.
const METRIC_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const lastMetricWrite = new Map<number, number>(); // nodeId → lastWriteTimestamp

export async function maybeRecordMetricSnapshot(
  nodeId: number,
  status: { cpuPercent: number; ramUsedBytes: number; ramTotalBytes: number; diskUsedBytes: number; diskTotalBytes: number },
): Promise<void> {
  const now = Date.now();
  const last = lastMetricWrite.get(nodeId) ?? 0;
  if (now - last < METRIC_WRITE_INTERVAL_MS) return;
  lastMetricWrite.set(nodeId, now);

  const ramPercent = status.ramTotalBytes > 0
    ? Math.round((status.ramUsedBytes / status.ramTotalBytes) * 100)
    : 0;
  const diskPercent = status.diskTotalBytes > 0
    ? Math.round((status.diskUsedBytes / status.diskTotalBytes) * 100)
    : 0;

  try {
    await db.insert(nodeMetricSnapshotsTable).values({
      nodeId,
      cpuPercent: Math.round(Math.min(100, Math.max(0, status.cpuPercent))),
      ramPercent: Math.min(100, Math.max(0, ramPercent)),
      diskPercent: Math.min(100, Math.max(0, diskPercent)),
    });
  } catch (err) {
    // Non-fatal: chart data is best-effort.
    logger.warn({ err, nodeId }, "node metrics: failed to write snapshot (ignored)");
  }
}

// ─── Status fetchers ──────────────────────────────────────────────────────────

async function fetchRemoteSystemStatus(
  managementApiUrl: string,
  managementApiSecret: string | null,
): Promise<SystemStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (managementApiSecret) headers["X-Management-Secret"] = managementApiSecret;

  try {
    const r = await fetch(`${managementApiUrl}/system/status`, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as SystemStatus;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─── Event helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if there is already an unacknowledged system_event of the
 * given type for this node, so we can skip redundant inserts.
 */
async function hasUnacknowledgedEvent(eventType: string, nodeId: number): Promise<boolean> {
  const rows = await jobsDb
    .select({ id: systemEventsTable.id })
    .from(systemEventsTable)
    .where(
      and(
        eq(systemEventsTable.eventType, eventType),
        isNull(systemEventsTable.acknowledgedAt),
        sql`${systemEventsTable.metadata} @> ${JSON.stringify({ nodeId })}::jsonb`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function emitEvent(
  eventType: string,
  nodeId: number,
  nodeName: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await jobsDb.insert(systemEventsTable).values({
    eventType,
    metadata: { nodeId, nodeName, ...extra },
  });
  logger.info({ eventType, nodeId, nodeName, ...extra }, `nodeMonitoring: emitted ${eventType}`);
}

// ─── Key migration ────────────────────────────────────────────────────────────

/**
 * Finish replacement operations whose new key was provisioned but whose
 * source-key revoke did not commit. The relationship lives on the replacement
 * row, so this works after a restart and does not depend on a process-local
 * queue.
 */
export async function reconcilePendingKeyReplacements(): Promise<void> {
  const replacements = await db
    .select()
    .from(vpnKeysTable)
    .where(
      and(
        isNull(vpnKeysTable.revokedAt),
        isNotNull(vpnKeysTable.provisionedAt),
        isNotNull(vpnKeysTable.replacesKeyId),
      ),
    );

  for (const replacement of replacements) {
    if (replacement.replacesKeyId === null) continue;

    const [source] = await db
      .select({ key: vpnKeysTable, node: vpnNodesTable })
      .from(vpnKeysTable)
      .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
      .where(
        and(
          eq(vpnKeysTable.id, replacement.replacesKeyId),
          eq(vpnKeysTable.userId, replacement.userId),
        ),
      );

    if (!source || source.key.revokedAt) continue;

    const [revoked] = await db
      .update(vpnKeysTable)
      .set({ revokedAt: new Date(), revokedReason: "admin" })
      .where(
        and(
          eq(vpnKeysTable.id, source.key.id),
          isNull(vpnKeysTable.revokedAt),
        ),
      )
      .returning({ id: vpnKeysTable.id });

    if (!revoked) continue;

    logger.warn(
      {
        oldKeyId: source.key.id,
        newKeyId: replacement.id,
        oldNodeId: source.key.nodeId,
        newNodeId: replacement.nodeId,
      },
      "nodeMonitoring: reconciled pending key replacement and revoked old key",
    );

    if (source.node.managementApiUrl) {
      try {
        await removeRemoteXrayClient(source.node, source.key.uuid);
      } catch (err) {
        logger.warn(
          { err, uuid: source.key.uuid, nodeId: source.key.nodeId },
          "nodeMonitoring: reconciled key DB revoke but old remote Xray removal failed",
        );
      }
    } else if (isLocalXrayEnabled()) {
      try {
        await removeXrayClient(source.key.uuid);
      } catch (err) {
        logger.warn(
          { err, uuid: source.key.uuid, nodeId: source.key.nodeId },
          "nodeMonitoring: reconciled key DB revoke but old local Xray removal failed",
        );
      }
    }
  }
}

/**
 * When a node is auto-deactivated, migrate all its active VPN keys to other
 * healthy nodes so affected users regain connectivity without admin intervention.
 *
 * Strategy mirrors the manual node-deletion flow in admin/vpnNodes.ts:
 *   1. Issue a replacement key on the least-loaded same-region node (or global
 *      fallback if no same-region capacity exists).
 *   2. Revoke the old key in the DB first, then remove from Xray (non-fatal if
 *      Xray on the dead node is unreachable — it's down anyway).
 */
async function migrateKeysFromDeactivatedNode(node: {
  id: number;
  name: string;
  region: string;
  managementApiUrl: string | null;
  managementApiSecret: string | null;
}): Promise<void> {
  const activeKeys = await db
    .select()
    .from(vpnKeysTable)
    .where(and(eq(vpnKeysTable.nodeId, node.id), isNull(vpnKeysTable.revokedAt)));

  if (activeKeys.length === 0) {
    logger.info({ nodeId: node.id, nodeName: node.name }, "nodeMonitoring: no active keys to migrate");
    return;
  }

  logger.info(
    { nodeId: node.id, nodeName: node.name, keyCount: activeKeys.length },
    "nodeMonitoring: migrating active keys from deactivated node",
  );

  // Pre-resolve slot limits for all affected users to avoid N+1 in the loop.
  const uniqueUserIds = [...new Set(activeKeys.map((k) => k.userId))];
  const slotsEntries = await Promise.all(
    uniqueUserIds.map(async (uid) => [uid, await resolveTotalSlots(uid)] as const),
  );
  const slotsMap = new Map<number, number | null>(slotsEntries);

  // Subquery: active key count per node — used for capacity checks and ordering.
  const activeCounts = db
    .select({ nodeId: vpnKeysTable.nodeId, cnt: sql<number>`count(*)::int`.as("cnt") })
    .from(vpnKeysTable)
    .where(isNull(vpnKeysTable.revokedAt))
    .groupBy(vpnKeysTable.nodeId)
    .as("active_counts");

  const nodeHasCapacity = or(
    isNull(vpnNodesTable.maxUsers),
    sql`coalesce(${activeCounts.cnt}, 0) < ${vpnNodesTable.maxUsers}`,
  );

  let migratedKeys = 0;
  let failedMigrations = 0;

  await Promise.all(
    activeKeys.map(async (key) => {
      const totalSlots = slotsMap.get(key.userId) ?? null;

      if (totalSlots === null) {
        failedMigrations++;
        logger.warn(
          { userId: key.userId, keyId: key.id },
          "nodeMonitoring: no active subscription, key left without migration",
        );
        return;
      }

      // Prefer the least-loaded active node in the same region (excluding this node).
      const [sameRegionNode] = await db
        .select({ id: vpnNodesTable.id })
        .from(vpnNodesTable)
        .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
        .where(
          and(
            eq(vpnNodesTable.isActive, true),
            eq(vpnNodesTable.region, node.region),
            ne(vpnNodesTable.id, node.id),
            nodeHasCapacity,
          ),
        )
        .orderBy(asc(sql`coalesce(${activeCounts.cnt}, 0)`))
        .limit(1);

      // Attempt 1: same-region preferred node.
      let result = await issueKeyForUser(
        key.userId,
        totalSlots,
        sameRegionNode?.id,
        key.label,
        key.description ?? undefined,
        undefined,
        key.id,
      );

      // Attempt 2: same-region failed → let auto-select pick globally.
      if (!result.ok && sameRegionNode?.id !== undefined) {
        result = await issueKeyForUser(
          key.userId,
          totalSlots,
          undefined,
          key.label,
          key.description ?? undefined,
          undefined,
          key.id,
        );
      }

      if (!result.ok) {
        failedMigrations++;
        logger.warn(
          { userId: key.userId, keyId: key.id, error: result.error },
          "nodeMonitoring: no available node for key migration",
        );
        return;
      }

      // Revoke old key: DB-first (source of truth), then Xray (non-fatal — node is down).
      try {
        await db
          .update(vpnKeysTable)
          .set({ revokedAt: new Date(), revokedReason: "admin" })
          .where(eq(vpnKeysTable.id, key.id));
      } catch (err) {
        logger.error(
          { err, oldKeyId: key.id, newKeyId: result.key.id },
          "nodeMonitoring: new key issued but old key DB revoke failed",
        );
      }

      // Best-effort Xray cleanup (node may be down — that's fine).
      if (node.managementApiUrl) {
        try {
          await removeRemoteXrayClient(node, key.uuid);
        } catch (err) {
          logger.warn({ err, uuid: key.uuid, nodeId: node.id }, "nodeMonitoring: remote Xray removal failed (ignored, node is down)");
        }
      } else if (isLocalXrayEnabled()) {
        try {
          await removeXrayClient(key.uuid);
        } catch (err) {
          logger.warn({ err, uuid: key.uuid, nodeId: node.id }, "nodeMonitoring: local Xray removal failed (ignored)");
        }
      }

      migratedKeys++;
      logger.info(
        {
          userId: key.userId,
          oldKeyId: key.id,
          newKeyId: result.key.id,
          newNodeId: result.key.nodeId,
          newNodeName: result.nodeName,
        },
        "nodeMonitoring: key migrated to new node",
      );

      // Emit a user-facing notification so the user sees the migration in their dashboard.
      try {
        await db.insert(systemEventsTable).values({
          eventType: "key_migrated",
          userId: key.userId,
          metadata: {
            oldNodeName: node.name,
            oldNodeId: node.id,
            newNodeName: result.nodeName,
            newNodeId: result.key.nodeId,
            oldKeyId: key.id,
            newKeyId: result.key.id,
          },
        });
      } catch (err) {
        logger.warn({ err, userId: key.userId }, "nodeMonitoring: failed to emit key_migrated notification (ignored)");
      }
    }),
  );

  logger.info(
    { nodeId: node.id, nodeName: node.name, migratedKeys, failedMigrations },
    "nodeMonitoring: key migration complete",
  );
}

// ─── Per-node poll logic ──────────────────────────────────────────────────────

async function pollNode(node: {
  id: number;
  name: string;
  region: string;
  isActive: boolean;
  consecutiveFailures: number;
  managementApiUrl: string | null;
  managementApiSecret: string | null;
}): Promise<void> {
  let status: SystemStatus;

  try {
    if (node.managementApiUrl) {
      status = await fetchRemoteSystemStatus(node.managementApiUrl, node.managementApiSecret);
    } else {
      status = await getLocalSystemStatus();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // Persist the incremented counter to DB and read back the new value.
    const [updated] = await jobsDb
      .update(vpnNodesTable)
      .set({ consecutiveFailures: sql`${vpnNodesTable.consecutiveFailures} + 1` })
      .where(eq(vpnNodesTable.id, node.id))
      .returning({ consecutiveFailures: vpnNodesTable.consecutiveFailures });

    const failures = updated?.consecutiveFailures ?? node.consecutiveFailures + 1;

    logger.warn(
      { nodeId: node.id, nodeName: node.name, failures, err: msg },
      "nodeMonitoring: node poll failed",
    );

    // Only act on active nodes that just crossed the threshold.
    if (failures >= FAILURE_ALERT_THRESHOLD && node.isActive) {
      // Deactivate the node in the DB.
      await jobsDb
        .update(vpnNodesTable)
        .set({ isActive: false })
        .where(eq(vpnNodesTable.id, node.id));

      logger.warn(
        { nodeId: node.id, nodeName: node.name, failures },
        "nodeMonitoring: node auto-deactivated after consecutive failures",
      );

      // Emit the unreachable event (deduplication not needed — once deactivated
      // the node leaves the active-node query, so this fires at most once per
      // outage cycle until the node recovers and fails again).
      await emitEvent("node_unreachable", node.id, node.name, {
        consecutiveFailures: failures,
        lastError: msg,
      });

      // Migrate all active keys to healthy nodes so users regain connectivity.
      await migrateKeysFromDeactivatedNode(node);
    }

    return;
  }

  // ── Successful poll ────────────────────────────────────────────────────────

  // Reset the persistent failure counter.
  await jobsDb
    .update(vpnNodesTable)
    .set({ consecutiveFailures: 0 })
    .where(eq(vpnNodesTable.id, node.id));

  // Record a metric snapshot (debounced to METRIC_WRITE_INTERVAL_MS).
  // disk fields default to 0 when the remote node omits them.
  void maybeRecordMetricSnapshot(node.id, {
    cpuPercent: status.cpuPercent,
    ramUsedBytes: status.ramUsedBytes,
    ramTotalBytes: status.ramTotalBytes,
    diskUsedBytes: status.diskUsedBytes,
    diskTotalBytes: status.diskTotalBytes,
  });

  // If the node was previously auto-deactivated, bring it back.
  if (!node.isActive) {
    await jobsDb
      .update(vpnNodesTable)
      .set({ isActive: true })
      .where(eq(vpnNodesTable.id, node.id));

    await emitEvent("node_recovered", node.id, node.name, {
      cpuPercent: status.cpuPercent,
    });

    logger.info(
      { nodeId: node.id, nodeName: node.name },
      "nodeMonitoring: node auto-reactivated after recovery",
    );

    // Skip resource checks on the first successful poll after recovery — one
    // clean response is not enough to call a node "overloaded".
    return;
  }

  // ── Resource threshold checks (active nodes only) ──────────────────────────

  const ramPercent =
    status.ramTotalBytes > 0
      ? Math.round((status.ramUsedBytes / status.ramTotalBytes) * 1000) / 10
      : 0;

  const cpuOverloaded = status.cpuPercent > CPU_THRESHOLD_PERCENT;
  const ramOverloaded = ramPercent > RAM_THRESHOLD_PERCENT;

  if (cpuOverloaded || ramOverloaded) {
    const alreadyReported = await hasUnacknowledgedEvent("node_overloaded", node.id);
    if (!alreadyReported) {
      await emitEvent("node_overloaded", node.id, node.name, {
        cpuPercent: status.cpuPercent,
        ramPercent,
        cpuOverloaded,
        ramOverloaded,
      });
    }
  }
}

// ─── Job entry point ──────────────────────────────────────────────────────────

async function runNodeMonitoringCycle(): Promise<void> {
  try {
    await reconcilePendingKeyReplacements();
  } catch (err) {
    logger.error({ err }, "nodeMonitoring: pending key replacement reconciliation failed");
  }

  // Probe all active nodes + any inactive nodes that were auto-deactivated
  // (consecutiveFailures > 0) so we can detect recovery.
  // Nodes that an admin manually set to isActive=false have consecutiveFailures=0
  // and are correctly excluded — we don't attempt to auto-reactivate them.
  const nodes = await jobsDb
    .select({
      id: vpnNodesTable.id,
      name: vpnNodesTable.name,
      region: vpnNodesTable.region,
      isActive: vpnNodesTable.isActive,
      consecutiveFailures: vpnNodesTable.consecutiveFailures,
      managementApiUrl: vpnNodesTable.managementApiUrl,
      managementApiSecret: vpnNodesTable.managementApiSecret,
    })
    .from(vpnNodesTable)
    .where(
      or(
        eq(vpnNodesTable.isActive, true),
        gt(vpnNodesTable.consecutiveFailures, 0),
      ),
    );

  if (nodes.length === 0) return;

  // Poll all nodes in parallel — each probe has its own timeout, so one slow
  // node doesn't hold up the rest.
  await Promise.allSettled(nodes.map((node) => pollNode(node)));
}

export function startNodeMonitoringJob(): NodeJS.Timeout {
  const run = () => {
    runNodeMonitoringCycle().catch((err) => {
      logger.error({ err }, "nodeMonitoring: monitoring cycle failed");
    });
  };

  // Stagger the first run by 30 seconds so startup traffic polling and session
  // cleanup don't all fire at the exact same moment.
  const warmupTimer = setTimeout(() => {
    run();
    setInterval(run, NODE_MONITOR_INTERVAL_MS);
  }, 30_000);

  // Return a handle that, when cleared, cancels the warmup (if it hasn't
  // fired yet). After warmup the interval runs until process exit.
  return warmupTimer;
}
