/**
 * Tests for lockCurrentSubscription — the single canonical "current
 * subscription" row selector shared by issueKeyForUser's serialization lock
 * (keyIssuance.ts), the extra_traffic top-up credit (confirmPayment.ts), and
 * enforceTrafficLimits' re-check (trafficPolling.ts). Every one of those
 * callers MUST resolve to the same row for a given user, or their
 * `SELECT ... FOR UPDATE` locks silently target different rows and stop
 * serializing against each other.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, plansTable, subscriptionsTable, usersTable } from "@workspace/db";
import { lockCurrentSubscription } from "./subscription";

describe("lockCurrentSubscription", () => {
  const createdUserIds: number[] = [];
  let planId: number;

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
    if (planId) await db.delete(plansTable).where(eq(plansTable.id, planId));
  });

  async function seedUser(): Promise<number> {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `lock-current-sub-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    createdUserIds.push(user.id);
    return user.id;
  }

  async function ensurePlan(): Promise<number> {
    if (planId) return planId;
    const [plan] = await db
      .insert(plansTable)
      .values({ name: `lock-current-sub-plan-${randomBytes(4).toString("hex")}`, priceRub: 10000, durationDays: 30 })
      .returning({ id: plansTable.id });
    planId = plan.id;
    return planId;
  }

  it("picks the most-recently-started active, unexpired subscription over a stale-active one that already lapsed by endsAt", async () => {
    const userId = await seedUser();
    const pid = await ensurePlan();

    const [stale] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: pid,
        status: "active",
        startsAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 60 * 60 * 1000), // lapsed an hour ago, sweep hasn't run yet
      })
      .returning({ id: subscriptionsTable.id });

    const [current] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: pid,
        status: "active",
        startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });

    const locked = await db.transaction(async (tx) => lockCurrentSubscription(tx, userId));
    expect(locked?.id).toBe(current.id);
    expect(locked?.id).not.toBe(stale.id);
  });

  it("falls back to a subscription with endsAt=null (e.g. hourly plan) when it is the most recently started", async () => {
    const userId = await seedUser();
    const pid = await ensurePlan();

    await db.insert(subscriptionsTable).values({
      userId,
      planId: pid,
      status: "active",
      startsAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const [hourly] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: pid,
        status: "active",
        startsAt: new Date(Date.now() - 60 * 60 * 1000),
        endsAt: null,
      })
      .returning({ id: subscriptionsTable.id });

    const locked = await db.transaction(async (tx) => lockCurrentSubscription(tx, userId));
    expect(locked?.id).toBe(hourly.id);
  });

  it("returns undefined when the user has no active, unexpired subscription", async () => {
    const userId = await seedUser();
    const pid = await ensurePlan();

    await db.insert(subscriptionsTable).values({
      userId,
      planId: pid,
      status: "active",
      startsAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const locked = await db.transaction(async (tx) => lockCurrentSubscription(tx, userId));
    expect(locked).toBeUndefined();
  });

  it("blocks a concurrent caller until the first transaction holding the lock commits — proving both target the same row", async () => {
    const userId = await seedUser();
    const pid = await ensurePlan();

    const [sub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: pid,
        status: "active",
        startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });

    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstTx = db.transaction(async (tx) => {
      const locked = await lockCurrentSubscription(tx, userId);
      events.push("first-locked");
      expect(locked?.id).toBe(sub.id);
      await firstMayRelease; // hold the lock open until the test says to release it
      events.push("first-committing");
    });

    // Give the first transaction a moment to acquire its lock before starting the second.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondTx = db.transaction(async (tx) => {
      events.push("second-attempting");
      const locked = await lockCurrentSubscription(tx, userId); // must block here
      events.push("second-locked");
      expect(locked?.id).toBe(sub.id);
    });

    // Give the second transaction time to block on the lock before releasing the first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual(["first-locked", "second-attempting"]);

    releaseFirst();
    await Promise.all([firstTx, secondTx]);

    // The second call only proceeded past "second-attempting" after the first committed.
    expect(events.indexOf("first-committing")).toBeLessThan(events.indexOf("second-locked"));
  });
});
