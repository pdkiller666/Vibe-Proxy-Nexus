import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, balanceTransactionsTable, paymentsTable, usersTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

/**
 * GET /admin/referrals
 * Returns a ranked list of referrers: who invited whom and how much revenue they brought.
 * Uses a single JOIN query — no ANY(array::int[]) which breaks in Drizzle.
 */
router.get("/admin/referrals", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  // Self-join: ref.referred_by_user_id = u.id naturally filters to users who have referrals.
  const rows = await db.execute<{
    referrer_id: number;
    referrer_email: string;
    referrer_name: string | null;
    referred_count: string;
    total_revenue_rub: string;
    commission_kopecks: string;
  }>(sql`
    SELECT
      u.id                                                        AS referrer_id,
      u.email                                                     AS referrer_email,
      u.name                                                      AS referrer_name,
      COUNT(DISTINCT ref.id)                                      AS referred_count,
      COALESCE(rev.amount_rub, 0)                                AS total_revenue_rub,
      COALESCE(comm.commission_kopecks, 0)                       AS commission_kopecks
    FROM ${usersTable} u
    -- Only users who have at least one referred user
    JOIN ${usersTable} ref ON ref.referred_by_user_id = u.id
    -- Sum confirmed payments from referred users (LATERAL avoids fan-out)
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(p.amount_rub), 0) AS amount_rub
      FROM ${paymentsTable} p
      WHERE p.user_id = ref.id AND p.status = 'confirmed'
    ) rev ON TRUE
    -- Referral commissions credited to this referrer
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(bt.amount_kopecks), 0) AS commission_kopecks
      FROM ${balanceTransactionsTable} bt
      WHERE bt.user_id = u.id AND bt.type = 'referral'
    ) comm ON TRUE
    GROUP BY u.id, u.email, u.name, rev.amount_rub, comm.commission_kopecks
    ORDER BY referred_count DESC, total_revenue_rub DESC
  `);

  res.json(
    rows.rows.map((r) => ({
      userId: r.referrer_id,
      email: r.referrer_email,
      name: r.referrer_name,
      referredCount: Number(r.referred_count),
      totalRevenueRub: Number(r.total_revenue_rub),
      commissionsRub: Math.round(Number(r.commission_kopecks) / 100),
    })),
  );
});

export default router;
