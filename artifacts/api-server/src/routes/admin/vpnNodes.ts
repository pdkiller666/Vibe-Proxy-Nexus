import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, vpnNodesTable } from "@workspace/db";
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

  const [node] = await db.insert(vpnNodesTable).values(parsed.data).returning();
  res.status(201).json(CreateVpnNodeResponse.parse(node));
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

  res.json(UpdateVpnNodeResponse.parse(node));
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

export default router;
