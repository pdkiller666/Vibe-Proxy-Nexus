import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { isLocalXrayEnabled, removeXrayClient } from "../../lib/xray";
import { removeRemoteXrayClient } from "../../lib/remoteNode";
import { issueKeyForUser } from "../../lib/keyIssuance";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

// Serialises concurrent issue requests for the same user within this process.
// Amvera runs a single Node instance, so an in-memory lock is sufficient: when
// the reverse proxy retries a timed-out POST, the retry queues behind the
// original request here and then hits the 30s duplicate check *after* the
// first key has been committed — closing the check-then-act race the plain
// pre-check alone could not.
const issueLocks = new Map<number, Promise<unknown>>();
function withUserIssueLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = issueLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  issueLocks.set(userId, tail);
  void tail.then(() => {
    if (issueLocks.get(userId) === tail) issueLocks.delete(userId);
  });
  return run;
}

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
  //
  // ⚠ Known edge case (L-1): if the user's subscription has already exceeded
  // its traffic limit (trafficLimitExceededAt is set), the next background
  // trafficPolling tick will immediately revoke this admin-issued key with
  // reason "traffic_limit". The admin panel shows this as a "briefly active"
  // key. To grant a persistent extra key in this state, either clear
  // trafficLimitExceededAt or sell the user a traffic top-up first.
  // All work runs under a per-user lock so a proxy-retried duplicate POST
  // queues behind the original request and only runs after its key row is
  // committed — the 30s duplicate check below then reliably catches it.
  await withUserIssueLock(userId, async () => {
    // Idempotency guard: if an active key for this user was created within the
    // last 30 seconds, return it instead of issuing another. Amvera's reverse
    // proxy is known to retry a POST against the upstream when the first
    // attempt exceeds its timeout, which used to create two keys from a single
    // admin click. Scoped to the same requested node (when nodeId is given) so
    // a deliberate second issuance to a *different* node is not suppressed.
    const dupWindow = new Date(Date.now() - 30_000);
    const dupConditions = [
      eq(vpnKeysTable.userId, userId),
      isNull(vpnKeysTable.revokedAt),
      gte(vpnKeysTable.createdAt, dupWindow),
    ];
    if (nodeId !== undefined) dupConditions.push(eq(vpnKeysTable.nodeId, nodeId));
    const [recent] = await db
      .select({ key: vpnKeysTable, nodeName: vpnNodesTable.name })
      .from(vpnKeysTable)
      .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
      .where(and(...dupConditions))
      .orderBy(desc(vpnKeysTable.createdAt))
      .limit(1);
    if (recent) {
      logger.warn({ userId, keyId: recent.key.id }, "admin vpn-key issue: duplicate request within 30s window — returning existing key");
      res.status(201).json({ ...recent.key, nodeName: recent.nodeName });
      return;
    }

    let result: Awaited<ReturnType<typeof issueKeyForUser>>;
    try {
      result = await issueKeyForUser(userId, Number.MAX_SAFE_INTEGER, nodeId);
    } catch (err) {
      // issueKeyForUser has internal try-catch for all expected paths; this
      // outer catch handles truly unexpected exceptions (e.g. DB pool exhausted
      // during the pre-transaction node queries) so the route always sends a
      // response instead of hanging and triggering an Amvera proxy timeout.
      logger.error({ err, userId, nodeId }, "admin vpn-key issue: unexpected error in issueKeyForUser");
      res.status(500).json({ error: "Internal error while issuing key" });
      return;
    }

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.status(201).json({ ...result.key, nodeName: result.nodeName });
  });
});

router.delete("/admin/vpn-keys/:keyId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const keyId = Number(req.params.keyId);
  if (!keyId) { res.status(400).json({ error: "invalid keyId" }); return; }

  const [existing] = await db
    .select({ key: vpnKeysTable, node: vpnNodesTable })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(eq(vpnKeysTable.id, keyId));
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

  if (!existing.key.revokedAt) {
    if (existing.node.managementApiUrl) {
      try {
        await removeRemoteXrayClient(existing.node, existing.key.uuid);
      } catch (err) {
        logger.warn({ err, keyId, uuid: existing.key.uuid }, "admin revoke: DB updated but remote node removal failed");
      }
    } else if (isLocalXrayEnabled()) {
      try {
        await removeXrayClient(existing.key.uuid);
      } catch (err) {
        // Non-fatal: DB is already the source of truth. Log so ops can notice
        // and clean up the stale Xray entry if needed.
        logger.warn({ err, keyId, uuid: existing.key.uuid }, "admin revoke: DB updated but Xray removal failed");
      }
    }
  }

  res.sendStatus(204);
});

export default router;
