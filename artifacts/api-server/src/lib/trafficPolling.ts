/**
 * Background job that periodically pulls per-user traffic deltas from
 * Xray's Stats API (see xrayStats.ts) and accumulates them into vpn_keys,
 * then enforces each plan's optional traffic cap by revoking keys for users
 * who have exceeded it in their current subscription period.
 *
 * No-op entirely when Xray isn't running locally (Replit dev, or any
 * environment without XRAY_CONFIG_PATH set) — pollUserTrafficDeltas()
 * already short-circuits to an empty map in that case.
 */
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { jobsDb, plansTable, subscriptionsTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { pollUserTrafficCounters } from "./xrayStats";
import { isLocalXrayEnabled, removeXrayClient } from "./xray";
import { pollRemoteNodeStats, removeRemoteXrayClient } from "./remoteNode";
import { logger } from "./logger";

const TRAFFIC_POLL_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Process-level health state for the traffic polling job. Tracked in memory
 * (not DB) — this is about the liveness of the background job itself, not
 * user data. Reset on every process restart. Exported for the admin health
 * endpoint (GET /admin/health/traffic-polling).
 */
export const trafficPollingHealth = {
  lastSuccessAt: null as Date | null,
  consecutiveFailures: 0,
  lastError: null as string | null,
};

/**
 * Applies queried *absolute* uplink/downlink counter reads (keyed by VPN key
 * UUID, see pollUserTrafficCounters) onto the matching vpn_keys rows. Safe
 * to call with an empty map (no-op).
 *
 * Each row's own `last_seen_*_bytes` columns are the only record of what
 * was already accounted for, so the delta for this cycle is computed
 * in-database as `current - last_seen` inside the same UPDATE that stores
 * the new `last_seen_*_bytes` — a single statement per key, so there is no
 * read-then-write gap where a concurrent poll (or crash) could apply the
 * same bytes twice or skip them.
 *
 * If `current < last_seen`, Xray's own counter must have been reset to 0
 * behind our backs (a process restart — see reloadXray() in xray.ts, or an
 * out-of-band `supervisorctl restart xray`). Since nothing ever reads that
 * counter except this poller, and it was never told to reset it (reset:
 * false in xrayStats.ts), any traffic since the restart is exactly
 * `current` bytes — not `current - last_seen`, which would double-subtract
 * work already credited from before the restart and could even go
 * negative. Treating `current` as the delta in that case means an Xray
 * restart mid-cycle never silently drops traffic, it just gets attributed
 * to the poll right after the restart instead of the poll before it.
 *
 * A crash between the gRPC read and this commit no longer loses anything
 * either: `last_seen_*_bytes` in the DB wasn't advanced, so the next poll
 * simply recomputes the same (larger) delta from the same baseline.
 *
 * All rows are applied in a single batched UPDATE (via a VALUES list joined
 * on uuid) rather than one round-trip per key. At scale (hundreds/thousands
 * of active keys) a per-key sequential UPDATE loop would hold this
 * transaction open for seconds and, combined with a small connection pool,
 * would starve concurrent user-facing requests — see .agents/memory for the
 * hourly-billing load analysis this was written for.
 */
export async function applyTrafficDeltas(
  counters: Map<string, { uplinkBytes: number; downlinkBytes: number }>,
): Promise<void> {
  const entries = [...counters].filter(([, c]) => c.uplinkBytes !== 0 || c.downlinkBytes !== 0);
  if (entries.length === 0) return;

  // Detect Xray counter resets before the UPDATE so we can emit WARN logs.
  // A reset occurs when the current reading is less than what was last seen,
  // meaning Xray restarted and its in-memory counters were zeroed. We fetch
  // the stored baselines here (one query for the whole batch) and compare
  // in JS; the UPDATE below still handles it correctly with its CASE branch,
  // but without this check the reset would be applied silently.
  const uuids = entries.map(([uuid]) => uuid);
  const lastSeenRows = await jobsDb
    .select({
      uuid: vpnKeysTable.uuid,
      lastSeenUpBytes: vpnKeysTable.lastSeenUpBytes,
      lastSeenDownBytes: vpnKeysTable.lastSeenDownBytes,
    })
    .from(vpnKeysTable)
    .where(inArray(vpnKeysTable.uuid, uuids));

  const lastSeenByUuid = new Map(lastSeenRows.map((r) => [r.uuid, r]));
  for (const [uuid, { uplinkBytes, downlinkBytes }] of entries) {
    const stored = lastSeenByUuid.get(uuid);
    if (!stored) continue;
    const upReset = uplinkBytes < stored.lastSeenUpBytes;
    const downReset = downlinkBytes < stored.lastSeenDownBytes;
    if (upReset || downReset) {
      // The inferred reset delta is exactly `current` (what Xray accumulated
      // since its restart), consistent with the CASE branch in the UPDATE.
      const resetDeltaUpBytes = upReset ? uplinkBytes : 0;
      const resetDeltaDownBytes = downReset ? downlinkBytes : 0;
      logger.warn(
        {
          uuid,
          resetDeltaUpBytes,
          resetDeltaDownBytes,
          lastSeenUpBytes: stored.lastSeenUpBytes,
          lastSeenDownBytes: stored.lastSeenDownBytes,
          currentUpBytes: uplinkBytes,
          currentDownBytes: downlinkBytes,
        },
        "Xray counter reset detected for key (likely Xray restart): attributing current reading as delta",
      );
    }
  }

  const values = sql.join(
    entries.map(
      ([uuid, { uplinkBytes, downlinkBytes }]) =>
        sql`(${uuid}::text, ${uplinkBytes}::bigint, ${downlinkBytes}::bigint)`,
    ),
    sql`, `,
  );

  await jobsDb.execute(sql`
    update vpn_keys as vk
    set
      traffic_up_bytes = vk.traffic_up_bytes + (case when c.up >= vk.last_seen_up_bytes then c.up - vk.last_seen_up_bytes else c.up end),
      traffic_down_bytes = vk.traffic_down_bytes + (case when c.down >= vk.last_seen_down_bytes then c.down - vk.last_seen_down_bytes else c.down end),
      period_up_bytes = vk.period_up_bytes + (case when c.up >= vk.last_seen_up_bytes then c.up - vk.last_seen_up_bytes else c.up end),
      period_down_bytes = vk.period_down_bytes + (case when c.down >= vk.last_seen_down_bytes then c.down - vk.last_seen_down_bytes else c.down end),
      last_seen_up_bytes = c.up,
      last_seen_down_bytes = c.down,
      last_traffic_at = now()
    from (values ${values}) as c(uuid, up, down)
    where vk.uuid = c.uuid
  `);
}

/**
 * Revokes VPN keys for any user whose current-period traffic (summed across
 * their own, still-active keys) exceeds their active plan's trafficLimitGb.
 * Users with no active subscription, or whose plan has no limit set
 * (trafficLimitGb IS NULL), are skipped entirely.
 */
export async function enforceTrafficLimits(): Promise<number> {
  const now = new Date();

  // A user should only ever have one active subscription, but resolve to
  // exactly one (DISTINCT ON, most recently started) defensively — an
  // ordinary innerJoin from vpn_keys straight to subscriptions would fan
  // each key's traffic out across every active subscription row a user
  // happens to have, multiplying periodBytes and triggering false
  // "exceeded" revocations.
  const currentPlanLimitByUser = jobsDb.$with("current_plan_limit_by_user").as(
    jobsDb
      .selectDistinctOn([subscriptionsTable.userId], {
        userId: subscriptionsTable.userId,
        subscriptionId: subscriptionsTable.id,
        trafficLimitGb: plansTable.trafficLimitGb,
        extraTrafficGb: subscriptionsTable.extraTrafficGb,
      })
      .from(subscriptionsTable)
      .innerJoin(plansTable, eq(plansTable.id, subscriptionsTable.planId))
      .where(
        and(
          eq(subscriptionsTable.status, "active"),
          or(isNull(subscriptionsTable.endsAt), gt(subscriptionsTable.endsAt, now)),
        ),
      )
      .orderBy(subscriptionsTable.userId, desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id)),
  );

  // sum(bigint + bigint) returns Postgres `numeric`, which the pg driver
  // hands back as a string — coerce explicitly with Number() rather than
  // relying on the `sql<number>` annotation, which is compile-time only.
  const rawUsage = await jobsDb
    .with(currentPlanLimitByUser)
    .select({
      userId: vpnKeysTable.userId,
      subscriptionId: currentPlanLimitByUser.subscriptionId,
      trafficLimitGb: currentPlanLimitByUser.trafficLimitGb,
      extraTrafficGb: currentPlanLimitByUser.extraTrafficGb,
      periodBytes: sql<string>`coalesce(sum(${vpnKeysTable.periodUpBytes} + ${vpnKeysTable.periodDownBytes}), 0)`.as(
        "period_bytes",
      ),
    })
    .from(vpnKeysTable)
    .innerJoin(currentPlanLimitByUser, eq(currentPlanLimitByUser.userId, vpnKeysTable.userId))
    .where(isNull(vpnKeysTable.revokedAt))
    .groupBy(
      vpnKeysTable.userId,
      currentPlanLimitByUser.subscriptionId,
      currentPlanLimitByUser.trafficLimitGb,
      currentPlanLimitByUser.extraTrafficGb,
    );
  const usage = rawUsage.map((r) => ({ ...r, periodBytes: Number(r.periodBytes) }));

  let revokedUsers = 0;

  for (const row of usage) {
    const trafficLimitGb = row.trafficLimitGb;
    if (trafficLimitGb == null) continue;
    // Effective cap = the plan's base allowance plus any traffic the user
    // has self-service topped-up for THIS subscription period (see
    // extraTrafficGb schema comment) — buying more GB must actually raise
    // the ceiling enforcement checks against, not just be cosmetic.
    const limitBytes = (trafficLimitGb + row.extraTrafficGb) * 1024 * 1024 * 1024;
    if (row.periodBytes < limitBytes) continue;

    // Re-verify and decide atomically under a lock on the exact subscription
    // row that keyIssuance.ts and confirmPayment.ts's extra-traffic branch
    // also lock (SELECT ... FOR UPDATE on this same row). Without this, a
    // concurrent traffic top-up landing between the batch usage query above
    // and the writes below could have already raised the cap or cleared the
    // flag — and this loop, still working off the stale `usage` snapshot,
    // would revoke the user's brand-new key and immediately re-stamp the
    // block flag, leaving a paying user falsely locked out indefinitely.
    // Locking the row means whichever transaction commits first wins, and
    // the other always observes the up-to-date state.
    const decision = await jobsDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM subscriptions WHERE id = ${row.subscriptionId} FOR UPDATE`);

      const [freshSub] = await tx
        .select({
          status: subscriptionsTable.status,
          extraTrafficGb: subscriptionsTable.extraTrafficGb,
          trafficLimitExceededAt: subscriptionsTable.trafficLimitExceededAt,
        })
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.id, row.subscriptionId));
      if (!freshSub || freshSub.status !== "active") return { act: false as const };

      const [{ freshPeriodBytes }] = await tx
        .select({
          freshPeriodBytes: sql<string>`coalesce(sum(${vpnKeysTable.periodUpBytes} + ${vpnKeysTable.periodDownBytes}), 0)`,
        })
        .from(vpnKeysTable)
        .where(and(eq(vpnKeysTable.userId, row.userId), isNull(vpnKeysTable.revokedAt)));

      const freshLimitBytes = (trafficLimitGb + freshSub.extraTrafficGb) * 1024 * 1024 * 1024;
      if (Number(freshPeriodBytes) < freshLimitBytes) {
        // A concurrent top-up (or renewal) already resolved this since the
        // batch query ran — nothing to revoke, nothing to flag.
        return { act: false as const };
      }

      const keysToRevoke = await tx
        .select({ key: vpnKeysTable, node: vpnNodesTable })
        .from(vpnKeysTable)
        .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
        .where(and(eq(vpnKeysTable.userId, row.userId), isNull(vpnKeysTable.revokedAt)));
      if (keysToRevoke.length === 0) return { act: false as const };

      // DB first (source of truth), Xray cleanup after commit — same
      // ordering as the user/admin revoke routes (see project memory:
      // vpn-key-revoke-write-order) and it keeps this lock held only as
      // long as the writes below, not any network calls.
      await tx
        .update(vpnKeysTable)
        .set({ revokedAt: now, revokedReason: "traffic_limit", xrayCleanupPendingAt: now })
        .where(and(eq(vpnKeysTable.userId, row.userId), isNull(vpnKeysTable.revokedAt)));

      // Persist the "blocked" flag on the subscription itself — this is what
      // closes the reissue loophole: keyIssuance.ts refuses to issue a brand
      // new key (which would start at 0 period bytes) while this is set, so
      // simply revoking-and-reissuing a device no longer bypasses the cap.
      // Only set it if not already set here (we hold the lock, so this can't
      // race a top-up clearing it — that transaction would already have
      // committed or is still blocked behind us).
      if (!freshSub.trafficLimitExceededAt) {
        await tx
          .update(subscriptionsTable)
          .set({ trafficLimitExceededAt: now })
          .where(eq(subscriptionsTable.id, row.subscriptionId));
      }

      return { act: true as const, keysToRevoke };
    });

    if (!decision.act) continue;

    for (const { key, node } of decision.keysToRevoke) {
      if (node.managementApiUrl) {
        try {
          await removeRemoteXrayClient(node, key.uuid);
        } catch (err) {
          logger.error({ err, uuid: key.uuid, userId: row.userId }, "Failed to remove client from remote node after traffic limit exceeded");
        }
      } else if (isLocalXrayEnabled()) {
        try {
          await removeXrayClient(key.uuid);
        } catch (err) {
          logger.error({ err, uuid: key.uuid, userId: row.userId }, "Failed to remove client from Xray after traffic limit exceeded");
        }
      }
    }

    revokedUsers += 1;
    logger.info(
      { userId: row.userId, periodBytes: row.periodBytes, limitBytes },
      "Revoked VPN keys: user exceeded plan's traffic limit for the current period",
    );
  }

  return revokedUsers;
}

// Serializes every flush (scheduled interval ticks AND the ad-hoc flush
// reloadXray() triggers before restarting Xray — see xray.ts) through a
// single queue, so a read (pollUserTrafficCounters) always happens strictly
// after the previous flush's write (applyTrafficDeltas) has committed.
//
// This ordering is what makes applyTrafficDeltas' `current < lastSeen`
// restart check sound. Without it, two flushes racing (e.g. the 60s
// interval firing at the same moment xray.ts triggers a pre-restart flush)
// could commit out of order: an older, smaller gRPC snapshot committing
// *after* a newer, larger one had already advanced `lastSeen` would make
// `current < lastSeen` true for a reason that has nothing to do with an
// actual Xray restart, and the whole (stale) `current` would be double
// counted on top of what the newer snapshot already credited. Serializing
// read+write as one unit per flush guarantees `current` can only be less
// than `lastSeen` when Xray's own counter was genuinely reset to 0 by a
// real process restart in between.
let flushQueue: Promise<void> = Promise.resolve();

async function doFlushTrafficDeltas(): Promise<{ polledNodes: string[] }> {
  const polledNodes: string[] = [];

  // Poll local Xray (if running on this container).
  const allCounters = await pollUserTrafficCounters();
  if (isLocalXrayEnabled()) {
    polledNodes.push("local");
  }

  // Poll all active remote nodes in parallel. Their UUIDs are globally unique
  // and disjoint from local keys, so maps can be merged without collisions.
  const remoteNodes = await jobsDb
    .select({
      managementApiUrl: vpnNodesTable.managementApiUrl,
      managementApiSecret: vpnNodesTable.managementApiSecret,
      name: vpnNodesTable.name,
    })
    .from(vpnNodesTable)
    .where(and(eq(vpnNodesTable.isActive, true), isNotNull(vpnNodesTable.managementApiUrl)));

  const remoteResults = await Promise.all(
    remoteNodes.map((node) => pollRemoteNodeStats(node)),
  );
  for (let i = 0; i < remoteResults.length; i++) {
    for (const [uuid, counts] of remoteResults[i]) {
      allCounters.set(uuid, counts);
    }
    polledNodes.push(remoteNodes[i].name);
  }

  await applyTrafficDeltas(allCounters);
  return { polledNodes };
}

/**
 * Reads Xray's current absolute counters and commits their deltas into
 * Postgres, without running traffic-limit enforcement. Exposed separately
 * from the interval job so xray.ts can call it right before a deliberate
 * `supervisorctl restart xray` (see reloadXray()) — flushing here means
 * whatever accumulated since the last scheduled poll is safely committed
 * before Xray's in-memory counters reset to 0, rather than only being
 * picked up (as `current` rather than a proper delta, see applyTrafficDeltas)
 * on the next scheduled poll.
 *
 * Queued behind any flush already in progress — see flushQueue above for
 * why strict ordering (not just mutual exclusion) matters here.
 */
export function flushTrafficDeltas(): Promise<{ polledNodes: string[] }> {
  const run = flushQueue.then(doFlushTrafficDeltas, doFlushTrafficDeltas);
  // Swallow so one failed flush doesn't permanently wedge the queue for
  // every flush queued behind it; each caller still observes its own
  // rejection via the returned `run` promise.
  flushQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function startTrafficPollingJob(): NodeJS.Timeout {
  const run = () => {
    flushTrafficDeltas()
      .then(({ polledNodes }) => enforceTrafficLimits().then((revokedUsers) => ({ polledNodes, revokedUsers })))
      .then(({ polledNodes }) => {
        const now = new Date();
        const prevFailures = trafficPollingHealth.consecutiveFailures;
        const prevLastSuccessAt = trafficPollingHealth.lastSuccessAt;

        trafficPollingHealth.lastSuccessAt = now;
        trafficPollingHealth.consecutiveFailures = 0;
        trafficPollingHealth.lastError = null;

        // Log a structured INFO event whenever polling recovers after one or
        // more consecutive failures — this creates an audit trail of how long
        // traffic data was potentially untracked and which nodes came back.
        if (prevFailures > 0) {
          const gapMs = prevLastSuccessAt ? now.getTime() - prevLastSuccessAt.getTime() : null;
          logger.info(
            {
              consecutiveFailuresRecovered: prevFailures,
              gapMs,
              gapSeconds: gapMs != null ? Math.round(gapMs / 1000) : null,
              lastSuccessAt: prevLastSuccessAt,
              recoveredAt: now,
              polledNodes,
            },
            "Traffic polling recovered after gap: consecutive failures cleared",
          );
        }
      })
      .catch((err) => {
        trafficPollingHealth.consecutiveFailures += 1;
        trafficPollingHealth.lastError = err instanceof Error ? err.message : String(err);
        logger.error({ err }, "Traffic polling job failed");
      });
  };

  run();

  return setInterval(run, TRAFFIC_POLL_INTERVAL_MS);
}
