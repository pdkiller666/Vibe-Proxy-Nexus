import { Router, type IRouter } from "express";
import { and, count, eq, gte, inArray, sql, sum } from "drizzle-orm";
import { db, paymentsTable, plansTable, subscriptionsTable, supportTicketsTable, usersTable, vpnKeysTable } from "@workspace/db";
import { GetAdminDashboardSummaryResponse } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { ONLINE_THRESHOLD_MS } from "../../lib/session";

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
    db.select({ value: count() }).from(usersTable).where(gte(usersTable.lastActiveAt, onlineThreshold)),
    db.select({ value: count() }).from(usersTable).where(gte(usersTable.createdAt, startOf7Days)),
    db.select({ value: count() }).from(usersTable).where(gte(usersTable.createdAt, startOf30Days)),
    db
      .select({ planName: plansTable.name, count: count() })
      .from(subscriptionsTable)
      .innerJoin(plansTable, eq(plansTable.id, subscriptionsTable.planId))
      .where(eq(subscriptionsTable.status, "active"))
      .groupBy(plansTable.name),
    db
      .select({
        // AT TIME ZONE 'UTC' forces UTC date extraction regardless of the
        // Postgres session timezone — must match the backend loop's toISOString()
        // which also produces UTC dates.
        date: sql<string>`to_char(${paymentsTable.confirmedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        amountRub: sum(paymentsTable.amountRub),
      })
      .from(paymentsTable)
      .where(and(eq(paymentsTable.status, "confirmed"), gte(paymentsTable.confirmedAt, startOf14Days)))
      .groupBy(sql`to_char(${paymentsTable.confirmedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`),
  ]);

  const revenueByDate = new Map(revenueByDayRows.map((r) => [r.date, Number(r.amountRub ?? 0)]));
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
