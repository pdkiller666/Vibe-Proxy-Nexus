import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { isLocalXrayEnabled, removeXrayClient } from "../../lib/xray";
import { issueKeyForUser } from "../../lib/keyIssuance";
import { logger } from "../../lib/logger";

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
  const { userId, nodeId } = req.body as { userId?: number; nodeId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }

  // Routed through the same issueKeyForUser as the self-service route
  // (previously this reimplemented node selection and picked *any* active
  // node with no capacity check at all — risking oversubscribing a node
  // past its configured maxUsers). Admin-issued keys intentionally still
  // bypass the *user's own* device-slot count and traffic-limit block (this
  // is a manual override for support cases, e.g. granting a bonus/temporary
  // device), but must always respect the target node's hardware capacity.
  const result = await issueKeyForUser(userId, Number.MAX_SAFE_INTEGER, nodeId);

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(201).json({ ...result.key, nodeName: result.nodeName });
});

router.delete("/admin/vpn-keys/:keyId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const keyId = Number(req.params.keyId);
  if (!keyId) { res.status(400).json({ error: "invalid keyId" }); return; }

  const [existing] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
  if (!existing) { res.status(404).json({ error: "Key not found" }); return; }

  // DB-first: mark revoked before touching Xray. If the DB write succeeds but
  // Xray removal fails the key is already non-functional (UUID is gone from
  // the DB-owned source of truth); the stale Xray entry will not accept new
  // connections because no valid session will reference it. This is the same
  // write order as the user-facing DELETE /vpn-keys/:keyId route.
  await db
    .update(vpnKeysTable)
    .set({ revokedAt: new Date(), revokedReason: "admin" })
    .where(eq(vpnKeysTable.id, keyId));

  if (isLocalXrayEnabled() && !existing.revokedAt) {
    try {
      await removeXrayClient(existing.uuid);
    } catch (err) {
      // Non-fatal: DB is already the source of truth. Log so ops can notice
      // and clean up the stale Xray entry if needed.
      logger.warn({ err, keyId, uuid: existing.uuid }, "admin revoke: DB updated but Xray removal failed");
    }
  }

  res.sendStatus(204);
});

export default router;
