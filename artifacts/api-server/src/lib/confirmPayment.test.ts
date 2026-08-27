/**
 * Unit tests for confirmPaymentById's extra_traffic branch, focused on the
 * "stale-active" subscription fallback: a subscription can still read
 * status='active' for a short window after its endsAt has passed (the expiry
 * sweep runs on an interval, not instantly). Crediting purchased traffic to
 * that subscription would silently lose it once the sweep finally runs.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
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
