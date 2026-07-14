/**
 * Unit tests for applyTrafficDeltas, focused on the subscription period-reset
 * scenario described in the task: when a subscription renews, the admin routes
 * zero periodUpBytes / periodDownBytes but MUST leave lastSeenUpBytes /
 * lastSeenDownBytes untouched.  If lastSeen* were also zeroed, the next poll
 * would compute  current - 0 = full lifetime counter  as the delta, silently
 * inflating the fresh period with all historical traffic.
 */
import { randomBytes } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, plansTable, subscriptionsTable, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { applyTrafficDeltas, enforceTrafficLimits } from "./trafficPolling";

// Prevent tests from attempting real gRPC calls to Xray.  applyTrafficDeltas
// never touches xray.ts, and enforceTrafficLimits only calls into it when
// isLocalXrayEnabled() returns true.
vi.mock("./xray", () => ({
  isLocalXrayEnabled: () => false,
  removeXrayClient: vi.fn(),
}));

describe("applyTrafficDeltas", () => {
  let userId: number;
  let nodeId: number;
  const keyIds: number[] = [];
  const subscriptionIds: number[] = [];
  let planId: number;

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `traffic-polling-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Traffic test node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Traffic plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;
  });

  afterEach(async () => {
    for (const id of keyIds.splice(0)) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    }
    for (const id of subscriptionIds.splice(0)) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  async function seedKey(overrides: {
    lastSeenUpBytes?: number;
    lastSeenDownBytes?: number;
    periodUpBytes?: number;
    periodDownBytes?: number;
    trafficUpBytes?: number;
    trafficDownBytes?: number;
  } = {}): Promise<{ id: number; uuid: string }> {
    const uuid = randomBytes(16).toString("hex");
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId,
        uuid,
        label: "test key",
        vlessLink: "vless://test",
        deepLink: "happ://test",
        ...overrides,
      })
      .returning({ id: vpnKeysTable.id, uuid: vpnKeysTable.uuid });
    keyIds.push(key.id);
    return key;
  }

  async function getKey(id: number) {
    const [key] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    return key!;
  }

  // -------------------------------------------------------------------------
  // Basic delta accounting
  // -------------------------------------------------------------------------

  it("accumulates deltas from a zero baseline on the first poll", async () => {
    const { id, uuid } = await seedKey(); // lastSeen* start at 0

    await applyTrafficDeltas(new Map([[uuid, { uplinkBytes: 1000, downlinkBytes: 2000 }]]));

    const key = await getKey(id);
    expect(key.trafficUpBytes).toBe(1000);
    expect(key.trafficDownBytes).toBe(2000);
    expect(key.periodUpBytes).toBe(1000);
    expect(key.periodDownBytes).toBe(2000);
    expect(key.lastSeenUpBytes).toBe(1000);
    expect(key.lastSeenDownBytes).toBe(2000);
  });

  it("credits only the incremental delta on subsequent polls (not the cumulative absolute)", async () => {
    // Simulate: 1 000 bytes already credited in a prior poll cycle.
    const { id, uuid } = await seedKey({
      lastSeenUpBytes: 1000,
      lastSeenDownBytes: 2000,
      trafficUpBytes: 1000,
      trafficDownBytes: 2000,
      periodUpBytes: 1000,
      periodDownBytes: 2000,
    });

    // Xray now reports 1 500 up / 3 000 down — only the 500 / 1 000 delta
    // since the last poll should be credited.
    await applyTrafficDeltas(new Map([[uuid, { uplinkBytes: 1500, downlinkBytes: 3000 }]]));

    const key = await getKey(id);
    expect(key.trafficUpBytes).toBe(1500);
    expect(key.trafficDownBytes).toBe(3000);
    expect(key.periodUpBytes).toBe(1500);
    expect(key.periodDownBytes).toBe(3000);
    expect(key.lastSeenUpBytes).toBe(1500);
    expect(key.lastSeenDownBytes).toBe(3000);
  });

  it("is a no-op when no counters are provided", async () => {
    const { id } = await seedKey({ lastSeenUpBytes: 500, periodUpBytes: 500 });

    await applyTrafficDeltas(new Map());

    const key = await getKey(id);
    expect(key.periodUpBytes).toBe(500);
    expect(key.lastSeenUpBytes).toBe(500);
  });

  // -------------------------------------------------------------------------
  // Period-reset safety: the core invariant this task enforces
  // -------------------------------------------------------------------------

  it("does not inflate the new period when a subscription period reset occurs between polls", async () => {
    // Phase 1: a user has accumulated 50 GB of traffic over the lifetime of
    // their subscription.  Xray's absolute counter stands at 50 000 bytes
    // (scaled down for the test) and lastSeen reflects that.
    const LIFETIME_BYTES_UP = 50_000;
    const LIFETIME_BYTES_DOWN = 80_000;

    const { id, uuid } = await seedKey({
      lastSeenUpBytes: LIFETIME_BYTES_UP,
      lastSeenDownBytes: LIFETIME_BYTES_DOWN,
      trafficUpBytes: LIFETIME_BYTES_UP,
      trafficDownBytes: LIFETIME_BYTES_DOWN,
      periodUpBytes: LIFETIME_BYTES_UP,
      periodDownBytes: LIFETIME_BYTES_DOWN,
    });

    // Phase 2: the admin confirms a renewal payment (or grants a new
    // subscription).  The route logic zeros period* but leaves lastSeen*
    // alone — simulate exactly that UPDATE here so this test validates the
    // invariant the routes are required to uphold.
    await db
      .update(vpnKeysTable)
      .set({ periodUpBytes: 0, periodDownBytes: 0, periodStartedAt: new Date() })
      .where(eq(vpnKeysTable.id, id));

    // Phase 3: user generates 1 000 / 2 000 new bytes after the renewal.
    // Xray's counter is now 51 000 / 82 000 (it never resets — reset:false).
    const NEW_XRAY_UP = LIFETIME_BYTES_UP + 1_000;
    const NEW_XRAY_DOWN = LIFETIME_BYTES_DOWN + 2_000;

    await applyTrafficDeltas(new Map([[uuid, { uplinkBytes: NEW_XRAY_UP, downlinkBytes: NEW_XRAY_DOWN }]]));

    const key = await getKey(id);

    // Period counters must reflect only traffic since the renewal (1 000 /
    // 2 000), not the full absolute counter (51 000 / 82 000).
    expect(key.periodUpBytes).toBe(1_000);
    expect(key.periodDownBytes).toBe(2_000);

    // Lifetime counters keep accumulating as normal.
    expect(key.trafficUpBytes).toBe(NEW_XRAY_UP);
    expect(key.trafficDownBytes).toBe(NEW_XRAY_DOWN);

    // lastSeen advances to the new absolute reading.
    expect(key.lastSeenUpBytes).toBe(NEW_XRAY_UP);
    expect(key.lastSeenDownBytes).toBe(NEW_XRAY_DOWN);
  });

  it("period counters stay at 0 after a renewal with no new traffic yet", async () => {
    const { id, uuid } = await seedKey({
      lastSeenUpBytes: 10_000,
      lastSeenDownBytes: 20_000,
      trafficUpBytes: 10_000,
      trafficDownBytes: 20_000,
      periodUpBytes: 10_000,
      periodDownBytes: 20_000,
    });

    // Renewal: zero period* only.
    await db
      .update(vpnKeysTable)
      .set({ periodUpBytes: 0, periodDownBytes: 0, periodStartedAt: new Date() })
      .where(eq(vpnKeysTable.id, id));

    // No new traffic yet — Xray still reports the same absolute values.
    await applyTrafficDeltas(new Map([[uuid, { uplinkBytes: 10_000, downlinkBytes: 20_000 }]]));

    const key = await getKey(id);
    expect(key.periodUpBytes).toBe(0);
    expect(key.periodDownBytes).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Xray-restart resilience (regression guard for the lastSeen > current path)
  // -------------------------------------------------------------------------

  it("treats the full current value as the delta when Xray's counter is lower than lastSeen (restart scenario)", async () => {
    // Before the restart, 5 000 bytes had been credited.
    const { id, uuid } = await seedKey({
      lastSeenUpBytes: 5_000,
      lastSeenDownBytes: 8_000,
      trafficUpBytes: 5_000,
      trafficDownBytes: 8_000,
      periodUpBytes: 5_000,
      periodDownBytes: 8_000,
    });

    // Xray restarted and its counter is back to 300 / 500 (traffic since
    // the restart).  current < lastSeen, so the delta is just `current`.
    await applyTrafficDeltas(new Map([[uuid, { uplinkBytes: 300, downlinkBytes: 500 }]]));

    const key = await getKey(id);
    expect(key.trafficUpBytes).toBe(5_300);
    expect(key.trafficDownBytes).toBe(8_500);
    expect(key.periodUpBytes).toBe(5_300);
    expect(key.periodDownBytes).toBe(8_500);
    expect(key.lastSeenUpBytes).toBe(300);
    expect(key.lastSeenDownBytes).toBe(500);
  });

  // -------------------------------------------------------------------------
  // Two-path combination: period reset + Xray restart in the same interval
  // -------------------------------------------------------------------------

  it("handles a period reset combined with an Xray restart gracefully", async () => {
    // Lots of historical traffic, lastSeen reflects it.
    const { id, uuid } = await seedKey({
      lastSeenUpBytes: 100_000,
      lastSeenDownBytes: 200_000,
      trafficUpBytes: 100_000,
      trafficDownBytes: 200_000,
      periodUpBytes: 100_000,
      periodDownBytes: 200_000,
    });

    // Renewal: zero period* but keep lastSeen*.
    await db
      .update(vpnKeysTable)
      .set({ periodUpBytes: 0, periodDownBytes: 0, periodStartedAt: new Date() })
      .where(eq(vpnKeysTable.id, id));

    // Xray also restarted (independently — e.g. config push), so its counter
    // is a small value below the preserved lastSeen.
    await applyTrafficDeltas(new Map([[uuid, { uplinkBytes: 400, downlinkBytes: 600 }]]));

    const key = await getKey(id);

    // The restart branch (current < lastSeen) treats current as the delta,
    // so only 400 / 600 new bytes land in the new period — not 100 400.
    expect(key.periodUpBytes).toBe(400);
    expect(key.periodDownBytes).toBe(600);
    expect(key.trafficUpBytes).toBe(100_400);
    expect(key.trafficDownBytes).toBe(200_600);
  });
});

// ---------------------------------------------------------------------------
// enforceTrafficLimits — billing-period correctness
// ---------------------------------------------------------------------------

describe("enforceTrafficLimits", () => {
  // One shared user + node for the whole suite; plans are seeded per-test so
  // each test controls exactly which trafficLimitGb it needs.
  let userId: number;
  let nodeId: number;
  const keyIds: number[] = [];
  const subscriptionIds: number[] = [];
  const planIds: number[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `enforce-limits-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Enforce limits node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;
  });

  afterEach(async () => {
    for (const id of keyIds.splice(0)) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    }
    for (const id of subscriptionIds.splice(0)) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    for (const id of planIds.splice(0)) {
      await db.delete(plansTable).where(eq(plansTable.id, id));
    }
  });

  afterAll(async () => {
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  /** Seed a plan with an optional traffic cap in GB. */
  async function seedPlan(trafficLimitGb: number | null): Promise<number> {
    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Enforce plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        trafficLimitGb,
      })
      .returning({ id: plansTable.id });
    planIds.push(plan.id);
    return plan.id;
  }

  /** Seed an active subscription for the shared user on the given plan. */
  async function seedActiveSubscription(planId: number): Promise<number> {
    const [sub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId,
        status: "active",
        startsAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
        endsAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),   // 15 days from now
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(sub.id);
    return sub.id;
  }

  /** Seed a VPN key for the shared user with specific period byte counters. */
  async function seedKey(overrides: {
    periodUpBytes?: number;
    periodDownBytes?: number;
    trafficUpBytes?: number;
    trafficDownBytes?: number;
  } = {}): Promise<number> {
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "test key",
        vlessLink: "vless://test",
        deepLink: "happ://test",
        ...overrides,
      })
      .returning({ id: vpnKeysTable.id });
    keyIds.push(key.id);
    return key.id;
  }

  async function getKey(id: number) {
    const [key] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    return key!;
  }

  // -------------------------------------------------------------------------
  // Core billing-period correctness: the main invariant this task enforces
  // -------------------------------------------------------------------------

  it("does NOT revoke a key when period bytes are 0, even if lifetime bytes are huge", async () => {
    // This simulates a user who exhausted their previous billing period but
    // just renewed: the admin reset period* to 0.  enforceTrafficLimits must
    // compare against period bytes only — not lifetime bytes — so the user
    // keeps access until they exhaust the new period.
    const planId = await seedPlan(10); // 10 GB cap
    await seedActiveSubscription(planId);
    const keyId = await seedKey({
      periodUpBytes: 0,
      periodDownBytes: 0,
      trafficUpBytes: 50 * 1024 * 1024 * 1024, // 50 GB lifetime
      trafficDownBytes: 80 * 1024 * 1024 * 1024,
    });

    const revokedCount = await enforceTrafficLimits();

    // The function may have acted on other users in the DB; we only care that
    // THIS user's key was not revoked.
    const key = await getKey(keyId);
    expect(key.revokedAt).toBeNull();
  });

  it("revokes keys when period bytes genuinely exceed the plan's cap", async () => {
    const LIMIT_GB = 10;
    const planId = await seedPlan(LIMIT_GB);
    await seedActiveSubscription(planId);

    // Seed a key whose period usage is 11 GB — 1 GB over the cap.
    const OVER_LIMIT_BYTES = 11 * 1024 * 1024 * 1024;
    const keyId = await seedKey({
      periodUpBytes: Math.floor(OVER_LIMIT_BYTES / 2),
      periodDownBytes: Math.ceil(OVER_LIMIT_BYTES / 2),
    });

    await enforceTrafficLimits();

    const key = await getKey(keyId);
    expect(key.revokedAt).not.toBeNull();
  });

  it("revokes a key when period bytes are exactly at the cap (boundary check)", async () => {
    // enforceTrafficLimits uses `periodBytes < limitBytes` — reaching the exact
    // limit triggers revocation, only strictly-below escapes it.
    const LIMIT_GB = 10;
    const planId = await seedPlan(LIMIT_GB);
    await seedActiveSubscription(planId);

    const LIMIT_BYTES = LIMIT_GB * 1024 * 1024 * 1024;
    const keyId = await seedKey({
      periodUpBytes: Math.floor(LIMIT_BYTES / 2),
      periodDownBytes: Math.ceil(LIMIT_BYTES / 2),
    });

    await enforceTrafficLimits();

    const key = await getKey(keyId);
    expect(key.revokedAt).not.toBeNull();
  });

  it("does NOT revoke a key when period bytes are one byte below the cap", async () => {
    const LIMIT_GB = 10;
    const planId = await seedPlan(LIMIT_GB);
    await seedActiveSubscription(planId);

    const LIMIT_BYTES = LIMIT_GB * 1024 * 1024 * 1024;
    const keyId = await seedKey({
      periodUpBytes: Math.floor((LIMIT_BYTES - 1) / 2),
      periodDownBytes: Math.floor((LIMIT_BYTES - 1) / 2),
    });

    await enforceTrafficLimits();

    const key = await getKey(keyId);
    expect(key.revokedAt).toBeNull();
  });

  it("never revokes a key when the plan has no trafficLimitGb cap (unlimited plan)", async () => {
    const planId = await seedPlan(null); // no cap
    await seedActiveSubscription(planId);

    // Absurdly large period bytes — should still not be revoked.
    const keyId = await seedKey({
      periodUpBytes: 1_000 * 1024 * 1024 * 1024,
      periodDownBytes: 1_000 * 1024 * 1024 * 1024,
    });

    await enforceTrafficLimits();

    const key = await getKey(keyId);
    expect(key.revokedAt).toBeNull();
  });

  it("revokes all active keys for the over-limit user, not just the first one", async () => {
    const planId = await seedPlan(5); // 5 GB cap
    await seedActiveSubscription(planId);

    const OVER_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
    // Split the usage across two keys (both active, both owned by the same user).
    const keyId1 = await seedKey({
      periodUpBytes: Math.floor(OVER_LIMIT_BYTES / 2),
      periodDownBytes: Math.ceil(OVER_LIMIT_BYTES / 2),
    });
    const keyId2 = await seedKey({ periodUpBytes: 0, periodDownBytes: 0 });

    await enforceTrafficLimits();

    const [key1, key2] = await Promise.all([getKey(keyId1), getKey(keyId2)]);
    expect(key1.revokedAt).not.toBeNull();
    expect(key2.revokedAt).not.toBeNull();
  });

  it("does not revoke keys for a user with no active subscription", async () => {
    // No subscription seeded — the inner join in enforceTrafficLimits should
    // exclude this user entirely.
    const keyId = await seedKey({
      periodUpBytes: 100 * 1024 * 1024 * 1024,
      periodDownBytes: 100 * 1024 * 1024 * 1024,
    });

    await enforceTrafficLimits();

    const key = await getKey(keyId);
    expect(key.revokedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Reissue-loophole closure: revokedReason + trafficLimitExceededAt flag
  // -------------------------------------------------------------------------

  it("stamps revokedReason='traffic_limit' and sets trafficLimitExceededAt on the subscription", async () => {
    const planId = await seedPlan(5); // 5 GB cap
    const subscriptionId = await seedActiveSubscription(planId);

    const OVER_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
    const keyId = await seedKey({
      periodUpBytes: Math.floor(OVER_LIMIT_BYTES / 2),
      periodDownBytes: Math.ceil(OVER_LIMIT_BYTES / 2),
    });

    await enforceTrafficLimits();

    const key = await getKey(keyId);
    expect(key.revokedAt).not.toBeNull();
    expect(key.revokedReason).toBe("traffic_limit");

    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, subscriptionId));
    expect(sub!.trafficLimitExceededAt).not.toBeNull();
  });

  it("raises the effective cap by extraTrafficGb, so a topped-up user is not revoked", async () => {
    const planId = await seedPlan(5); // 5 GB base cap
    const subscriptionId = await seedActiveSubscription(planId);
    // Top up +5 GB — total effective cap is now 10 GB.
    await db
      .update(subscriptionsTable)
      .set({ extraTrafficGb: 5 })
      .where(eq(subscriptionsTable.id, subscriptionId));

    // 6 GB used: over the base 5 GB cap, but under the effective 10 GB cap.
    const USED_BYTES = 6 * 1024 * 1024 * 1024;
    const keyId = await seedKey({
      periodUpBytes: Math.floor(USED_BYTES / 2),
      periodDownBytes: Math.ceil(USED_BYTES / 2),
    });

    await enforceTrafficLimits();

    const key = await getKey(keyId);
    expect(key.revokedAt).toBeNull();
  });

  it("does not re-stamp trafficLimitExceededAt once already set (top-up clears it independently)", async () => {
    const planId = await seedPlan(5);
    const subscriptionId = await seedActiveSubscription(planId);
    const alreadyFlaggedAt = new Date(Date.now() - 60_000);
    await db
      .update(subscriptionsTable)
      .set({ trafficLimitExceededAt: alreadyFlaggedAt })
      .where(eq(subscriptionsTable.id, subscriptionId));

    const OVER_LIMIT_BYTES = 6 * 1024 * 1024 * 1024;
    await seedKey({
      periodUpBytes: Math.floor(OVER_LIMIT_BYTES / 2),
      periodDownBytes: Math.ceil(OVER_LIMIT_BYTES / 2),
    });

    await enforceTrafficLimits();

    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, subscriptionId));
    expect(sub!.trafficLimitExceededAt?.getTime()).toBe(alreadyFlaggedAt.getTime());
  });
});
