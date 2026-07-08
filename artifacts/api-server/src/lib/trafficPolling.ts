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
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, vpnKeysTable } from "@workspace/db";
import { pollUserTrafficCounters } from "./xrayStats";
import { isLocalXrayEnabled, removeXrayClient } from "./xray";
import { logger } from "./logger";

const TRAFFIC_POLL_INTERVAL_MS = 60 * 1000; // 1 minute

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
 */
export async function applyTrafficDeltas(
  counters: Map<string, { uplinkBytes: number; downlinkBytes: number }>,
): Promise<void> {
  const entries = [...counters].filter(([, c]) => c.uplinkBytes !== 0 || c.downlinkBytes !== 0);
  if (entries.length === 0) return;

  await db.transaction(async (tx) => {
    for (const [uuid, { uplinkBytes, downlinkBytes }] of entries) {
      const upDelta = sql`(case when ${uplinkBytes} >= ${vpnKeysTable.lastSeenUpBytes} then ${uplinkBytes} - ${vpnKeysTable.lastSeenUpBytes} else ${uplinkBytes} end)`;
      const downDelta = sql`(case when ${downlinkBytes} >= ${vpnKeysTable.lastSeenDownBytes} then ${downlinkBytes} - ${vpnKeysTable.lastSeenDownBytes} else ${downlinkBytes} end)`;
      await tx
        .update(vpnKeysTable)
        .set({
          trafficUpBytes: sql`${vpnKeysTable.trafficUpBytes} + ${upDelta}`,
          trafficDownBytes: sql`${vpnKeysTable.trafficDownBytes} + ${downDelta}`,
          periodUpBytes: sql`${vpnKeysTable.periodUpBytes} + ${upDelta}`,
          periodDownBytes: sql`${vpnKeysTable.periodDownBytes} + ${downDelta}`,
          lastSeenUpBytes: uplinkBytes,
          lastSeenDownBytes: downlinkBytes,
        })
        .where(eq(vpnKeysTable.uuid, uuid));
    }
  });
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
  const currentPlanLimitByUser = db.$with("current_plan_limit_by_user").as(
    db
      .selectDistinctOn([subscriptionsTable.userId], {
        userId: subscriptionsTable.userId,
        trafficLimitGb: plansTable.trafficLimitGb,
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
  const rawUsage = await db
    .with(currentPlanLimitByUser)
    .select({
      userId: vpnKeysTable.userId,
      trafficLimitGb: currentPlanLimitByUser.trafficLimitGb,
      periodBytes: sql<string>`coalesce(sum(${vpnKeysTable.periodUpBytes} + ${vpnKeysTable.periodDownBytes}), 0)`.as(
        "period_bytes",
      ),
    })
    .from(vpnKeysTable)
    .innerJoin(currentPlanLimitByUser, eq(currentPlanLimitByUser.userId, vpnKeysTable.userId))
    .where(isNull(vpnKeysTable.revokedAt))
    .groupBy(vpnKeysTable.userId, currentPlanLimitByUser.trafficLimitGb);
  const usage = rawUsage.map((r) => ({ ...r, periodBytes: Number(r.periodBytes) }));

  let revokedUsers = 0;

  for (const row of usage) {
    if (row.trafficLimitGb == null) continue;
    const limitBytes = row.trafficLimitGb * 1024 * 1024 * 1024;
    if (row.periodBytes < limitBytes) continue;

    const keysToRevoke = await db
      .select()
      .from(vpnKeysTable)
      .where(and(eq(vpnKeysTable.userId, row.userId), isNull(vpnKeysTable.revokedAt)));

    if (keysToRevoke.length === 0) continue;

    for (const key of keysToRevoke) {
      if (isLocalXrayEnabled()) {
        try {
          await removeXrayClient(key.uuid);
        } catch (err) {
          logger.error({ err, uuid: key.uuid, userId: row.userId }, "Failed to remove client from Xray after traffic limit exceeded");
        }
      }
    }

    await db
      .update(vpnKeysTable)
      .set({ revokedAt: now })
      .where(and(eq(vpnKeysTable.userId, row.userId), isNull(vpnKeysTable.revokedAt)));

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

async function doFlushTrafficDeltas(): Promise<void> {
  const counters = await pollUserTrafficCounters();
  await applyTrafficDeltas(counters);
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
export function flushTrafficDeltas(): Promise<void> {
  const run = flushQueue.then(doFlushTrafficDeltas, doFlushTrafficDeltas);
  // Swallow so one failed flush doesn't permanently wedge the queue for
  // every flush queued behind it; each caller still observes its own
  // rejection via the returned `run` promise.
  flushQueue = run.catch(() => undefined);
  return run;
}

export function startTrafficPollingJob(): NodeJS.Timeout {
  const run = () => {
    flushTrafficDeltas()
      .then(() => enforceTrafficLimits())
      .catch((err) => {
        logger.error({ err }, "Traffic polling job failed");
      });
  };

  run();

  return setInterval(run, TRAFFIC_POLL_INTERVAL_MS);
}
