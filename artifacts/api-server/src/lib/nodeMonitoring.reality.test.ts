import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const remoteMocks = vi.hoisted(() => ({
  add: vi.fn(),
  list: vi.fn(),
  poll: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("./remoteNode", () => ({
  addRemoteXrayClient: remoteMocks.add,
  listRemoteXrayClients: remoteMocks.list,
  pollRemoteNodeStats: remoteMocks.poll,
  removeRemoteXrayClient: remoteMocks.remove,
}));
vi.mock("./xray", () => ({
  isLocalXrayEnabled: () => false,
  reconcileLocalXrayClients: vi.fn(),
  removeXrayClient: vi.fn(),
}));

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { runNodeMonitoringCycleForTests } from "./nodeMonitoring";

describe("Reality node monitoring migration", () => {
  const suffix = randomBytes(6).toString("hex");
  let userId: number;
  let planId: number;
  const nodeIds: number[] = [];

  beforeAll(async () => {
    remoteMocks.add.mockResolvedValue(undefined);
    remoteMocks.list.mockResolvedValue([]);
    remoteMocks.poll.mockResolvedValue(new Map());
    remoteMocks.remove.mockResolvedValue(undefined);

    const [user] = await db.insert(usersTable).values({
      email: `monitor-reality-${suffix}@example.com`,
      passwordHash: "test",
      referralCode: `monitor-reality-${suffix}`,
    }).returning({ id: usersTable.id });
    userId = user.id;

    const [plan] = await db.insert(plansTable).values({
      name: `Monitor Reality ${suffix}`,
      priceRub: 100,
      durationDays: 30,
      devicesIncluded: 2,
    }).returning({ id: plansTable.id });
    planId = plan.id;
    await db.insert(subscriptionsTable).values({
      userId,
      planId,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const nodes = await db.insert(vpnNodesTable).values([
      {
        name: `Failed Reality ${suffix}`,
        region: `monitor-reality-${suffix}`,
        host: "203.0.113.50",
        port: 443,
        sni: "example.com",
        transport: "reality",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        shortId: "a1b2c3d4",
        managementApiUrl: "http://failed-reality.test",
        managementApiSecret: "failed-secret",
        isActive: true,
        consecutiveFailures: 2,
      },
      {
        name: `Healthy Reality ${suffix}`,
        region: `monitor-reality-${suffix}`,
        host: "203.0.113.51",
        port: 443,
        sni: "example.com",
        transport: "reality",
        publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        shortId: "b1b2c3d4",
        managementApiUrl: "http://healthy-reality.test",
        managementApiSecret: "healthy-secret",
        isActive: true,
      },
    ]).returning({ id: vpnNodesTable.id });
    nodeIds.push(...nodes.map((node) => node.id));

    await db.insert(vpnKeysTable).values({
      userId,
      nodeId: nodeIds[0],
      uuid: randomBytes(16).toString("hex"),
      label: "Reality monitoring key",
      vlessLink: "vless://old-reality",
      deepLink: "reality://old",
      provisionedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await db.delete(vpnNodesTable).where(inArray(vpnNodesTable.id, nodeIds));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("migrates a failed Reality source to a healthy Reality target before revoking", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).startsWith("http://failed-reality.test")) {
        throw new Error("node unavailable");
      }
      return new Response(JSON.stringify({
        cpuPercent: 1,
        ramUsedBytes: 1,
        ramTotalBytes: 100,
        diskUsedBytes: 1,
        diskTotalBytes: 100,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      await runNodeMonitoringCycleForTests();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const keys = await db
      .select()
      .from(vpnKeysTable)
      .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.nodeId).toBe(nodeIds[1]);
    expect(keys[0]?.replacesKeyId).not.toBeNull();

    const [source] = await db
      .select({ isActive: vpnNodesTable.isActive })
      .from(vpnNodesTable)
      .where(eq(vpnNodesTable.id, nodeIds[0]));
    expect(source.isActive).toBe(false);
    expect(remoteMocks.add).toHaveBeenCalled();
  });
});