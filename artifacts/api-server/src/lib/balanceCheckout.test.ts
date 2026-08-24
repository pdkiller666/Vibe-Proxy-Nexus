/**
 * Integration tests for checkoutFromBalance() — ТЗ §6 scenarios 1–6, 10.
 *
 * confirmPaymentById is mocked with a plain vi.fn() stub.
 * The default implementation (set in beforeEach) simulates a successful
 * confirm by updating the payment row to status='confirmed' in the DB, which
 * also makes the inner-tx dedup guard work correctly for scenario 4a.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  balanceTransactionsTable,
  paymentsTable,
  paymentSettingsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";

// Keep the factory minimal — no closure over imports (ESM hoisting caveat).
vi.mock("./confirmPayment", () => ({
  confirmPaymentById: vi.fn(),
}));

// Import AFTER vi.mock so the stub is in place.
import { confirmPaymentById } from "./confirmPayment";
import { checkoutFromBalance } from "./balanceCheckout";

// ── Helpers ───────────────────────────────────────────────────────────────────

const uid = () => randomBytes(6).toString("hex");

async function seedUser(balanceKopecks: number) {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `balance-checkout-test-${uid()}@example.com`,
      passwordHash: "not-a-real-hash",
      referralCode: uid(),
      balanceKopecks,
    })
    .returning({ id: usersTable.id });
  return user!;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("checkoutFromBalance", () => {
  const PLAN_PRICE_RUB = 300;
  let monthlyPlanId: number;
  let hourlyPlanId: number;

  // Track created rows for afterEach cleanup.
  const userIds: number[] = [];
  const subIds: number[] = [];
  const planIds: number[] = [];
  const paymentIds: number[] = [];
  const txIds: number[] = [];

  // payment_settings bookkeeping
  let settingsId: number | null = null;
  let settingsInserted = false;
  let originalEnabled = false;
  let originalExtraTrafficPriceRub = 0;
  let originalExtraTrafficPackageGb = 0;

  // Default mock: simulates a successful confirm by writing confirmed status to DB.
  // Set in beforeEach so afterEach resets leave a clean slate.
  beforeEach(() => {
    vi.mocked(confirmPaymentById).mockImplementation(async (paymentId: number) => {
      await db
        .update(paymentsTable)
        .set({ status: "confirmed" })
        .where(eq(paymentsTable.id, paymentId));
      const [p] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
      return { ok: true as const, payment: p! };
    });
  });

  afterEach(async () => {
    vi.mocked(confirmPaymentById).mockReset();

    for (const id of txIds.splice(0))
      await db.delete(balanceTransactionsTable).where(eq(balanceTransactionsTable.id, id));
    for (const id of paymentIds.splice(0))
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    for (const id of subIds.splice(0))
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    for (const id of userIds.splice(0))
      await db.delete(usersTable).where(eq(usersTable.id, id));
    for (const id of planIds.splice(0))
      await db.delete(plansTable).where(eq(plansTable.id, id));
  });

  beforeAll(async () => {
    // Ensure payment_settings has balancePaymentsEnabled=true
    const [existing] = await db.select().from(paymentSettingsTable).limit(1);
    if (!existing) {
      const [row] = await db
        .insert(paymentSettingsTable)
        .values({ sbpPhone: "", sbpBank: "", sbpRecipientName: "", balancePaymentsEnabled: true })
        .returning({ id: paymentSettingsTable.id });
      settingsId = row!.id;
      settingsInserted = true;
    } else {
      settingsId = existing.id;
      originalEnabled = existing.balancePaymentsEnabled;
      originalExtraTrafficPriceRub = existing.extraTrafficPriceRub;
      originalExtraTrafficPackageGb = existing.extraTrafficPackageGb;
      await db
        .update(paymentSettingsTable)
        .set({
          balancePaymentsEnabled: true,
          extraTrafficPriceRub: 50,
          extraTrafficPackageGb: 10,
        })
        .where(eq(paymentSettingsTable.id, settingsId!));
    }
    if (settingsId !== null && settingsInserted) {
      await db
        .update(paymentSettingsTable)
        .set({ extraTrafficPriceRub: 50, extraTrafficPackageGb: 10 })
        .where(eq(paymentSettingsTable.id, settingsId));
    }

    const [mp] = await db
      .insert(plansTable)
      .values({ name: `Balance checkout test plan ${uid()}`, priceRub: PLAN_PRICE_RUB, durationDays: 30, billingType: "monthly" })
      .returning({ id: plansTable.id });
    monthlyPlanId = mp!.id;

    const [hp] = await db
      .insert(plansTable)
      .values({ name: `Hourly test plan ${uid()}`, priceRub: 0, durationDays: 0, billingType: "hourly", hourlyRateKopecks: 100 })
      .returning({ id: plansTable.id });
    hourlyPlanId = hp!.id;
  });

  afterAll(async () => {
    await db.delete(plansTable).where(eq(plansTable.id, monthlyPlanId));
    await db.delete(plansTable).where(eq(plansTable.id, hourlyPlanId));
    if (settingsInserted && settingsId !== null) {
      await db.delete(paymentSettingsTable).where(eq(paymentSettingsTable.id, settingsId));
    } else if (settingsId !== null) {
      await db
        .update(paymentSettingsTable)
        .set({
          balancePaymentsEnabled: originalEnabled,
          extraTrafficPriceRub: originalExtraTrafficPriceRub,
          extraTrafficPackageGb: originalExtraTrafficPackageGb,
        })
        .where(eq(paymentSettingsTable.id, settingsId));
    }
  });

  /** Collect rows created by checkoutFromBalance for a given user so afterEach can clean them up. */
  async function collectCreated(userId: number) {
    userIds.push(userId);
    const subs = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId));
    subIds.push(...subs.map((s) => s.id));
    const payments = await db
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(eq(paymentsTable.userId, userId));
    paymentIds.push(...payments.map((p) => p.id));
    const txs = await db
      .select({ id: balanceTransactionsTable.id })
      .from(balanceTransactionsTable)
      .where(eq(balanceTransactionsTable.userId, userId));
    txIds.push(...txs.map((t) => t.id));
  }

  // ── Scenario 1: Success ─────────────────────────────────────────────────────
  it("scenario 1: success — balance debited, payment confirmed, debit tx created", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 2;
    const { id: userId } = await seedUser(initialBalance);

    const outcome = await checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.type).toBe("subscription");
    expect(outcome.result.amountRub).toBe(PLAN_PRICE_RUB);

    // Balance reduced by plan price
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance - PLAN_PRICE_RUB * 100);

    // Payment is confirmed (mock wrote this)
    const [payment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, outcome.result.paymentId));
    expect(payment!.status).toBe("confirmed");
    expect(payment!.provider).toBe("balance");
    expect(payment!.amountRub).toBe(PLAN_PRICE_RUB);

    // Debit balance transaction exists
    const txs = await db.select().from(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, userId));
    const debit = txs.find((t) => t.type === "debit");
    expect(debit).toBeDefined();
    expect(debit!.amountKopecks).toBe(-(PLAN_PRICE_RUB * 100));

    // Exactly one subscription row created
    const subs = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    expect(subs).toHaveLength(1);

    await collectCreated(userId);
  });

  // ── Scenario 2: Insufficient balance ────────────────────────────────────────
  it("scenario 2: insufficient balance → 402, balance untouched, no payment created", async () => {
    const { id: userId } = await seedUser(100); // 1 ₽ — far less than plan price

    const outcome = await checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(402);
    // Narrow the discriminated union to the 402 variant before accessing its fields.
    if (outcome.status !== 402) return;
    expect(outcome.error).toBe("insufficient_balance");
    expect(outcome.balanceKopecks).toBe(100);
    expect(outcome.requiredKopecks).toBe(PLAN_PRICE_RUB * 100);

    // Balance unchanged
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(100);

    // No payment inserted
    const payments = await db.select().from(paymentsTable).where(eq(paymentsTable.userId, userId));
    expect(payments).toHaveLength(0);

    expect(vi.mocked(confirmPaymentById)).not.toHaveBeenCalled();

    await collectCreated(userId);
  });

  // ── Scenario 3: Hourly plan → 400 ───────────────────────────────────────────
  it("scenario 3: hourly plan → 400, checkout rejected", async () => {
    const { id: userId } = await seedUser(100_000);

    const outcome = await checkoutFromBalance(userId, { kind: "subscription", planId: hourlyPlanId });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    expect(outcome.error).toMatch(/почасов/i);

    await collectCreated(userId);
  });

  // ── Scenario 4a: Sequential double-click dedup ──────────────────────────────
  it("scenario 4a: sequential double-click within 60 s → single debit, same paymentId, exactly one subscription", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 3;
    const { id: userId } = await seedUser(initialBalance);

    // First call fully completes (mock sets payment to 'confirmed')
    const first = await checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second call hits the inner-tx dedup (confirmed payment found after lock)
    const second = await checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.paymentId).toBe(first.result.paymentId);

    // Balance debited only once
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance - PLAN_PRICE_RUB * 100);

    // confirmPaymentById called exactly once
    expect(vi.mocked(confirmPaymentById)).toHaveBeenCalledTimes(1);

    // Exactly one subscription row — no orphans from the second call
    const subs = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    expect(subs).toHaveLength(1);

    await collectCreated(userId);
  });

  // ── Scenario 4b: Concurrent requests — only one debit ───────────────────────
  it("scenario 4b: two concurrent requests — exactly one debit and at most one subscription", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 5;
    const { id: userId } = await seedUser(initialBalance);

    // Fire both requests simultaneously
    const [r1, r2] = await Promise.all([
      checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId }),
      checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId }),
    ]);

    // At least one must succeed (the one that won the lock)
    const successes = [r1, r2].filter((r) => r.ok);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // The losing request must be blocked: either dedup-confirmed (ok:true) or 409
    const failures = [r1, r2].filter((r) => !r.ok);
    for (const f of failures) {
      if (f.ok) continue;
      expect(f.status).toBe(409);
    }

    // Balance debited at most once — the core invariant
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBeGreaterThanOrEqual(initialBalance - PLAN_PRICE_RUB * 100);

    // At most one subscription row created — no orphans
    const subs = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    expect(subs.length).toBeLessThanOrEqual(1);

    // At most one confirmed payment
    const allPayments = await db.select().from(paymentsTable).where(eq(paymentsTable.userId, userId));
    const confirmedCount = allPayments.filter((p) => p.status === "confirmed").length;
    expect(confirmedCount).toBeLessThanOrEqual(1);

    await collectCreated(userId);
  });

  // ── Scenario 5: confirmPaymentById fails → compensation ─────────────────────
  it("scenario 5: confirmPaymentById fails (payment still pending) → balance refunded, refund tx created", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 2;
    const { id: userId } = await seedUser(initialBalance);

    // Override: confirm fails without touching the DB (simulates crash mid-confirm)
    vi.mocked(confirmPaymentById).mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: "simulated_confirm_failure",
    });

    const outcome = await checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(500);

    // Balance fully restored
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance);

    // Payment rejected
    const payments = await db.select().from(paymentsTable).where(eq(paymentsTable.userId, userId));
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe("rejected");

    // Both debit and refund transactions must exist
    const txs = await db.select().from(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, userId));
    const debit = txs.find((t) => t.type === "debit");
    const refund = txs.find((t) => t.type === "refund");
    expect(debit).toBeDefined();
    expect(refund).toBeDefined();
    expect(refund!.amountKopecks).toBe(PLAN_PRICE_RUB * 100);

    await collectCreated(userId);
  });

  // ── Scenario 5b: confirmPaymentById fails AFTER confirming — no refund ───────
  it("scenario 5b: confirmPaymentById confirms payment then returns failure → balance NOT refunded (service already granted)", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 2;
    const { id: userId } = await seedUser(initialBalance);

    // Simulate post-confirm failure: payment is written as confirmed in DB,
    // but the function returns ok:false (e.g. key issuance threw after commit)
    vi.mocked(confirmPaymentById).mockImplementation(async (paymentId: number) => {
      // First, write confirmed status (simulates the successful DB commit)
      await db
        .update(paymentsTable)
        .set({ status: "confirmed" })
        .where(eq(paymentsTable.id, paymentId));
      // Then return failure (simulates an exception after the payment was settled)
      return { ok: false as const, status: 500, error: "post_confirm_key_issuance_failed" };
    });

    const outcome = await checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(500);

    // Balance must NOT be refunded — the service was granted
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance - PLAN_PRICE_RUB * 100);

    // Payment remains confirmed (not rejected)
    const payments = await db.select().from(paymentsTable).where(eq(paymentsTable.userId, userId));
    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe("confirmed");

    // No refund transaction
    const txs = await db.select().from(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, userId));
    const refund = txs.find((t) => t.type === "refund");
    expect(refund).toBeUndefined();

    await collectCreated(userId);
  });

  // ── Scenario 6: Slot/traffic without active subscription → 400 ───────────────
  it("scenario 6a: extra_device_slot without active subscription → 400", async () => {
    const { id: userId } = await seedUser(100_000);

    const outcome = await checkoutFromBalance(userId, { kind: "extra_device_slot" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    expect(outcome.error).toMatch(/подписк/i);

    await collectCreated(userId);
  });

  it("scenario 6b: extra_traffic without active subscription → 400", async () => {
    const { id: userId } = await seedUser(100_000);

    const outcome = await checkoutFromBalance(userId, { kind: "extra_traffic" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(400);
    expect(outcome.error).toMatch(/подписк/i);

    await collectCreated(userId);
  });

  it("scenario 6c: balance payment replaces an existing pending manual traffic order", async () => {
    const [trafficPlan] = await db
      .insert(plansTable)
      .values({
        name: `Traffic balance switch plan ${uid()}`,
        priceRub: PLAN_PRICE_RUB,
        durationDays: 30,
        billingType: "monthly",
        trafficLimitGb: 100,
      })
      .returning({ id: plansTable.id });
    planIds.push(trafficPlan!.id);

    const initialBalance = 20_000;
    const { id: userId } = await seedUser(initialBalance);
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: trafficPlan!.id,
        status: "active",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });
    subIds.push(subscription!.id);

    const [manualPayment] = await db
      .insert(paymentsTable)
      .values({
        userId,
        subscriptionId: subscription!.id,
        type: "extra_traffic",
        provider: "manual_sbp",
        amountRub: 50,
        extraTrafficGb: 10,
        status: "pending",
        reference: `manual-${uid()}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(manualPayment!.id);

    const outcome = await checkoutFromBalance(userId, {
      kind: "extra_traffic",
      pendingPaymentId: manualPayment!.id,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.type).toBe("extra_traffic");
    expect(outcome.result.amountRub).toBe(50);

    const [updatedManualPayment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, manualPayment!.id));
    expect(updatedManualPayment!.status).toBe("rejected");
    expect(updatedManualPayment!.rejectionReason).toBe("Заменён оплатой с баланса");

    const [balancePayment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, outcome.result.paymentId));
    expect(balancePayment!.provider).toBe("balance");
    expect(balancePayment!.status).toBe("confirmed");
    expect(balancePayment!.subscriptionId).toBe(subscription!.id);
    expect(balancePayment!.extraTrafficGb).toBe(10);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance - 50 * 100);

    // Simulate the other lock order: manual confirmation won before the
    // balance request acquired the source payment row. The named source is no
    // longer pending, so checkout must not create another payment or debit.
    await db
      .update(paymentsTable)
      .set({ status: "confirmed" })
      .where(eq(paymentsTable.id, manualPayment!.id));
    const retry = await checkoutFromBalance(userId, {
      kind: "extra_traffic",
      pendingPaymentId: manualPayment!.id,
    });
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.status).toBe(409);
      expect(retry.error).toBe("pending_payment_not_pending");
    }
    const [userAfterRetry] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(userAfterRetry!.balanceKopecks).toBe(initialBalance - 50 * 100);
    const paymentsAfterRetry = await db
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(eq(paymentsTable.userId, userId));
    expect(paymentsAfterRetry).toHaveLength(2);

    await collectCreated(userId);
  });

  it("scenario 6d: balance payment replaces an existing pending subscription order without creating a duplicate", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 2;
    const { id: userId } = await seedUser(initialBalance);
    const [pendingSubscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: monthlyPlanId,
        status: "pending_payment",
        startsAt: new Date(),
      })
      .returning({ id: subscriptionsTable.id });
    subIds.push(pendingSubscription!.id);

    const [manualPayment] = await db
      .insert(paymentsTable)
      .values({
        userId,
        subscriptionId: pendingSubscription!.id,
        type: "subscription",
        provider: "manual_sbp",
        amountRub: PLAN_PRICE_RUB,
        status: "pending",
        reference: `manual-subscription-${uid()}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(manualPayment!.id);

    const outcome = await checkoutFromBalance(userId, {
      kind: "subscription",
      pendingPaymentId: manualPayment!.id,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const [replacedManualPayment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, manualPayment!.id));
    expect(replacedManualPayment!.status).toBe("rejected");
    expect(replacedManualPayment!.rejectionReason).toBe("Заменён оплатой с баланса");

    const [balancePayment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, outcome.result.paymentId));
    expect(balancePayment!.provider).toBe("balance");
    expect(balancePayment!.status).toBe("confirmed");
    expect(balancePayment!.subscriptionId).toBe(pendingSubscription!.id);

    const subscriptions = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId));
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.id).toBe(pendingSubscription!.id);

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance - PLAN_PRICE_RUB * 100);

    await collectCreated(userId);
  });

  // ── Scenario 10: Feature flag disabled → 409 ────────────────────────────────
  it("scenario 10: feature flag balancePaymentsEnabled=false → 409", async () => {
    await db
      .update(paymentSettingsTable)
      .set({ balancePaymentsEnabled: false })
      .where(eq(paymentSettingsTable.id, settingsId!));

    const { id: userId } = await seedUser(100_000);

    try {
      const outcome = await checkoutFromBalance(userId, { kind: "subscription", planId: monthlyPlanId });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.status).toBe(409);
      expect(outcome.error).toBe("feature_disabled");
    } finally {
      await db
        .update(paymentSettingsTable)
        .set({ balancePaymentsEnabled: true })
        .where(eq(paymentSettingsTable.id, settingsId!));
      await collectCreated(userId);
    }
  });
});
