import { Router, type IRouter } from "express";
import { asc, eq, isNull, and, ne, or, sql } from "drizzle-orm";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import { db, vpnKeysTable, vpnNodesTable } from "@workspace/db";
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

        // Revoke old key: DB-first (source of truth), then Xray (non-fatal — node is being removed).
        try {
          await db
            .update(vpnKeysTable)
            .set({ revokedAt: new Date(), revokedReason: "admin" })
            .where(eq(vpnKeysTable.id, key.id));
        } catch (err) {
          logger.error(
            { err, oldKeyId: key.id, newKeyId: result.key.id },
            "delete node: new key issued but old key DB revoke failed",
          );
        }

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

/** Read local system status from /proc files and os module. */
/** Sample /proc/stat twice ~200 ms apart to get real CPU utilisation. */
async function getCpuPercent(): Promise<number> {
  const readStat = async () => {
    const text = await fs.readFile("/proc/stat", "utf8").catch(() => "");
    const line = text.split("\n")[0] ?? "";
    const nums = line.replace(/^cpu\s+/, "").split(/\s+/).map(Number).filter(n => !isNaN(n));
    // Fields: user nice system idle iowait irq softirq steal guest guest_nice
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
    const total = nums.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const before = await readStat();
  await new Promise<void>(resolve => setTimeout(resolve, 200));
  const after = await readStat();
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10);
}

async function getLocalSystemStatus() {
  const cpuPercent = await getCpuPercent();

  // RAM: /proc/meminfo (MemTotal / MemAvailable, kB → bytes)
  const memInfo = await fs.readFile("/proc/meminfo", "utf8").catch(() => "");
  const getValue = (key: string) => {
    const m = memInfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1]) * 1024 : 0;
  };
  const ramTotalBytes = getValue("MemTotal");
  const ramUsedBytes = ramTotalBytes - getValue("MemAvailable");

  // Disk: df -B1 /
  const dfOut = await execAsync("df -B1 / | tail -1", { timeout: 5_000 }).catch(() => ({ stdout: "" }));
  const dfParts = dfOut.stdout.trim().split(/\s+/);
  const diskTotalBytes = parseInt(dfParts[1] ?? "0") || 0;
  const diskUsedBytes = parseInt(dfParts[2] ?? "0") || 0;

  // Uptime: /proc/uptime
  const uptimeText = await fs.readFile("/proc/uptime", "utf8").catch(() => "0");
  const uptimeSeconds = Math.floor(parseFloat(uptimeText.split(" ")[0] ?? "0"));

  return { cpuPercent, ramUsedBytes, ramTotalBytes, diskUsedBytes, diskTotalBytes, uptimeSeconds };
}

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg.includes("aborted") ? "Timeout (10s)" : msg });
  }
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
