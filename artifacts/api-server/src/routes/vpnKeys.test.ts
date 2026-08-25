import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
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
        // Allow enough device slots so the sequential test cases can each issue
        // a key without hitting the 1-device default limit. Some keys aren't
        // revoked between tests (e.g. the "wrong owner" test leaves a key active).
        devicesIncluded: 5,
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
    // Explicitly specify nodeId so auto-selection never picks up a remote node
    // from a parallel test suite (vpnNodeDelete creates active remote nodes that
    // resolve to fake-mgmt.example.com — causing ENOTFOUND 502 in this worker).
    const res = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({ nodeId });

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
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
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
        // Give the owner enough device slots so per-user limits never interfere
        // with the node-capacity checks these tests are designed to exercise.
        devicesIncluded: 5,
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

/**
 * Regression tests for the global slot-limit bug:
 *   Amvera can retry a slow POST /vpn-keys and the retry may land on a
 *   different node. Before the fix, the per-node slot check inside the
 *   FOR UPDATE tx counted only keys on the *selected* node, so the retry
 *   on node B succeeded even though the first request already committed a
 *   key on node A — leaving the user with two keys on a 1-device plan.
 *
 *   The fix counts ALL active keys for the user across all nodes inside the
 *   locked transaction. These tests catch any regression back to per-node counting.
 */
describe("Global slot limit enforced across different nodes", () => {
  let userId: number;
  let userCookie: string;
  let planId: number;
  let nodeAId: number;
  let nodeBId: number;
  const createdKeyIds: number[] = [];

  async function createLoggedInUser(): Promise<{ id: number; cookie: string }> {
    const email = `vpnkeys-global-${randomBytes(6).toString("hex")}@example.com`;
    const password = "correct-horse-battery-staple";
    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
      .returning({ id: usersTable.id });
    const res = await request.post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
    if (!sessionCookie) throw new Error("Login did not set session cookie");
    return { id: user.id, cookie: sessionCookie.split(";")[0] };
  }

  beforeAll(async () => {
    const owner = await createLoggedInUser();
    userId = owner.id;
    userCookie = owner.cookie;

    // Plan with exactly 1 device slot (the default) so any second key is over-limit.
    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Global slot test plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 1,
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

    // Two distinct nodes, both with unlimited capacity so node-level cap is never
    // the reason for rejection — only the per-user global slot count matters.
    const [nodeA] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Global-test node A ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "global-a.example.com",
        sni: "global-a.example.com",
        isActive: true,
        maxUsers: null,
      })
      .returning({ id: vpnNodesTable.id });
    nodeAId = nodeA.id;

    const [nodeB] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Global-test node B ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "global-b.example.com",
        sni: "global-b.example.com",
        isActive: true,
        maxUsers: null,
      })
      .returning({ id: vpnNodesTable.id });
    nodeBId = nodeB.id;
  });

  afterAll(async () => {
    for (const id of createdKeyIds) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    }
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeAId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeBId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("blocks issuing a second key on node B when a key already exists on node A (sequential retry simulation)", async () => {
    // First request lands on node A — should succeed.
    const firstRes = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({ nodeId: nodeAId });
    expect(firstRes.status).toBe(201);
    createdKeyIds.push(firstRes.body.id);

    // Simulated Amvera retry: same user, different node — must be rejected.
    const retryRes = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({ nodeId: nodeBId });
    expect(retryRes.status).toBe(409);

    // Revoking the first key must release the same slot, so a subsequent
    // request can issue a replacement on another node.
    const revokeRes = await request
      .delete(`/api/vpn-keys/${firstRes.body.id}`)
      .set("Cookie", userCookie);
    expect(revokeRes.status).toBe(204);

    const replacementRes = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({ nodeId: nodeBId });
    expect(replacementRes.status).toBe(201);
    expect(replacementRes.body.id).not.toBe(firstRes.body.id);
    createdKeyIds.push(replacementRes.body.id);
  });

  it("allows at most one key when two concurrent requests race for the same slot", async () => {
    // Revoke the key created in the previous test so this user starts fresh.
    for (const id of createdKeyIds) {
      await db
        .update(vpnKeysTable)
        .set({ revokedAt: new Date() })
        .where(eq(vpnKeysTable.id, id));
    }

    // Fire both requests simultaneously — the FOR UPDATE tx serializes them and
    // only one should commit a new key row.
    const [resA, resB] = await Promise.all([
      request.post("/api/vpn-keys").set("Cookie", userCookie).send({ nodeId: nodeAId }),
      request.post("/api/vpn-keys").set("Cookie", userCookie).send({ nodeId: nodeBId }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Track the winning key for cleanup.
    const winner = resA.status === 201 ? resA : resB;
    createdKeyIds.push(winner.body.id);
  });
});

describe("Idempotent key issuance (Amvera proxy retry)", () => {
  let userId: number;
  let userCookie: string;
  let planId: number;
  let nodeId: number;
  const createdKeyIds: number[] = [];

  async function createLoggedInUser(): Promise<{ id: number; cookie: string }> {
    const email = `vpnkeys-idem-${randomBytes(6).toString("hex")}@example.com`;
    const password = "correct-horse-battery-staple";
    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
      .returning({ id: usersTable.id });
    const res = await request.post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
    if (!sessionCookie) throw new Error("Login did not set session cookie");
    return { id: user.id, cookie: sessionCookie.split(";")[0] };
  }

  beforeAll(async () => {
    const owner = await createLoggedInUser();
    userId = owner.id;
    userCookie = owner.cookie;

    // 3 device slots — the exact production scenario: a user with free slots
    // whose retried request would previously pass the slot check twice.
    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Idem test plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 3,
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

    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Idem-test node ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "idem.example.com",
        sni: "idem.example.com",
        isActive: true,
        maxUsers: null,
      })
      .returning({ id: vpnNodesTable.id });
    nodeId = node.id;
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  it("returns the same key for a sequential retry with the same idempotencyKey", async () => {
    const idempotencyKey = randomBytes(16).toString("hex");

    const first = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({ nodeId, idempotencyKey });
    expect(first.status).toBe(201);
    createdKeyIds.push(first.body.id);

    // Simulated Amvera proxy retry of the same click.
    const retry = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({ nodeId, idempotencyKey });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.uuid).toBe(first.body.uuid);

    // Exactly one active key exists despite two successful responses.
    const rows = await db
      .select({ id: vpnKeysTable.id })
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, userId));
    expect(rows.length).toBe(1);
  });

  it("creates exactly one key when the retry races the original concurrently", async () => {
    const idempotencyKey = randomBytes(16).toString("hex");

    const [resA, resB] = await Promise.all([
      request.post("/api/vpn-keys").set("Cookie", userCookie).send({ nodeId, idempotencyKey }),
      request.post("/api/vpn-keys").set("Cookie", userCookie).send({ nodeId, idempotencyKey }),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.id).toBe(resB.body.id);
  });

  it("still issues distinct keys for distinct idempotencyKeys (separate clicks)", async () => {
    // The user has 3 slots and 2 keys so far (from the tests above) — a real
    // second click with a new UUID must produce a new key, not a replay.
    const res = await request
      .post("/api/vpn-keys")
      .set("Cookie", userCookie)
      .send({ nodeId, idempotencyKey: randomBytes(16).toString("hex") });
    expect(res.status).toBe(201);
    expect(createdKeyIds).not.toContain(res.body.id);
  });
});

describe("VPN key relocation", () => {
  const userIds: number[] = [];
  const subscriptionIds: number[] = [];
  const keyIds: number[] = [];
  const nodeIds: number[] = [];
  let planId: number;
  let sourceNodeId: number;
  let targetNodeId: number;

  async function createLoggedInUser(): Promise<{ id: number; cookie: string }> {
    const email = `vpnkeys-relocate-${randomBytes(6).toString("hex")}@example.com`;
    const password = "correct-horse-battery-staple";
    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
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

  beforeAll(async () => {
    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Relocation one-slot plan ${randomBytes(4).toString("hex")}`,
        priceRub: 1000,
        durationDays: 30,
        devicesIncluded: 1,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [source] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Relocation source ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "relocation-source.example.com",
        sni: "relocation-source.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    sourceNodeId = source.id;
    nodeIds.push(sourceNodeId);

    const [target] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Relocation target ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "relocation-target.example.com",
        sni: "relocation-target.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    targetNodeId = target.id;
    nodeIds.push(targetNodeId);
  });

  afterAll(async () => {
    for (const id of keyIds) {
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

  it.each([
    { label: "trial", isTrial: true },
    { label: "monthly", isTrial: false },
  ])("relocates a one-slot $label subscription and replays the completed request", async ({ isTrial }) => {
    const owner = await createLoggedInUser();
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: owner.id,
        planId,
        status: "active",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        isTrial,
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription.id);

    const first = await request
      .post("/api/vpn-keys")
      .set("Cookie", owner.cookie)
      .send({ nodeId: sourceNodeId });
    expect(first.status).toBe(201);
    const oldKeyId = first.body.id as number;
    keyIds.push(oldKeyId);

    const idempotencyKey = randomBytes(16).toString("hex");
    const relocationPath = `/api/vpn-keys/${oldKeyId}/relocate`;
    const relocationBody = { nodeId: targetNodeId, idempotencyKey };
    const relocated = await request
      .post(relocationPath)
      .set("Cookie", owner.cookie)
      .send(relocationBody);
    expect(relocated.status).toBe(200);
    expect(relocated.body.nodeId).toBe(targetNodeId);
    const newKeyId = relocated.body.id as number;
    keyIds.push(newKeyId);

    const replay = await request
      .post(relocationPath)
      .set("Cookie", owner.cookie)
      .send(relocationBody);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(newKeyId);
    expect(replay.body.uuid).toBe(relocated.body.uuid);

    const rows = await db
      .select({ id: vpnKeysTable.id, revokedAt: vpnKeysTable.revokedAt, nodeId: vpnKeysTable.nodeId })
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, owner.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt === null)).toEqual([
      expect.objectContaining({ id: newKeyId, nodeId: targetNodeId }),
    ]);
    expect(rows.find((row) => row.id === oldKeyId)?.revokedAt).not.toBeNull();
  });

  it("deduplicates concurrent relocation requests for a one-slot subscription", async () => {
    const owner = await createLoggedInUser();
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: owner.id,
        planId,
        status: "active",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription.id);

    const first = await request
      .post("/api/vpn-keys")
      .set("Cookie", owner.cookie)
      .send({ nodeId: sourceNodeId });
    expect(first.status).toBe(201);
    const oldKeyId = first.body.id as number;
    keyIds.push(oldKeyId);

    const relocationPath = `/api/vpn-keys/${oldKeyId}/relocate`;
    const relocationBody = {
      nodeId: targetNodeId,
      idempotencyKey: randomBytes(16).toString("hex"),
    };
    const [responseA, responseB] = await Promise.all([
      request.post(relocationPath).set("Cookie", owner.cookie).send(relocationBody),
      request.post(relocationPath).set("Cookie", owner.cookie).send(relocationBody),
    ]);

    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(responseA.body.id).toBe(responseB.body.id);

    const activeKeys = await db
      .select({ id: vpnKeysTable.id })
      .from(vpnKeysTable)
      .where(
        and(
          eq(vpnKeysTable.userId, owner.id),
          isNull(vpnKeysTable.revokedAt),
        ),
      );
    expect(activeKeys).toEqual([{ id: responseA.body.id }]);
    keyIds.push(responseA.body.id);
  });
});
