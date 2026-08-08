/**
 * Duplicate-subscription creation tests.
 *
 * Verifies that POST /subscriptions (and the hourly activation path) never
 * creates a second subscription row — even when two requests arrive
 * concurrently (as Amvera's proxy retry can cause) or sequentially.
 *
 * Key invariants under test:
 *  - Sequential duplicate → 409 (app-level pending_payment guard)
 *  - Concurrent duplicate → neither response is a 500; only one DB row created
 *  - Hourly plan: sequential duplicate → 409 (existing active hourly guard)
 *  - Hourly plan: concurrent duplicate → neither response is a 500; one row
 */

import { randomBytes } from "node:crypto";
import { and, eq, count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import {
  db,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import app from "../app";
import { hashPassword } from "../lib/password";

const request = supertest(app);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createUser(): Promise<{ id: number; cookie: string }> {
  const email = `sub-dup-${randomBytes(6).toString("hex")}@example.com`;
  const password = "correct-horse-battery-staple";
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      role: "user",
      referralCode: randomBytes(8).toString("hex"),
      // Enough balance for hourly plan activation checks
      balanceKopecks: 99999,
    })
    .returning({ id: usersTable.id });

  const loginRes = await request
    .post("/api/auth/login")
    .send({ email, password });
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const setCookie = loginRes.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  const cookie = sessionCookie.split(";")[0];
  return { id: user.id, cookie };
}

// ── Fixture tracking for afterAll cleanup ─────────────────────────────────────

const createdUserIds: number[] = [];
const createdSubscriptionIds: number[] = [];
const createdPaymentIds: number[] = [];

let monthlyPlanId: number;
let hourlyPlanId: number;

beforeAll(async () => {
  const [monthly] = await db
    .insert(plansTable)
    .values({
      name: `sub-dup-monthly-${randomBytes(4).toString("hex")}`,
      priceRub: 500,
      durationDays: 30,
    })
    .returning({ id: plansTable.id });
  monthlyPlanId = monthly.id;

  const [hourly] = await db
    .insert(plansTable)
    .values({
      name: `sub-dup-hourly-${randomBytes(4).toString("hex")}`,
      priceRub: 0,
      durationDays: 0,
      billingType: "hourly",
      hourlyRateKopecks: 100,
    })
    .returning({ id: plansTable.id });
  hourlyPlanId = hourly.id;
});

afterAll(async () => {
  for (const id of createdPaymentIds) {
    await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
  }
  for (const id of createdSubscriptionIds) {
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
  }
  if (createdUserIds.length > 0) {
    await db.delete(vpnKeysTable).where(inArray(vpnKeysTable.userId, createdUserIds));
    // Also clean up any subscriptions/payments not tracked individually
    for (const uid of createdUserIds) {
      const subs = await db
        .select({ id: subscriptionsTable.id })
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.userId, uid));
      for (const sub of subs) {
        await db.delete(paymentsTable).where(eq(paymentsTable.subscriptionId, sub.id));
      }
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, uid));
    }
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
  await db.delete(plansTable).where(eq(plansTable.id, monthlyPlanId));
  await db.delete(plansTable).where(eq(plansTable.id, hourlyPlanId));
});

// ── Monthly plan (pending_payment + payment row) ──────────────────────────────

describe("POST /subscriptions — monthly plan duplicate prevention", () => {
  it("first request creates a pending subscription and returns 201", async () => {
    const { id: userId, cookie } = await createUser();
    createdUserIds.push(userId);

    const res = await request
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ planId: monthlyPlanId, provider: "manual_sbp" });

    expect(res.status).toBe(201);
    expect(res.body.subscription).toBeDefined();
    expect(res.body.subscription.status).toBe("pending_payment");
    expect(res.body.payment).toBeDefined();
    expect(res.body.payment.status).toBe("pending");
  });

  it("sequential duplicate: second request returns 409, not 500", async () => {
    const { id: userId, cookie } = await createUser();
    createdUserIds.push(userId);

    const first = await request
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ planId: monthlyPlanId, provider: "manual_sbp" });
    expect(first.status).toBe(201);

    const second = await request
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ planId: monthlyPlanId, provider: "manual_sbp" });

    expect(second.status).toBe(409);
    expect(second.body.existingSubscriptionId).toBeDefined();

    // Only one subscription row must exist for this user
    const subs = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.userId, userId),
          eq(subscriptionsTable.status, "pending_payment"),
        ),
      );
    expect(subs.length).toBe(1);
  });

  it("concurrent duplicate: both requests return non-500, only one subscription row created", async () => {
    const { id: userId, cookie } = await createUser();
    createdUserIds.push(userId);

    // Fire two requests concurrently — simulates Amvera retrying a slow POST
    const [res1, res2] = await Promise.all([
      request
        .post("/api/subscriptions")
        .set("Cookie", cookie)
        .send({ planId: monthlyPlanId, provider: "manual_sbp" }),
      request
        .post("/api/subscriptions")
        .set("Cookie", cookie)
        .send({ planId: monthlyPlanId, provider: "manual_sbp" }),
    ]);

    // Neither may be a 500 — the user must never see an unhandled error
    expect(res1.status).not.toBe(500);
    expect(res2.status).not.toBe(500);

    // Exactly one must succeed (201); the other must be rejected (409)
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Database must have exactly one pending subscription row
    const pendingSubs = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.userId, userId),
          eq(subscriptionsTable.status, "pending_payment"),
        ),
      );
    expect(pendingSubs.length).toBe(1);

    // And exactly one pending payment row
    const pendingPayments = await db
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(
        and(
          eq(paymentsTable.userId, userId),
          eq(paymentsTable.status, "pending"),
        ),
      );
    expect(pendingPayments.length).toBe(1);
  });
});

// ── Hourly plan (immediately activated via balance) ───────────────────────────

describe("POST /subscriptions — hourly plan duplicate prevention", () => {
  it("first request activates the hourly plan and returns 201", async () => {
    const { id: userId, cookie } = await createUser();
    createdUserIds.push(userId);

    const res = await request
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ planId: hourlyPlanId });

    expect(res.status).toBe(201);
    expect(res.body.subscription).toBeDefined();
    expect(res.body.subscription.status).toBe("active");
    expect(res.body.payment).toBeNull();
  });

  it("sequential duplicate: second request returns 409, not 500", async () => {
    const { id: userId, cookie } = await createUser();
    createdUserIds.push(userId);

    const first = await request
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ planId: hourlyPlanId });
    expect(first.status).toBe(201);

    const second = await request
      .post("/api/subscriptions")
      .set("Cookie", cookie)
      .send({ planId: hourlyPlanId });

    expect(second.status).toBe(409);

    // Only one active subscription row
    const activeSubs = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.userId, userId),
          eq(subscriptionsTable.status, "active"),
        ),
      );
    expect(activeSubs.length).toBe(1);
  });

  it("concurrent duplicate: both requests return non-500, only one active subscription", async () => {
    const { id: userId, cookie } = await createUser();
    createdUserIds.push(userId);

    const [res1, res2] = await Promise.all([
      request
        .post("/api/subscriptions")
        .set("Cookie", cookie)
        .send({ planId: hourlyPlanId }),
      request
        .post("/api/subscriptions")
        .set("Cookie", cookie)
        .send({ planId: hourlyPlanId }),
    ]);

    // Neither may be a 500 — the user must never see an unhandled error.
    // The FOR UPDATE lock inside the transaction serialises concurrent
    // activations: the second request blocks until the first commits, then
    // re-checks and finds the newly active subscription → 409.
    expect(res1.status).not.toBe(500);
    expect(res2.status).not.toBe(500);

    // Exactly one must succeed (201); the other must be rejected (409).
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Database must have exactly one active subscription row for this user
    const activeSubs = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.userId, userId),
          eq(subscriptionsTable.status, "active"),
        ),
      );
    expect(activeSubs.length).toBe(1);
  });
});
