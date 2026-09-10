import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { db, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";

const request = supertest(app);
const password = "correct-horse-battery-staple";

type TestUser = { id: number; email: string };

async function createUser(role: "user" | "admin"): Promise<TestUser> {
  const email = `dashboard-${role}-${randomBytes(6).toString("hex")}@example.com`;
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: await hashPassword(password),
      role,
      referralCode: randomBytes(8).toString("hex"),
    })
    .returning({ id: usersTable.id, email: usersTable.email });
  return user!;
}

async function loginAsAdmin(admin: TestUser): Promise<string> {
  const response = await request.post("/api/auth/login").send({
    email: admin.email,
    password,
  });
  expect(response.status).toBe(200);

  const cookies = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"]
    : [response.headers["set-cookie"]];
  const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  return sessionCookie.split(";")[0]!;
}

async function createNode(name: string, isActive = true): Promise<number> {
  const [node] = await db
    .insert(vpnNodesTable)
    .values({
      name,
      region: "test",
      host: `${name.toLowerCase().replaceAll(" ", "-")}.example.com`,
      sni: "test.example.com",
      isActive,
    })
    .returning({ id: vpnNodesTable.id });
  return node!.id;
}

async function createKey(userId: number, nodeId: number, lastTrafficAt: Date, revokedAt?: Date) {
  const [key] = await db
    .insert(vpnKeysTable)
    .values({
      userId,
      nodeId,
      uuid: randomBytes(16).toString("hex"),
      label: "dashboard-test",
      vlessLink: "vless://dashboard-test",
      deepLink: "happ://dashboard-test",
      lastTrafficAt,
      revokedAt,
    })
    .returning({ id: vpnKeysTable.id });
  return key!.id;
}

describe("admin dashboard VPN activity by node", () => {
  let admin: TestUser;
  let adminCookie: string;
  const userIds: number[] = [];
  const nodeIds: number[] = [];
  const keyIds: number[] = [];

  beforeAll(async () => {
    admin = await createUser("admin");
    adminCookie = await loginAsAdmin(admin);

    const [alice, bob] = await Promise.all([createUser("user"), createUser("user")]);
    userIds.push(alice.id, bob.id);

    const [polandNode, germanyNode, emptyNode, inactiveNode] = await Promise.all([
      createNode(`Dashboard Poland ${randomBytes(3).toString("hex")}`),
      createNode(`Dashboard Germany ${randomBytes(3).toString("hex")}`),
      createNode(`Dashboard Empty ${randomBytes(3).toString("hex")}`),
      createNode(`Dashboard Inactive ${randomBytes(3).toString("hex")}`, false),
    ]);
    nodeIds.push(polandNode, germanyNode, emptyNode, inactiveNode);

    const recent = new Date(Date.now() - 2 * 60 * 1000);
    const stale = new Date(Date.now() - 20 * 60 * 1000);
    keyIds.push(
      await createKey(alice.id, polandNode, recent),
      await createKey(alice.id, polandNode, recent),
      await createKey(alice.id, germanyNode, recent),
      await createKey(bob.id, germanyNode, recent),
      await createKey(bob.id, polandNode, stale),
      await createKey(bob.id, inactiveNode, recent),
    );
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(inArray(vpnKeysTable.id, keyIds));
    await db.delete(vpnNodesTable).where(inArray(vpnNodesTable.id, nodeIds));
    await db.delete(usersTable).where(inArray(usersTable.id, [...userIds, admin.id]));
  });

  it("counts distinct fresh VPN users per active node and keeps zero-load nodes", async () => {
    const response = await request
      .get("/api/admin/dashboard/summary")
      .set("Cookie", adminCookie);

    expect(response.status).toBe(200);

    const rows = response.body.activeVpnByNode as Array<{
      nodeId: number;
      activeUsers: number;
    }>;

    expect(rows.find((row) => row.nodeId === nodeIds[0])).toMatchObject({
      nodeId: nodeIds[0],
      activeUsers: 1,
    });
    expect(rows.find((row) => row.nodeId === nodeIds[1])).toMatchObject({
      nodeId: nodeIds[1],
      activeUsers: 2,
    });
    expect(rows.find((row) => row.nodeId === nodeIds[2])).toMatchObject({
      nodeId: nodeIds[2],
      activeUsers: 0,
    });
    expect(rows.some((row) => row.nodeId === nodeIds[3])).toBe(false);
  });
});
