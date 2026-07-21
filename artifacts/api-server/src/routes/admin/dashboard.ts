import { Router, type IRouter } from "express";
import { and, count, eq, gte, inArray, isNull, or, sql, sum } from "drizzle-orm";
import { db, paymentsTable, plansTable, subscriptionsTable, supportTicketsTable, usersTable, vpnKeysTable } from "@workspace/db";
import { GetAdminDashboardSummaryResponse } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { ONLINE_THRESHOLD_MS } from "../../lib/session";

// Mirror the same threshold used in admin/users.ts for the per-user status badge.
const VPN_ONLINE_THRESHOLD_MS = 10 * 60 * 1000;

const router: IRouter = Router();

router.get("/admin/dashboard/summary", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  // Calendar-month boundary in UTC — consistent regardless of server locale.
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  // Rolling 30-day window — useful when the current calendar month just
  // started and the monthly figure would otherwise look misleadingly small.
  const startOf30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const startOf7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const onlineThreshold = new Date(Date.now() - ONLINE_THRESHOLD_MS);
  const vpnOnlineThreshold = new Date(Date.now() - VPN_ONLINE_THRESHOLD_MS);
  const startOf14Days = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [
    [totalUsers],
    [activeSubscriptions],
    [pendingPayments],
    [monthlyRevenue],
    [last30DaysRevenue],
    [totalVpnKeys],
    [openTickets],
    [activeNow],
    [newUsersLast7Days],
    [newUsersLast30Days],
    planDistributionRows,
    revenueByDayRows,
  ] = await Promise.all([
    db.select({ value: count() }).from(usersTable),
    db.select({ value: count() }).from(subscriptionsTable).where(eq(subscriptionsTable.status, "active")),
    db.select({ value: count() }).from(paymentsTable).where(eq(paymentsTable.status, "pending")),
    db
      .select({ value: sum(paymentsTable.amountRub) })
      .from(paymentsTable)
      .where(and(eq(paymentsTable.status, "confirmed"), gte(paymentsTable.confirmedAt, startOfMonth))),
    db
      .select({ value: sum(paymentsTable.amountRub) })
      .from(paymentsTable)
      .where(and(eq(paymentsTable.status, "confirmed"), gte(paymentsTable.confirmedAt, startOf30Days))),
    db.select({ value: count() }).from(vpnKeysTable),
    db
      .select({ value: count() })
      .from(supportTicketsTable)
      .where(inArray(supportTicketsTable.status, ["open", "answered"])),
    // Count users who are either on the site (lastActiveAt) OR using VPN
    // (lastTrafficAt on any non-revoked key). LEFT JOIN + COUNT DISTINCT avoids
    // double-counting users who have multiple active keys.
    db
      .select({ value: sql<number>`count(distinct ${usersTable.id})::int` })
      .from(usersTable)
      .leftJoin(
        vpnKeysTable,
        and(eq(vpnKeysTable.userId, usersTable.id), isNull(vpnKeysTable.revokedAt)),
      )
      .where(
        or(
          gte(usersTable.lastActiveAt, onlineThreshold),
          gte(vpnKeysTable.lastTrafficAt, vpnOnlineThreshold),
        ),
      ),
    db.select({ value: count() }).from(usersTable).where(gte(usersTable.createdAt, startOf7Days)),
    db.select({ value: count() }).from(usersTable).where(gte(usersTable.createdAt, startOf30Days)),
    db
      .select({ planName: plansTable.name, count: count() })
      .from(subscriptionsTable)
      .innerJoin(plansTable, eq(plansTable.id, subscriptionsTable.planId))
      .where(eq(subscriptionsTable.status, "active"))
      .groupBy(plansTable.name),
    // Fetch raw (confirmedAt, amountRub) pairs for the 14-day window and
    // aggregate by UTC date in JavaScript. Doing the date grouping in SQL via
    // to_char() + AT TIME ZONE proved fragile across different Postgres session
    // timezones (grouping key didn't always match the JS loop's toISOString()
    // output), so we aggregate here to guarantee consistent UTC dates.
    db
      .select({ confirmedAt: paymentsTable.confirmedAt, amountRub: paymentsTable.amountRub })
      .from(paymentsTable)
      .where(and(eq(paymentsTable.status, "confirmed"), gte(paymentsTable.confirmedAt, startOf14Days))),
  ]);

  // Group raw payment rows by UTC date — toISOString().slice(0,10) produces
  // the same "YYYY-MM-DD" format used in the loop below, so keys always match.
  const revenueByDate = new Map<string, number>();
  for (const p of revenueByDayRows) {
    if (!p.confirmedAt) continue;
    const key = p.confirmedAt.toISOString().slice(0, 10);
    revenueByDate.set(key, (revenueByDate.get(key) ?? 0) + p.amountRub);
  }

  const revenueByDay: { date: string; amountRub: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    revenueByDay.push({ date: key, amountRub: revenueByDate.get(key) ?? 0 });
  }

  res.json(
    GetAdminDashboardSummaryResponse.parse({
      totalUsers: totalUsers?.value ?? 0,
      activeSubscriptions: activeSubscriptions?.value ?? 0,
      pendingPayments: pendingPayments?.value ?? 0,
      monthlyRevenueRub: Number(monthlyRevenue?.value ?? 0),
      last30DaysRevenueRub: Number(last30DaysRevenue?.value ?? 0),
      totalVpnKeys: totalVpnKeys?.value ?? 0,
      openTickets: openTickets?.value ?? 0,
      activeNow: activeNow?.value ?? 0,
      newUsersLast7Days: newUsersLast7Days?.value ?? 0,
      newUsersLast30Days: newUsersLast30Days?.value ?? 0,
      planDistribution: planDistributionRows,
      revenueByDay,
    }),
  );
});

export default router;
