import { Router, type IRouter } from "express";
import { asc, eq, inArray, isNull, and, ne, or, sql } from "drizzle-orm";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { db, vpnKeysTable, vpnNodesTable, systemEventsTable } from "@workspace/db";
import {
  CreateVpnNodeBody,
  CreateVpnNodeResponse,
  DeleteVpnNodeParams,
  DeleteVpnNodeResponse,
  MigrateVpnNodeKeysParams,
  MigrateVpnNodeKeysResponse,
  GetAdminVpnNodeRealityIdentityResponse,
  UpdateVpnNodeBody,
  UpdateVpnNodeParams,
  UpdateVpnNodeResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { isLocalXrayEnabled, removeXrayClient } from "../../lib/xray";
import { getRemoteRealityIdentity, removeRemoteXrayClient } from "../../lib/remoteNode";
import { issueKeyForUser, resolveTotalSlots } from "../../lib/keyIssuance";
import { logger } from "../../lib/logger";
import { maybeRecordMetricSnapshot } from "../../lib/nodeMonitoring";
import { getLocalSystemStatus } from "../../lib/sysStatus";
import { readNl1InterfaceCounters } from "../../lib/nl1InterfaceCounters";
import { bankActiveKeyUsageForRevocation } from "../../lib/trafficCarryover";
import { afterTrafficDeltasFlushed } from "../../lib/trafficPolling";
import { flagEmojiForNode } from "../../lib/vless";
import { migrateKeysFromNode } from "../../lib/adminKeyMigration";

const router: IRouter = Router();
const execAsync = promisify(exec);

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return value as string;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeVpnNodePayload<T extends {
  managementApiUrl?: string | null;
  managementApiSecret?: string | null;
  certSha256?: string | null;
  publicKey?: string | null;
  shortId?: string | null;
}>(
  data: T,
): T {
  const normalized = { ...data };
  if ("managementApiUrl" in normalized) normalized.managementApiUrl = normalizeNullableString(normalized.managementApiUrl);
  if ("managementApiSecret" in normalized) normalized.managementApiSecret = normalizeNullableString(normalized.managementApiSecret);
  if ("certSha256" in normalized) normalized.certSha256 = normalizeNullableString(normalized.certSha256);
  if ("publicKey" in normalized) normalized.publicKey = normalizeNullableString(normalized.publicKey);
  if ("shortId" in normalized) normalized.shortId = normalizeNullableString(normalized.shortId);
  if (normalized.managementApiUrl === null) normalized.managementApiSecret = null;
  return normalized;
}

function realityConfigurationError(node: {
  transport: string;
  host: string | null | undefined;
  port: number | null | undefined;
  sni: string | null | undefined;
  managementApiUrl: string | null | undefined;
  publicKey: string | null | undefined;
  shortId: string | null | undefined;
}): string | null {
  if (node.transport !== "reality") return null;
  if (!node.host) {
    return "Для Reality укажите прямой Host/IP тестовой VPS (не только SNI)";
  }
  if (!node.managementApiUrl) {
    return "VLESS+Reality доступен только для отдельной удалённой VPS-ноды";
  }
  if (!Number.isInteger(node.port) || node.port! < 1 || node.port! > 65535) {
    return "Укажите корректный TCP-порт Reality-ноды";
  }
  if (!node.sni || !/^[A-Za-z0-9.-]+$/.test(node.sni)) {
    return "Укажите корректный Reality Server Name (SNI)";
  }
  if (!node.publicKey || !/^[A-Za-z0-9_-]{43}=?$/.test(node.publicKey)) {
    return "Для VLESS+Reality укажите X25519 Public Key";
  }
  if (!node.shortId || !/^[0-9a-fA-F]{1,16}$/.test(node.shortId)) {
    return "Short ID должен содержать от 1 до 16 шестнадцатеричных символов";
  }
  return null;
}

router.get("/admin/vpn-nodes", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const nodes = await db
    .select()
    .from(vpnNodesTable)
    .orderBy(asc(vpnNodesTable.name));

  const activeKeys = await db
    .select({ nodeId: vpnKeysTable.nodeId })
    .from(vpnKeysTable)
    .where(isNull(vpnKeysTable.revokedAt));
  const countsByNode = new Map<number, number>();
  for (const { nodeId } of activeKeys) {
    countsByNode.set(nodeId, (countsByNode.get(nodeId) ?? 0) + 1);
  }

  res.json(
    nodes.map((node) => ({
      ...node,
      activeUserCount: countsByNode.get(node.id) ?? 0,
      flagEmoji: flagEmojiForNode(node) ?? null,
    })),
  );
});

router.post("/admin/vpn-nodes", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateVpnNodeBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // `host` is optional in the API schema (some callers rely on SNI == host)
  // but NOT NULL in the DB — fall back to sni when omitted.
  const createData = normalizeVpnNodePayload(parsed.data);
  if (createData.transport === "reality" && !parsed.data.host?.trim()) {
    res.status(400).json({ error: "Для Reality-ноды нужен прямой Host/IP VPS, отдельно от SNI" });
    return;
  }
  const realityError = realityConfigurationError({
    transport: createData.transport ?? "ws",
    host: createData.host,
    port: createData.port,
    sni: createData.sni,
    managementApiUrl: createData.managementApiUrl,
    publicKey: createData.publicKey,
    shortId: createData.shortId,
  });
  if (realityError) {
    res.status(400).json({ error: realityError });
    return;
  }

  const [node] = await db
    .insert(vpnNodesTable)
    .values({ ...createData, host: createData.host ?? createData.sni })
    .returning();
  res.status(201).json(CreateVpnNodeResponse.parse({ ...node, activeUserCount: 0 }));
});

router.patch("/admin/vpn-nodes/:nodeId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateVpnNodeParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateVpnNodeBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [currentNode] = await db
    .select()
    .from(vpnNodesTable)
    .where(eq(vpnNodesTable.id, params.data.nodeId));
  if (!currentNode) {
    res.status(404).json({ error: "VPN node not found" });
    return;
  }

  const normalizedPatch = normalizeVpnNodePayload(parsed.data);
  const nextTransport = normalizedPatch.transport ?? currentNode.transport;
  const nextManagementApiUrl =
    normalizedPatch.managementApiUrl === undefined
      ? currentNode.managementApiUrl
      : normalizedPatch.managementApiUrl;
  const nextHost =
    normalizedPatch.host === undefined
      ? currentNode.host
      : normalizedPatch.host;
  const nextPort =
    normalizedPatch.port === undefined
      ? currentNode.port
      : normalizedPatch.port;
  const nextSni =
    normalizedPatch.sni === undefined
      ? currentNode.sni
      : normalizedPatch.sni;
  const nextPublicKey =
    normalizedPatch.publicKey === undefined
      ? currentNode.publicKey
      : normalizedPatch.publicKey;
  const nextShortId =
    normalizedPatch.shortId === undefined
      ? currentNode.shortId
      : normalizedPatch.shortId;
  const realityError = realityConfigurationError({
    transport: nextTransport,
    host: nextHost,
    port: nextPort,
    sni: nextSni,
    managementApiUrl: nextManagementApiUrl,
    publicKey: nextPublicKey,
    shortId: nextShortId,
  });
  if (realityError) {
    res.status(400).json({ error: realityError });
    return;
  }

  const realityProfileChanged =
    (currentNode.transport === "reality" || nextTransport === "reality") &&
    (nextTransport !== currentNode.transport ||
      nextHost !== currentNode.host ||
      nextPort !== currentNode.port ||
      nextSni !== currentNode.sni ||
      nextManagementApiUrl !== currentNode.managementApiUrl ||
      nextPublicKey !== currentNode.publicKey ||
      nextShortId !== currentNode.shortId);
  if (realityProfileChanged) {
    const [{ count: activeKeyCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(vpnKeysTable)
      .where(
        and(
          eq(vpnKeysTable.nodeId, currentNode.id),
          isNull(vpnKeysTable.revokedAt),
        ),
      );
    if (activeKeyCount > 0) {
      res.status(409).json({
        error: "Нельзя менять транспорт, адрес, порт или параметры Reality-ноды с активными ключами",
      });
      return;
    }
  }

  const updateData =
    normalizedPatch.isActive === undefined
      ? normalizedPatch
      : { ...normalizedPatch, consecutiveFailures: 0 };
  const [node] = await db
    .update(vpnNodesTable)
    .set(updateData)
    .where(eq(vpnNodesTable.id, params.data.nodeId))
    .returning();

  if (!node) {
    res.status(404).json({ error: "VPN node not found" });
    return;
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(vpnKeysTable)
    .where(and(eq(vpnKeysTable.nodeId, node.id), isNull(vpnKeysTable.revokedAt)));

  res.json(UpdateVpnNodeResponse.parse({ ...node, activeUserCount: count }));
});

router.post("/admin/vpn-nodes/:nodeId/migrate-keys", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = MigrateVpnNodeKeysParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const result = await migrateKeysFromNode(params.data.nodeId);
  if (result.kind === "not_found") {
    res.status(404).json({ error: "VPN node not found" });
    return;
  }
  if (result.kind === "in_progress") {
    res.status(409).json({ error: "Миграция ключей с этой ноды уже выполняется." });
    return;
  }

  res.json(MigrateVpnNodeKeysResponse.parse(result.result));
});

router.delete("/admin/vpn-nodes/:nodeId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteVpnNodeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const nodeId = params.data.nodeId;

  // 1. Load the node — need its region and managementApiUrl for migration + Xray cleanup.
  const [node] = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
  if (!node) {
    res.status(404).json({ error: "VPN node not found" });
    return;
  }

  // Stop new issuance before taking the migration snapshot. If this request
  // later fails, leaving the node inactive is safer than placing fresh keys
  // onto a node an admin is trying to remove.
  await db
    .update(vpnNodesTable)
    .set({ isActive: false, consecutiveFailures: 0 })
    .where(eq(vpnNodesTable.id, nodeId));

  // 2. Load all keys on this node (active + historical). We delete them all so
  //    the ON DELETE RESTRICT FK constraint doesn't block the node deletion.
  const allKeys = await db
    .select()
    .from(vpnKeysTable)
    .where(eq(vpnKeysTable.nodeId, nodeId));

  const activeKeys = allKeys.filter((k) => !k.revokedAt);

  // 3. Migrate active keys to other nodes before deleting them.
  //    For each key: issue a replacement on the least-loaded same-region node
  //    (falling back to globally least-loaded if no same-region capacity exists),
  //    then revoke the old key. Any failed migration aborts the deletion below;
  //    removing the node while an active key has no replacement would strand
  //    that user without VPN access.
  let migratedKeys = 0;
  let failedMigrations = 0;

  if (activeKeys.length > 0) {
    // Pre-resolve slot limits for all affected users to avoid N+1 in the parallel loop.
    const uniqueUserIds = [...new Set(activeKeys.map((k) => k.userId))];
    const slotsEntries = await Promise.all(
      uniqueUserIds.map(async (uid) => [uid, await resolveTotalSlots(uid)] as const),
    );
    const slotsMap = new Map<number, number | null>(slotsEntries);

    // Subquery: active key count per node — used for both capacity checks and ordering.
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

    await Promise.all(
      activeKeys.map(async (key) => {
        const totalSlots = slotsMap.get(key.userId) ?? null;

        // No active subscription → key cannot be re-issued, so the node must
        // remain in place rather than deleting the user's only key.
        if (totalSlots === null) {
          failedMigrations++;
          logger.warn(
            { userId: key.userId, keyId: key.id },
            "delete node: no active subscription, node deletion will be aborted",
          );
          return;
        }

        // Find the least-loaded active node in the same region (excluding the node being deleted).
        const [sameRegionNode] = await db
          .select({ id: vpnNodesTable.id })
          .from(vpnNodesTable)
          .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
          .where(
            and(
              eq(vpnNodesTable.isActive, true),
              eq(vpnNodesTable.region, node.region),
              ne(vpnNodesTable.id, nodeId),
              nodeHasCapacity,
            ),
          )
          .orderBy(asc(sql`coalesce(${activeCounts.cnt}, 0)`))
          .limit(1);

        // Attempt 1: same-region preferred node (or undefined → auto-select globally).
        let result = await issueKeyForUser(
          key.userId,
          totalSlots,
          sameRegionNode?.id,
          key.label,
          key.description ?? undefined,
        );

        // Attempt 2: same-region node failed (e.g. at capacity) → let auto-select pick globally.
        if (!result.ok && sameRegionNode?.id !== undefined) {
          result = await issueKeyForUser(
            key.userId,
            totalSlots,
            undefined,
            key.label,
            key.description ?? undefined,
          );
        }

        if (!result.ok) {
          failedMigrations++;
          logger.warn(
            { userId: key.userId, keyId: key.id, error: result.error },
            "delete node: no available node for key migration, node deletion will be aborted",
          );
          return;
        }

        // Carry over the accumulated traffic counters to the new key by
        // reading and deleting the OLD key row in a single transaction —
        // NOT from the `key` object captured before this loop started.
        // Between that earlier snapshot and now, issueKeyForUser ran (which
        // can involve real network calls to a remote node's management API),
        // and the traffic-polling job (trafficPolling.ts, every 60s) could
        // have advanced this exact key's counters via applyTrafficDeltas in
        // the meantime. `DELETE ... RETURNING` inside a transaction reads
        // the row's truly-latest committed values at the moment of removal
        // (blocking behind, then reading after, any concurrent UPDATE on the
        // same row) — a plain read-then-later-delete would silently drop
        // whatever traffic accrued during that window.
        try {
          await db.transaction(async (tx) => {
            const [source] = await tx
              .delete(vpnKeysTable)
              .where(eq(vpnKeysTable.id, key.id))
              .returning();
            if (!source) throw new Error("SOURCE_KEY_ALREADY_GONE");
            // Postgres treats an UPDATE affecting zero rows as a successful
            // statement — if the just-issued replacement row disappeared in
            // the interval since issueKeyForUser returned (e.g. an
            // overlapping revoke/delete elsewhere), this UPDATE would
            // silently no-op and the transaction would still commit,
            // discarding the source counters with no error and no event.
            // RETURNING its id turns that into an explicit, checkable outcome.
            const [updated] = await tx
              .update(vpnKeysTable)
              .set({
                trafficUpBytes: source.trafficUpBytes,
                trafficDownBytes: source.trafficDownBytes,
                periodUpBytes: source.periodUpBytes,
                periodDownBytes: source.periodDownBytes,
                periodStartedAt: source.periodStartedAt,
              })
              .where(eq(vpnKeysTable.id, result.key.id))
              .returning({ id: vpnKeysTable.id });
            if (!updated) throw new Error("REPLACEMENT_KEY_DISAPPEARED_DURING_TRANSFER");
            return source;
          });
        } catch (err) {
          // A failure here must NOT be reported as a successful migration —
          // that would silently lose the old key's traffic history. Record a
          // durable admin-visible event with the exact counters that could
          // not be transferred (for manual reconciliation), unwind the
          // just-issued replacement, and report this as a failed migration —
          // same outcome as "no available node" above. The old key row remains
          // because the counter-transfer transaction rolled back; keeping the
          // node is what preserves access while an admin investigates.
          logger.error(
            { err, oldKeyId: key.id, newKeyId: result.key.id },
            "delete node: failed to carry over traffic history to migrated key — unwinding replacement, reporting as a failed migration",
          );
          failedMigrations++;
          try {
            await db.insert(systemEventsTable).values({
              eventType: "key_migration_traffic_loss",
              userId: key.userId,
              metadata: {
                oldKeyId: key.id,
                newKeyId: result.key.id,
                nodeId,
                nodeName: node.name,
                lastKnownTrafficUpBytes: key.trafficUpBytes,
                lastKnownTrafficDownBytes: key.trafficDownBytes,
                lastKnownPeriodUpBytes: key.periodUpBytes,
                lastKnownPeriodDownBytes: key.periodDownBytes,
                reason: err instanceof Error ? err.message : String(err),
              },
            });
          } catch (eventErr) {
            logger.error({ err: eventErr, oldKeyId: key.id }, "delete node: failed to record key_migration_traffic_loss event");
          }
          try {
            const [newNode] = await db
              .select()
              .from(vpnNodesTable)
              .where(eq(vpnNodesTable.id, result.key.nodeId));
            if (newNode?.managementApiUrl) {
              await removeRemoteXrayClient(newNode, result.key.uuid).catch(() => {/* best-effort */});
            } else if (isLocalXrayEnabled()) {
              await removeXrayClient(result.key.uuid).catch(() => {/* best-effort */});
            }
            await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, result.key.id));
          } catch (cleanupErr) {
            logger.error(
              { err: cleanupErr, newKeyId: result.key.id },
              "delete node: failed to unwind replacement key after traffic-copy failure",
            );
          }
          return;
        }

        // The old key's DB row is already gone (deleted atomically above
        // along with reading its final counters) — only the Xray client
        // itself needs cleaning up now, best-effort, using the uuid we
        // already have in memory.
        if (node.managementApiUrl) {
          try {
            await removeRemoteXrayClient(node, key.uuid);
          } catch (err) {
            logger.warn({ err, uuid: key.uuid, nodeId }, "delete node: remote Xray removal of migrated key failed (ignored)");
          }
        } else if (isLocalXrayEnabled()) {
          try {
            await removeXrayClient(key.uuid);
          } catch (err) {
            logger.warn({ err, uuid: key.uuid, nodeId }, "delete node: local Xray removal of migrated key failed (ignored)");
          }
        }

        migratedKeys++;
        logger.info(
          { userId: key.userId, oldKeyId: key.id, newKeyId: result.key.id, newNodeId: result.key.nodeId, newNodeName: result.nodeName },
          "delete node: key migrated to new node",
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
          logger.warn({ err, userId: key.userId }, "delete node: failed to emit key_migrated notification (ignored)");
        }
      }),
    );
  }

  // Fail closed: successful migrations may already have moved some keys, but
  // the source node and every key that could not be migrated must remain
  // available. The node is intentionally left inactive (set above) so no new
  // keys are issued to it while the admin resolves the failed migration.
  if (failedMigrations > 0) {
    logger.error(
      { nodeId, name: node.name, migratedKeys, failedMigrations },
      "delete node: aborting because not all active keys were migrated",
    );
    res.status(409).json({
      error: "Не удалось перенести все активные ключи. Узел сохранён и отключён для новых выдач.",
      migratedKeys,
      failedMigrations,
    });
    return;
  }

  // 4. Delete all keys for this node, then the node itself.
  //    Both in a try/catch so a concurrent race doesn't leave partial state.
  try {
    await afterTrafficDeltasFlushed(() => db.transaction(async (tx) => {
      const remainingActive = await tx
        .select({ id: vpnKeysTable.id, userId: vpnKeysTable.userId })
        .from(vpnKeysTable)
        .where(and(eq(vpnKeysTable.nodeId, nodeId), isNull(vpnKeysTable.revokedAt)));
      const byUser = new Map<number, number[]>();
      for (const key of remainingActive) {
        const ids = byUser.get(key.userId) ?? [];
        ids.push(key.id);
        byUser.set(key.userId, ids);
      }
      for (const [userId, keyIds] of byUser) {
        await bankActiveKeyUsageForRevocation(tx, userId, keyIds);
      }
      await tx.delete(vpnKeysTable).where(eq(vpnKeysTable.nodeId, nodeId));
      await tx.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    }));
  } catch (err) {
    logger.error({ err, nodeId }, "delete node: DB deletion failed");
    res.status(500).json({ error: "Не удалось удалить узел из базы данных" });
    return;
  }

  logger.info(
    { nodeId, name: node.name, deletedKeys: allKeys.length, migratedKeys, failedMigrations },
    "VPN node deleted",
  );
  res.status(200).json(DeleteVpnNodeResponse.parse({ migratedKeys, failedMigrations }));
});

router.get("/admin/vpn-nodes/:nodeId/health", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const nodeId = Number(req.params["nodeId"]);
  if (!nodeId || isNaN(nodeId)) { res.status(400).json({ error: "Invalid nodeId" }); return; }

  const [node] = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  // Local Amvera node — no remote API to ping; always considered healthy.
  if (!node.managementApiUrl) {
    res.json({ ok: true, latencyMs: null });
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const t0 = Date.now();
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (node.managementApiSecret) headers["X-Management-Secret"] = node.managementApiSecret;
    const r = await fetch(`${node.managementApiUrl}/stats`, { signal: controller.signal, headers });
    clearTimeout(timeout);
    const latencyMs = Date.now() - t0;
    if (!r.ok) {
      res.json({ ok: false, latencyMs, error: `HTTP ${r.status}` });
      return;
    }
    res.json({ ok: true, latencyMs });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ ok: false, latencyMs: null, error: msg.includes("aborted") ? "Timeout (5s)" : msg });
  }
});

router.get("/admin/vpn-nodes/:nodeId/reality-identity", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const nodeId = Number(req.params["nodeId"]);
  if (!Number.isInteger(nodeId) || nodeId < 1) {
    res.status(400).json({ error: "Invalid nodeId" });
    return;
  }

  const [node] = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
  if (!node) {
    res.status(404).json({ error: "Node not found" });
    return;
  }
  if (node.transport !== "reality") {
    res.status(400).json({ error: "Node is not configured for Reality" });
    return;
  }
  if (!node.managementApiUrl || !node.managementApiSecret) {
    res.status(409).json({ error: "Reality node management API is not configured" });
    return;
  }

  try {
    const live = await getRemoteRealityIdentity(node);
    const matches = {
      publicKey: Boolean(node.publicKey?.trim()) && node.publicKey!.trim() === live.publicKey,
      port: node.port === live.port,
      sni: Boolean(node.sni.trim()) && live.serverNames.some(
        (serverName) => serverName.toLowerCase() === node.sni.trim().toLowerCase(),
      ),
      shortId: Boolean(node.shortId?.trim()) && live.shortIds.includes(node.shortId!.trim()),
      transport: live.network === "tcp" && live.security === "reality",
      all: false,
    };
    matches.all = matches.publicKey && matches.port && matches.sni && matches.shortId && matches.transport;

    const result = GetAdminVpnNodeRealityIdentityResponse.parse({
      nodeId: node.id,
      nodeName: node.name,
      stored: {
        transport: node.transport,
        host: node.host,
        port: node.port,
        sni: node.sni,
        publicKey: node.publicKey,
        shortId: node.shortId,
      },
      live,
      matches,
    });
    res.json(result);
  } catch {
    // Do not return remote management details, error bodies, or credentials.
    logger.warn({ nodeId }, "Reality identity comparison failed");
    res.status(502).json({ error: "Не удалось получить публичные параметры Reality с узла" });
  }
});

// ─── System management endpoints ──────────────────────────────────────────────

/** Fetch recent log lines for the given process from supervisorctl. */
async function getLocalSystemLogs(process: string, lines: number): Promise<string[]> {
  const byteBudget = Math.max(lines * 250, 8192);
  const result = await execAsync(
    `supervisorctl tail -${byteBudget} ${process} stdout`,
    { timeout: 10_000 },
  ).catch((err: Error & { stdout?: string; stderr?: string }) => ({
    stdout: err.stdout ?? "",
    stderr: err.stderr ?? "",
  }));
  const raw = result.stdout || "";
  return raw.split("\n").filter(Boolean).slice(-lines);
}

router.get("/admin/vpn-nodes/:nodeId/system/status", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const nodeId = Number(req.params["nodeId"]);
  if (!nodeId || isNaN(nodeId)) { res.status(400).json({ error: "Invalid nodeId" }); return; }

  const [node] = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  if (!node.managementApiUrl) {
    // Local node — gather stats directly.
    try {
      const status = await getLocalSystemStatus();
      res.json({ ...status, ...await getNodeXrayTraffic24h(nodeId) });
      // Fire-and-forget snapshot (non-fatal, debounced to 5 min).
      void maybeRecordMetricSnapshot(nodeId, status);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
    return;
  }

  // Remote node — proxy to mgmt-api.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (node.managementApiSecret) headers["X-Management-Secret"] = node.managementApiSecret;
    const r = await fetch(`${node.managementApiUrl}/system/status`, { signal: controller.signal, headers });
    clearTimeout(timeout);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      res.status(r.status).json({ error: `Remote node returned HTTP ${r.status}: ${text.slice(0, 200)}` });
      return;
    }
    const data = await r.json() as Record<string, unknown>;
    let statusData = data;
    const hasNetworkCounters =
      typeof data.networkInterface === "string" &&
      Number.isSafeInteger(data.networkRxBytes) &&
      Number.isSafeInteger(data.networkTxBytes);
    if (!hasNetworkCounters) {
      try {
        const interfaceCounters = await readNl1InterfaceCounters(node.host);
        if (interfaceCounters) statusData = { ...data, ...interfaceCounters };
      } catch (err) {
        logger.warn({ err, nodeId }, "admin node status: NL1 interface-counter fallback failed");
      }
    }
    res.json({ ...statusData, ...await getNodeXrayTraffic24h(nodeId) });
    // Fire-and-forget snapshot for remote nodes too.
    void maybeRecordMetricSnapshot(nodeId, statusData as Parameters<typeof maybeRecordMetricSnapshot>[1]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg.includes("aborted") ? "Timeout (10s)" : msg });
  }
});

async function getNodeXrayTraffic24h(nodeId: number): Promise<{
  xrayUpBytes24h: number | null;
  xrayDownBytes24h: number | null;
}> {
  try {
    const result = await db.execute(sql`
      SELECT
        COALESCE(SUM(xray_up_bytes), 0)::text AS up_bytes,
        COALESCE(SUM(xray_down_bytes), 0)::text AS down_bytes
      FROM node_traffic_snapshots
      WHERE node_id = ${nodeId}
        AND source = 'xray'
        AND recorded_at >= NOW() - INTERVAL '24 hours'
    `) as { rows: Array<{ up_bytes: string; down_bytes: string }> };
    const row = result.rows[0];
    return {
      xrayUpBytes24h: row ? Number(row.up_bytes) : 0,
      xrayDownBytes24h: row ? Number(row.down_bytes) : 0,
    };
  } catch (err) {
    logger.warn({ err, nodeId }, "node Xray traffic summary unavailable");
    return { xrayUpBytes24h: null, xrayDownBytes24h: null };
  }
}

// ─── Historical metric time-series ───────────────────────────────────────────
router.get("/admin/vpn-nodes/:nodeId/system/traffic", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const nodeId = Number(req.params["nodeId"]);
  if (!nodeId || !Number.isInteger(nodeId)) {
    res.status(400).json({ error: "Invalid nodeId" });
    return;
  }

  const source = req.query["source"] as string;
  if (source !== "interface" && source !== "xray") {
    res.status(400).json({ error: "source must be interface or xray" });
    return;
  }

  const now = new Date();
  const fromRaw = req.query["from"] as string | undefined;
  const toRaw = req.query["to"] as string | undefined;
  const fromDate = fromRaw ? new Date(fromRaw) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const toDate = toRaw ? new Date(toRaw) : now;
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime()) || toDate < fromDate) {
    res.status(400).json({ error: "Invalid from/to date range" });
    return;
  }

  const rangeMs = toDate.getTime() - fromDate.getTime();
  const bucketSeconds =
    rangeMs <= 7 * 24 * 3600 * 1000 ? 15 * 60 :
    rangeMs <= 30 * 24 * 3600 * 1000 ? 60 * 60 :
    4 * 3600;

  let rows: Array<{ bucket: Date; in_bytes: string | number; out_bytes: string | number }>;
  if (source === "xray") {
    const result = await db.execute(sql`
      SELECT
        to_timestamp(floor(extract(epoch FROM recorded_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
        COALESCE(SUM(xray_up_bytes), 0)::text AS in_bytes,
        COALESCE(SUM(xray_down_bytes), 0)::text AS out_bytes
      FROM node_traffic_snapshots
      WHERE node_id = ${nodeId}
        AND source = 'xray'
        AND recorded_at >= ${fromDate}
        AND recorded_at <= ${toDate}
      GROUP BY bucket
      ORDER BY bucket ASC
    `) as { rows: typeof rows };
    rows = result.rows;
  } else {
    const result = await db.execute(sql`
      WITH samples AS (
        (
          SELECT recorded_at, interface_name, interface_rx_bytes, interface_tx_bytes
          FROM node_traffic_snapshots
          WHERE node_id = ${nodeId}
            AND source = 'interface'
            AND recorded_at < ${fromDate}
          ORDER BY recorded_at DESC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT recorded_at, interface_name, interface_rx_bytes, interface_tx_bytes
          FROM node_traffic_snapshots
          WHERE node_id = ${nodeId}
            AND source = 'interface'
            AND recorded_at >= ${fromDate}
            AND recorded_at <= ${toDate}
        )
      ),
      sampled AS (
        SELECT
          recorded_at,
          interface_name,
          interface_rx_bytes,
          interface_tx_bytes,
          LAG(interface_name) OVER (ORDER BY recorded_at) AS previous_interface,
          LAG(interface_rx_bytes) OVER (ORDER BY recorded_at) AS previous_rx,
          LAG(interface_tx_bytes) OVER (ORDER BY recorded_at) AS previous_tx
        FROM samples
      ),
      deltas AS (
        SELECT
          recorded_at,
          CASE
            WHEN interface_name = previous_interface AND interface_rx_bytes >= previous_rx
              THEN interface_rx_bytes - previous_rx
            WHEN interface_name = previous_interface AND interface_rx_bytes < previous_rx
              THEN interface_rx_bytes
            ELSE NULL
          END AS in_bytes,
          CASE
            WHEN interface_name = previous_interface AND interface_tx_bytes >= previous_tx
              THEN interface_tx_bytes - previous_tx
            WHEN interface_name = previous_interface AND interface_tx_bytes < previous_tx
              THEN interface_tx_bytes
            ELSE NULL
          END AS out_bytes
        FROM sampled
        WHERE recorded_at >= ${fromDate}
      )
      SELECT
        to_timestamp(floor(extract(epoch FROM recorded_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket,
        COALESCE(SUM(in_bytes), 0)::text AS in_bytes,
        COALESCE(SUM(out_bytes), 0)::text AS out_bytes
      FROM deltas
      WHERE recorded_at <= ${toDate}
      GROUP BY bucket
      ORDER BY bucket ASC
    `) as { rows: typeof rows };
    rows = result.rows;
  }

  res.json({
    source,
    points: rows.map((row) => ({
      ts: new Date(row.bucket).getTime(),
      inBytes: Number(row.in_bytes),
      outBytes: Number(row.out_bytes),
    })),
  });
});

router.get("/admin/vpn-nodes/:nodeId/system/metrics", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const nodeId = Number(req.params["nodeId"]);
  if (!nodeId || isNaN(nodeId)) { res.status(400).json({ error: "Invalid nodeId" }); return; }

  const metric = req.query["metric"] as string;
  if (!["cpu", "ram", "disk"].includes(metric)) {
    res.status(400).json({ error: "metric must be cpu, ram, or disk" });
    return;
  }

  const now = new Date();
  const fromRaw = req.query["from"] as string | undefined;
  const toRaw   = req.query["to"]   as string | undefined;
  const fromDate = fromRaw ? new Date(fromRaw) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const toDate   = toRaw   ? new Date(toRaw)   : now;

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    res.status(400).json({ error: "Invalid from/to date" });
    return;
  }

  // Pick the aggregation bucket based on range length:
  //   ≤ 7 days  → 15-minute averages
  //   ≤ 30 days → 1-hour averages
  //   > 30 days → 4-hour averages
  const rangeMs = toDate.getTime() - fromDate.getTime();
  const bucketSeconds =
    rangeMs <= 7 * 24 * 3600 * 1000  ? 15 * 60 :
    rangeMs <= 30 * 24 * 3600 * 1000 ? 60 * 60 :
                                        4 * 3600;

  const colMap: Record<string, string> = {
    cpu:  "cpu_percent",
    ram:  "ram_percent",
    disk: "disk_percent",
  };
  const col = colMap[metric]!;

  // Raw SQL aggregate: group by time bucket, return avg value + bucket start ts.
  const rows = await db.execute(
    sql`
      SELECT
        date_trunc('second',
          to_timestamp(
            floor(extract(epoch from recorded_at) / ${bucketSeconds}) * ${bucketSeconds}
          )
        ) AS bucket,
        round(avg(${sql.raw(col)}))::int AS value
      FROM node_metric_snapshots
      WHERE node_id = ${nodeId}
        AND recorded_at >= ${fromDate}
        AND recorded_at <= ${toDate}
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
  ) as { rows: Array<{ bucket: Date; value: number }> };

  const points = rows.rows.map((r) => ({
    ts: new Date(r.bucket).getTime(),
    value: r.value,
  }));

  res.json({ metric, points });
});

router.get("/admin/vpn-nodes/:nodeId/system/logs", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const nodeId = Number(req.params["nodeId"]);
  if (!nodeId || isNaN(nodeId)) { res.status(400).json({ error: "Invalid nodeId" }); return; }

  const process = (req.query["process"] as string) || "xray";
  const lines = Math.min(Math.max(parseInt((req.query["lines"] as string) ?? "100") || 100, 1), 1000);

  if (!["xray", "mgmt-api"].includes(process)) {
    res.status(400).json({ error: "Invalid process name" });
    return;
  }

  const [node] = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  if (!node.managementApiUrl) {
    // Local node.
    try {
      const logLines = await getLocalSystemLogs(process, lines);
      res.json({ process, lines: logLines });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
    return;
  }

  // Remote node — proxy to mgmt-api.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const headers: Record<string, string> = { "Accept": "application/json" };
    if (node.managementApiSecret) headers["X-Management-Secret"] = node.managementApiSecret;
    const url = new URL(`${node.managementApiUrl}/system/logs`);
    url.searchParams.set("process", process);
    url.searchParams.set("lines", String(lines));
    const r = await fetch(url.toString(), { signal: controller.signal, headers });
    clearTimeout(timeout);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      res.status(r.status).json({ error: `Remote node returned HTTP ${r.status}: ${text.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    res.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg.includes("aborted") ? "Timeout (15s)" : msg });
  }
});

router.post("/admin/vpn-nodes/:nodeId/system/restart-xray", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const nodeId = Number(req.params["nodeId"]);
  if (!nodeId || isNaN(nodeId)) { res.status(400).json({ error: "Invalid nodeId" }); return; }

  const [node] = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
  if (!node) { res.status(404).json({ error: "Node not found" }); return; }

  if (!node.managementApiUrl) {
    // Local node — restart via supervisorctl directly.
    try {
      const result = await execAsync("supervisorctl restart xray", { timeout: 30_000 });
      const output = (result.stdout || "").trim();
      const status = await getLocalSystemStatus();
      res.json({ ok: true, output, status });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Even on timeout, Xray may have restarted — return partial result.
      try {
        const status = await getLocalSystemStatus();
        res.json({ ok: false, output: msg.slice(0, 500), status });
      } catch {
        res.status(500).json({ error: msg });
      }
    }
    return;
  }

  // Remote node — proxy to mgmt-api.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35_000);
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Content-Length": "0",
    };
    if (node.managementApiSecret) headers["X-Management-Secret"] = node.managementApiSecret;
    const r = await fetch(`${node.managementApiUrl}/system/restart-xray`, {
      method: "POST",
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      res.status(r.status).json({ error: `Remote node returned HTTP ${r.status}: ${text.slice(0, 200)}` });
      return;
    }
    const data = await r.json();
    res.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg.includes("aborted") ? "Timeout (35s)" : msg });
  }
});

export default router;
