import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { addXrayClient, isLocalXrayEnabled, removeXrayClient } from "../../lib/xray";
import { buildVlessLink, buildDeepLink, generateKeyUuid } from "../../lib/vless";
import { BRAND_NAME } from "../../lib/subscription";

const router: IRouter = Router();

router.get("/admin/vpn-keys", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      key: vpnKeysTable,
      nodeName: vpnNodesTable.name,
      userEmail: usersTable.email,
    })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .innerJoin(usersTable, eq(vpnKeysTable.userId, usersTable.id))
    .orderBy(desc(vpnKeysTable.createdAt));

  res.json(rows.map(({ key, nodeName, userEmail }) => ({ ...key, nodeName, userEmail })));
});

router.post("/admin/vpn-keys/issue", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  const [node] = await db
    .select()
    .from(vpnNodesTable)
    .where(eq(vpnNodesTable.isActive, true))
    .limit(1);

  if (!node) { res.status(404).json({ error: "No active VPN node" }); return; }

  const uuid = generateKeyUuid();
  const label = `${BRAND_NAME} — ${node.name}`;
  const vlessLink = buildVlessLink(node, uuid, label);
  const deepLink = buildDeepLink(vlessLink);

  if (isLocalXrayEnabled()) {
    try {
      // See keyIssuance.ts: the Xray "email" identifier must be the unique
      // UUID, not the (possibly colliding) display label.
      await addXrayClient(uuid, uuid);
    } catch (err) {
      res.status(502).json({ error: "Failed to provision key on node" });
      return;
    }
  }

  const [key] = await db
    .insert(vpnKeysTable)
    .values({ userId, nodeId: node.id, uuid, label, vlessLink, deepLink })
    .returning();

  if (!key) {
    if (isLocalXrayEnabled()) { try { await removeXrayClient(uuid); } catch {} }
    res.status(500).json({ error: "Failed to persist key" });
    return;
  }

  res.status(201).json({ ...key, nodeName: node.name });
});

router.delete("/admin/vpn-keys/:keyId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const keyId = Number(req.params.keyId);
  if (!keyId) { res.status(400).json({ error: "invalid keyId" }); return; }

  const [existing] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
  if (!existing) { res.status(404).json({ error: "Key not found" }); return; }

  if (isLocalXrayEnabled() && !existing.revokedAt) {
    try { await removeXrayClient(existing.uuid); } catch (err) {
      res.status(502).json({ error: "Failed to remove from node" }); return;
    }
  }

  await db.update(vpnKeysTable).set({ revokedAt: new Date(), revokedReason: "admin" }).where(eq(vpnKeysTable.id, keyId));
  res.sendStatus(204);
});

export default router;
