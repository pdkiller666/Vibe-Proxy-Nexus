import { Router, type IRouter } from "express";
import { and, count, eq, gte, sum } from "drizzle-orm";
import { db, paymentsTable, subscriptionsTable, usersTable, vpnKeysTable } from "@workspace/db";
import { GetAdminDashboardSummaryResponse } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

router.get("/admin/dashboard/summary", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [[totalUsers], [activeSubscriptions], [pendingPayments], [monthlyRevenue], [totalVpnKeys]] =
    await Promise.all([
      db.select({ value: count() }).from(usersTable),
      db.select({ value: count() }).from(subscriptionsTable).where(eq(subscriptionsTable.status, "active")),
      db.select({ value: count() }).from(paymentsTable).where(eq(paymentsTable.status, "pending")),
      db
        .select({ value: sum(paymentsTable.amountRub) })
        .from(paymentsTable)
        .where(and(eq(paymentsTable.status, "confirmed"), gte(paymentsTable.confirmedAt, startOfMonth))),
      db.select({ value: count() }).from(vpnKeysTable),
    ]);

  res.json(
    GetAdminDashboardSummaryResponse.parse({
      totalUsers: totalUsers?.value ?? 0,
      activeSubscriptions: activeSubscriptions?.value ?? 0,
      pendingPayments: pendingPayments?.value ?? 0,
      monthlyRevenueRub: Number(monthlyRevenue?.value ?? 0),
      totalVpnKeys: totalVpnKeys?.value ?? 0,
    }),
  );
});

export default router;
