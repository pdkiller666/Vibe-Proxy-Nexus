/**
 * Unit tests for confirmPaymentById's extra_traffic branch, focused on the
 * "stale-active" subscription fallback: a subscription can still read
 * status='active' for a short window after its endsAt has passed (the expiry
 * sweep runs on an interval, not instantly). Crediting purchased traffic to
 * that subscription would silently lose it once the sweep finally runs.
 */
import { randomBytes } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  db,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
} from "@workspace/db";
import { confirmPaymentById } from "./confirmPayment";

// ensureActiveKeyForUser tries real key issuance (node selection, Xray, etc.)
// which is irrelevant to what these tests verify — stub it out.
vi.mock("./keyIssuance", () => ({
  ensureActiveKeyForUser: vi.fn().mockResolvedValue(undefined),
}));

describe("confirmPaymentById — extra_traffic endsAt fallback", () => {
  let userId: number;
  let planId: number;
  const subscriptionIds: number[] = [];
  const paymentIds: number[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `confirm-payment-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Confirm payment plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;
  });

  afterEach(async () => {
    for (const id of paymentIds.splice(0)) {
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    }
    for (const id of subscriptionIds.splice(0)) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  async function seedSubscription(status: "active", endsAt: Date | null): Promise<number> {
    const [sub] = await db
      .insert(subscriptionsTable)
      .values({ userId, planId, status, startsAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), endsAt })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(sub.id);
    return sub.id;
  }

  async function seedExtraTrafficPayment(subscriptionId: number, grantedGb: number): Promise<number> {
    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId,
        subscriptionId,
        type: "extra_traffic",
        provider: "manual_sbp",
        amountRub: 10000,
        extraTrafficGb: grantedGb,
        status: "pending",
        reference: `test-${randomBytes(6).toString("hex")}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(payment.id);
    return payment.id;
  }

  it("redirects the credit to the user's genuinely-current subscription when the payment's own subscription is status=active but past its endsAt", async () => {
    // The payment's own subscription: status is still 'active' in the DB
    // (expiry sweep hasn't run yet), but its endsAt is already in the past.
    const staleSubId = await seedSubscription("active", new Date(Date.now() - 60 * 60 * 1000));
    const paymentId = await seedExtraTrafficPayment(staleSubId, 10);

    // The user's real current subscription — renewed/switched to already.
    const currentSubId = await seedSubscription("active", new Date(Date.now() + 15 * 24 * 60 * 60 * 1000));

    const result = await confirmPaymentById(paymentId);
    expect(result.ok).toBe(true);

    const [staleSub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, staleSubId));
    const [currentSub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, currentSubId));

    // Credit landed on the current subscription, not the stale one.
    expect(currentSub!.extraTrafficGb).toBe(10);
    expect(staleSub!.extraTrafficGb).toBe(0);

    // The payment's audit trail follows the traffic to the actual target.
    const [updatedPayment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
    expect(updatedPayment!.subscriptionId).toBe(currentSubId);
    expect(updatedPayment!.status).toBe("confirmed");
  });

  it("credits the payment's own subscription directly when it is genuinely current (endsAt in the future)", async () => {
    const subId = await seedSubscription("active", new Date(Date.now() + 15 * 24 * 60 * 60 * 1000));
    const paymentId = await seedExtraTrafficPayment(subId, 7);

    const result = await confirmPaymentById(paymentId);
    expect(result.ok).toBe(true);

    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, subId));
    expect(sub!.extraTrafficGb).toBe(7);

    const [updatedPayment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
    expect(updatedPayment!.subscriptionId).toBe(subId);
  });

  it("credits a subscription with endsAt=null (e.g. hourly plan) directly, never treating it as stale", async () => {
    const subId = await seedSubscription("active", null);
    const paymentId = await seedExtraTrafficPayment(subId, 3);

    const result = await confirmPaymentById(paymentId);
    expect(result.ok).toBe(true);

    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, subId));
    expect(sub!.extraTrafficGb).toBe(3);
  });

  it("fails with SUBSCRIPTION_NOT_ACTIVE-style error when both the payment's subscription is stale and there is no other current subscription", async () => {
    const staleSubId = await seedSubscription("active", new Date(Date.now() - 60 * 60 * 1000));
    const paymentId = await seedExtraTrafficPayment(staleSubId, 10);

    const result = await confirmPaymentById(paymentId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);

    const [updatedPayment] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
    expect(updatedPayment!.status).toBe("pending"); // never confirmed
  });
});

describe("confirmPaymentById — concurrent subscription confirmations", () => {
  const userIds: number[] = [];
  const planIds: number[] = [];
  const subscriptionIds: number[] = [];
  const paymentIds: number[] = [];

  afterEach(async () => {
    for (const id of paymentIds.splice(0)) {
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    }
    for (const id of subscriptionIds.splice(0)) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    for (const id of planIds.splice(0)) {
      await db.delete(plansTable).where(eq(plansTable.id, id));
    }
    for (const id of userIds.splice(0)) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, id));
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  it("serializes two confirmations for one subscriber and preserves both paid periods", async () => {
    const [subscriber] = await db
      .insert(usersTable)
      .values({
        email: `parallel-confirm-subscriber-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userIds.push(subscriber.id);

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Parallel confirmation plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        billingType: "monthly",
      })
      .returning({ id: plansTable.id });
    planIds.push(plan.id);

    // Current production constraints prevent this state from being created
    // anew, but older deployments could already contain it. Vitest runs API
    // files sequentially, so temporarily removing the two guards lets this
    // integration test reproduce the exact legacy race without affecting
    // another test file. The finally block restores both indexes even when an
    // assertion fails.
    await db.execute(sql`DROP INDEX IF EXISTS subscriptions_one_pending_per_user_idx`);
    await db.execute(sql`DROP INDEX IF EXISTS payments_one_pending_per_user_type_idx`);
    try {
      const [firstSubscription, secondSubscription] = await Promise.all([
        db
          .insert(subscriptionsTable)
          .values({ userId: subscriber.id, planId: plan.id, status: "pending_payment" })
          .returning({ id: subscriptionsTable.id })
          .then(([row]) => row!),
        db
          .insert(subscriptionsTable)
          .values({ userId: subscriber.id, planId: plan.id, status: "pending_payment" })
          .returning({ id: subscriptionsTable.id })
          .then(([row]) => row!),
      ]);
      subscriptionIds.push(firstSubscription.id, secondSubscription.id);

      const [firstPayment, secondPayment] = await Promise.all([
        db
          .insert(paymentsTable)
          .values({
            userId: subscriber.id,
            subscriptionId: firstSubscription.id,
            type: "subscription",
            provider: "manual_sbp",
            amountRub: 10000,
            status: "pending",
            reference: `parallel-a-${randomBytes(6).toString("hex")}`,
          })
          .returning({ id: paymentsTable.id })
          .then(([row]) => row!),
        db
          .insert(paymentsTable)
          .values({
            userId: subscriber.id,
            subscriptionId: secondSubscription.id,
            type: "subscription",
            provider: "manual_sbp",
            amountRub: 10000,
            status: "pending",
            reference: `parallel-b-${randomBytes(6).toString("hex")}`,
          })
          .returning({ id: paymentsTable.id })
          .then(([row]) => row!),
      ]);
      paymentIds.push(firstPayment.id, secondPayment.id);

      const results = await Promise.all([
        confirmPaymentById(firstPayment.id),
        confirmPaymentById(secondPayment.id),
      ]);
      expect(results.every((result) => result.ok)).toBe(true);

      const subscriptions = await db
        .select()
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.userId, subscriber.id))
        .orderBy(asc(subscriptionsTable.startsAt));

      expect(subscriptions).toHaveLength(2);
      expect(subscriptions.map((row) => row.status).sort()).toEqual(["active", "expired"]);

      const [firstPeriod, secondPeriod] = subscriptions;
      expect(firstPeriod!.startsAt).not.toBeNull();
      expect(firstPeriod!.endsAt).not.toBeNull();
      expect(secondPeriod!.startsAt).not.toBeNull();
      expect(secondPeriod!.endsAt).not.toBeNull();
      expect(secondPeriod!.startsAt!.getTime()).toBe(firstPeriod!.endsAt!.getTime());

      const periodMs = 30 * 24 * 60 * 60 * 1000;
      expect(firstPeriod!.endsAt!.getTime() - firstPeriod!.startsAt!.getTime()).toBe(periodMs);
      expect(secondPeriod!.endsAt!.getTime() - secondPeriod!.startsAt!.getTime()).toBe(periodMs);
    } finally {
      await db.delete(paymentsTable).where(eq(paymentsTable.userId, subscriber.id));
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, subscriber.id));
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_pending_per_user_idx
        ON subscriptions (user_id)
        WHERE status = 'pending_payment'
      `);
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS payments_one_pending_per_user_type_idx
        ON payments (user_id, type)
        WHERE status = 'pending'
      `);
    }
  });
});

describe("confirmPaymentById — payment/subscription ownership", () => {
  const userIds: number[] = [];
  const planIds: number[] = [];
  const subscriptionIds: number[] = [];
  const paymentIds: number[] = [];

  afterAll(async () => {
    for (const id of paymentIds) {
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    }
    for (const id of subscriptionIds) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    for (const id of planIds) {
      await db.delete(plansTable).where(eq(plansTable.id, id));
    }
    for (const id of userIds) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, id));
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  async function seedMismatchedPayment(type: "extra_device_slot" | "extra_traffic") {
    const [payer] = await db
      .insert(usersTable)
      .values({
        email: `ownership-${type}-payer-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    const [owner] = await db
      .insert(usersTable)
      .values({
        email: `ownership-${type}-owner-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userIds.push(payer.id, owner.id);

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Ownership ${type} plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        billingType: "monthly",
      })
      .returning({ id: plansTable.id });
    planIds.push(plan.id);

    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: owner.id,
        planId: plan.id,
        status: "active",
        startsAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        extraDeviceSlots: type === "extra_device_slot" ? 2 : 0,
        extraTrafficGb: type === "extra_traffic" ? 3 : 0,
      })
      .returning();
    subscriptionIds.push(subscription.id);

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId: payer.id,
        subscriptionId: subscription.id,
        type,
        provider: "manual_sbp",
        amountRub: 10000,
        extraTrafficGb: type === "extra_traffic" ? 5 : undefined,
        status: "pending",
        reference: `ownership-${type}-${randomBytes(6).toString("hex")}`,
      })
      .returning();
    paymentIds.push(payment.id);

    return { payer, owner, subscription, payment };
  }

  it("rejects a payment whose user differs from its subscription owner without changing either row", async () => {
    const [payer] = await db
      .insert(usersTable)
      .values({
        email: `ownership-payer-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    const [owner] = await db
      .insert(usersTable)
      .values({
        email: `ownership-owner-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userIds.push(payer.id, owner.id);

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Ownership check plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        billingType: "monthly",
      })
      .returning({ id: plansTable.id });
    planIds.push(plan.id);

    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: owner.id,
        planId: plan.id,
        status: "pending_payment",
      })
      .returning();
    subscriptionIds.push(subscription.id);

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId: payer.id,
        subscriptionId: subscription.id,
        type: "subscription",
        provider: "manual_sbp",
        amountRub: 10000,
        status: "pending",
        reference: `ownership-${randomBytes(6).toString("hex")}`,
      })
      .returning();
    paymentIds.push(payment.id);

    const result = await confirmPaymentById(payment.id);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Payment does not belong to the selected subscription",
    });

    const [unchangedPayment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, payment.id));
    const [unchangedSubscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscription.id));

    expect(unchangedPayment).toMatchObject({
      id: payment.id,
      userId: payer.id,
      subscriptionId: subscription.id,
      status: "pending",
      confirmedAt: null,
    });
    expect(unchangedSubscription).toMatchObject({
      id: subscription.id,
      userId: owner.id,
      status: "pending_payment",
      startsAt: null,
      endsAt: null,
    });
  });

  it("rejects a mismatched extra-device-slot payment before incrementing the other user's slots", async () => {
    const { subscription, payment } = await seedMismatchedPayment("extra_device_slot");

    const result = await confirmPaymentById(payment.id);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Payment does not belong to the selected subscription",
    });

    const [unchangedSubscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscription.id));
    const [unchangedPayment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, payment.id));

    expect(unchangedSubscription).toMatchObject({
      id: subscription.id,
      userId: subscription.userId,
      extraDeviceSlots: 2,
    });
    expect(unchangedPayment).toMatchObject({
      id: payment.id,
      subscriptionId: subscription.id,
      status: "pending",
    });
  });

  it("rejects a mismatched extra-traffic payment before changing the other user's traffic allowance", async () => {
    const { subscription, payment } = await seedMismatchedPayment("extra_traffic");

    const result = await confirmPaymentById(payment.id);

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Payment does not belong to the selected subscription",
    });

    const [unchangedSubscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscription.id));
    const [unchangedPayment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, payment.id));

    expect(unchangedSubscription).toMatchObject({
      id: subscription.id,
      userId: subscription.userId,
      extraTrafficGb: 3,
    });
    expect(unchangedPayment).toMatchObject({
      id: payment.id,
      subscriptionId: subscription.id,
      status: "pending",
    });
  });
});
