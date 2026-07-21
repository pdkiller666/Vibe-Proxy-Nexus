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
    activityRows,
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
    // Single query that mirrors the three-state badge logic in admin/users.ts:
    // - "vpn"  → max(lastTrafficAt) within 10 min AND more recent than lastActiveAt
    // - "site" → lastActiveAt within 5 min AND no fresher VPN signal
    // The two groups are mutually exclusive so they sum to activeNow.
    db.execute<{ active_on_vpn: string; active_on_site: string }>(sql`
      SELECT
        COUNT(DISTINCT CASE WHEN activity = 'vpn'  THEN user_id END)::int AS active_on_vpn,
        COUNT(DISTINCT CASE WHEN activity = 'site' THEN user_id END)::int AS active_on_site
      FROM (
        SELECT
          u.id AS user_id,
          CASE
            WHEN MAX(k.last_traffic_at) >= ${vpnOnlineThreshold}
                 AND (u.last_active_at IS NULL OR MAX(k.last_traffic_at) >= u.last_active_at)
              THEN 'vpn'
            WHEN u.last_active_at >= ${onlineThreshold}
                 AND (MAX(k.last_traffic_at) IS NULL OR MAX(k.last_traffic_at) < ${vpnOnlineThreshold}
                      OR u.last_active_at > MAX(k.last_traffic_at))
              THEN 'site'
            ELSE NULL
          END AS activity
        FROM ${usersTable} u
        LEFT JOIN ${vpnKeysTable} k
          ON k.user_id = u.id AND k.revoked_at IS NULL
        GROUP BY u.id, u.last_active_at
      ) t
    `),
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
      activeOnVpn: Number(activityRows.rows[0]?.active_on_vpn ?? 0),
      activeOnSite: Number(activityRows.rows[0]?.active_on_site ?? 0),
      activeNow: Number(activityRows.rows[0]?.active_on_vpn ?? 0) + Number(activityRows.rows[0]?.active_on_site ?? 0),
      newUsersLast7Days: newUsersLast7Days?.value ?? 0,
      newUsersLast30Days: newUsersLast30Days?.value ?? 0,
      planDistribution: planDistributionRows,
      revenueByDay,
    }),
  );
});

export default router;
