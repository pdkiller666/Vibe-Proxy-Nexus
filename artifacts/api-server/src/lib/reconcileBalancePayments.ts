/**
 * reconcileBalancePayments.ts
 *
 * Crash-window safety net (ТЗ v2.1 §4.5).
 *
 * If the process dies between tx1 (balance debited, payment=pending) and the
 * confirmPaymentById call, the payment stays permanently pending and the user
 * loses funds without gaining the service. This job detects those orphans and
 * compensates: reject the payment + refund the balance.
 *
 * Safety:
 *   - A balance payment in status=pending for > STALE_BALANCE_PAYMENT_MS is
 *     GUARANTEED to be unconfirmed: normal tx1→confirm takes milliseconds.
 *   - The UPDATE uses `status='pending'` as a predicate — fully idempotent.
 *   - Runs at startup (like backfillReferralCodes) + every 10 minutes.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { db, paymentsTable, usersTable, balanceTransactionsTable } from "@workspace/db";
import { logger } from "./logger";

// Orphaned payments older than this threshold are safe to compensate.
const STALE_BALANCE_PAYMENT_MS = 5 * 60 * 1000; // 5 minutes
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes

export async function runReconciliation(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_BALANCE_PAYMENT_MS);

  // Find all stale pending balance payments
  const stale = await db
    .select({
      id: paymentsTable.id,
      userId: paymentsTable.userId,
      amountRub: paymentsTable.amountRub,
    })
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.provider, "balance"),
        eq(paymentsTable.status, "pending"),
        lt(paymentsTable.createdAt, staleBefore),
      ),
    );

  if (stale.length === 0) return;

  logger.warn({ count: stale.length }, "reconcileBalancePayments: found stale pending balance payments");

  for (const payment of stale) {
    const refundKopecks = payment.amountRub * 100;
    try {
      await db.transaction(async (tx) => {
        // Idempotent: only update if still pending
        const [updated] = await tx
          .update(paymentsTable)
          .set({ status: "rejected", rejectionReason: "balance_reconciled" })
          .where(
            and(
              eq(paymentsTable.id, payment.id),
              eq(paymentsTable.status, "pending"),
            ),
          )
          .returning({ id: paymentsTable.id });

        if (!updated) return; // Already processed by another instance

        await tx
          .update(usersTable)
          .set({ balanceKopecks: sql`${usersTable.balanceKopecks} + ${refundKopecks}` })
          .where(eq(usersTable.id, payment.userId));

        await tx.insert(balanceTransactionsTable).values({
          userId: payment.userId,
          amountKopecks: refundKopecks,
          type: "refund",
          paymentId: payment.id,
          description: `Автовозврат: зависший баланс-платёж (reconciler) — ${payment.amountRub} ₽`,
        });
      });

      logger.warn({ paymentId: payment.id, userId: payment.userId, refundKopecks },
        "reconcileBalancePayments: compensated stale payment");
    } catch (err) {
      logger.error({ err, paymentId: payment.id }, "reconcileBalancePayments: compensation failed for payment");
    }
  }
}

export function startReconcileBalancePaymentsJob(): void {
  // Run once at startup to handle any crash from a previous instance
  runReconciliation().catch((err) =>
    logger.error({ err }, "reconcileBalancePayments: startup run failed"),
  );

  // Then run periodically
  setInterval(() => {
    runReconciliation().catch((err) =>
      logger.error({ err }, "reconcileBalancePayments: periodic run failed"),
    );
  }, RECONCILE_INTERVAL_MS);
}
