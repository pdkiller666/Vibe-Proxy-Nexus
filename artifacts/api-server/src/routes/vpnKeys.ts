import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import {
  CreateVpnKeyBody,
  CreateVpnKeyResponse,
  GetSubscriptionUrlResponse,
  ListMyVpnKeysResponse,
  RevokeVpnKeyParams,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { buildDeepLink, buildVlessLink, generateKeyUuid } from "../lib/vless";
import { addXrayClient, isLocalXrayEnabled, removeXrayClient } from "../lib/xray";
import { BRAND_NAME, buildSubscriptionUrl } from "../lib/subscription";

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

  // Fetch active subscription WITH plan for devicesIncluded.
  // See meResponse.ts for why endsAt is re-checked here rather than trusting
  // status alone: the expiry sweep runs periodically, not instantly.
  const [activeWithPlan] = await db
    .select({ devicesIncluded: plansTable.devicesIncluded })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(
      and(
        eq(subscriptionsTable.userId, user.id),
        eq(subscriptionsTable.status, "active"),
        or(isNull(subscriptionsTable.endsAt), gt(subscriptionsTable.endsAt, new Date())),
      ),
    );

  if (!activeWithPlan) {
    res.status(403).json({ error: "An active subscription is required to issue a VPN key" });
    return;
  }

  // totalSlots = plan quota + admin-granted extras
  const totalSlots = activeWithPlan.devicesIncluded + user.extraDeviceSlots;

  // Nodes with a maxUsers cap are excluded from selection once their
  // non-revoked key count reaches the limit.
  const activeCounts = db
    .select({
      nodeId: vpnKeysTable.nodeId,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(vpnKeysTable)
    .where(isNull(vpnKeysTable.revokedAt))
    .groupBy(vpnKeysTable.nodeId)
    .as("active_counts");

  const nodeHasCapacity = or(
    isNull(vpnNodesTable.maxUsers),
    sql`coalesce(${activeCounts.count}, 0) < ${vpnNodesTable.maxUsers}`,
  );

  let node;

  if (parsed.data.nodeId) {
    // --- Explicit node ---
    [node] = await db
      .select({ node: vpnNodesTable })
      .from(vpnNodesTable)
      .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
      .where(
        and(eq(vpnNodesTable.id, parsed.data.nodeId), eq(vpnNodesTable.isActive, true), nodeHasCapacity),
      )
      .then((rows) => rows.map((r) => r.node));

    if (!node) {
      const [exists] = await db
        .select({ id: vpnNodesTable.id })
        .from(vpnNodesTable)
        .where(and(eq(vpnNodesTable.id, parsed.data.nodeId), eq(vpnNodesTable.isActive, true)));
      res.status(exists ? 409 : 404).json({
        error: exists ? "Selected VPN node has reached its user capacity" : "No available VPN node found",
      });
      return;
    }

    // Device slot check for this node
    const [{ slotCount }] = await db
      .select({ slotCount: count() })
      .from(vpnKeysTable)
      .where(
        and(
          eq(vpnKeysTable.userId, user.id),
          eq(vpnKeysTable.nodeId, node.id),
          isNull(vpnKeysTable.revokedAt),
        ),
      );

    if (slotCount >= totalSlots) {
      res.status(409).json({
        error: `Все слоты устройств заняты (${slotCount} из ${totalSlots}). Обратитесь к администратору для расширения.`,
      });
      return;
    }
  } else {
    // --- Auto-select: find first node with capacity and a free slot for this user ---
    const candidateNodes = await db
      .select({ node: vpnNodesTable })
      .from(vpnNodesTable)
      .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
      .where(and(eq(vpnNodesTable.isActive, true), nodeHasCapacity))
      .orderBy(asc(vpnNodesTable.id))
      .then((rows) => rows.map((r) => r.node));

    if (candidateNodes.length === 0) {
      res.status(404).json({ error: "No available VPN node found" });
      return;
    }

    // Get user's active key count per node
    const userKeyCounts = await db
      .select({ nodeId: vpnKeysTable.nodeId, cnt: count() })
      .from(vpnKeysTable)
      .where(and(eq(vpnKeysTable.userId, user.id), isNull(vpnKeysTable.revokedAt)))
      .groupBy(vpnKeysTable.nodeId);

    const userCountMap = new Map(userKeyCounts.map((r) => [r.nodeId, r.cnt]));

    node = candidateNodes.find((n) => (userCountMap.get(n.id) ?? 0) < totalSlots);

    if (!node) {
      res.status(409).json({
        error: `Все слоты устройств заняты (${totalSlots} из ${totalSlots}). Обратитесь к администратору для расширения.`,
      });
      return;
    }
  }

  const uuid = generateKeyUuid();
  // Default label is the branded project name plus the node — never the
  // user's email, since this string is shown as the profile name inside VPN
  // client apps (Happ, v2rayNG, ...).
  const label = parsed.data.label?.trim() || `${BRAND_NAME} — ${node.name}`;
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

// Stable, self-updating subscription URL for the current user. Add this once
// in the VPN client app (Happ, v2rayNG, ...) instead of pasting individual
// vless links — new/rotated keys show up automatically on the app's next
// refresh, and the app overwrites any local edits the user makes.
router.get("/vpn-keys/subscription-url", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const url = buildSubscriptionUrl(req, user.id);
  res.json(GetSubscriptionUrlResponse.parse({ url }));
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
