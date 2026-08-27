/**
 * Unit tests for isTrafficLimitBlocked — the check that closes the
 * "revoke-and-reissue" loophole around per-period traffic caps (see
 * trafficPolling.ts enforceTrafficLimits, which sets trafficLimitExceededAt).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import {
  isTrafficLimitBlocked,
  issueKeyForUserUnlockedForTests,
  setReplayPollingForTests,
} from "./keyIssuance";

// Shrink the pending-replay poll window (prod: 10 × 500 ms ≈ 5 s, which would
// exceed Vitest's default 5 s test timeout) — independent of NODE_ENV.
setReplayPollingForTests(150, 5);

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
        referralCode: randomBytes(6).toString("hex"),
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

/**
 * Cross-process idempotency: races two calls to the UNLOCKED issuance
 * function, simulating two separate API processes (Amvera proxy retry hitting
 * a second instance) where the in-process per-user lock cannot help. Only the
 * DB-level guarantees apply: FOR UPDATE subscription lock, in-tx idempotency
 * re-check, and the unique index on idempotency_key.
 */
describe("issueKeyForUser idempotency across processes (unlocked)", () => {
  let userId: number;
  let planId: number;
  let nodeId: number;

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `idem-unlocked-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Idem unlocked plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 1,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    // Active subscription — required for the FOR UPDATE lock row to exist.
    await db.insert(subscriptionsTable).values({
      userId,
      planId,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Idem-unlocked node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "idem-unlocked.example.com",
        sni: "idem-unlocked.example.com",
        isActive: true,
        maxUsers: null,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;
  });

  afterEach(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("both racing requests get the SAME key when exactly one user slot remains", async () => {
    const idempotencyKey = randomBytes(16).toString("hex");

    // totalSlots = 1: the loser of the race would previously hit
    // SLOTS_EXCEEDED (409) instead of replaying the winner's 201.
    const [a, b] = await Promise.all([
      issueKeyForUserUnlockedForTests(userId, 1, nodeId, undefined, undefined, idempotencyKey),
      issueKeyForUserUnlockedForTests(userId, 1, nodeId, undefined, undefined, idempotencyKey),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.key.id).toBe(b.key.id);
      expect(a.key.uuid).toBe(b.key.uuid);
    }

    const rows = await db
      .select({ id: vpnKeysTable.id })
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, userId));
    expect(rows.length).toBe(1);
  });

  it("both racing requests get the SAME key when the node has exactly one capacity slot left", async () => {
    // Constrain the NODE (not the user): loser would previously hit NODE_FULL.
    await db.update(vpnNodesTable).set({ maxUsers: 1 }).where(eq(vpnNodesTable.id, nodeId));
    try {
      const idempotencyKey = randomBytes(16).toString("hex");

      // totalSlots = 2 so the user-slot check never fires — only node capacity.
      const [a, b] = await Promise.all([
        issueKeyForUserUnlockedForTests(userId, 2, nodeId, undefined, undefined, idempotencyKey),
        issueKeyForUserUnlockedForTests(userId, 2, nodeId, undefined, undefined, idempotencyKey),
      ]);

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (a.ok && b.ok) expect(a.key.id).toBe(b.key.id);

      const rows = await db
        .select({ id: vpnKeysTable.id })
        .from(vpnKeysTable)
        .where(eq(vpnKeysTable.userId, userId));
      expect(rows.length).toBe(1);
    } finally {
      await db.update(vpnNodesTable).set({ maxUsers: null }).where(eq(vpnNodesTable.id, nodeId));
    }
  });

  it("sequential retry after commit replays instead of 409 even at the slot limit", async () => {
    const idempotencyKey = randomBytes(16).toString("hex");

    const first = await issueKeyForUserUnlockedForTests(userId, 1, nodeId, undefined, undefined, idempotencyKey);
    expect(first.ok).toBe(true);

    // Retry arrives after the original committed and consumed the last slot.
    const retry = await issueKeyForUserUnlockedForTests(userId, 1, nodeId, undefined, undefined, idempotencyKey);
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) expect(retry.key.id).toBe(first.key.id);
  });
});

/**
 * enforceTrafficBlock re-check: closes the window between a caller's own
 * pre-check (isTrafficLimitBlocked, read outside any lock) and the moment
 * this function actually inserts a new key. Without the in-transaction
 * re-check, enforceTrafficLimits() (trafficPolling.ts) could flag the
 * subscription in that gap and a brand-new 0-byte key would still be issued.
 */
describe("issueKeyForUser enforceTrafficBlock re-check", () => {
  let userId: number;
  let planId: number;
  let nodeId: number;
  let subscriptionId: number;

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `enforce-block-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Enforce block plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 5,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Enforce block node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "enforce-block.example.com",
        sni: "enforce-block.example.com",
        isActive: true,
        maxUsers: null,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;
  });

  afterEach(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
  });

  afterAll(async () => {
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
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
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        trafficLimitExceededAt,
      })
      .returning({ id: subscriptionsTable.id });
    return sub.id;
  }

  it("refuses to issue a new key when the subscription is flagged and enforceTrafficBlock=true", async () => {
    subscriptionId = await seedActiveSubscription(new Date());

    const result = await issueKeyForUserUnlockedForTests(
      userId,
      5,
      nodeId,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // enforceTrafficBlock
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);

    const rows = await db.select({ id: vpnKeysTable.id }).from(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    expect(rows.length).toBe(0);
  });

  it("still issues a key when flagged but enforceTrafficBlock is omitted (admin/system bypass callers)", async () => {
    subscriptionId = await seedActiveSubscription(new Date());

    const result = await issueKeyForUserUnlockedForTests(userId, 5, nodeId);

    expect(result.ok).toBe(true);
  });

  it("issues a key normally when not flagged, even with enforceTrafficBlock=true", async () => {
    subscriptionId = await seedActiveSubscription(null);

    const result = await issueKeyForUserUnlockedForTests(
      userId,
      5,
      nodeId,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(result.ok).toBe(true);
  });

  it("checks the user's CURRENT subscription's flag, not a stale-active one with a different flag state", async () => {
    // A stale-active subscription (status='active' but already past endsAt —
    // the periodic expiry sweep hasn't run yet) is flagged as exceeded, but
    // the user's genuinely current subscription is not. The re-check must
    // follow lockCurrentSubscription's canonical row selection (same one
    // enforceTrafficLimits/confirmPayment use), not an arbitrary active row,
    // or a user who topped up under their current subscription could still
    // be wrongly blocked by an old, unrelated flag.
    await db.insert(subscriptionsTable).values({
      userId,
      planId,
      status: "active",
      startsAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
      trafficLimitExceededAt: new Date(),
    });
    subscriptionId = await seedActiveSubscription(null); // current, not flagged

    const allowed = await issueKeyForUserUnlockedForTests(
      userId,
      5,
      nodeId,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(allowed.ok).toBe(true);

    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));

    // Inverse: stale-active is NOT flagged, current IS flagged — must block.
    await db.insert(subscriptionsTable).values({
      userId,
      planId,
      status: "active",
      startsAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
      trafficLimitExceededAt: null,
    });
    subscriptionId = await seedActiveSubscription(new Date()); // current, flagged

    const blocked = await issueKeyForUserUnlockedForTests(
      userId,
      5,
      nodeId,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.status).toBe(403);
  });
});

/**
 * Provisioning-aware idempotency: a replay must never fabricate a 201 for a
 * key whose Xray provisioning failed or is still undecided.
 */
describe("issueKeyForUser idempotency vs Xray provisioning", () => {
  let userId: number;
  let planId: number;
  let remoteNodeId: number;

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `idem-prov-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(6).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Idem prov plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 2,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    await db.insert(subscriptionsTable).values({
      userId,
      planId,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // "Remote" node whose Management API is unreachable → every provisioning
    // attempt fails fast with ECONNREFUSED.
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Idem-prov node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "idem-prov.example.com",
        sni: "idem-prov.example.com",
        isActive: true,
        maxUsers: null,
        managementApiUrl: "http://127.0.0.1:9",
      })
      .returning({ id: vpnNodesTable.id });
    remoteNodeId = node.id;
  });

  afterEach(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, remoteNodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("a retry after a provisioning failure runs a fresh attempt, never replays the failed key as 201", async () => {
    const idempotencyKey = randomBytes(16).toString("hex");

    const first = await issueKeyForUserUnlockedForTests(userId, 2, remoteNodeId, undefined, undefined, idempotencyKey);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.status).toBe(502);

    // The compensating write revoked the row AND cleared its idempotency key.
    const rowsAfterFirst = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, userId));
    expect(rowsAfterFirst.length).toBe(1);
    expect(rowsAfterFirst[0].revokedAt).not.toBeNull();
    expect(rowsAfterFirst[0].idempotencyKey).toBeNull();
    expect(rowsAfterFirst[0].provisionedAt).toBeNull();

    // Retry: fresh attempt (also fails — node still down), NOT a 201 replay.
    const retry = await issueKeyForUserUnlockedForTests(userId, 2, remoteNodeId, undefined, undefined, idempotencyKey);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.status).toBe(502);

    const rowsAfterRetry = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, userId));
    expect(rowsAfterRetry.length).toBe(2);
    expect(rowsAfterRetry.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("a retry that finds the original still provisioning gets a retriable 409, not a fabricated 201", async () => {
    const idempotencyKey = randomBytes(16).toString("hex");

    // Simulate a cross-process original mid-provisioning: committed row,
    // provisionedAt NULL, not revoked.
    await db.insert(vpnKeysTable).values({
      userId,
      nodeId: remoteNodeId,
      uuid: randomBytes(16).toString("hex"),
      label: "pending-test",
      vlessLink: "vless://pending",
      deepLink: "happ://pending",
      idempotencyKey,
      provisionedAt: null,
    });

    const retry = await issueKeyForUserUnlockedForTests(userId, 2, remoteNodeId, undefined, undefined, idempotencyKey);
    expect(retry.ok).toBe(false);
    if (!retry.ok) {
      expect(retry.status).toBe(409);
      expect(retry.error).toContain("выпускается");
    }

    // No duplicate row was created by the retry.
    const rows = await db
      .select({ id: vpnKeysTable.id })
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, userId));
    expect(rows.length).toBe(1);
  });

  it("a retry waiting on a pending original returns 201 once the original finishes provisioning", async () => {
    const idempotencyKey = randomBytes(16).toString("hex");

    const [row] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId: remoteNodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "pending-then-done",
        vlessLink: "vless://pending",
        deepLink: "happ://pending",
        idempotencyKey,
        provisionedAt: null,
      })
      .returning({ id: vpnKeysTable.id });

    // Original "finishes provisioning" while the retry is polling.
    const finishSoon = (async () => {
      await new Promise((r) => setTimeout(r, 300));
      await db
        .update(vpnKeysTable)
        .set({ provisionedAt: new Date() })
        .where(eq(vpnKeysTable.id, row.id));
    })();

    const retry = await issueKeyForUserUnlockedForTests(userId, 2, remoteNodeId, undefined, undefined, idempotencyKey);
    await finishSoon;

    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.key.id).toBe(row.id);
  });
});
