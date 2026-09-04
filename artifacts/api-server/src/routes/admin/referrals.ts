import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, balanceTransactionsTable, paymentsTable, usersTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { REFERRAL_COMMISSION_PROVIDER_VALUES } from "../../lib/referralEligibility";

const router: IRouter = Router();
const referralCommissionProvidersSql = sql.join(
  REFERRAL_COMMISSION_PROVIDER_VALUES.map((provider) => sql`${provider}`),
  sql`, `,
);

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
    paying_referred_count: string;
    total_revenue_rub: string;
    commission_kopecks: string;
  }>(sql`
    SELECT
      u.id                                                        AS referrer_id,
      u.email                                                     AS referrer_email,
      u.name                                                      AS referrer_name,
      stats.referred_count                                       AS referred_count,
      stats.paying_referred_count                                AS paying_referred_count,
      stats.subscription_revenue_rub                             AS total_revenue_rub,
      COALESCE(comm.commission_kopecks, 0)                       AS commission_kopecks
    FROM ${usersTable} u
    -- Registrations, paying referrals, and subscription revenue are kept in
    -- one aggregate so multiple payments cannot multiply the registration
    -- count. This is the same eligibility policy used when crediting
    -- commissions: confirmed, positive subscription payments from an
    -- external provider; wallet debits and free grants are excluded.
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT ref.id) AS referred_count,
        COUNT(DISTINCT p.user_id) AS paying_referred_count,
        COALESCE(SUM(p.amount_rub), 0) AS subscription_revenue_rub
      FROM ${usersTable} ref
      LEFT JOIN ${paymentsTable} p
        ON p.user_id = ref.id
       AND p.status = 'confirmed'
       AND p.type = 'subscription'
       AND p.amount_rub > 0
       AND p.provider IN (${referralCommissionProvidersSql})
      WHERE ref.referred_by_user_id = u.id
    ) stats ON TRUE
    -- Referral commissions credited to this referrer
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(bt.amount_kopecks), 0) AS commission_kopecks
      FROM ${balanceTransactionsTable} bt
      WHERE bt.user_id = u.id AND bt.type IN ('referral', 'referral_reversal')
    ) comm ON TRUE
    -- Only users who have at least one referred user.
    WHERE EXISTS (
      SELECT 1
      FROM ${usersTable} ref
      WHERE ref.referred_by_user_id = u.id
    )
    ORDER BY stats.referred_count DESC, stats.subscription_revenue_rub DESC
  `);

  res.json(
    rows.rows.map((r) => ({
      userId: r.referrer_id,
      email: r.referrer_email,
      name: r.referrer_name,
      referredCount: Number(r.referred_count),
      payingReferredCount: Number(r.paying_referred_count),
      totalRevenueRub: Number(r.total_revenue_rub),
      commissionsRub: Math.round(Number(r.commission_kopecks) / 100),
    })),
  );
});

export default router;
