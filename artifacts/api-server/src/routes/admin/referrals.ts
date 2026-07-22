import { Router, type IRouter } from "express";
import { eq, isNotNull, sql } from "drizzle-orm";
import { db, balanceTransactionsTable, paymentsTable, usersTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

/**
 * GET /admin/referrals
 * Returns a ranked list of referrers: who invited whom and how much revenue they brought.
 */
router.get("/admin/referrals", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  // All users who have at least one referred user.
  const referrers = await db
    .selectDistinct({ referrerId: usersTable.referredByUserId })
    .from(usersTable)
    .where(isNotNull(usersTable.referredByUserId));

  if (referrers.length === 0) {
    res.json([]);
    return;
  }

  const referrerIds = referrers.map((r) => r.referrerId as number);

  // Per-referrer aggregates in a single pass.
  const rows = await db.execute<{
    referrer_id: number;
    referrer_email: string;
    referrer_name: string | null;
    referred_count: string;
    total_revenue_kopecks: string;
    commission_kopecks: string;
  }>(sql`
    SELECT
      u.id                                                          AS referrer_id,
      u.email                                                       AS referrer_email,
      u.name                                                        AS referrer_name,
      COUNT(DISTINCT ref.id)::int                                   AS referred_count,
      COALESCE(SUM(DISTINCT_REVENUE.amount_rub), 0) * 100          AS total_revenue_kopecks,
      COALESCE(comm.commission_kopecks, 0)                         AS commission_kopecks
    FROM ${usersTable} u
    -- referred users
    JOIN ${usersTable} ref ON ref.referred_by_user_id = u.id
    -- sum of confirmed payments by referred users
    LEFT JOIN LATERAL (
      SELECT SUM(p.amount_rub) AS amount_rub
      FROM ${paymentsTable} p
      WHERE p.user_id = ref.id AND p.status = 'confirmed'
    ) AS DISTINCT_REVENUE ON TRUE
    -- referral commissions credited to this referrer
    LEFT JOIN LATERAL (
      SELECT SUM(bt.amount_kopecks) AS commission_kopecks
      FROM ${balanceTransactionsTable} bt
      WHERE bt.user_id = u.id AND bt.type = 'referral'
    ) AS comm ON TRUE
    WHERE u.id = ANY(${referrerIds}::int[])
    GROUP BY u.id, u.email, u.name, comm.commission_kopecks
    ORDER BY referred_count DESC, total_revenue_kopecks DESC
  `);

  res.json(
    rows.rows.map((r) => ({
      userId: r.referrer_id,
      email: r.referrer_email,
      name: r.referrer_name,
      referredCount: Number(r.referred_count),
      totalRevenueRub: Math.round(Number(r.total_revenue_kopecks) / 100),
      commissionsRub: Math.round(Number(r.commission_kopecks) / 100),
    })),
  );
});

export default router;
