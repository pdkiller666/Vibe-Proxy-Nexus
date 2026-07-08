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
import { pollUserTrafficDeltas } from "./xrayStats";
import { isLocalXrayEnabled, removeXrayClient } from "./xray";
import { logger } from "./logger";

const TRAFFIC_POLL_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Applies queried uplink/downlink deltas (keyed by VPN key UUID) onto the
 * matching vpn_keys rows, adding to both the lifetime and current-period
 * counters. Safe to call with an empty map (no-op).
 *
 * Xray's QueryStats(reset: true) already zeroed its own counters the moment
 * it returned this map, so these deltas exist nowhere else. Applying them
 * inside a single transaction means we either commit the whole batch or
 * none of it — a partial failure can't silently attribute one user's
 * traffic to another or leave the table in a half-updated state. A crash
 * between the gRPC call and the commit can still lose that one poll's
 * deltas (there is no durable outbox), but that is a bounded, ~1-minute
 * worth of undercounting rather than corruption — acceptable for this
 * feature's accuracy requirements.
 */
export async function applyTrafficDeltas(
  deltas: Map<string, { uplinkBytes: number; downlinkBytes: number }>,
): Promise<void> {
  const entries = [...deltas].filter(([, d]) => d.uplinkBytes !== 0 || d.downlinkBytes !== 0);
  if (entries.length === 0) return;

  await db.transaction(async (tx) => {
    for (const [uuid, { uplinkBytes, downlinkBytes }] of entries) {
      await tx
        .update(vpnKeysTable)
        .set({
          trafficUpBytes: sql`${vpnKeysTable.trafficUpBytes} + ${uplinkBytes}`,
          trafficDownBytes: sql`${vpnKeysTable.trafficDownBytes} + ${downlinkBytes}`,
          periodUpBytes: sql`${vpnKeysTable.periodUpBytes} + ${uplinkBytes}`,
          periodDownBytes: sql`${vpnKeysTable.periodDownBytes} + ${downlinkBytes}`,
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

export function startTrafficPollingJob(): NodeJS.Timeout {
  const run = () => {
    pollUserTrafficDeltas()
      .then((deltas) => applyTrafficDeltas(deltas))
      .then(() => enforceTrafficLimits())
      .catch((err) => {
        logger.error({ err }, "Traffic polling job failed");
      });
  };

  run();

  return setInterval(run, TRAFFIC_POLL_INTERVAL_MS);
}
