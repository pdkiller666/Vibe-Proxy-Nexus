import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, vpnNodesTable } from "@workspace/db";
import { ListVpnNodesResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/vpn-nodes", async (_req, res): Promise<void> => {
  const nodes = await db
    .select()
    .from(vpnNodesTable)
    .where(eq(vpnNodesTable.isActive, true))
    .orderBy(asc(vpnNodesTable.name));

  res.json(ListVpnNodesResponse.parse(nodes));
});

export default router;
