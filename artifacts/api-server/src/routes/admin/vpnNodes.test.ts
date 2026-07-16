import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { db, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
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
    .values({ email, passwordHash, role })
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
});
