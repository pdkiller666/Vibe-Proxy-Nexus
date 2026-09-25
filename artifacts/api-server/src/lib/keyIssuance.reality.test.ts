import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const remoteMocks = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("./remoteNode", () => ({ addRemoteXrayClient: remoteMocks.add }));
vi.mock("./xray", () => ({
  addXrayClient: vi.fn(),
  isLocalXrayEnabled: () => false,
}));

import { eq } from "drizzle-orm";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { issueKeyForUserUnlockedForTests } from "./keyIssuance";

describe("key issuance transport selection", () => {
  const suffix = randomBytes(6).toString("hex");
  let userId: number;
  let planId: number;
  let wsNodeId: number;
  let realityNodeId: number;

  beforeAll(async () => {
    remoteMocks.add.mockResolvedValue(undefined);
    const [user] = await db.insert(usersTable).values({
      email: `reality-selection-${suffix}@example.com`,
      passwordHash: "test",
      referralCode: `reality-${suffix}`,
    }).returning({ id: usersTable.id });
    userId = user.id;
    const [plan] = await db.insert(plansTable).values({
      name: `Reality selection ${suffix}`,
      priceRub: 100,
      durationDays: 30,
      devicesIncluded: 3,
    }).returning({ id: plansTable.id });
    planId = plan.id;
    await db.insert(subscriptionsTable).values({
      userId,
      planId,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const [ws] = await db.insert(vpnNodesTable).values({
      name: `WS selection ${suffix}`,
      region: "test",
      host: "ws.example.test",
      sni: "ws.example.test",
      transport: "ws",
      managementApiUrl: "https://ws-mgmt.example.test",
      isActive: true,
      maxUsers: 0,
    }).returning({ id: vpnNodesTable.id });
    wsNodeId = ws.id;
    const [reality] = await db.insert(vpnNodesTable).values({
      name: `Reality selection ${suffix}`,
      region: "test",
      host: "203.0.113.10",
      port: 8443,
      sni: "example.com",
      transport: "reality",
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      shortId: "a1b2c3d4",
      managementApiUrl: "https://reality-mgmt.example.test",
      isActive: true,
    }).returning({ id: vpnNodesTable.id });
    realityNodeId = reality.id;
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, wsNodeId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, realityNodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("auto-selects an active Reality node alongside WS by load", async () => {
    const result = await issueKeyForUserUnlockedForTests(userId, 3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nodeName).toBe(`Reality selection ${suffix}`);
  });

  it("allows a regular user to explicitly select a Reality node", async () => {
    const result = await issueKeyForUserUnlockedForTests(
      userId,
      3,
      realityNodeId,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nodeName).toBe(`Reality selection ${suffix}`);
  });
});