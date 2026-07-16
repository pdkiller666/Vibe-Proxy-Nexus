/**
 * Integration tests for runHourlyBillingTick().
 *
 * Each test seeds its own isolated user + subscription + VPN key(s), calls the
 * billing tick, and asserts the resulting DB state. Xray is mocked out so no
 * real gRPC calls are made.
 *
 * Key constants (must match hourlyBilling.ts):
 *   BILLING_TICK_MS  = 5 * 60 * 1_000   (5 minutes)
 *   IDLE_GRACE_MS    = 15 * 60 * 1_000  (15 minutes)
 *   perTickKopecks   = hourlyRateKopecks / 12
 */
import { randomBytes } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  db,
  balanceTransactionsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { runHourlyBillingTick } from "./hourlyBilling";

vi.mock("./xray", () => ({
  isLocalXrayEnabled: () => false,
  removeXrayClient: vi.fn(),
}));

// Mirror of constants in hourlyBilling.ts — changing these here without
// changing the source would make the tests trivially pass on wrong logic.
const TICK_MS = 5 * 60 * 1_000;
const IDLE_GRACE_MS = 15 * 60 * 1_000;

// Plan rate: 1200 kopecks/hour → 100 kopecks per 5-minute tick.
const HOURLY_RATE_KOPECKS = 1_200;
const PER_TICK_KOPECKS = HOURLY_RATE_KOPECKS / 12; // 100

describe("runHourlyBillingTick", () => {
  let nodeId: number;
  let planId: number;

  // Per-test teardown lists — cleared in afterEach.
  const userIds: number[] = [];
  const subscriptionIds: number[] = [];
  const keyIds: number[] = [];

  beforeAll(async () => {
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Hourly billing test node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "billing-test.example.com",
        sni: "billing-test.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Hourly plan ${randomBytes(4).toString("hex")}`,
        priceRub: 0,
        durationDays: 0,
        billingType: "hourly",
        hourlyRateKopecks: HOURLY_RATE_KOPECKS,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;
  });

  afterEach(async () => {
    for (const id of keyIds.splice(0))
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    for (const id of subscriptionIds.splice(0))
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    for (const id of userIds.splice(0))
      await db.delete(usersTable).where(eq(usersTable.id, id));
  });

  afterAll(async () => {
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function seedUser(balanceKopecks: number): Promise<{ id: number }> {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `hourly-billing-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
        balanceKopecks,
      })
      .returning({ id: usersTable.id });
    userIds.push(user.id);
    return user;
  }

  async function seedSubscription(
    userId: number,
    lastBilledAt: Date | null,
  ): Promise<{ id: number }> {
    const [sub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId,
        status: "active",
        startsAt: new Date(Date.now() - 2 * 60 * 60 * 1_000), // started 2h ago
        lastBilledAt,
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(sub.id);
    return sub;
  }

  async function seedKey(
    userId: number,
    lastTrafficAt: Date | null,
  ): Promise<{ id: number }> {
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "test",
        vlessLink: "vless://test",
        deepLink: "happ://test",
        lastTrafficAt,
      })
      .returning({ id: vpnKeysTable.id });
    keyIds.push(key.id);
    return key;
  }

  async function getUser(id: number) {
    const [u] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    return u!;
  }

  async function getSubscription(id: number) {
    const [s] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    return s!;
  }

  async function getKey(id: number) {
    const [k] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    return k!;
  }

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  it("is a no-op when the user's device has never sent traffic (lastTrafficAt = null)", async () => {
    const { id: userId } = await seedUser(100_000);
    const { id: subId } = await seedSubscription(userId, new Date(Date.now() - TICK_MS));
    await seedKey(userId, null); // device exists but no traffic yet

    const result = await runHourlyBillingTick();

    expect(result.billed).toBe(0);
    expect(result.expired).toBe(0);
    const user = await getUser(userId);
    expect(user.balanceKopecks).toBe(100_000); // unchanged
    const sub = await getSubscription(subId);
    expect(sub.status).toBe("active");
  });

  it("is a no-op when the device has been idle past the grace window and before the billing window", async () => {
    // lastTrafficAt is OLDER than lastBilledAt, and the idle period exceeds
    // IDLE_GRACE_MS so isActiveNow = false.  billUpToMs = lastTrafficAt, which
    // is before billFrom = lastBilledAt → ticksElapsed < 0 → no charge.
    const lastBilledAt = new Date(Date.now() - TICK_MS);
    const lastTrafficAt = new Date(Date.now() - (IDLE_GRACE_MS + TICK_MS)); // idle 20 min, before last bill
    const { id: userId } = await seedUser(100_000);
    await seedSubscription(userId, lastBilledAt);
    await seedKey(userId, lastTrafficAt);

    const result = await runHourlyBillingTick();

    expect(result.billed).toBe(0);
    const user = await getUser(userId);
    expect(user.balanceKopecks).toBe(100_000);
  });

  it("charges for exactly one tick when the device sent traffic within the last tick window", async () => {
    const lastBilledAt = new Date(Date.now() - TICK_MS);
    const { id: userId } = await seedUser(10_000);
    const { id: subId } = await seedSubscription(userId, lastBilledAt);
    await seedKey(userId, new Date()); // active right now

    await runHourlyBillingTick();

    const user = await getUser(userId);
    // Charged exactly 1 tick (100 kopecks). Math.round(1 * 100) = 100.
    expect(user.balanceKopecks).toBe(10_000 - PER_TICK_KOPECKS);
    const sub = await getSubscription(subId);
    expect(sub.status).toBe("active");
    // lastBilledAt advanced by one tick.
    expect(sub.lastBilledAt?.getTime()).toBeCloseTo(lastBilledAt.getTime() + TICK_MS, -3);
  });

  it("charges for multiple elapsed ticks when the device has been consistently active", async () => {
    const N_TICKS = 4;
    const lastBilledAt = new Date(Date.now() - N_TICKS * TICK_MS);
    const { id: userId } = await seedUser(100_000);
    await seedSubscription(userId, lastBilledAt);
    await seedKey(userId, new Date()); // active right now

    await runHourlyBillingTick();

    const user = await getUser(userId);
    expect(user.balanceKopecks).toBe(100_000 - N_TICKS * PER_TICK_KOPECKS);
  });

  it("writes a ledger entry (balance transaction) for each charged tick", async () => {
    const lastBilledAt = new Date(Date.now() - TICK_MS);
    const { id: userId } = await seedUser(10_000);
    await seedSubscription(userId, lastBilledAt);
    await seedKey(userId, new Date());

    await runHourlyBillingTick();

    const txns = await db
      .select()
      .from(balanceTransactionsTable)
      .where(eq(balanceTransactionsTable.userId, userId));

    // Exactly one debit ledger entry.
    expect(txns).toHaveLength(1);
    expect(txns[0]!.type).toBe("debit");
    expect(txns[0]!.amountKopecks).toBe(-PER_TICK_KOPECKS);

    // Cleanup: remove the ledger entry so afterEach user delete doesn't FK-fail.
    await db.delete(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, userId));
  });

  it("expires the subscription when the balance cannot cover even one tick", async () => {
    // balance = 0 → affordableTicks = 0 → immediately expired
    const lastBilledAt = new Date(Date.now() - TICK_MS);
    const { id: userId } = await seedUser(0);
    const { id: subId } = await seedSubscription(userId, lastBilledAt);
    const { id: keyId } = await seedKey(userId, new Date());

    await runHourlyBillingTick();

    const sub = await getSubscription(subId);
    expect(sub.status).toBe("expired");

    const key = await getKey(keyId);
    expect(key.revokedAt).not.toBeNull();
    expect(key.revokedReason).toBe("billing");
  });

  it("charges up to what the balance can afford, then expires and revokes keys", async () => {
    // Enough for 2 ticks out of 5 elapsed.
    const N_ELAPSED = 5;
    const lastBilledAt = new Date(Date.now() - N_ELAPSED * TICK_MS);
    const balance = 2 * PER_TICK_KOPECKS; // exactly 200 kopecks
    const { id: userId } = await seedUser(balance);
    const { id: subId } = await seedSubscription(userId, lastBilledAt);
    const { id: keyId } = await seedKey(userId, new Date());

    await runHourlyBillingTick();

    // Balance fully drained (2 ticks charged).
    const user = await getUser(userId);
    expect(user.balanceKopecks).toBe(0);

    // Subscription expired because balance ran out before all ticks were covered.
    const sub = await getSubscription(subId);
    expect(sub.status).toBe("expired");

    // Key revoked.
    const key = await getKey(keyId);
    expect(key.revokedAt).not.toBeNull();
    expect(key.revokedReason).toBe("billing");

    // Cleanup ledger entry.
    await db.delete(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, userId));
  });

  it("charges all active keys' users independently (two active users on the same plan)", async () => {
    const lastBilledAt = new Date(Date.now() - TICK_MS);
    const { id: userId1 } = await seedUser(10_000);
    const { id: userId2 } = await seedUser(10_000);
    await seedSubscription(userId1, lastBilledAt);
    await seedSubscription(userId2, lastBilledAt);
    await seedKey(userId1, new Date());
    await seedKey(userId2, new Date());

    await runHourlyBillingTick();

    const user1 = await getUser(userId1);
    const user2 = await getUser(userId2);
    expect(user1.balanceKopecks).toBe(10_000 - PER_TICK_KOPECKS);
    expect(user2.balanceKopecks).toBe(10_000 - PER_TICK_KOPECKS);

    // Cleanup ledger.
    for (const uid of [userId1, userId2]) {
      await db.delete(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, uid));
    }
  });

  it("does not charge a second time when called again immediately (no new elapsed ticks)", async () => {
    const lastBilledAt = new Date(Date.now() - TICK_MS);
    const { id: userId } = await seedUser(10_000);
    await seedSubscription(userId, lastBilledAt);
    await seedKey(userId, new Date());

    // First tick — charges 1 tick and advances lastBilledAt to roughly now.
    await runHourlyBillingTick();

    const after1 = await getUser(userId);
    expect(after1.balanceKopecks).toBe(10_000 - PER_TICK_KOPECKS);

    // Second tick called immediately — lastBilledAt is now ≈ now, so
    // ticksElapsed = 0 and no additional charge should happen.
    await runHourlyBillingTick();

    const after2 = await getUser(userId);
    expect(after2.balanceKopecks).toBe(10_000 - PER_TICK_KOPECKS); // still the same

    // Cleanup ledger.
    await db.delete(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, userId));
  });

  it("does not revoke keys when a user still has another active subscription after expiry", async () => {
    // This mirrors the logic in hourlyBilling.ts that checks stillActive before revoking.
    const { id: userId } = await seedUser(0); // balance = 0 → will expire
    const { id: hourlySubId } = await seedSubscription(userId, new Date(Date.now() - TICK_MS));
    await seedKey(userId, new Date());

    // Give the user a second *non-hourly* active subscription (e.g. monthly) that
    // should keep their keys alive even after the hourly one expires.
    const [monthlyPlan] = await db
      .insert(plansTable)
      .values({
        name: `Monthly backup ${randomBytes(4).toString("hex")}`,
        priceRub: 30000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });

    const [monthlySub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: monthlyPlan.id,
        status: "active",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(monthlySub.id);

    await runHourlyBillingTick();

    // Hourly sub expired.
    const hourlySubRow = await getSubscription(hourlySubId);
    expect(hourlySubRow.status).toBe("expired");

    // But the user still has an active monthly sub, so their key stays active.
    const activeKeys = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, userId));
    const allRevoked = activeKeys.every((k) => k.revokedAt !== null);
    expect(allRevoked).toBe(false); // at least one key still active

    // Cleanup.
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, monthlySub.id));
    await db.delete(plansTable).where(eq(plansTable.id, monthlyPlan.id));
  });
});
