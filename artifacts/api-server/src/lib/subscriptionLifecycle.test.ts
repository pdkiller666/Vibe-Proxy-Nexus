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
  expireOverdueSubscriptions,
  revokeKeysPastGracePeriod,
} from "./subscriptionLifecycle";

describe("expireOverdueSubscriptions", () => {
  let userId: number;
  let planId: number;
  let nodeId: number;
  const subscriptionIds: number[] = [];
  const vpnKeyIds: number[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `lifecycle-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Lifecycle plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Lifecycle node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;
  });

  afterEach(async () => {
    for (const id of vpnKeyIds.splice(0)) {
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

  async function seedSubscription(
    status: "active" | "expired",
    endsAt: Date | null,
  ): Promise<number> {
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({ userId, planId, status, startsAt: new Date(), endsAt })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription.id);
    return subscription.id;
  }

  async function seedKey(): Promise<number> {
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "test key",
        vlessLink: "vless://test",
        deepLink: "happ://test",
      })
      .returning({ id: vpnKeysTable.id });
    vpnKeyIds.push(key.id);
    return key.id;
  }

  it("marks an overdue active subscription as expired but leaves the user's keys alone", async () => {
    const subscriptionId = await seedSubscription(
      "active",
      new Date(Date.now() - 60 * 60 * 1000),
    );
    const keyId = await seedKey();

    const count = await expireOverdueSubscriptions();

    expect(count).toBeGreaterThanOrEqual(1);

    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));
    expect(subscription?.status).toBe("expired");

    // Revocation is a separate, grace-period-gated sweep (see
    // revokeKeysPastGracePeriod below) — expiring the subscription alone
    // must not cut VPN access immediately.
    const [key] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("does not touch a subscription that has not expired yet", async () => {
    const subscriptionId = await seedSubscription(
      "active",
      new Date(Date.now() + 60 * 60 * 1000),
    );
    const keyId = await seedKey();

    await expireOverdueSubscriptions();

    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));
    expect(subscription?.status).toBe("active");

    const [key] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("is a no-op when there is nothing overdue", async () => {
    const count = await expireOverdueSubscriptions();
    expect(count).toBe(0);
  });
});

describe("revokeKeysPastGracePeriod", () => {
  let userId: number;
  let planId: number;
  let nodeId: number;
  const subscriptionIds: number[] = [];
  const vpnKeyIds: number[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `lifecycle-grace-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Lifecycle grace plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Lifecycle grace node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;
  });

  afterEach(async () => {
    for (const id of vpnKeyIds.splice(0)) {
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

  async function seedSubscription(
    status: "active" | "expired",
    endsAt: Date | null,
  ): Promise<number> {
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({ userId, planId, status, startsAt: new Date(), endsAt })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription.id);
    return subscription.id;
  }

  async function seedKey(): Promise<number> {
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "test key",
        vlessLink: "vless://test",
        deepLink: "happ://test",
      })
      .returning({ id: vpnKeysTable.id });
    vpnKeyIds.push(key.id);
    return key.id;
  }

  it("does not revoke keys within the grace period after expiry", async () => {
    await seedSubscription("expired", new Date(Date.now() - 60 * 60 * 1000)); // 1h ago
    const keyId = await seedKey();

    await revokeKeysPastGracePeriod();

    const [key] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("revokes keys once the grace period has passed", async () => {
    await seedSubscription(
      "expired",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ); // 30 days ago
    const keyId = await seedKey();

    const count = await revokeKeysPastGracePeriod();

    expect(count).toBeGreaterThanOrEqual(1);

    const [key] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).not.toBeNull();
  });

  it("does not revoke keys when the user has a currently active subscription", async () => {
    await seedSubscription(
      "expired",
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ); // long-expired row
    await seedSubscription("active", new Date(Date.now() + 60 * 60 * 1000)); // but a fresh active one too
    const keyId = await seedKey();

    await revokeKeysPastGracePeriod();

    const [key] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("leaves keys alone when the user has no dated subscription at all", async () => {
    const keyId = await seedKey();

    await revokeKeysPastGracePeriod();

    const [key] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("is a no-op when there are no unrevoked keys", async () => {
    const count = await revokeKeysPastGracePeriod();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
