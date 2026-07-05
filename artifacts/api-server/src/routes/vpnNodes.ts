import { Router, type IRouter } from "express";
import { asc, eq, isNull } from "drizzle-orm";
import { db, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { ListVpnNodesResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/vpn-nodes", async (_req, res): Promise<void> => {
  const nodes = await db
    .select()
    .from(vpnNodesTable)
    .where(eq(vpnNodesTable.isActive, true))
    .orderBy(asc(vpnNodesTable.name));

  // Cheap enough to compute per-request (admin node count is small) and
  // lets both the admin panel and the key-issuance node picker show current
  // occupancy against maxUsers.
  const activeKeys = await db.select({ nodeId: vpnKeysTable.nodeId }).from(vpnKeysTable).where(isNull(vpnKeysTable.revokedAt));
  const countsByNode = new Map<number, number>();
  for (const { nodeId } of activeKeys) {
    countsByNode.set(nodeId, (countsByNode.get(nodeId) ?? 0) + 1);
  }

  res.json(
    ListVpnNodesResponse.parse(
      nodes.map((node) => ({ ...node, activeUserCount: countsByNode.get(node.id) ?? 0 })),
    ),
  );
});

export default router;
