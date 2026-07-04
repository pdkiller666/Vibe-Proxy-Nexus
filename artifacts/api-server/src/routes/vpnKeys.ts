import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, subscriptionsTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { CreateVpnKeyBody, CreateVpnKeyResponse, ListMyVpnKeysResponse, RevokeVpnKeyParams } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { buildDeepLink, buildVlessLink, generateKeyUuid } from "../lib/vless";

const router: IRouter = Router();

router.get("/vpn-keys/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const rows = await db
    .select({
      key: vpnKeysTable,
      nodeName: vpnNodesTable.name,
    })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(eq(vpnKeysTable.userId, user.id))
    .orderBy(desc(vpnKeysTable.createdAt));

  res.json(
    ListMyVpnKeysResponse.parse(
      rows.map(({ key, nodeName }) => ({ ...key, nodeName })),
    ),
  );
});

router.post("/vpn-keys", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const parsed = CreateVpnKeyBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [activeSubscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, user.id), eq(subscriptionsTable.status, "active")));

  if (!activeSubscription) {
    res.status(403).json({ error: "An active subscription is required to issue a VPN key" });
    return;
  }

  let node;
  if (parsed.data.nodeId) {
    [node] = await db
      .select()
      .from(vpnNodesTable)
      .where(and(eq(vpnNodesTable.id, parsed.data.nodeId), eq(vpnNodesTable.isActive, true)));
  } else {
    [node] = await db
      .select()
      .from(vpnNodesTable)
      .where(eq(vpnNodesTable.isActive, true))
      .orderBy(asc(vpnNodesTable.id))
      .limit(1);
  }

  if (!node) {
    res.status(404).json({ error: "No available VPN node found" });
    return;
  }

  const uuid = generateKeyUuid();
  const label = parsed.data.label?.trim() || `${node.name} — ${user.email}`;
  const vlessLink = buildVlessLink(node, uuid, label);
  const deepLink = buildDeepLink(vlessLink);

  const [key] = await db
    .insert(vpnKeysTable)
    .values({
      userId: user.id,
      nodeId: node.id,
      uuid,
      label,
      vlessLink,
      deepLink,
    })
    .returning();

  if (!key) {
    res.status(500).json({ error: "Failed to issue VPN key" });
    return;
  }

  res.status(201).json(CreateVpnKeyResponse.parse({ ...key, nodeName: node.name }));
});

router.delete("/vpn-keys/:keyId", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const params = RevokeVpnKeyParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [key] = await db
    .update(vpnKeysTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(vpnKeysTable.id, params.data.keyId), eq(vpnKeysTable.userId, user.id)))
    .returning();

  if (!key) {
    res.status(404).json({ error: "VPN key not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
