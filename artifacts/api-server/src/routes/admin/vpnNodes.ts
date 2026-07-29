import { Router, type IRouter } from "express";
import { eq, isNull, and, sql } from "drizzle-orm";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import { db, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import {
  CreateVpnNodeBody,
  CreateVpnNodeResponse,
  DeleteVpnNodeParams,
  UpdateVpnNodeBody,
  UpdateVpnNodeParams,
  UpdateVpnNodeResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

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

  const [node] = await db
    .delete(vpnNodesTable)
    .where(eq(vpnNodesTable.id, params.data.nodeId))
    .returning();

  if (!node) {
    res.status(404).json({ error: "VPN node not found" });
    return;
  }

  res.sendStatus(204);
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
async function getLocalSystemStatus() {
  // CPU: use 1-minute load average normalised by CPU count
  const loadAvg1m = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const cpuPercent = Math.min(100, Math.round((loadAvg1m / cpuCount) * 1000) / 10);

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
