import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import {
  db,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";

const request = supertest(app);

async function createUser(role: "user" | "admin"): Promise<{
  id: number;
  email: string;
  password: string;
}> {
  const email = `payments-test-${role}-${randomBytes(6).toString("hex")}@example.com`;
  const password = "correct-horse-battery-staple";
  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash, role })
    .returning({ id: usersTable.id });

  return { id: user.id, email, password };
}

async function loginAndGetCookie(email: string, password: string): Promise<string> {
  const res = await request.post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);

  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  return sessionCookie.split(";")[0];
}

describe("admin payments confirm/reject flow", () => {
  let adminId: number;
  let adminCookie: string;
  let userId: number;
  let planId: number;
  const subscriptionIds: number[] = [];
  const paymentIds: number[] = [];
  const extraUserIds: number[] = [];

  beforeAll(async () => {
    const admin = await createUser("admin");
    adminId = admin.id;
    adminCookie = await loginAndGetCookie(admin.email, admin.password);

    const user = await createUser("user");
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Test plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;
  });

  afterAll(async () => {
    for (const id of paymentIds) {
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    }
    for (const id of subscriptionIds) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
    for (const id of extraUserIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  async function seedPendingPayment(): Promise<{ subscriptionId: number; paymentId: number }> {
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({ userId, planId, status: "pending_payment" })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription.id);

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        subscriptionId: subscription.id,
        userId,
        provider: "manual_sbp",
        amountRub: 10000,
        status: "pending",
        reference: `TEST-${randomBytes(4).toString("hex")}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(payment.id);

    return { subscriptionId: subscription.id, paymentId: payment.id };
  }

  it("rejects non-admin users with 403", async () => {
    const regular = await createUser("user");
    const cookie = await loginAndGetCookie(regular.email, regular.password);
    const { paymentId } = await seedPendingPayment();

    const res = await request
      .post(`/api/admin/payments/${paymentId}/confirm`)
      .set("Cookie", cookie);

    expect(res.status).toBe(403);
    await db.delete(usersTable).where(eq(usersTable.id, regular.id));
  });

  it("confirming a pending payment activates the subscription", async () => {
    const { subscriptionId, paymentId } = await seedPendingPayment();

    const res = await request
      .post(`/api/admin/payments/${paymentId}/confirm`)
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("confirmed");
    expect(res.body.confirmedAt).not.toBeNull();

    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));

    expect(subscription?.status).toBe("active");
    expect(subscription?.startsAt).not.toBeNull();
    expect(subscription?.endsAt).not.toBeNull();
  });

  it("rejecting a pending payment marks payment and subscription rejected with a reason", async () => {
    const { subscriptionId, paymentId } = await seedPendingPayment();

    const res = await request
      .post(`/api/admin/payments/${paymentId}/reject`)
      .set("Cookie", adminCookie)
      .send({ reason: "Оплата не найдена" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rejectionReason).toBe("Оплата не найдена");

    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));

    expect(subscription?.status).toBe("rejected");
  });

  it("returns 409 when confirming a payment that is no longer pending", async () => {
    const { paymentId } = await seedPendingPayment();

    const first = await request
      .post(`/api/admin/payments/${paymentId}/confirm`)
      .set("Cookie", adminCookie);
    expect(first.status).toBe(200);

    const second = await request
      .post(`/api/admin/payments/${paymentId}/confirm`)
      .set("Cookie", adminCookie);
    expect(second.status).toBe(409);
  });

  it("returns 409 when rejecting a payment that was already confirmed", async () => {
    const { paymentId } = await seedPendingPayment();

    const confirm = await request
      .post(`/api/admin/payments/${paymentId}/confirm`)
      .set("Cookie", adminCookie);
    expect(confirm.status).toBe(200);

    const reject = await request
      .post(`/api/admin/payments/${paymentId}/reject`)
      .set("Cookie", adminCookie)
      .send({ reason: "Слишком поздно" });
    expect(reject.status).toBe(409);
  });

  it("returns 404 for a payment id that does not exist", async () => {
    const res = await request
      .post("/api/admin/payments/999999999/confirm")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(404);
  });

  it("chains an early renewal onto the end of the current active period instead of restarting the clock", async () => {
    // Use a dedicated user so earlier tests' leftover active subscriptions
    // for the shared `userId` (only cleaned up in afterAll) can't affect
    // which "current active" row this test's renewal chains onto.
    const renewalUser = await createUser("user");
    extraUserIds.push(renewalUser.id);

    const currentEndsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const [currentSubscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: renewalUser.id,
        planId,
        status: "active",
        startsAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000),
        endsAt: currentEndsAt,
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(currentSubscription.id);

    const [pendingSubscription] = await db
      .insert(subscriptionsTable)
      .values({ userId: renewalUser.id, planId, status: "pending_payment" })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(pendingSubscription.id);

    const [pendingPayment] = await db
      .insert(paymentsTable)
      .values({
        subscriptionId: pendingSubscription.id,
        userId: renewalUser.id,
        provider: "manual_sbp",
        amountRub: 10000,
        status: "pending",
        reference: `TEST-${randomBytes(4).toString("hex")}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(pendingPayment.id);

    const renewalSubscriptionId = pendingSubscription.id;
    const paymentId = pendingPayment.id;

    const res = await request
      .post(`/api/admin/payments/${paymentId}/confirm`)
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);

    const [renewedSubscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, renewalSubscriptionId));

    expect(renewedSubscription?.status).toBe("active");
    expect(renewedSubscription?.startsAt?.getTime()).toBe(currentEndsAt.getTime());
    expect(renewedSubscription?.endsAt?.getTime()).toBe(
      currentEndsAt.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
  });

  it("returns 409 when confirming a payment whose subscription is already active", async () => {
    const { subscriptionId, paymentId } = await seedPendingPayment();

    await db
      .update(subscriptionsTable)
      .set({ status: "active", startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
      .where(eq(subscriptionsTable.id, subscriptionId));

    const res = await request
      .post(`/api/admin/payments/${paymentId}/confirm`)
      .set("Cookie", adminCookie);

    expect(res.status).toBe(409);
  });
});
