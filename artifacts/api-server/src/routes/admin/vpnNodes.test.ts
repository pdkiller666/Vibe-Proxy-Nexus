import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";

const request = supertest(app);

async function createUser(role: "user" | "admin"): Promise<{
  id: number;
  email: string;
  password: string;
}> {
  const email = `vpnnodes-test-${role}-${randomBytes(6).toString("hex")}@example.com`;
  const password = "correct-horse-battery-staple";
  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash, role, referralCode: randomBytes(8).toString("hex") })
    .returning({ id: usersTable.id });

  return { id: user.id, email, password };
}

async function loginAndGetCookie(email: string, password: string): Promise<string> {
  const res = await request.post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);

  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  return sessionCookie.split(";")[0];
}

describe("admin vpn node capacity fields", () => {
  let adminId: number;
  let adminCookie: string;
  const nodeIds: number[] = [];
  const vpnKeyIds: number[] = [];

  beforeAll(async () => {
    const admin = await createUser("admin");
    adminId = admin.id;
    adminCookie = await loginAndGetCookie(admin.email, admin.password);
  });

  afterAll(async () => {
    for (const id of vpnKeyIds) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    }
    for (const id of nodeIds) {
      await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, id));
    }
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  it("creates a node with maxUsers and returns activeUserCount 0", async () => {
    const res = await request
      .post("/api/admin/vpn-nodes")
      .set("Cookie", adminCookie)
      .send({
        name: `Node ${randomBytes(4).toString("hex")}`,
        region: "test",
        sni: "test.example.com",
        maxUsers: 5,
      });

    expect(res.status).toBe(201);
    expect(res.body.maxUsers).toBe(5);
    expect(res.body.activeUserCount).toBe(0);
    nodeIds.push(res.body.id);
  });

  it("creates a node without maxUsers (unlimited)", async () => {
    const res = await request
      .post("/api/admin/vpn-nodes")
      .set("Cookie", adminCookie)
      .send({
        name: `Node ${randomBytes(4).toString("hex")}`,
        region: "test",
        sni: "test.example.com",
      });

    expect(res.status).toBe(201);
    expect(res.body.maxUsers).toBeNull();
    nodeIds.push(res.body.id);
  });

  it("lists inactive nodes so admins can reactivate them", async () => {
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Inactive ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "inactive.example.com",
        sni: "inactive.example.com",
        isActive: false,
      })
      .returning();
    nodeIds.push(node.id);

    const res = await request
      .get("/api/admin/vpn-nodes")
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: node.id,
          isActive: false,
          activeUserCount: 0,
        }),
      ]),
    );
  });

  it("returns an empty migration summary for a node without active keys", async () => {
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Migration source ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "migration.example.com",
        sni: "migration.example.com",
        isActive: false,
      })
      .returning({ id: vpnNodesTable.id });
    nodeIds.push(node.id);

    const res = await request
      .post(`/api/admin/vpn-nodes/${node.id}/migrate-keys`)
      .set("Cookie", adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalKeys: 0,
      migratedKeys: 0,
      failedMigrations: 0,
    });
  });

  it("reflects active (non-revoked) key count on update", async () => {
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
        maxUsers: 3,
      })
      .returning({ id: vpnNodesTable.id });
    nodeIds.push(node.id);

    const [activeKey] = await db
      .insert(vpnKeysTable)
      .values({
        userId: adminId,
        nodeId: node.id,
        uuid: randomBytes(16).toString("hex"),
        label: "test",
        vlessLink: "vless://test",
        deepLink: "v2raytun://test",
      })
      .returning({ id: vpnKeysTable.id });
    vpnKeyIds.push(activeKey.id);

    const [revokedKey] = await db
      .insert(vpnKeysTable)
      .values({
        userId: adminId,
        nodeId: node.id,
        uuid: randomBytes(16).toString("hex"),
        label: "test",
        vlessLink: "vless://test",
        deepLink: "v2raytun://test",
        revokedAt: new Date(),
      })
      .returning({ id: vpnKeysTable.id });
    vpnKeyIds.push(revokedKey.id);

    const res = await request
      .patch(`/api/admin/vpn-nodes/${node.id}`)
      .set("Cookie", adminCookie)
      .send({ region: "test-updated" });

    expect(res.status).toBe(200);
    expect(res.body.activeUserCount).toBe(1);
    expect(res.body.maxUsers).toBe(3);
  });

  it("allows clearing maxUsers back to unlimited via update", async () => {
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
        maxUsers: 2,
      })
      .returning({ id: vpnNodesTable.id });
    nodeIds.push(node.id);

    const res = await request
      .patch(`/api/admin/vpn-nodes/${node.id}`)
      .set("Cookie", adminCookie)
      .send({ maxUsers: null });

    expect(res.status).toBe(200);
    expect(res.body.maxUsers).toBeNull();
  });

  it("clears the auto-recovery marker when an admin explicitly disables a node", async () => {
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
        consecutiveFailures: 2,
      })
      .returning({ id: vpnNodesTable.id });
    nodeIds.push(node.id);

    const res = await request
      .patch(`/api/admin/vpn-nodes/${node.id}`)
      .set("Cookie", adminCookie)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    const [updated] = await db
      .select({ consecutiveFailures: vpnNodesTable.consecutiveFailures })
      .from(vpnNodesTable)
      .where(eq(vpnNodesTable.id, node.id));
    expect(updated?.consecutiveFailures).toBe(0);
  });
});

describe("manual VPN key migration", () => {
  let adminId: number;
  let adminCookie: string;
  let testUserId: number;
  let planId: number;
  const nodeIds: number[] = [];

  beforeAll(async () => {
    const admin = await createUser("admin");
    adminId = admin.id;
    adminCookie = await loginAndGetCookie(admin.email, admin.password);

    const user = await createUser("user");
    testUserId = user.id;
  });

  afterAll(async () => {
    if (nodeIds.length > 0) {
      await db.delete(vpnKeysTable).where(inArray(vpnKeysTable.nodeId, nodeIds));
      await db.delete(vpnNodesTable).where(inArray(vpnNodesTable.id, nodeIds));
    }
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, testUserId));
    if (planId) {
      await db.delete(plansTable).where(eq(plansTable.id, planId));
    }
    await db.delete(usersTable).where(inArray(usersTable.id, [adminId, testUserId]));
  });

  it("moves an active key with traffic and does not duplicate it on a repeated request", async () => {
    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Manual migration test plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 2,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    await db.insert(subscriptionsTable).values({
      userId: testUserId,
      planId: plan.id,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const region = `manual-migration-${randomBytes(4).toString("hex")}`;
    const [sourceNode, targetNode] = await db
      .insert(vpnNodesTable)
      .values([
        {
          name: `Manual migration source ${randomBytes(4).toString("hex")}`,
          region,
          host: "source.test.example.com",
          sni: "source.test.example.com",
          isActive: true,
        },
        {
          name: `Manual migration target ${randomBytes(4).toString("hex")}`,
          region,
          host: "target.test.example.com",
          sni: "target.test.example.com",
          isActive: true,
        },
      ])
      .returning({ id: vpnNodesTable.id });
    nodeIds.push(sourceNode.id, targetNode.id);

    const PERIOD_UP = 3 * 1024 * 1024 * 1024;
    const PERIOD_DOWN = 2 * 1024 * 1024 * 1024;
    const LIFETIME_UP = 50 * 1024 * 1024 * 1024;
    const LIFETIME_DOWN = 40 * 1024 * 1024 * 1024;
    const periodStartedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const [sourceKey] = await db
      .insert(vpnKeysTable)
      .values({
        userId: testUserId,
        nodeId: sourceNode.id,
        uuid: randomBytes(16).toString("hex"),
        label: "migration-test-key",
        vlessLink: "vless://migration-test",
        deepLink: "v2raytun://migration-test",
        periodUpBytes: PERIOD_UP,
        periodDownBytes: PERIOD_DOWN,
        trafficUpBytes: LIFETIME_UP,
        trafficDownBytes: LIFETIME_DOWN,
        periodStartedAt,
      })
      .returning({ id: vpnKeysTable.id });

    const first = await request
      .post(`/api/admin/vpn-nodes/${sourceNode.id}/migrate-keys`)
      .set("Cookie", adminCookie);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      totalKeys: 1,
      migratedKeys: 1,
      failedMigrations: 0,
    });

    const afterFirst = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, testUserId));
    expect(afterFirst).toHaveLength(2);

    const replacement = afterFirst.find((key) => key.replacesKeyId === sourceKey.id);
    expect(replacement).toBeDefined();
    expect(replacement!.nodeId).toBe(targetNode.id);
    expect(replacement!.revokedAt).toBeNull();
    expect(replacement!.periodUpBytes).toBe(PERIOD_UP);
    expect(replacement!.periodDownBytes).toBe(PERIOD_DOWN);
    expect(replacement!.trafficUpBytes).toBe(LIFETIME_UP);
    expect(replacement!.trafficDownBytes).toBe(LIFETIME_DOWN);
    expect(replacement!.periodStartedAt.getTime()).toBe(periodStartedAt.getTime());

    const original = afterFirst.find((key) => key.id === sourceKey.id);
    expect(original!.revokedAt).not.toBeNull();
    expect(original!.revokedReason).toBe("admin");

    const second = await request
      .post(`/api/admin/vpn-nodes/${sourceNode.id}/migrate-keys`)
      .set("Cookie", adminCookie);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      totalKeys: 0,
      migratedKeys: 0,
      failedMigrations: 0,
    });

    const afterSecond = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, testUserId));
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond.filter((key) => key.revokedAt === null)).toHaveLength(1);
    expect(afterSecond.filter((key) => key.nodeId === targetNode.id && key.revokedAt === null)).toHaveLength(1);
  });
});
