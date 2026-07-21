import { Router, type IRouter } from "express";
import { eq, isNull, and, sql } from "drizzle-orm";
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

export default router;
