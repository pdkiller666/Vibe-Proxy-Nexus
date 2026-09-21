import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  systemEventsTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { issueKeyForUser, resolveTotalSlots } from "./keyIssuance";
import { removeRemoteXrayClient } from "./remoteNode";
import { isLocalXrayEnabled, removeXrayClient } from "./xray";
import { afterTrafficDeltasFlushed } from "./trafficPolling";
import { bankActiveKeyUsageForRevocation } from "./trafficCarryover";
import { logger } from "./logger";

export type AdminKeyMigrationResult = {
  totalKeys: number;
  migratedKeys: number;
  failedMigrations: number;
};

const runningMigrations = new Set<number>();

/**
 * Manually move all active keys off a node without deleting the node.
 *
 * The source node is excluded even when it is still active. Each replacement
 * is issued before the source key is revoked, and source traffic counters are
 * copied in the same transaction as the DB revoke. The deterministic
 * idempotency key makes a retried request resume an in-flight replacement
 * instead of creating a second key.
 */
export async function migrateKeysFromNode(
  nodeId: number,
): Promise<
  | { kind: "ok"; result: AdminKeyMigrationResult }
  | { kind: "not_found" }
  | { kind: "in_progress" }
> {
  if (runningMigrations.has(nodeId)) return { kind: "in_progress" };
  runningMigrations.add(nodeId);

  try {
    const [sourceNode] = await db
      .select()
      .from(vpnNodesTable)
      .where(eq(vpnNodesTable.id, nodeId));
    if (!sourceNode) return { kind: "not_found" };

    const activeKeys = await db
      .select()
      .from(vpnKeysTable)
      .where(
        and(eq(vpnKeysTable.nodeId, nodeId), isNull(vpnKeysTable.revokedAt)),
      );

    let migratedKeys = 0;
    let failedMigrations = 0;

    for (const sourceKey of activeKeys) {
      const totalSlots = await resolveTotalSlots(sourceKey.userId);
      if (totalSlots === null) {
        failedMigrations++;
        logger.warn(
          { nodeId, keyId: sourceKey.id, userId: sourceKey.userId },
          "admin key migration: user has no active subscription",
        );
        continue;
      }

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

      // Same-region nodes are preferred, then other active nodes. Re-querying
      // for each key lets the capacity check observe the previous transfer.
      const candidates = await db
        .select({ node: vpnNodesTable })
        .from(vpnNodesTable)
        .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
        .where(
          and(
            eq(vpnNodesTable.isActive, true),
            ne(vpnNodesTable.id, nodeId),
            nodeHasCapacity,
          ),
        )
        .orderBy(
          asc(
            sql`case when ${vpnNodesTable.region} = ${sourceNode.region} then 0 else 1 end`,
          ),
          asc(sql`coalesce(${activeCounts.count}, 0)`),
        )
        .then((rows) => rows.map((row) => row.node));

      const idempotencyKey = `admin-node-migration:${nodeId}:${sourceKey.id}`;
      let replacement:
        | Extract<Awaited<ReturnType<typeof issueKeyForUser>>, { ok: true }>
        | undefined;

      for (const target of candidates) {
        const attempt = await issueKeyForUser(
          sourceKey.userId,
          totalSlots,
          target.id,
          sourceKey.label,
          sourceKey.description ?? undefined,
          idempotencyKey,
          sourceKey.id,
        );
        if (attempt.ok) {
          replacement = attempt;
          break;
        }
      }

      if (!replacement) {
        failedMigrations++;
        logger.warn(
          { nodeId, keyId: sourceKey.id, userId: sourceKey.userId },
          "admin key migration: no available destination node",
        );
        continue;
      }

      try {
        await afterTrafficDeltasFlushed(() =>
          db.transaction(async (tx) => {
            await bankActiveKeyUsageForRevocation(tx, sourceKey.userId, [
              sourceKey.id,
            ]);

            const [revokedSource] = await tx
              .update(vpnKeysTable)
              .set({
                revokedAt: new Date(),
                revokedReason: "admin",
                xrayCleanupPendingAt: new Date(),
              })
              .where(
                and(
                  eq(vpnKeysTable.id, sourceKey.id),
                  isNull(vpnKeysTable.revokedAt),
                ),
              )
              .returning();

            if (!revokedSource) throw new Error("SOURCE_KEY_ALREADY_REVOKED");

            const [updatedReplacement] = await tx
              .update(vpnKeysTable)
              .set({
                trafficUpBytes: revokedSource.trafficUpBytes,
                trafficDownBytes: revokedSource.trafficDownBytes,
                periodUpBytes: revokedSource.periodUpBytes,
                periodDownBytes: revokedSource.periodDownBytes,
                periodStartedAt: revokedSource.periodStartedAt,
              })
              .where(
                and(
                  eq(vpnKeysTable.id, replacement.key.id),
                  eq(vpnKeysTable.userId, sourceKey.userId),
                  isNull(vpnKeysTable.revokedAt),
                ),
              )
              .returning({ id: vpnKeysTable.id });

            if (!updatedReplacement) {
              throw new Error("REPLACEMENT_KEY_DISAPPEARED_DURING_TRANSFER");
            }
          }),
        );
      } catch (err) {
        // A concurrent migration may have completed the same deterministic
        // replacement between our snapshot and this transaction. Keep that
        // replacement intact; otherwise preserve the source key and report it.
        if (err instanceof Error && err.message === "SOURCE_KEY_ALREADY_REVOKED") {
          const [currentSource] = await db
            .select({ revokedAt: vpnKeysTable.revokedAt })
            .from(vpnKeysTable)
            .where(eq(vpnKeysTable.id, sourceKey.id));
          if (currentSource?.revokedAt) {
            migratedKeys++;
            continue;
          }
        }

        failedMigrations++;
        logger.error(
          {
            err,
            nodeId,
            oldKeyId: sourceKey.id,
            newKeyId: replacement.key.id,
          },
          "admin key migration: failed to transfer source key",
        );
        continue;
      }

      if (sourceNode.managementApiUrl) {
        await removeRemoteXrayClient(sourceNode, sourceKey.uuid).catch((err) =>
          logger.warn(
            { err, uuid: sourceKey.uuid, nodeId },
            "admin key migration: source remote Xray cleanup failed",
          ),
        );
      } else if (isLocalXrayEnabled()) {
        await removeXrayClient(sourceKey.uuid).catch((err) =>
          logger.warn(
            { err, uuid: sourceKey.uuid, nodeId },
            "admin key migration: source local Xray cleanup failed",
          ),
        );
      }

      migratedKeys++;
      try {
        await db.insert(systemEventsTable).values({
          eventType: "key_migrated",
          userId: sourceKey.userId,
          metadata: {
            oldNodeName: sourceNode.name,
            oldNodeId: nodeId,
            newNodeName: replacement.nodeName,
            newNodeId: replacement.key.nodeId,
            oldKeyId: sourceKey.id,
            newKeyId: replacement.key.id,
            initiatedBy: "admin_manual",
          },
        });
      } catch (err) {
        logger.warn(
          { err, userId: sourceKey.userId },
          "admin key migration: failed to emit user notification",
        );
      }
    }

    return {
      kind: "ok",
      result: {
        totalKeys: activeKeys.length,
        migratedKeys,
        failedMigrations,
      },
    };
  } finally {
    runningMigrations.delete(nodeId);
  }
}