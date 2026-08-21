import { and, asc, count, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  plansTable,
  subscriptionsTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { buildDeepLink, buildVlessLink, generateKeyUuid } from "./vless";
import { addXrayClient, isLocalXrayEnabled } from "./xray";
import { addRemoteXrayClient } from "./remoteNode";
import { BRAND_NAME } from "./subscription";
import { logger } from "./logger";

export type IssueKeyResult =
  | { ok: true; key: typeof vpnKeysTable.$inferSelect; nodeName: string }
  | { ok: false; status: number; error: string };

// Per-user in-process serialization of key issuance. Amvera's proxy retries
// slow POSTs, so one click can hit this process twice concurrently; chaining
// the second call behind the first makes the idempotency-key lookup (below)
// see the first call's committed row instead of racing it. This complements —
// not replaces — the DB-level FOR UPDATE locks and the unique index on
// idempotency_key, which remain the cross-process guarantees.
const userIssueLocks = new Map<number, Promise<unknown>>();

async function withUserIssueLock<T>(
  userId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = userIssueLocks.get(userId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of predecessor outcome
  // Keep the map from growing forever: clear the entry once the chain drains.
  const cleanup = run.catch(() => {}).finally(() => {
    if (userIssueLocks.get(userId) === cleanup) userIssueLocks.delete(userId);
  });
  userIssueLocks.set(userId, cleanup);
  return run;
}

type ReplayLookup =
  | { kind: "hit"; result: IssueKeyResult & { ok: true } }
  | { kind: "pending" } // row committed but Xray provisioning still in flight
  | { kind: "miss" };

/**
 * Looks up a previously issued key by (userId, idempotencyKey).
 *
 * Only a PROVISIONED key counts as a replayable success:
 * - provisionedAt set → "hit" (revoked-or-not: the original click succeeded;
 *   a user-revoked key is still the honest answer for that click).
 * - provisionedAt null + not revoked → "pending": the original request is
 *   still inside its post-commit Xray call; its outcome (201 or 502+revoke)
 *   is not decided yet, so we must not fabricate a success.
 * - no row (or provisioning failed — failure clears idempotency_key when
 *   revoking, see below) → "miss": caller proceeds with a fresh attempt.
 */
async function findKeyByIdempotencyKey(
  userId: number,
  idempotencyKey: string,
): Promise<ReplayLookup> {
  const [existing] = await db
    .select({ key: vpnKeysTable, nodeName: vpnNodesTable.name })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(
      and(
        eq(vpnKeysTable.userId, userId),
        eq(vpnKeysTable.idempotencyKey, idempotencyKey),
      ),
    );
  if (!existing) return { kind: "miss" };
  if (!existing.key.provisionedAt && !existing.key.revokedAt) {
    return { kind: "pending" };
  }
  if (!existing.key.provisionedAt && existing.key.revokedAt) {
    // Revoked before ever being provisioned — a failed original whose
    // idempotency_key was not cleared (e.g. the clearing update itself
    // failed). Never replay it as success.
    return { kind: "miss" };
  }
  return {
    kind: "hit",
    result: { ok: true, key: existing.key, nodeName: existing.nodeName },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How long a retry waits for a cross-process original that is still
// provisioning before giving up with a retriable 409 (~5 s total).
let replayPendingPollMs = 500;
let replayPendingMaxPolls = 10;

/** Test-only: shrink the pending-replay poll window so tests stay fast. */
export function setReplayPollingForTests(pollMs: number, maxPolls: number): void {
  replayPendingPollMs = pollMs;
  replayPendingMaxPolls = maxPolls;
}

const PENDING_RETRY_RESULT: IssueKeyResult = {
  ok: false,
  status: 409,
  error: "Ключ ещё выпускается. Подождите несколько секунд и обновите список устройств.",
};

/**
 * Resolves an idempotent replay, waiting out a "pending" original:
 * - hit → the original's key (201 replay).
 * - pending that resolves within the poll window → hit or miss accordingly.
 * - pending that never resolves → retriable 409 (never a fabricated 201).
 * - miss → null: caller proceeds (fresh attempt or its own failure result).
 */
async function awaitReplay(
  userId: number,
  idempotencyKey: string,
): Promise<IssueKeyResult | null> {
  for (let attempt = 0; ; attempt++) {
    const lookup = await findKeyByIdempotencyKey(userId, idempotencyKey);
    if (lookup.kind === "hit") return lookup.result;
    if (lookup.kind === "miss") return null;
    if (attempt >= replayPendingMaxPolls) return PENDING_RETRY_RESULT;
    await sleep(replayPendingPollMs);
  }
}

/**
 * Returns the already-issued key for this (userId, idempotencyKey) if one
 * exists, otherwise the given fallback failure. Every slot/capacity rejection
 * path must go through this: on a cross-process retry (second Amvera
 * instance) the original request may commit *between* the top-of-function
 * replay lookup and a later slot/capacity check — the retry must then replay
 * the original 201, not 409 with "slots full".
 */
async function replayOrFail(
  userId: number,
  idempotencyKey: string | undefined,
  fallback: IssueKeyResult,
): Promise<IssueKeyResult> {
  if (idempotencyKey) {
    const replay = await awaitReplay(userId, idempotencyKey);
    if (replay) return replay;
  }
  return fallback;
}

/**
 * Core key-issuance logic shared between the user-facing POST /vpn-keys route
 * and the automatic key created on registration.
 *
 * @param userId        - The user to issue the key for.
 * @param totalSlots    - devicesIncluded + extraDeviceSlots for this user.
 * @param preferNodeId  - Optional explicit node id (undefined → auto-select).
 * @param preferLabel   - Optional label override (undefined → branded default).
 * @param replaceKeyId  - Relocation-only source key excluded from the slot count
 *                        while its replacement is being provisioned.
 */
export async function issueKeyForUser(
  userId: number,
  totalSlots: number,
  preferNodeId?: number,
  preferLabel?: string,
  description?: string,
  idempotencyKey?: string,
  replaceKeyId?: number,
): Promise<IssueKeyResult> {
  return withUserIssueLock(userId, () =>
    issueKeyForUserInner(
      userId,
      totalSlots,
      preferNodeId,
      preferLabel,
      description,
      idempotencyKey,
      replaceKeyId,
    ),
  );
}

/**
 * Test-only export: the issuance logic WITHOUT the in-process per-user lock.
 * Racing two calls to this simulates two separate API processes (e.g. two
 * Amvera instances), where only the DB-level guarantees (FOR UPDATE locks,
 * in-tx idempotency re-check, unique index on idempotency_key) apply.
 */
export const issueKeyForUserUnlockedForTests = issueKeyForUserInner;

async function issueKeyForUserInner(
  userId: number,
  totalSlots: number,
  preferNodeId?: number,
  preferLabel?: string,
  description?: string,
  idempotencyKey?: string,
  replaceKeyId?: number,
): Promise<IssueKeyResult> {
  // Idempotent replay: a retried request (same client-generated UUID) gets
  // the key issued by the first attempt instead of a duplicate. Checked
  // before any slot/capacity logic so a replay never 409s on "slots full".
  if (idempotencyKey) {
    const replay = await awaitReplay(userId, idempotencyKey);
    if (replay) return replay;
  }

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

  let node: typeof vpnNodesTable.$inferSelect | undefined;

  if (preferNodeId !== undefined) {
    [node] = await db
      .select({ node: vpnNodesTable })
      .from(vpnNodesTable)
      .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
      .where(
        and(
          eq(vpnNodesTable.id, preferNodeId),
          eq(vpnNodesTable.isActive, true),
          nodeHasCapacity,
        ),
      )
      .then((rows) => rows.map((r) => r.node));

    if (!node) {
      const [exists] = await db
        .select({ id: vpnNodesTable.id })
        .from(vpnNodesTable)
        .where(
          and(
            eq(vpnNodesTable.id, preferNodeId),
            eq(vpnNodesTable.isActive, true),
          ),
        );
      return replayOrFail(userId, idempotencyKey, {
        ok: false,
        status: exists ? 409 : 404,
        error: exists
          ? "Selected VPN node has reached its user capacity"
          : "No available VPN node found",
      });
    }

    // Count total active keys for this user across ALL nodes (not just the
    // selected node) so that a retry landing on a different node cannot bypass
    // the slot limit that was already exhausted on the first attempt.
    const slotConditions = [
      eq(vpnKeysTable.userId, userId),
      isNull(vpnKeysTable.revokedAt),
      ...(replaceKeyId !== undefined ? [ne(vpnKeysTable.id, replaceKeyId)] : []),
    ];
    const [{ slotCount }] = await db
      .select({ slotCount: count() })
      .from(vpnKeysTable)
      .where(and(...slotConditions));

    if (slotCount >= totalSlots) {
      return replayOrFail(userId, idempotencyKey, {
        ok: false,
        status: 409,
        error: `Все слоты устройств заняты (${slotCount} из ${totalSlots}). Обратитесь к администратору для расширения.`,
      });
    }
  } else {
    const candidateNodes = await db
      .select({ node: vpnNodesTable })
      .from(vpnNodesTable)
      .leftJoin(activeCounts, eq(activeCounts.nodeId, vpnNodesTable.id))
      .where(and(eq(vpnNodesTable.isActive, true), nodeHasCapacity))
      // Least-loaded node first: pick the one with fewest active keys overall.
      // coalesce handles nodes that have never had a key (count IS NULL → 0).
      .orderBy(asc(sql`coalesce(${activeCounts.count}, 0)`))
      .then((rows) => rows.map((r) => r.node));

    if (candidateNodes.length === 0) {
      return replayOrFail(userId, idempotencyKey, {
        ok: false,
        status: 404,
        error: "No available VPN node found",
      });
    }

    const userKeyCounts = await db
      .select({ nodeId: vpnKeysTable.nodeId, cnt: count() })
      .from(vpnKeysTable)
      .where(
        and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)),
      )
      .groupBy(vpnKeysTable.nodeId);

    // Fast-fail: if the user already has totalSlots keys across ALL nodes,
    // there is no point selecting a node — the inner-tx check would reject it
    // anyway. This catches retries that arrive after the first request commits.
    const totalExisting = userKeyCounts.reduce((sum, r) => sum + r.cnt, 0);
    if (totalExisting >= totalSlots) {
      return replayOrFail(userId, idempotencyKey, {
        ok: false,
        status: 409,
        error: `Все слоты устройств заняты (${totalExisting} из ${totalSlots}). Обратитесь к администратору для расширения.`,
      });
    }

    const userCountMap = new Map(userKeyCounts.map((r) => [r.nodeId, r.cnt]));
    node = candidateNodes.find(
      (n) => (userCountMap.get(n.id) ?? 0) < totalSlots,
    );

    if (!node) {
      return replayOrFail(userId, idempotencyKey, {
        ok: false,
        status: 409,
        error: `Все слоты устройств заняты (${totalSlots} из ${totalSlots}). Обратитесь к администратору для расширения.`,
      });
    }
  }

  const uuid = generateKeyUuid();
  const label = preferLabel?.trim() || `${BRAND_NAME} — ${node.name}`;
  const vlessLink = buildVlessLink(node, uuid, label);
  const deepLink = buildDeepLink(vlessLink);

  // Atomic slot-check + DB insert, serialized by pessimistic row locks.
  //
  // Both the user's subscription (per-user slot limit) and the target node
  // (capacity) are locked FOR UPDATE so that concurrent calls for the same
  // user or node block here until we commit — eliminating the TOCTOU between
  // the outer checks above and the INSERT below.
  //
  // Xray provisioning runs after the commit so the DB lock is held as briefly
  // as possible. If Xray fails we immediately mark the committed key revoked;
  // that leaves the DB as the authoritative source of truth (key non-existent
  // from the user's perspective) rather than an orphaned Xray client.
  // Whether the key needs an Xray client added post-commit. When it does not
  // (dev without local Xray), the key is fully usable at commit time and is
  // marked provisioned in the same INSERT.
  const shouldProvision = node.managementApiUrl != null || isLocalXrayEnabled();

  // eslint-disable-next-line prefer-const
  let key!: typeof vpnKeysTable.$inferSelect;
  try {
    key = await db.transaction(async (tx) => {
      // Lock the user's active subscription to serialize concurrent issuance
      // for this user. Any concurrent issueKeyForUser for the same user will
      // block at this point until we commit, so its subsequent count query
      // reflects our already-inserted key.
      await tx.execute(
        sql`SELECT id FROM subscriptions WHERE user_id = ${userId} AND status = 'active' LIMIT 1 FOR UPDATE`,
      );

      // Idempotency re-check INSIDE the lock: a cross-process retry can pass
      // the top-of-function replay lookup before the original commits, then
      // block here on the subscription lock. Once the lock is granted the
      // original's key is committed and visible — return it instead of
      // proceeding into slot/capacity checks that would now 409.
      if (idempotencyKey) {
        const [dup] = await tx
          .select()
          .from(vpnKeysTable)
          .where(
            and(
              eq(vpnKeysTable.userId, userId),
              eq(vpnKeysTable.idempotencyKey, idempotencyKey),
            ),
          );
        if (dup) throw Object.assign(new Error("IDEMPOTENT_REPLAY"), { dup });
      }

      // Re-count inside the lock — the safe, authoritative slot count.
      // IMPORTANT: count across ALL nodes, not just the selected one.
      // A per-node count allows a concurrent retry (e.g. Amvera proxy retry)
      // to slip through by landing on a different node after the first request
      // has already committed a key on the originally selected node.
      const slotConditions = [
        eq(vpnKeysTable.userId, userId),
        isNull(vpnKeysTable.revokedAt),
        ...(replaceKeyId !== undefined ? [ne(vpnKeysTable.id, replaceKeyId)] : []),
      ];
      const [{ slotCount }] = await tx
        .select({ slotCount: count() })
        .from(vpnKeysTable)
        .where(and(...slotConditions));
      if (slotCount >= totalSlots) {
        throw Object.assign(new Error("SLOTS_EXCEEDED"), { slotCount, totalSlots });
      }

      // Lock the node row to serialize capacity checks across concurrent callers.
      await tx.execute(sql`SELECT id FROM vpn_nodes WHERE id = ${node.id} FOR UPDATE`);

      // Re-count node capacity inside the lock (only when there is a limit).
      if (node.maxUsers !== null) {
        const [{ nodeCount }] = await tx
          .select({ nodeCount: count() })
          .from(vpnKeysTable)
          .where(and(eq(vpnKeysTable.nodeId, node.id), isNull(vpnKeysTable.revokedAt)));
        if (nodeCount >= node.maxUsers) throw new Error("NODE_FULL");
      }

      const [row] = await tx
        .insert(vpnKeysTable)
        .values({
          userId,
          nodeId: node.id,
          uuid,
          label,
          description: description?.trim() || null,
          vlessLink,
          deepLink,
          idempotencyKey: idempotencyKey ?? null,
          provisionedAt: shouldProvision ? null : new Date(),
        })
        .returning();
      if (!row) throw new Error("INSERT_FAILED");
      return row;
    });
  } catch (err) {
    if (err instanceof Error && err.message === "IDEMPOTENT_REPLAY") {
      // Re-resolve via the shared helper: it waits out a still-provisioning
      // original and carries the node name the ORIGINAL request used.
      const replay = await awaitReplay(userId, idempotencyKey!);
      if (replay) return replay;
      // The original's provisioning failed while we waited (its row was
      // revoked and its idempotency_key cleared) — retriable.
      return PENDING_RETRY_RESULT;
    }
    if (err instanceof Error && err.message === "SLOTS_EXCEEDED") {
      const e = err as Error & { slotCount: number; totalSlots: number };
      return replayOrFail(userId, idempotencyKey, {
        ok: false,
        status: 409,
        error: `Все слоты устройств заняты (${e.slotCount} из ${e.totalSlots}). Обратитесь к администратору для расширения.`,
      });
    }
    if (err instanceof Error && err.message === "NODE_FULL") {
      return replayOrFail(userId, idempotencyKey, {
        ok: false,
        status: 409,
        error: "Selected VPN node has reached its user capacity",
      });
    }
    // Unique-index race on idempotency_key: another process (or a request the
    // in-process lock can't see, e.g. a second Amvera instance) committed the
    // same click first. Return that key — the user gets exactly one.
    if (
      idempotencyKey &&
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "23505"
    ) {
      const replay = await awaitReplay(userId, idempotencyKey);
      if (replay) return replay;
      return PENDING_RETRY_RESULT;
    }
    logger.error({ err }, "issueKeyForUser: failed to persist VPN key");
    return { ok: false, status: 500, error: "Failed to issue VPN key" };
  }

  // Provision the Xray client after committing — lock released before the
  // network call. Failure: immediately revoke the DB row (compensating write)
  // so the user never sees a "working" key that can't actually connect.
  //
  // Routing: remote nodes (managementApiUrl != null) receive a REST call to
  // their Management API; the local Amvera node writes to its on-disk config.
  if (shouldProvision) {
    try {
      if (node.managementApiUrl) {
        // Use UUID as the label/email — same rationale as local Xray:
        // labels can collide across users and corrupt per-user traffic stats.
        // limitIp: 1 enforces one simultaneous source IP per key (= one device).
        await addRemoteXrayClient(node, uuid, uuid, 1);
      } else {
        // Use UUID (not label) as the Xray "email" tag — labels can collide
        // across users and corrupt Xray's per-user dedup and traffic attribution.
        // limitIp: 1 enforces one simultaneous source IP per key (= one device).
        await addXrayClient(uuid, uuid, 1);
      }
      // Mark the key usable only now — replays of this idempotency key must
      // not report success while this network call was still undecided.
      const provisionedAt = new Date();
      await db
        .update(vpnKeysTable)
        .set({ provisionedAt })
        .where(eq(vpnKeysTable.id, key.id));
      key = { ...key, provisionedAt };
    } catch (err) {
      logger.error({ err, remote: !!node.managementApiUrl }, "issueKeyForUser: Xray provisioning failed; revoking committed DB key");
      try {
        // Clear idempotency_key alongside the revoke: a retry of the same
        // click must run a FRESH issuance attempt (provisioning may succeed
        // the second time), not replay this failed row as a success.
        await db
          .update(vpnKeysTable)
          .set({ revokedAt: new Date(), revokedReason: "admin", idempotencyKey: null })
          .where(eq(vpnKeysTable.id, key.id));
      } catch (dbErr) {
        logger.error({ err: dbErr, uuid }, "issueKeyForUser: DB revoke also failed — orphaned key in DB");
      }
      return { ok: false, status: 502, error: "Failed to provision VPN key on the node" };
    }
  }

  return { ok: true, key, nodeName: node.name };
}

/**
 * Resolves devicesIncluded + extraDeviceSlots for a user who has an active
 * subscription. extraDeviceSlots lives on the subscription row itself (see
 * schema comment) — a user with no active subscription has no slots at all,
 * including any they previously purchased under an expired/switched
 * subscription. Returns null if no active subscription exists.
 */
export async function resolveTotalSlots(
  userId: number,
): Promise<number | null> {
  const [activeWithPlan] = await db
    .select({
      devicesIncluded: plansTable.devicesIncluded,
      extraDeviceSlots: subscriptionsTable.extraDeviceSlots,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(
      and(
        eq(subscriptionsTable.userId, userId),
        eq(subscriptionsTable.status, "active"),
        or(
          isNull(subscriptionsTable.endsAt),
          gt(subscriptionsTable.endsAt, new Date()),
        ),
      ),
    )
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  if (!activeWithPlan) return null;
  return activeWithPlan.devicesIncluded + activeWithPlan.extraDeviceSlots;
}

/**
 * True when the user's active subscription has been flagged by
 * enforceTrafficLimits() as having exceeded its traffic cap for the current
 * period (see subscriptions.trafficLimitExceededAt schema comment).
 *
 * Callers must check this before issuing a brand new key: without it, a user
 * whose keys were just revoked for exceeding the limit could free up a
 * device slot and issue a fresh key (which starts at 0 period bytes),
 * silently bypassing the cap until the new key alone re-exceeds it.
 */
export async function isTrafficLimitBlocked(userId: number): Promise<boolean> {
  const [activeSub] = await db
    .select({ trafficLimitExceededAt: subscriptionsTable.trafficLimitExceededAt })
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  return Boolean(activeSub?.trafficLimitExceededAt);
}

/**
 * Guarantees a just-activated subscriber has at least one usable VPN key —
 * the same guarantee registration gives trial users via the auto-issue in
 * auth.ts. Without this, a user whose trial key was revoked (e.g. by the
 * grace-period sweep in subscriptionLifecycle.ts) while their manual-payment
 * confirmation was pending ends up with an active paid subscription and zero
 * keys, forced to figure out "Добавить устройство" on their own.
 *
 * No-ops if the user already has any non-revoked key (covers the common case
 * of renewing/switching plans without ever losing the trial key) or if slot
 * resolution / issuance fails — this runs after the payment is already
 * confirmed, so a key-issuance hiccup must never surface as a payment error.
 */
export async function ensureActiveKeyForUser(userId: number): Promise<void> {
  try {
    const [{ activeKeyCount }] = await db
      .select({ activeKeyCount: count() })
      .from(vpnKeysTable)
      .where(
        and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)),
      );

    if (activeKeyCount > 0) return;

    const totalSlots = await resolveTotalSlots(userId);
    if (totalSlots === null || totalSlots <= 0) return;

    const result = await issueKeyForUser(userId, totalSlots);
    if (result.ok) {
      logger.info(
        { userId, keyId: result.key.id },
        "Auto-issued VPN key after subscription activation (user had none)",
      );
    } else {
      logger.warn(
        { userId, err: result.error },
        "Could not auto-issue VPN key after subscription activation",
      );
    }
  } catch (err) {
    logger.error({ err, userId }, "ensureActiveKeyForUser failed");
  }
}
