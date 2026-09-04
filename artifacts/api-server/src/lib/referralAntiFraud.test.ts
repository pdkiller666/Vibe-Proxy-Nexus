import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  balanceTransactionsTable,
  db,
  paymentSettingsTable,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import { confirmPaymentById, refundPaymentById } from "./confirmPayment";

vi.mock("./keyIssuance", () => ({
  ensureActiveKeyForUser: vi.fn().mockResolvedValue(undefined),
}));

describe("referral commission anti-fraud and refunds", () => {
  let planId: number;
  let settingsId: number;
  let originalCommission: number;
  const userIds: number[] = [];
  const subscriptionIds: number[] = [];
  const paymentIds: number[] = [];

  beforeAll(async () => {
    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Referral anti-fraud ${randomBytes(4).toString("hex")}`,
        priceRub: 1000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [existing] = await db.select().from(paymentSettingsTable).limit(1);
    if (existing) {
      settingsId = existing.id;
      originalCommission = existing.referralCommissionPercent;
    } else {
      const [created] = await db
        .insert(paymentSettingsTable)
        .values({
          sbpPhone: "+70000000000",
          sbpBank: "Test bank",
          sbpRecipientName: "Test recipient",
          referralCommissionPercent: 10,
        })
        .returning({ id: paymentSettingsTable.id });
      settingsId = created.id;
      originalCommission = 10;
    }

    await db
      .update(paymentSettingsTable)
      .set({ referralCommissionPercent: 10 })
      .where(eq(paymentSettingsTable.id, settingsId));
  });

  afterEach(async () => {
    if (userIds.length > 0) {
      await db
        .delete(balanceTransactionsTable)
        .where(inArray(balanceTransactionsTable.userId, userIds));
    }
    for (const id of paymentIds.splice(0)) {
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    }
    for (const id of subscriptionIds.splice(0)) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    for (const id of userIds.splice(0)) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  afterAll(async () => {
    if (settingsId) {
      const [existing] = await db
        .select({ id: paymentSettingsTable.id })
        .from(paymentSettingsTable)
        .where(eq(paymentSettingsTable.id, settingsId));
      if (existing) {
        await db
          .update(paymentSettingsTable)
          .set({ referralCommissionPercent: originalCommission })
          .where(eq(paymentSettingsTable.id, settingsId));
      }
    }
    await db.delete(plansTable).where(eq(plansTable.id, planId));
  });

  async function seedPayment(
    provider: "manual_sbp" | "balance" | "free_grant" = "manual_sbp",
  ) {
    const [referrer] = await db
      .insert(usersTable)
      .values({
        email: `referrer-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
        balanceKopecks: 0,
      })
      .returning();
    const [payer] = await db
      .insert(usersTable)
      .values({
        email: `payer-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
        referredByUserId: referrer.id,
      })
      .returning();
    userIds.push(referrer.id, payer.id);

    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({ userId: payer.id, planId, status: "pending_payment" })
      .returning();
    subscriptionIds.push(subscription.id);

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId: payer.id,
        subscriptionId: subscription.id,
        type: "subscription",
        provider,
        amountRub: 1000,
        reference: `referral-${randomBytes(6).toString("hex")}`,
      })
      .returning();
    paymentIds.push(payment.id);

    return { referrer, payer, payment };
  }

  it("credits an external commission exactly once and reverses it exactly once", async () => {
    const { referrer, payment } = await seedPayment();
    const commissionKopecks = 10_000;

    const confirmations = await Promise.all([
      confirmPaymentById(payment.id),
      confirmPaymentById(payment.id),
    ]);
    expect(confirmations.some((result) => result.ok)).toBe(true);

    const [credited] = await db
      .select({ balanceKopecks: usersTable.balanceKopecks })
      .from(usersTable)
      .where(eq(usersTable.id, referrer.id));
    expect(credited?.balanceKopecks).toBe(commissionKopecks);

    const commissionRows = await db
      .select()
      .from(balanceTransactionsTable)
      .where(
        and(
          eq(balanceTransactionsTable.paymentId, payment.id),
          eq(balanceTransactionsTable.type, "referral"),
        ),
      );
    expect(commissionRows).toHaveLength(1);

    const refunds = await Promise.all([
      refundPaymentById(payment.id, "chargeback", "provider dispute"),
      refundPaymentById(payment.id, "chargeback", "duplicate callback"),
    ]);
    expect(refunds.every((result) => result.ok)).toBe(true);
    const refunded = refunds.find((result) => result.ok);
    if (refunded?.ok) {
      expect(refunded.payment.status).toBe("refunded");
      expect(refunded.payment.refundKind).toBe("chargeback");
    }

    const [afterRefund] = await db
      .select({ balanceKopecks: usersTable.balanceKopecks })
      .from(usersTable)
      .where(eq(usersTable.id, referrer.id));
    expect(afterRefund?.balanceKopecks).toBe(0);

    const reversalRows = await db
      .select()
      .from(balanceTransactionsTable)
      .where(
        and(
          eq(balanceTransactionsTable.paymentId, payment.id),
          eq(balanceTransactionsTable.type, "referral_reversal"),
        ),
      );
    expect(reversalRows).toHaveLength(1);
    expect(reversalRows[0]?.amountKopecks).toBe(-commissionKopecks);
  });

  it("does not manufacture referral balance from an internal wallet payment", async () => {
    const { referrer, payment } = await seedPayment("balance");

    const result = await confirmPaymentById(payment.id);
    expect(result.ok).toBe(true);

    const [user] = await db
      .select({ balanceKopecks: usersTable.balanceKopecks })
      .from(usersTable)
      .where(eq(usersTable.id, referrer.id));
    expect(user?.balanceKopecks).toBe(0);

    const referralRows = await db
      .select()
      .from(balanceTransactionsTable)
      .where(
        and(
          eq(balanceTransactionsTable.paymentId, payment.id),
          eq(balanceTransactionsTable.type, "referral"),
        ),
      );
    expect(referralRows).toHaveLength(0);

    const refund = await refundPaymentById(payment.id);
    expect(refund.ok).toBe(false);
    if (!refund.ok) expect(refund.status).toBe(409);
  });

  it("reverses an external balance top-up exactly once", async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `topup-refund-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning();
    userIds.push(user.id);

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId: user.id,
        type: "balance_topup",
        provider: "yoomoney",
        amountRub: 500,
        status: "pending",
        reference: `topup-refund-${randomBytes(6).toString("hex")}`,
      })
      .returning();
    paymentIds.push(payment.id);

    const confirmed = await confirmPaymentById(payment.id);
    expect(confirmed.ok).toBe(true);

    const refunds = await Promise.all([
      refundPaymentById(payment.id, "refund", "customer request"),
      refundPaymentById(payment.id, "refund", "duplicate admin click"),
    ]);
    expect(refunds.every((result) => result.ok)).toBe(true);

    const [afterRefund] = await db
      .select({ balanceKopecks: usersTable.balanceKopecks })
      .from(usersTable)
      .where(eq(usersTable.id, user.id));
    expect(afterRefund?.balanceKopecks).toBe(0);

    const ledgerRows = await db
      .select({
        type: balanceTransactionsTable.type,
        amountKopecks: balanceTransactionsTable.amountKopecks,
      })
      .from(balanceTransactionsTable)
      .where(eq(balanceTransactionsTable.paymentId, payment.id));
    expect(ledgerRows).toEqual([
      { type: "topup", amountKopecks: 50_000 },
      { type: "refund", amountKopecks: -50_000 },
    ]);
  });

  it("does not manufacture referral balance from an auditable free grant", async () => {
    const { referrer, payment } = await seedPayment("free_grant");

    const result = await confirmPaymentById(payment.id);
    expect(result.ok).toBe(true);

    const [user] = await db
      .select({ balanceKopecks: usersTable.balanceKopecks })
      .from(usersTable)
      .where(eq(usersTable.id, referrer.id));
    expect(user?.balanceKopecks).toBe(0);

    const referralRows = await db
      .select()
      .from(balanceTransactionsTable)
      .where(
        and(
          eq(balanceTransactionsTable.paymentId, payment.id),
          eq(balanceTransactionsTable.type, "referral"),
        ),
      );
    expect(referralRows).toHaveLength(0);
  });

  it("rejects an attempt to create a self-referral at the database boundary", async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `self-referral-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning();
    userIds.push(user.id);

    await expect(
      db
        .update(usersTable)
        .set({ referredByUserId: user.id })
        .where(eq(usersTable.id, user.id)),
    ).rejects.toThrow();
  });
});