/**
 * Admin diagnostic endpoint for the hourly billing job.
 *
 * GET /admin/debug/billing  — returns exactly what the billing loop would see
 * for every active hourly subscription, including the computed tick counts and
 * the reason a subscription would be skipped, WITHOUT actually charging anyone.
 *
 * Use this when billing appears to have stalled for a user: call the endpoint,
 * inspect the "skipReason" field, and the fix becomes obvious.
 */
import { Router, type IRouter } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { jobsDb, plansTable, subscriptionsTable, usersTable, vpnKeysTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../../lib/auth";

const router: IRouter = Router();

const BILLING_TICK_MS = 5 * 60 * 1000;
const IDLE_GRACE_MS = 15 * 60 * 1000;

router.get("/admin/debug/billing", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const now = new Date();

  const rows = await jobsDb
    .select({
      subscriptionId: subscriptionsTable.id,
      userId: subscriptionsTable.userId,
      email: usersTable.email,
      status: subscriptionsTable.status,
      planName: plansTable.name,
      billingType: plansTable.billingType,
      hourlyRateKopecks: plansTable.hourlyRateKopecks,
      lastBilledAt: subscriptionsTable.lastBilledAt,
      startsAt: subscriptionsTable.startsAt,
      createdAt: subscriptionsTable.createdAt,
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
      usersTable.email,
      subscriptionsTable.status,
      plansTable.name,
      plansTable.billingType,
      plansTable.hourlyRateKopecks,
      subscriptionsTable.lastBilledAt,
      subscriptionsTable.startsAt,
      subscriptionsTable.createdAt,
      usersTable.balanceKopecks,
    );

  const result = rows.map((row) => {
    const rateKopecks = row.hourlyRateKopecks;

    if (!rateKopecks || rateKopecks <= 0) {
      return {
        subscriptionId: row.subscriptionId,
        userId: row.userId,
        email: row.email,
        planName: row.planName,
        hourlyRateKopecks: rateKopecks,
        lastBilledAt: row.lastBilledAt,
        startsAt: row.startsAt,
        lastTrafficAt: row.lastTrafficAt,
        balanceKopecks: row.balanceKopecks,
        balanceRub: (row.balanceKopecks / 100).toFixed(2),
        skipReason: "PLAN_RATE_NULL_OR_ZERO",
        ticksElapsed: null,
        affordableTicks: null,
        wouldChargeTicks: null,
        wouldChargeKopecks: null,
        wouldChargeRub: null,
        nowServer: now,
      };
    }

    const lastTrafficAt = row.lastTrafficAt ? new Date(row.lastTrafficAt) : null;
    const lastBilledAt = row.lastBilledAt ? new Date(row.lastBilledAt) : null;
    const startsAt = row.startsAt ? new Date(row.startsAt) : null;
    const createdAt = new Date(row.createdAt);

    const billFrom = lastBilledAt ?? startsAt ?? createdAt;
    const idleSinceMs = lastTrafficAt ? now.getTime() - lastTrafficAt.getTime() : Infinity;
    const isActiveNow = idleSinceMs <= IDLE_GRACE_MS;
    const billUpToMs = isActiveNow ? now.getTime() : lastTrafficAt ? lastTrafficAt.getTime() : billFrom.getTime();

    const ticksElapsed = Math.floor((billUpToMs - billFrom.getTime()) / BILLING_TICK_MS);

    if (ticksElapsed < 1) {
      return {
        subscriptionId: row.subscriptionId,
        userId: row.userId,
        email: row.email,
        planName: row.planName,
        hourlyRateKopecks: rateKopecks,
        lastBilledAt: lastBilledAt,
        startsAt: startsAt,
        lastTrafficAt: lastTrafficAt,
        balanceKopecks: row.balanceKopecks,
        balanceRub: (row.balanceKopecks / 100).toFixed(2),
        billFrom,
        billUpTo: new Date(billUpToMs),
        isActiveNow,
        idleSinceMs: idleSinceMs === Infinity ? null : idleSinceMs,
        lastBilledAtInFuture: lastBilledAt ? lastBilledAt > now : false,
        skipReason: lastBilledAt && lastBilledAt > now
          ? "LAST_BILLED_AT_IN_FUTURE"
          : isActiveNow
          ? "TICKS_ELAPSED_ZERO_ACTIVE"
          : "TICKS_ELAPSED_ZERO_IDLE",
        ticksElapsed,
        affordableTicks: null,
        wouldChargeTicks: null,
        wouldChargeKopecks: null,
        wouldChargeRub: null,
        nowServer: now,
      };
    }

    const perTickKopecks = rateKopecks / 12;
    const affordableTicks = Math.min(ticksElapsed, Math.floor(row.balanceKopecks / perTickKopecks));
    const wouldChargeTicks = affordableTicks;
    const wouldChargeKopecks = Math.round(affordableTicks * perTickKopecks);
    const wouldExpire = affordableTicks < 1;

    return {
      subscriptionId: row.subscriptionId,
      userId: row.userId,
      email: row.email,
      planName: row.planName,
      hourlyRateKopecks: rateKopecks,
      perTickKopecks,
      lastBilledAt: lastBilledAt,
      startsAt: startsAt,
      lastTrafficAt: lastTrafficAt,
      balanceKopecks: row.balanceKopecks,
      balanceRub: (row.balanceKopecks / 100).toFixed(2),
      billFrom,
      billUpTo: new Date(billUpToMs),
      isActiveNow,
      idleSinceMs: idleSinceMs === Infinity ? null : idleSinceMs,
      skipReason: wouldExpire ? "WOULD_EXPIRE_BALANCE_TOO_LOW" : null,
      ticksElapsed,
      affordableTicks,
      wouldChargeTicks,
      wouldChargeKopecks,
      wouldChargeRub: (wouldChargeKopecks / 100).toFixed(2),
      wouldExpireSubscription: wouldExpire || affordableTicks < ticksElapsed,
      nowServer: now,
    };
  });

  res.json({ count: result.length, subscriptions: result });
});

export default router;
