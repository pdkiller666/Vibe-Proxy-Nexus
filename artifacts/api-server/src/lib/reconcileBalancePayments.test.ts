/**
 * Integration tests for runReconciliation() — ТЗ §6 scenarios 11–12.
 *
 * No mocking required: the reconciler only touches the DB.
 * Tests seed payments that are already in 'pending'+'balance' state
 * and are older than the 5-minute STALE_BALANCE_PAYMENT_MS threshold.
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  balanceTransactionsTable,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import { runReconciliation } from "./reconcileBalancePayments";

const uid = () => randomBytes(6).toString("hex");

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedUser(balanceKopecks: number) {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `reconcile-test-${uid()}@example.com`,
      passwordHash: "not-a-real-hash",
      referralCode: uid(),
      balanceKopecks,
    })
    .returning({ id: usersTable.id });
  return user!;
}

/**
 * Insert a pending balance payment with createdAt set far in the past
 * (older than the 5-minute stale threshold).
 */
async function seedStaleBalancePayment(userId: number, planId: number, amountRub: number) {
  const [payment] = await db
    .insert(paymentsTable)
    .values({
      userId,
      type: "subscription",
      provider: "balance",
      amountRub,
      status: "pending",
      reference: `reconcile-test-ref-${uid()}`,
    })
    .returning({ id: paymentsTable.id });

  // Back-date the createdAt column to > 5 minutes ago
  await db.execute(
    sql`UPDATE payments SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = ${payment!.id}`,
  );

  return payment!;
}

// ── Suite setup ───────────────────────────────────────────────────────────────

describe("runReconciliation", () => {
  let planId: number;
  const AMOUNT_RUB = 300;

  const userIds: number[] = [];
  const paymentIds: number[] = [];
  const txIds: number[] = [];
  const subIds: number[] = [];

  beforeAll(async () => {
    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Reconcile test plan ${uid()}`,
        priceRub: AMOUNT_RUB,
        durationDays: 30,
        billingType: "monthly",
      })
      .returning({ id: plansTable.id });
    planId = plan!.id;
  });

  afterEach(async () => {
    for (const id of txIds.splice(0))
      await db.delete(balanceTransactionsTable).where(eq(balanceTransactionsTable.id, id));
    for (const id of paymentIds.splice(0))
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    for (const id of subIds.splice(0))
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    for (const id of userIds.splice(0))
      await db.delete(usersTable).where(eq(usersTable.id, id));
  });

  afterAll(async () => {
    await db.delete(plansTable).where(eq(plansTable.id, planId));
  });

  async function collectCreated(userId: number, paymentId: number) {
    userIds.push(userId);
    paymentIds.push(paymentId);

    const txs = await db
      .select({ id: balanceTransactionsTable.id })
      .from(balanceTransactionsTable)
      .where(eq(balanceTransactionsTable.userId, userId));
    txIds.push(...txs.map((t) => t.id));
  }

  // ── Scenario 11: Stale payment → reject + refund ─────────────────────────────
  it("scenario 11: pending balance-payment older than 5 min → rejected, balance refunded, refund tx created", async () => {
    const initialBalance = 50_000;
    const debitedBalance = initialBalance - AMOUNT_RUB * 100; // simulate the debit that happened in tx1
    const { id: userId } = await seedUser(debitedBalance);
    const { id: paymentId } = await seedStaleBalancePayment(userId, planId, AMOUNT_RUB);

    await runReconciliation();

    // Payment rejected
    const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
    expect(payment!.status).toBe("rejected");
    expect(payment!.rejectionReason).toBe("balance_reconciled");

    // Balance restored to what it was before the debit
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(debitedBalance + AMOUNT_RUB * 100);

    // Refund balance transaction created
    const txs = await db
      .select()
      .from(balanceTransactionsTable)
      .where(eq(balanceTransactionsTable.userId, userId));
    expect(txs).toHaveLength(1);
    expect(txs[0]!.type).toBe("refund");
    expect(txs[0]!.amountKopecks).toBe(AMOUNT_RUB * 100);

    await collectCreated(userId, paymentId);
  });

  // ── Scenario 12: Idempotency — second run must not duplicate refund ───────────
  it("scenario 12: running reconciler twice does not duplicate the refund", async () => {
    const debitedBalance = 10_000;
    const { id: userId } = await seedUser(debitedBalance);
    const { id: paymentId } = await seedStaleBalancePayment(userId, planId, AMOUNT_RUB);

    // First run: compensates the stale payment
    await runReconciliation();

    const [userAfterFirst] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    const balanceAfterFirst = userAfterFirst!.balanceKopecks;

    // Second run: the payment is now 'rejected' — predicate `status='pending'` excludes it
    await runReconciliation();

    // Balance unchanged after second run
    const [userAfterSecond] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(userAfterSecond!.balanceKopecks).toBe(balanceAfterFirst);

    // Still exactly one refund tx (no duplicates)
    const txs = await db
      .select()
      .from(balanceTransactionsTable)
      .where(eq(balanceTransactionsTable.userId, userId));
    const refunds = txs.filter((t) => t.type === "refund");
    expect(refunds).toHaveLength(1);

    await collectCreated(userId, paymentId);
  });

  // ── Bonus: fresh (non-stale) payment is left alone ──────────────────────────
  it("fresh pending balance-payment (< 5 min old) is not touched by reconciler", async () => {
    const debitedBalance = 10_000;
    const { id: userId } = await seedUser(debitedBalance);

    // Insert a payment with default createdAt = NOW() (fresh)
    const [freshPayment] = await db
      .insert(paymentsTable)
      .values({
        userId,
        type: "subscription",
        provider: "balance",
        amountRub: AMOUNT_RUB,
        status: "pending",
        reference: `reconcile-fresh-${uid()}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(freshPayment!.id);
    userIds.push(userId);

    await runReconciliation();

    // Payment still pending
    const [payment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, freshPayment!.id));
    expect(payment!.status).toBe("pending");

    // Balance untouched
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(debitedBalance);
  });
});
