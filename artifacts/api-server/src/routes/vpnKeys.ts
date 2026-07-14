import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import {
  CreateVpnKeyBody,
  CreateVpnKeyResponse,
  GetSubscriptionUrlResponse,
  ListMyVpnKeysResponse,
  RevokeVpnKeyParams,
  UpdateVpnKeyBody,
  UpdateVpnKeyParams,
  UpdateVpnKeyResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { removeXrayClient, isLocalXrayEnabled } from "../lib/xray";
import { buildSubscriptionUrl } from "../lib/subscription";
import { buildServingVlessLink } from "../lib/vless";
import { isTrafficLimitBlocked, issueKeyForUser, resolveTotalSlots } from "../lib/keyIssuance";

const router: IRouter = Router();

router.get("/vpn-keys/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const rows = await db
    .select({
      key: vpnKeysTable,
      node: vpnNodesTable,
    })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(eq(vpnKeysTable.userId, user.id))
    .orderBy(desc(vpnKeysTable.createdAt));

  // Regenerate the vless link per-request (instead of trusting the stored
  // column) so an already-issued key transparently starts using the primary
  // public domain — or falls back to the technical one — without needing to
  // be re-issued. See buildServingVlessLink for the domain selection logic.
  const keys = await Promise.all(
    rows.map(async ({ key, node }) => ({
      ...key,
      nodeName: node.name,
      vlessLink: key.revokedAt ? key.vlessLink : await buildServingVlessLink(node, key.uuid, key.label),
    })),
  );

  res.json(ListMyVpnKeysResponse.parse(keys));
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
  const totalSlots = await resolveTotalSlots(user.id);

  if (totalSlots === null) {
    res.status(403).json({ error: "An active subscription is required to issue a VPN key" });
    return;
  }

  // Block issuing a fresh key while the subscription is flagged for
  // exceeding its traffic cap — otherwise a revoked user could just free a
  // device slot and issue a brand new key (0 period bytes) to bypass the
  // limit. Buying extra traffic (or renewing) clears this flag.
  if (await isTrafficLimitBlocked(user.id)) {
    res.status(403).json({
      error: "Лимит трафика по тарифу исчерпан. Докупите трафик или подождите продления подписки, чтобы выпустить новый ключ.",
    });
    return;
  }

  const result = await issueKeyForUser(
    user.id,
    totalSlots,
    parsed.data.nodeId ?? undefined,
    parsed.data.label ?? undefined,
    parsed.data.description ?? undefined,
  );

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  res.status(201).json(CreateVpnKeyResponse.parse({ ...result.key, nodeName: result.nodeName }));
});

// Stable, self-updating subscription URL for the current user. Add this once
// in the VPN client app (Happ, v2rayNG, ...) instead of pasting individual
// vless links — new/rotated keys show up automatically on the app's next
// refresh, and the app overwrites any local edits the user makes.
router.get("/vpn-keys/subscription-url", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const url = await buildSubscriptionUrl(req, user.id);
  res.json(GetSubscriptionUrlResponse.parse({ url }));
});

router.patch("/vpn-keys/:keyId", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const params = UpdateVpnKeyParams.safeParse(req.params);
  const body = UpdateVpnKeyBody.safeParse(req.body);

  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.error ?? body.error)!.message });
    return;
  }

  // Trim and reject an empty label — a key must always have a display name.
  const label = body.data.label?.trim();
  if (label !== undefined && label.length === 0) {
    res.status(400).json({ error: "Label cannot be empty" });
    return;
  }

  const [existing] = await db
    .select({ key: vpnKeysTable, node: vpnNodesTable })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(and(eq(vpnKeysTable.id, params.data.keyId), eq(vpnKeysTable.userId, user.id)));

  if (!existing) {
    res.status(404).json({ error: "VPN key not found" });
    return;
  }

  const [updated] = await db
    .update(vpnKeysTable)
    .set({
      ...(label !== undefined ? { label } : {}),
      ...(body.data.description !== undefined ? { description: body.data.description.trim() || null } : {}),
    })
    .where(and(eq(vpnKeysTable.id, existing.key.id), eq(vpnKeysTable.userId, user.id)))
    .returning();

  if (!updated) {
    res.status(500).json({ error: "Failed to update VPN key" });
    return;
  }

  // The vless link embeds the label as its display remark — regenerate it so
  // the response reflects the new name immediately (same as the list route).
  res.json(
    UpdateVpnKeyResponse.parse({
      ...updated,
      nodeName: existing.node.name,
      vlessLink: updated.revokedAt
        ? updated.vlessLink
        : await buildServingVlessLink(existing.node, updated.uuid, updated.label),
    }),
  );
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
      .set({ revokedAt: new Date(), revokedReason: "user" })
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
