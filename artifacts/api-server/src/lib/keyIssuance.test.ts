/**
 * Unit tests for isTrafficLimitBlocked — the check that closes the
 * "revoke-and-reissue" loophole around per-period traffic caps (see
 * trafficPolling.ts enforceTrafficLimits, which sets trafficLimitExceededAt).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, plansTable, subscriptionsTable, usersTable } from "@workspace/db";
import { isTrafficLimitBlocked } from "./keyIssuance";

describe("isTrafficLimitBlocked", () => {
  let userId: number;
  let planId: number;
  const subscriptionIds: number[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `traffic-blocked-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Traffic blocked plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        trafficLimitGb: 10,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;
  });

  afterEach(async () => {
    for (const id of subscriptionIds.splice(0)) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  async function seedActiveSubscription(trafficLimitExceededAt: Date | null): Promise<number> {
    const [sub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId,
        status: "active",
        startsAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        trafficLimitExceededAt,
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(sub.id);
    return sub.id;
  }

  it("returns false when the active subscription has never exceeded its limit", async () => {
    await seedActiveSubscription(null);
    expect(await isTrafficLimitBlocked(userId)).toBe(false);
  });

  it("returns true once the active subscription's trafficLimitExceededAt is set", async () => {
    await seedActiveSubscription(new Date());
    expect(await isTrafficLimitBlocked(userId)).toBe(true);
  });

  it("returns false when there is no active subscription at all", async () => {
    // No subscription seeded for this test.
    expect(await isTrafficLimitBlocked(userId)).toBe(false);
  });
});
