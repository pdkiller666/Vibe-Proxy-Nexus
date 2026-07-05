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
import { expireOverdueSubscriptions } from "./subscriptionLifecycle";

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

  async function seedSubscription(status: "active" | "expired", endsAt: Date | null): Promise<number> {
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

  it("marks an overdue active subscription as expired and revokes the user's keys", async () => {
    const subscriptionId = await seedSubscription("active", new Date(Date.now() - 60 * 60 * 1000));
    const keyId = await seedKey();

    const count = await expireOverdueSubscriptions();

    expect(count).toBeGreaterThanOrEqual(1);

    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));
    expect(subscription?.status).toBe("expired");

    const [key] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).not.toBeNull();
  });

  it("does not touch a subscription that has not expired yet", async () => {
    const subscriptionId = await seedSubscription("active", new Date(Date.now() + 60 * 60 * 1000));
    const keyId = await seedKey();

    await expireOverdueSubscriptions();

    const [subscription] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));
    expect(subscription?.status).toBe("active");

    const [key] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("does not revoke keys when the user has another still-active subscription", async () => {
    const overdueId = await seedSubscription("active", new Date(Date.now() - 60 * 60 * 1000));
    await seedSubscription("active", new Date(Date.now() + 60 * 60 * 1000));
    const keyId = await seedKey();

    await expireOverdueSubscriptions();

    const [overdue] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, overdueId));
    expect(overdue?.status).toBe("expired");

    const [key] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("is a no-op when there is nothing overdue", async () => {
    const count = await expireOverdueSubscriptions();
    expect(count).toBe(0);
  });
});
