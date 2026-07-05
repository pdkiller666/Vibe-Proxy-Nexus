import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
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
import app from "../app";
import { hashPassword } from "../lib/password";

const request = supertest(app);

describe("VPN key revoke flow", () => {
  let userId: number;
  let userCookie: string;
  let otherUserId: number;
  let otherUserCookie: string;
  let planId: number;
  let nodeId: number;
  const subscriptionIds: number[] = [];
  const vpnKeyIds: number[] = [];

  async function createLoggedInUser(): Promise<{ id: number; cookie: string }> {
    const email = `vpnkeys-test-${randomBytes(6).toString("hex")}@example.com`;
    const password = "correct-horse-battery-staple";
    const passwordHash = await hashPassword(password);

    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user" })
      .returning({ id: usersTable.id });

    const res = await request.post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
    if (!sessionCookie) throw new Error("Login did not set a session cookie");

    return { id: user.id, cookie: sessionCookie.split(";")[0] };
  }

  beforeAll(async () => {
    const owner = await createLoggedInUser();
    userId = owner.id;
    userCookie = owner.cookie;

    const other = await createLoggedInUser();
    otherUserId = other.id;
    otherUserCookie = other.cookie;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Test plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Test node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "test.example.com",
        sni: "test.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;

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
    subscriptionIds.push(subscription.id);
  });

  afterAll(async () => {
    for (const id of vpnKeyIds) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    }
    for (const id of subscriptionIds) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(usersTable).where(eq(usersTable.id, otherUserId));
  });

  async function issueKey(): Promise<number> {
    const res = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({});

    expect(res.status).toBe(201);
    vpnKeyIds.push(res.body.id);
    return res.body.id as number;
  }

  it("revokes an owned VPN key and stamps revokedAt", async () => {
    const keyId = await issueKey();

    const res = await request.delete(`/api/vpn-keys/${keyId}`).set("Cookie", userCookie);
    expect(res.status).toBe(204);

    const [key] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).not.toBeNull();
  });

  it("is idempotent — revoking an already-revoked key still succeeds", async () => {
    const keyId = await issueKey();

    const first = await request.delete(`/api/vpn-keys/${keyId}`).set("Cookie", userCookie);
    expect(first.status).toBe(204);

    const second = await request.delete(`/api/vpn-keys/${keyId}`).set("Cookie", userCookie);
    expect(second.status).toBe(204);
  });

  it("returns 404 when a user tries to revoke another user's key", async () => {
    const keyId = await issueKey();

    const res = await request.delete(`/api/vpn-keys/${keyId}`).set("Cookie", otherUserCookie);
    expect(res.status).toBe(404);

    const [key] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
    expect(key?.revokedAt).toBeNull();
  });

  it("returns 404 for a VPN key id that does not exist", async () => {
    const res = await request.delete("/api/vpn-keys/999999999").set("Cookie", userCookie);
    expect(res.status).toBe(404);
  });

  it("returns 401 when there is no session cookie", async () => {
    const keyId = await issueKey();

    const res = await request.delete(`/api/vpn-keys/${keyId}`);
    expect(res.status).toBe(401);
  });

  it("rejects issuing a key without an active subscription", async () => {
    const noSub = await createLoggedInUser();

    const res = await request.post("/api/vpn-keys").set("Cookie", noSub.cookie).send({});
    expect(res.status).toBe(403);

    await db.delete(usersTable).where(eq(usersTable.id, noSub.id));
  });
});

describe("VPN node capacity limit", () => {
  let ownerId: number;
  let ownerCookie: string;
  let planId: number;
  let fullNodeId: number;
  let openNodeId: number;
  const subscriptionIds: number[] = [];
  const vpnKeyIds: number[] = [];
  const nodeIds: number[] = [];
  const userIds: number[] = [];

  async function createLoggedInUser(): Promise<{ id: number; cookie: string }> {
    const email = `vpnkeys-cap-test-${randomBytes(6).toString("hex")}@example.com`;
    const password = "correct-horse-battery-staple";
    const passwordHash = await hashPassword(password);

    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user" })
      .returning({ id: usersTable.id });
    userIds.push(user.id);

    const res = await request.post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
    if (!sessionCookie) throw new Error("Login did not set a session cookie");

    return { id: user.id, cookie: sessionCookie.split(";")[0] };
  }

  async function giveActiveSubscription(uid: number): Promise<void> {
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: uid,
        planId,
        status: "active",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription.id);
  }

  beforeAll(async () => {
    const owner = await createLoggedInUser();
    ownerId = owner.id;
    ownerCookie = owner.cookie;

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Test plan cap ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    await giveActiveSubscription(ownerId);

    const [fullNode] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Full node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "full.example.com",
        sni: "full.example.com",
        isActive: true,
        maxUsers: 1,
      })
      .returning({ id: vpnNodesTable.id });
    fullNodeId = fullNode.id;
    nodeIds.push(fullNodeId);

    const [openNode] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Open node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "open.example.com",
        sni: "open.example.com",
        isActive: true,
        maxUsers: null,
      })
      .returning({ id: vpnNodesTable.id });
    openNodeId = openNode.id;
    nodeIds.push(openNodeId);

    // Fill fullNode to its cap of 1 with a key belonging to a throwaway user.
    const filler = await createLoggedInUser();
    await giveActiveSubscription(filler.id);
    const fillRes = await request
      .post("/api/vpn-keys")
      .set("Cookie", filler.cookie)
      .send({ nodeId: fullNodeId });
    expect(fillRes.status).toBe(201);
    vpnKeyIds.push(fillRes.body.id);
  });

  afterAll(async () => {
    for (const id of vpnKeyIds) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    }
    for (const id of subscriptionIds) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    for (const id of nodeIds) {
      await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, id));
    }
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    for (const id of userIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  it("rejects issuing a key on a node that has reached maxUsers", async () => {
    const res = await request
      .post("/api/vpn-keys")
      .set("Cookie", ownerCookie)
      .send({ nodeId: fullNodeId });

    expect(res.status).toBe(409);
  });

  it("still allows issuing a key on a node without a maxUsers cap", async () => {
    const res = await request
      .post("/api/vpn-keys")
      .set("Cookie", ownerCookie)
      .send({ nodeId: openNodeId });

    expect(res.status).toBe(201);
    vpnKeyIds.push(res.body.id);
  });

  it("auto-selection skips a full node and picks one with remaining capacity", async () => {
    const res = await request.post("/api/vpn-keys").set("Cookie", ownerCookie).send({});

    expect(res.status).toBe(201);
    expect(res.body.nodeId).not.toBe(fullNodeId);
    vpnKeyIds.push(res.body.id);
  });

  it("revoking a key on a full node frees up capacity for the next issuance", async () => {
    const revokeRes = await request
      .delete(`/api/vpn-keys/${vpnKeyIds[0]}`)
      .set("Cookie", ownerCookie);
    expect([204, 404]).toContain(revokeRes.status);

    const [fillerKey] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.nodeId, fullNodeId));
    if (fillerKey) {
      await db
        .update(vpnKeysTable)
        .set({ revokedAt: new Date() })
        .where(eq(vpnKeysTable.id, fillerKey.id));
    }

    const res = await request
      .post("/api/vpn-keys")
      .set("Cookie", ownerCookie)
      .send({ nodeId: fullNodeId });

    expect(res.status).toBe(201);
    vpnKeyIds.push(res.body.id);
  });
});
