import { Router, type IRouter } from "express";
import { asc, eq, isNull, and, ne, or, sql } from "drizzle-orm";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { db, vpnKeysTable, vpnNodesTable, systemEventsTable } from "@workspace/db";
import {
  CreateVpnNodeBody,
  CreateVpnNodeResponse,
  DeleteVpnNodeParams,
  DeleteVpnNodeResponse,
  UpdateVpnNodeBody,
  UpdateVpnNodeParams,
  UpdateVpnNodeResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { isLocalXrayEnabled, removeXrayClient } from "../../lib/xray";
import { removeRemoteXrayClient } from "../../lib/remoteNode";
import { issueKeyForUser, resolveTotalSlots } from "../../lib/keyIssuance";
import { logger } from "../../lib/logger";
import { maybeRecordMetricSnapshot } from "../../lib/nodeMonitoring";
import { getLocalSystemStatus } from "../../lib/sysStatus";

const router: IRouter = Router();
const execAsync = promisify(exec);


router.post("/admin/vpn-nodes", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateVpnNodeBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // `host` is optional in the API schema (some callers rely on SNI == host)
  // but NOT NULL in the DB — fall back to sni when omitted.
  const [node] = await db
    .insert(vpnNodesTable)
    .values({ ...parsed.data, host: parsed.data.host ?? parsed.data.sni })
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

  const [node] = await db
    .update(vpnNodesTable)
    .set(parsed.data)
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
  //    then revoke the old key. Failures are logged but don't abort the deletion
  //    — the key will be removed along with the node regardless.
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

        // No active subscription → key cannot be re-issued; it will be deleted with the node.
        if (totalSlots === null) {
          failedMigrations++;
          logger.warn(
            { userId: key.userId, keyId: key.id },
            "delete node: no active subscription, key deleted without migration",
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
            "delete node: no available node for key migration, key deleted without replacement",
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
          // same outcome as "no available node" above. The old key row
          // itself cannot be preserved: vpn_keys.node_id is NOT NULL with
          // ON DELETE RESTRICT, so every key on this node (migrated or not)
          // must be gone before the node row can be deleted below.
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

  // 4. Delete all keys for this node, then the node itself.
  //    Both in a try/catch so a concurrent race doesn't leave partial state.
  try {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.nodeId, nodeId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
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
      res.json(status);
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
    const data = await r.json();
    res.json(data);
    // Fire-and-forget snapshot for remote nodes too.
    void maybeRecordMetricSnapshot(nodeId, data as Parameters<typeof maybeRecordMetricSnapshot>[1]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg.includes("aborted") ? "Timeout (10s)" : msg });
  }
});

// ─── Historical metric time-series ───────────────────────────────────────────
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
