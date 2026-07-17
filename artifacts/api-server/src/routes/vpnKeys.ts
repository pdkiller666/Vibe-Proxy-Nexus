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
import { isLocalXrayEnabled, removeXrayClient } from "../lib/xray";
import { removeRemoteXrayClient } from "../lib/remoteNode";
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
    .select({ key: vpnKeysTable, node: vpnNodesTable })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(and(eq(vpnKeysTable.id, params.data.keyId), eq(vpnKeysTable.userId, user.id)));

  if (!existing) {
    res.status(404).json({ error: "VPN key not found" });
    return;
  }

  if (existing.key.revokedAt) {
    // Already revoked — idempotent, return success.
    res.sendStatus(204);
    return;
  }

  // Update the DB first so the key is marked revoked even if Xray removal
  // subsequently fails. The safe failure mode: DB says revoked, Xray still
  // has the client → device stops connecting on next Xray restart or key
  // reconcile, no user data integrity issue. The previous (unsafe) order was
  // Xray-first: DB still said active while the device couldn't connect, which
  // presented the user with a "working" key that did nothing.
  try {
    await db
      .update(vpnKeysTable)
      .set({ revokedAt: new Date(), revokedReason: "user" })
      .where(and(eq(vpnKeysTable.id, existing.key.id), eq(vpnKeysTable.userId, user.id)));
  } catch (err) {
    req.log.error({ err, keyId: existing.key.id }, "Failed to revoke VPN key in DB");
    res.status(500).json({ error: "Failed to revoke VPN key" });
    return;
  }

  // Remove from Xray/remote node after the DB is committed. Non-fatal: the
  // key is already DB-revoked (source of truth). Routes to remote Management
  // API for remote nodes, or to local Xray for the Amvera node.
  if (existing.node.managementApiUrl) {
    try {
      await removeRemoteXrayClient(existing.node, existing.key.uuid);
    } catch (err) {
      req.log.warn({ err, uuid: existing.key.uuid }, "Key revoked in DB but remote node removal failed");
    }
  } else if (isLocalXrayEnabled()) {
    try {
      await removeXrayClient(existing.key.uuid);
    } catch (err) {
      req.log.warn(
        { err, uuid: existing.key.uuid },
        "Key revoked in DB but Xray removal failed — client will stop connecting on next Xray restart",
      );
    }
  }

  res.sendStatus(204);
});

export default router;
