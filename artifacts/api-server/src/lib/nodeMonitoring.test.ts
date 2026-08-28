import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { reconcilePendingKeyReplacements } from "./nodeMonitoring";

describe("pending VPN key replacement reconciliation", () => {
  let userId: number;
  let oldNodeId: number;
  let newNodeId: number;
  let oldKeyId: number;
  let newKeyId: number;
  let planId: number;
  let subscriptionId: number;

  beforeAll(async () => {
    const suffix = randomBytes(8).toString("hex");
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `node-monitoring-reconcile-${suffix}@example.com`,
        passwordHash: "test-only",
        role: "user",
        referralCode: `reconcile-${suffix}`,
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Reconcile plan ${suffix}`,
        priceRub: 100,
        durationDays: 30,
        trafficLimitGb: 10,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId,
        status: "active",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionId = subscription.id;

    const [oldNode] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Reconcile old node ${suffix}`,
        region: "test",
        host: "reconcile-old.example.com",
        sni: "reconcile-old.example.com",
      })
      .returning({ id: vpnNodesTable.id });
    oldNodeId = oldNode.id;

    const [newNode] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Reconcile new node ${suffix}`,
        region: "test",
        host: "reconcile-new.example.com",
        sni: "reconcile-new.example.com",
      })
      .returning({ id: vpnNodesTable.id });
    newNodeId = newNode.id;

    const [oldKey] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId: oldNodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "Old replacement source",
        vlessLink: "vless://old",
        deepLink: "old://key",
        provisionedAt: new Date(),
        periodUpBytes: 1_200,
        periodDownBytes: 2_300,
      })
      .returning({ id: vpnKeysTable.id });
    oldKeyId = oldKey.id;

    const [newKey] = await db
      .insert(vpnKeysTable)
      .values({
        userId,
        nodeId: newNodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "Replacement key",
        vlessLink: "vless://new",
        deepLink: "new://key",
        replacesKeyId: oldKeyId,
        provisionedAt: new Date(),
      })
      .returning({ id: vpnKeysTable.id });
    newKeyId = newKey.id;
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, newKeyId));
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, oldKeyId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, subscriptionId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, oldNodeId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, newNodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("revokes the old source and keeps the provisioned replacement active", async () => {
    await reconcilePendingKeyReplacements();

    const rows = await db
      .select({
        id: vpnKeysTable.id,
        revokedAt: vpnKeysTable.revokedAt,
        replacesKeyId: vpnKeysTable.replacesKeyId,
      })
      .from(vpnKeysTable)
      .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)));

    expect(rows).toEqual([
      expect.objectContaining({ id: newKeyId, replacesKeyId: oldKeyId }),
    ]);

    const [oldKey] = await db
      .select({ revokedAt: vpnKeysTable.revokedAt })
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.id, oldKeyId));
    expect(oldKey.revokedAt).not.toBeNull();

    const [subscription] = await db
      .select({ carried: subscriptionsTable.carriedOverPeriodBytes })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));
    expect(subscription.carried).toBe(3_500);
  });
});