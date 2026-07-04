import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, subscriptionsTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { CreateVpnKeyBody, CreateVpnKeyResponse, ListMyVpnKeysResponse, RevokeVpnKeyParams } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { buildDeepLink, buildVlessLink, generateKeyUuid } from "../lib/vless";
import { addXrayClient, isLocalXrayEnabled, removeXrayClient } from "../lib/xray";

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

  // When Xray runs alongside this server (all-in-one deployment), register the
  // client with Xray first so we never hand out a key that isn't actually live.
  if (isLocalXrayEnabled()) {
    try {
      await addXrayClient(uuid, label);
    } catch (err) {
      req.log.error({ err }, "Failed to register client with local Xray");
      res.status(502).json({ error: "Failed to provision VPN key on the node" });
      return;
    }
  }

  let key;
  try {
    [key] = await db
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
  } catch (err) {
    req.log.error({ err }, "Failed to persist VPN key");
  }

  if (!key) {
    // Roll back the Xray client so we don't leak an orphaned live client.
    if (isLocalXrayEnabled()) {
      try {
        await removeXrayClient(uuid);
      } catch (err) {
        req.log.error({ err, uuid }, "Failed to roll back orphaned Xray client");
      }
    }
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

  const [existing] = await db
    .select()
    .from(vpnKeysTable)
    .where(and(eq(vpnKeysTable.id, params.data.keyId), eq(vpnKeysTable.userId, user.id)));

  if (!existing) {
    res.status(404).json({ error: "VPN key not found" });
    return;
  }

  // Remove the client from Xray first so the key stops working before we mark
  // it revoked; if that fails, keep the DB state consistent and surface it.
  if (isLocalXrayEnabled() && !existing.revokedAt) {
    try {
      await removeXrayClient(existing.uuid);
    } catch (err) {
      req.log.error({ err, uuid: existing.uuid }, "Failed to remove client from local Xray");
      res.status(502).json({ error: "Failed to revoke VPN key on the node" });
      return;
    }
  }

  try {
    await db
      .update(vpnKeysTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(vpnKeysTable.id, existing.id), eq(vpnKeysTable.userId, user.id)));
  } catch (err) {
    // The client is already gone from Xray but the DB still shows it active.
    // Surface this so it can be reconciled (retry revoke).
    req.log.error(
      { err, uuid: existing.uuid },
      "Client removed from Xray but DB revoke failed — reconciliation needed",
    );
    res.status(500).json({ error: "Failed to revoke VPN key" });
    return;
  }

  res.sendStatus(204);
});

export default router;
