import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
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
import { logger } from "../lib/logger";

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
    parsed.data.idempotencyKey ?? undefined,
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
      .set({ revokedAt: new Date(), revokedReason: "user", xrayCleanupPendingAt: new Date() })
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
      await db.update(vpnKeysTable).set({ xrayCleanupPendingAt: null }).where(eq(vpnKeysTable.id, existing.key.id));
    } catch (err) {
      req.log.warn({ err, uuid: existing.key.uuid }, "Key revoked in DB but remote node removal failed");
    }
  } else if (isLocalXrayEnabled()) {
    try {
      await removeXrayClient(existing.key.uuid);
      await db.update(vpnKeysTable).set({ xrayCleanupPendingAt: null }).where(eq(vpnKeysTable.id, existing.key.id));
    } catch (err) {
      req.log.warn(
        { err, uuid: existing.key.uuid },
        "Key revoked in DB but Xray removal failed — client will stop connecting on next Xray restart",
      );
    }
  }

  res.sendStatus(204);
});

// Inline Zod schemas — avoid api-zod composite-tsconfig resolution issues for
// the new schemas that haven't been codegen'd into api-zod yet.
const RelocateVpnKeyParams = z.object({ keyId: z.coerce.number().int().positive() });
const RelocateVpnKeyBody = z.object({
  nodeId: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

async function findRelocationReplay(userId: number, idempotencyKey: string, targetNodeId: number) {
  const [row] = await db
    .select({ key: vpnKeysTable, node: vpnNodesTable })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(
      and(
        eq(vpnKeysTable.userId, userId),
        eq(vpnKeysTable.idempotencyKey, idempotencyKey),
        eq(vpnKeysTable.nodeId, targetNodeId),
      ),
    );
  return row;
}

/**
 * POST /vpn-keys/:keyId/relocate
 *
 * Move a key to a different node: issues a new key on the target node
 * (preserving label/description), then revokes the old key.
 *
 * Order — new key first, old key revoked after:
 *  - The source key is excluded from the user's total slot count only for this
 *    replacement operation. It remains active in DB/Xray until the new key is
 *    fully provisioned, so a one-device plan can be moved without granting a
 *    second device slot.
 *  - Revoking after guarantees the user always has at least one working key
 *    during the swap. If the revoke fails the old key becomes a supernumerary
 *    that the admin can clean up, but the user is never left key-less.
 */
router.post("/vpn-keys/:keyId/relocate", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const params = RelocateVpnKeyParams.safeParse(req.params);
  const body = RelocateVpnKeyBody.safeParse(req.body);

  if (!params.success || !body.success) {
    res.status(400).json({ error: (params.error ?? body.error)!.message });
    return;
  }

  const { keyId } = params.data;
  const { nodeId: targetNodeId, idempotencyKey } = body.data;

  // The proxy can retry a slow POST after the first relocation has already
  // provisioned the replacement and revoked the source key. Replay the
  // completed operation before checking the source key's revokedAt, otherwise
  // the retry is incorrectly reported as "Cannot relocate a revoked key".
  if (idempotencyKey) {
    const replay = await findRelocationReplay(user.id, idempotencyKey, targetNodeId);
    if (replay) {
      if (replay.key.provisionedAt && !replay.key.revokedAt) {
        res.json(CreateVpnKeyResponse.parse({ ...replay.key, nodeName: replay.node.name }));
        return;
      }
      if (!replay.key.provisionedAt && !replay.key.revokedAt) {
        res.status(409).json({
          error: "Перемещение ключа ещё выполняется. Повторите попытку через несколько секунд.",
        });
        return;
      }
      res.status(409).json({
        error: "Эта операция перемещения уже завершена, но новый ключ больше не активен.",
      });
      return;
    }
  }

  // Load the existing key + its current node.
  const [existing] = await db
    .select({ key: vpnKeysTable, node: vpnNodesTable })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(and(eq(vpnKeysTable.id, keyId), eq(vpnKeysTable.userId, user.id)));

  if (!existing) {
    res.status(404).json({ error: "VPN key not found" });
    return;
  }
  if (existing.key.revokedAt) {
    res.status(409).json({ error: "Нельзя переместить уже отозванный ключ." });
    return;
  }
  if (existing.key.nodeId === targetNodeId) {
    res.status(409).json({ error: "Ключ уже находится на этом сервере" });
    return;
  }

  // Require an active subscription (same guard as POST /vpn-keys).
  const totalSlots = await resolveTotalSlots(user.id);
  if (totalSlots === null) {
    res.status(403).json({ error: "An active subscription is required" });
    return;
  }
  if (await isTrafficLimitBlocked(user.id)) {
    res.status(403).json({
      error: "Лимит трафика исчерпан. Докупите трафик или дождитесь продления подписки.",
    });
    return;
  }

  // Issue the new key first — old key stays active so the user is never left
  // without a working connection during the swap.
  // idempotencyKey (client-generated UUID per click) prevents Amvera's proxy
  // retries from issuing a duplicate key on the target node.
  const result = await issueKeyForUser(
    user.id,
    totalSlots,
    targetNodeId,
    existing.key.label,
    existing.key.description ?? undefined,
    idempotencyKey,
    existing.key.id,
  );

  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }

  // Revoke the old key: DB-first (source of truth), then Xray (non-fatal).
  try {
    await db
      .update(vpnKeysTable)
    .set({ revokedAt: new Date(), revokedReason: "user", xrayCleanupPendingAt: new Date() })
      .where(and(eq(vpnKeysTable.id, existing.key.id), eq(vpnKeysTable.userId, user.id)));
  } catch (err) {
    logger.error({ err, oldKeyId: existing.key.id, newKeyId: result.key.id },
      "relocate: new key issued but old key DB revoke failed — old key left active for cleanup");
  }

  if (existing.node.managementApiUrl) {
    try {
      await removeRemoteXrayClient(existing.node, existing.key.uuid);
      await db.update(vpnKeysTable).set({ xrayCleanupPendingAt: null }).where(eq(vpnKeysTable.id, existing.key.id));
    } catch (err) {
      logger.warn({ err, uuid: existing.key.uuid }, "relocate: old remote Xray client removal failed (ignored)");
    }
  } else if (isLocalXrayEnabled()) {
    try {
      await removeXrayClient(existing.key.uuid);
      await db.update(vpnKeysTable).set({ xrayCleanupPendingAt: null }).where(eq(vpnKeysTable.id, existing.key.id));
    } catch (err) {
      logger.warn({ err, uuid: existing.key.uuid }, "relocate: old local Xray client removal failed (ignored)");
    }
  }

  logger.info({ userId: user.id, oldKeyId: existing.key.id, newKeyId: result.key.id, targetNodeId },
    "VPN key relocated");

  res.json(CreateVpnKeyResponse.parse({ ...result.key, nodeName: result.nodeName }));
});

export default router;
