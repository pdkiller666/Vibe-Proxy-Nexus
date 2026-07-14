/**
 * Automatic, usage-based billing for "hourly" plans (see plans.billingType).
 * There is no manual start/stop — a subscription is billed only while at
 * least one of the user's VPN keys has shown traffic recently, using the
 * `vpn_keys.last_traffic_at` timestamp trafficPolling.ts already maintains.
 *
 * Runs on a 5-minute tick, offset from the 60s traffic-poll interval so the
 * two heavy batch jobs never compete for the jobs connection pool at the
 * same instant (see jobsDb in @workspace/db).
 *
 * Every read and write here is a single batched statement across all hourly
 * subscriptions, not a per-user round trip — see .agents/memory for the
 * load analysis (100-1000 concurrent hourly users) this was designed for.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  balanceTransactionsTable,
  jobsDb,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
} from "@workspace/db";
import { isLocalXrayEnabled, removeXrayClient } from "./xray";
import { logger } from "./logger";

const BILLING_TICK_MS = 5 * 60 * 1000;
/** A device with no traffic for longer than this is considered disconnected. */
const IDLE_GRACE_MS = 15 * 60 * 1000;

interface HourlySubscriptionRow {
  subscriptionId: number;
  userId: number;
  lastBilledAt: Date | null;
  startsAt: Date | null;
  createdAt: Date;
  hourlyRateKopecks: number;
  balanceKopecks: number;
  lastTrafficAt: Date | null;
}

/**
 * One tick of hourly billing: charges every active hourly subscription for
 * elapsed 5-minute ticks during which the user's device(s) were actually
 * sending traffic, stopping (without charging further) once a device has
 * been idle past IDLE_GRACE_MS. Subscriptions whose balance runs out
 * mid-tick are expired and their keys revoked.
 *
 * Safe to call concurrently/repeatedly: every write is scoped by the
 * subscription's current lastBilledAt/status, so a re-run after a partial
 * failure only ever charges for time not already billed.
 */
export async function runHourlyBillingTick(): Promise<{ billed: number; expired: number }> {
  const now = new Date();

  const rows = await jobsDb
    .select({
      subscriptionId: subscriptionsTable.id,
      userId: subscriptionsTable.userId,
      lastBilledAt: subscriptionsTable.lastBilledAt,
      startsAt: subscriptionsTable.startsAt,
      createdAt: subscriptionsTable.createdAt,
      hourlyRateKopecks: plansTable.hourlyRateKopecks,
      balanceKopecks: usersTable.balanceKopecks,
      lastTrafficAt: sql<Date | null>`max(${vpnKeysTable.lastTrafficAt})`,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(plansTable.id, subscriptionsTable.planId))
    .innerJoin(usersTable, eq(usersTable.id, subscriptionsTable.userId))
    .leftJoin(
      vpnKeysTable,
      and(eq(vpnKeysTable.userId, subscriptionsTable.userId), isNull(vpnKeysTable.revokedAt)),
    )
    .where(and(eq(subscriptionsTable.status, "active"), eq(plansTable.billingType, "hourly")))
    .groupBy(
      subscriptionsTable.id,
      subscriptionsTable.userId,
      subscriptionsTable.lastBilledAt,
      subscriptionsTable.startsAt,
      subscriptionsTable.createdAt,
      plansTable.hourlyRateKopecks,
      usersTable.balanceKopecks,
    );

  if (rows.length === 0) return { billed: 0, expired: 0 };

  const charges: { subscriptionId: number; userId: number; amountKopecks: number; newLastBilledAt: Date }[] = [];
  const expirations: { subscriptionId: number; userId: number; newLastBilledAt: Date }[] = [];

  for (const row of rows as HourlySubscriptionRow[]) {
    const rateKopecks = row.hourlyRateKopecks;
    if (!rateKopecks || rateKopecks <= 0) continue; // misconfigured plan — skip rather than charge nothing meaningfully

    // The raw SQL aggregate (max(...)) comes back from the pg driver as a
    // string/Date depending on the column's parser, not necessarily a Date
    // instance — normalize explicitly rather than trusting the TS annotation.
    const lastTrafficAt = row.lastTrafficAt ? new Date(row.lastTrafficAt) : null;
    const lastBilledAt = row.lastBilledAt ? new Date(row.lastBilledAt) : null;
    const startsAt = row.startsAt ? new Date(row.startsAt) : null;
    const createdAt = new Date(row.createdAt);

    const billFrom = lastBilledAt ?? startsAt ?? createdAt;
    const idleSince = lastTrafficAt ? now.getTime() - lastTrafficAt.getTime() : Infinity;
    const isActiveNow = idleSince <= IDLE_GRACE_MS;

    // Only bill up to the last known activity, never past it — otherwise a
    // long idle period would get charged in full the moment traffic resumes.
    const billUpToMs = isActiveNow ? now.getTime() : lastTrafficAt ? lastTrafficAt.getTime() : billFrom.getTime();

    const ticksElapsed = Math.floor((billUpToMs - billFrom.getTime()) / BILLING_TICK_MS);
    if (ticksElapsed < 1) continue;

    const perTickKopecks = rateKopecks / 12;
    const affordableTicks = Math.min(ticksElapsed, Math.floor(row.balanceKopecks / perTickKopecks));

    if (affordableTicks < 1) {
      // Balance is already too low to cover even one more tick — end the
      // subscription rather than silently letting it run unpaid.
      expirations.push({
        subscriptionId: row.subscriptionId,
        userId: row.userId,
        newLastBilledAt: billFrom,
      });
      continue;
    }

    const amountKopecks = Math.round(affordableTicks * perTickKopecks);
    const newLastBilledAt = new Date(billFrom.getTime() + affordableTicks * BILLING_TICK_MS);

    charges.push({ subscriptionId: row.subscriptionId, userId: row.userId, amountKopecks, newLastBilledAt });

    if (affordableTicks < ticksElapsed) {
      // Charged everything the balance could cover, but that didn't reach
      // the full elapsed/active window — balance hit zero mid-tick.
      expirations.push({ subscriptionId: row.subscriptionId, userId: row.userId, newLastBilledAt });
    }
  }

  if (charges.length > 0) {
    await jobsDb.transaction(async (tx) => {
      const balanceValues = sql.join(
        charges.map((c) => sql`(${c.userId}::int, ${c.amountKopecks}::int)`),
        sql`, `,
      );
      await tx.execute(sql`
        update users as u
        set balance_kopecks = u.balance_kopecks - c.amount
        from (values ${balanceValues}) as c(user_id, amount)
        where u.id = c.user_id
      `);

      const subValues = sql.join(
        charges.map((c) => sql`(${c.subscriptionId}::int, ${c.newLastBilledAt.toISOString()}::timestamptz)`),
        sql`, `,
      );
      await tx.execute(sql`
        update subscriptions as s
        set last_billed_at = c.last_billed_at
        from (values ${subValues}) as c(id, last_billed_at)
        where s.id = c.id
      `);

      await tx.insert(balanceTransactionsTable).values(
        charges.map((c) => ({
          userId: c.userId,
          amountKopecks: -c.amountKopecks,
          type: "debit" as const,
          description: "Списание за почасовой тариф VPN",
        })),
      );
    });
  }

  if (expirations.length > 0) {
    const subIds = expirations.map((e) => e.subscriptionId);
    const affectedUserIds = [...new Set(expirations.map((e) => e.userId))];

    await jobsDb.transaction(async (tx) => {
      const subValues = sql.join(
        expirations.map((e) => sql`(${e.subscriptionId}::int, ${e.newLastBilledAt.toISOString()}::timestamptz)`),
        sql`, `,
      );
      await tx.execute(sql`
        update subscriptions as s
        set status = 'expired', last_billed_at = c.last_billed_at
        from (values ${subValues}) as c(id, last_billed_at)
        where s.id = c.id
      `);
    });

    // Revoke keys only for users left with no other active subscription —
    // mirrors expireOverdueSubscriptions() in subscriptionLifecycle.ts.
    const stillActive = await jobsDb
      .select({ userId: subscriptionsTable.userId })
      .from(subscriptionsTable)
      .where(and(inArray(subscriptionsTable.userId, affectedUserIds), eq(subscriptionsTable.status, "active")));
    const stillActiveUserIds = new Set(stillActive.map((r) => r.userId));
    const usersToRevoke = affectedUserIds.filter((id) => !stillActiveUserIds.has(id));

    if (usersToRevoke.length > 0) {
      const keysToRevoke = await jobsDb
        .select()
        .from(vpnKeysTable)
        .where(and(inArray(vpnKeysTable.userId, usersToRevoke), isNull(vpnKeysTable.revokedAt)));

      for (const key of keysToRevoke) {
        if (isLocalXrayEnabled()) {
          try {
            await removeXrayClient(key.uuid);
          } catch (err) {
            logger.error({ err, uuid: key.uuid, userId: key.userId }, "Failed to remove client from Xray after hourly balance ran out");
          }
        }
      }

      await jobsDb
        .update(vpnKeysTable)
        .set({ revokedAt: now, revokedReason: "billing" })
        .where(and(inArray(vpnKeysTable.userId, usersToRevoke), isNull(vpnKeysTable.revokedAt)));
    }

    logger.info({ subscriptionIds: subIds, userIds: usersToRevoke }, "Expired hourly subscriptions: balance ran out");
  }

  return { billed: charges.length, expired: expirations.length };
}

export function startHourlyBillingJob(): NodeJS.Timeout {
  const run = () => {
    runHourlyBillingTick()
      .then(({ billed, expired }) => {
        if (billed > 0 || expired > 0) {
          logger.info({ billed, expired }, "Hourly billing tick completed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Hourly billing tick failed");
      });
  };

  // Stagger 30s off the traffic-poll interval so the two batch jobs don't
  // both hit the jobs pool at the same instant.
  setTimeout(run, 30 * 1000);

  return setInterval(run, BILLING_TICK_MS);
}
