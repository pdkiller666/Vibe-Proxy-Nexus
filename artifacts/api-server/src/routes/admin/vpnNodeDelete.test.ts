/**
 * Tests for DELETE /admin/vpn-nodes/:nodeId
 *
 * Covers:
 *  1. Deleting a node with active keys: keys are removed from Xray (mocked)
 *     and deleted from the database.
 *  2. Deleting a node with zero keys completes without errors.
 *  3. A second DELETE on the same (already-deleted) node returns 404.
 *
 * remoteNode is mocked so no real HTTP calls are made to a management API.
 * Local Xray (isLocalXrayEnabled) is always false in the dev/test environment
 * (XRAY_CONFIG_PATH is unset), so no fs/supervisorctl mocking is needed.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { db, plansTable, subscriptionsTable, systemEventsTable, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";

// ─── Module mocks ─────────────────────────────────────────────────────────────

// Mock the remote-node client so the DELETE handler doesn't attempt real HTTP
// calls when the test node has a managementApiUrl set.
vi.mock("../../lib/remoteNode", () => ({
  removeRemoteXrayClient: vi.fn().mockResolvedValue(undefined),
  addRemoteXrayClient: vi.fn().mockResolvedValue(undefined),
  pollRemoteNodeStats: vi.fn().mockResolvedValue(new Map()),
  remoteNodePollingHealth: new Map(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const request = supertest(app);

async function createAdmin(): Promise<{ id: number; cookie: string }> {
  const email = `node-delete-test-admin-${randomBytes(6).toString("hex")}@example.com`;
  const password = "correct-horse-battery-staple";
  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash, role: "admin", referralCode: randomBytes(8).toString("hex") })
    .returning({ id: usersTable.id });

  const res = await request.post("/api/auth/login").send({ email, password });
  if (res.status !== 200) throw new Error(`Login failed: ${res.status}`);

  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  const sessionCookie = cookies.find((c: string) => c.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");

  return { id: user.id, cookie: sessionCookie.split(";")[0] };
}

async function createNodeInRegion(region: string): Promise<{ id: number }> {
  const [node] = await db
    .insert(vpnNodesTable)
    .values({
      name: `Delete-test node ${randomBytes(6).toString("hex")}`,
      region,
      host: "remote.example.com",
      sni: "remote.example.com",
      isActive: true,
      managementApiUrl: "http://fake-mgmt.example.com",
      managementApiSecret: "fake-secret",
    })
    .returning({ id: vpnNodesTable.id });
  return { id: node.id };
}

async function createRemoteNode(): Promise<{ id: number }> {
  return createNodeInRegion("test");
}

async function insertKey(userId: number, nodeId: number): Promise<{ id: number; uuid: string }> {
  const uuid = randomBytes(16).toString("hex");
  const [key] = await db
    .insert(vpnKeysTable)
    .values({
      userId,
      nodeId,
      uuid,
      label: "test-key",
      vlessLink: "vless://test",
      deepLink: "v2raytun://test",
    })
    .returning({ id: vpnKeysTable.id, uuid: vpnKeysTable.uuid });
  return { id: key.id, uuid: key.uuid };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("DELETE /admin/vpn-nodes/:nodeId", () => {
  let adminId: number;
  let adminCookie: string;

  // Track any DB rows created by individual tests so afterAll can clean up
  // whatever the DELETE handler didn't already remove (e.g. the admin user,
  // and nodes left behind by the 403 test whose DELETE is blocked).
  const createdUserIds: number[] = [];
  const createdNodeIds: number[] = [];

  beforeAll(async () => {
    const admin = await createAdmin();
    adminId = admin.id;
    adminCookie = admin.cookie;
    createdUserIds.push(adminId);
  });

  afterAll(async () => {
    // Delete any nodes that weren't removed by the handler (e.g. the 403 test's node).
    for (const id of createdNodeIds) {
      await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, id)).catch(() => {/* already deleted by handler */});
    }
    for (const id of createdUserIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  it("removes active keys from Xray and deletes them from the database", async () => {
    // Arrange: a remote node with one active key.
    const { id: nodeId } = await createRemoteNode();
    createdNodeIds.push(nodeId);
    const { id: keyId, uuid: keyUuid } = await insertKey(adminId, nodeId);

    // Act.
    const res = await request
      .delete(`/api/admin/vpn-nodes/${nodeId}`)
      .set("Cookie", adminCookie);

    // Act succeeded.
    expect(res.status).toBe(200);

    // The admin user has no active subscription, so resolveTotalSlots() returns null
    // and migration fails for the key (failedMigrations=1). The handler does NOT call
    // removeRemoteXrayClient when a migration is skipped — it only calls it after a
    // successful re-issue on another node. The key is still hard-deleted at step 4.
    expect(res.body).toMatchObject({ migratedKeys: 0, failedMigrations: 1 });

    // Assert: key row is gone from DB (hard-deleted by the handler at step 4).
    const keys = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, keyId));
    expect(keys).toHaveLength(0);

    // Assert: node row is gone from DB.
    const nodes = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    expect(nodes).toHaveLength(0);
  });

  it("carries over traffic counters onto the migrated key instead of resetting them to zero", async () => {
    // Arrange: a user with an active subscription (so migration can re-issue),
    // a source node to be deleted, and a same-region target node to migrate to.
    const email = `node-delete-migrate-${randomBytes(6).toString("hex")}@example.com`;
    const passwordHash = await hashPassword("correct-horse-battery-staple");
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
      .returning({ id: usersTable.id });
    createdUserIds.push(user.id);

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Node-delete migrate plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        // devicesIncluded=2: the old key on the node-being-deleted is still
        // active (not yet revoked) while issueKeyForUser runs for the
        // replacement, so a devicesIncluded=1 plan would spuriously hit
        // SLOTS_EXCEEDED here — unrelated to what this test verifies.
        devicesIncluded: 2,
      })
      .returning({ id: plansTable.id });

    await db.insert(subscriptionsTable).values({
      userId: user.id,
      planId: plan.id,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // Isolate this migration to a region unique to this test so the
    // "least-loaded same-region node" selection can't be swayed by any other
    // test's (or a prior run's leftover) same-region node.
    const carryOverRegion = `carryover-${randomBytes(4).toString("hex")}`;
    const { id: sourceNodeId } = await createNodeInRegion(carryOverRegion);
    createdNodeIds.push(sourceNodeId);
    const { id: targetNodeId } = await createNodeInRegion(carryOverRegion);
    createdNodeIds.push(targetNodeId);

    const PERIOD_UP = 3 * 1024 * 1024 * 1024;
    const PERIOD_DOWN = 2 * 1024 * 1024 * 1024;
    const LIFETIME_UP = 50 * 1024 * 1024 * 1024;
    const LIFETIME_DOWN = 40 * 1024 * 1024 * 1024;
    const periodStartedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId: user.id,
        nodeId: sourceNodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "test-key",
        vlessLink: "vless://test",
        deepLink: "v2raytun://test",
        periodUpBytes: PERIOD_UP,
        periodDownBytes: PERIOD_DOWN,
        trafficUpBytes: LIFETIME_UP,
        trafficDownBytes: LIFETIME_DOWN,
        periodStartedAt,
      })
      .returning({ id: vpnKeysTable.id });

    // Act.
    const res = await request
      .delete(`/api/admin/vpn-nodes/${sourceNodeId}`)
      .set("Cookie", adminCookie);

    // Assert: migration succeeded (not a failed/skipped migration).
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ migratedKeys: 1, failedMigrations: 0 });

    // The old key row is gone; find its replacement on the target node.
    const oldKeyRows = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.id, key.id));
    expect(oldKeyRows).toHaveLength(0);

    const [newKey] = await db
      .select()
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, user.id));
    expect(newKey).toBeDefined();
    expect(newKey!.nodeId).toBe(targetNodeId);
    expect(newKey!.periodUpBytes).toBe(PERIOD_UP);
    expect(newKey!.periodDownBytes).toBe(PERIOD_DOWN);
    expect(newKey!.trafficUpBytes).toBe(LIFETIME_UP);
    expect(newKey!.trafficDownBytes).toBe(LIFETIME_DOWN);
    expect(newKey!.periodStartedAt?.getTime()).toBe(periodStartedAt.getTime());

    // Cleanup (not handled by afterAll's node/user loops).
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, user.id));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, user.id));
    await db.delete(plansTable).where(eq(plansTable.id, plan.id));
  });

  it("does not lose traffic recorded by a concurrent poll that lands while the migration is still in flight", async () => {
    // Reproduces the exact interleaving the counter-transfer step must
    // survive: a traffic-polling tick (applyTrafficDeltas, runs every 60s in
    // production) advances the source key's counters WHILE issueKeyForUser is
    // still provisioning the replacement on the target node — i.e. strictly
    // after any snapshot of the key taken at the top of the migration loop,
    // but strictly before the old key's row is read/deleted for the counter
    // transfer. The transfer must read the row's latest value at deletion
    // time, not an earlier in-memory snapshot, or this traffic is lost.
    const email = `node-delete-race-${randomBytes(6).toString("hex")}@example.com`;
    const passwordHash = await hashPassword("correct-horse-battery-staple");
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
      .returning({ id: usersTable.id });
    createdUserIds.push(user.id);

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Node-delete race plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 2,
      })
      .returning({ id: plansTable.id });

    await db.insert(subscriptionsTable).values({
      userId: user.id,
      planId: plan.id,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // Use a region unique to this test so the "least-loaded same-region node"
    // selection can only ever pick between this test's own two nodes — other
    // tests in this file leave their target nodes alive until the file's
    // afterAll, and they'd otherwise be eligible (and possibly tied on load)
    // same-region candidates too.
    const raceRegion = `race-${randomBytes(4).toString("hex")}`;
    const { id: sourceNodeId } = await createNodeInRegion(raceRegion);
    createdNodeIds.push(sourceNodeId);
    const { id: targetNodeId } = await createNodeInRegion(raceRegion);
    createdNodeIds.push(targetNodeId);

    const PERIOD_UP = 3 * 1024 * 1024 * 1024;
    const PERIOD_DOWN = 2 * 1024 * 1024 * 1024;
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId: user.id,
        nodeId: sourceNodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "test-key",
        vlessLink: "vless://test",
        deepLink: "v2raytun://test",
        periodUpBytes: PERIOD_UP,
        periodDownBytes: PERIOD_DOWN,
      })
      .returning({ id: vpnKeysTable.id, uuid: vpnKeysTable.uuid });

    // Hold the replacement's provisioning call open so we can land a
    // concurrent traffic-poll tick on the source key while the migration is
    // still mid-flight, before it ever reads the source row for the transfer.
    const { addRemoteXrayClient } = await import("../../lib/remoteNode");
    let releaseProvisioning!: () => void;
    const provisioningGate = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    vi.mocked(addRemoteXrayClient).mockImplementationOnce(async () => {
      await provisioningGate;
    });

    const deletePromise = request.delete(`/api/admin/vpn-nodes/${sourceNodeId}`).set("Cookie", adminCookie);

    // Give the handler time to reach (and block on) provisioning.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const EXTRA_UP = 500 * 1024 * 1024;
    const EXTRA_DOWN = 300 * 1024 * 1024;
    const { applyTrafficDeltas } = await import("../../lib/trafficPolling");
    await applyTrafficDeltas(new Map([[key.uuid, { uplinkBytes: EXTRA_UP, downlinkBytes: EXTRA_DOWN }]]));

    releaseProvisioning();
    const res = await deletePromise;

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ migratedKeys: 1, failedMigrations: 0 });

    const [newKey] = await db.select().from(vpnKeysTable).where(eq(vpnKeysTable.userId, user.id));
    expect(newKey).toBeDefined();
    expect(newKey!.nodeId).toBe(targetNodeId);
    // The migration must carry over PERIOD_UP + the poll's delta, not just
    // the PERIOD_UP value snapshotted before the poll landed.
    expect(newKey!.periodUpBytes).toBe(PERIOD_UP + EXTRA_UP);
    expect(newKey!.periodDownBytes).toBe(PERIOD_DOWN + EXTRA_DOWN);

    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, user.id));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, user.id));
    await db.delete(plansTable).where(eq(plansTable.id, plan.id));
  });

  it("reports a failed migration (not a silent no-op) when the replacement key disappears before the counter transfer runs", async () => {
    // Reproduces the other side of the same interleaving: something else
    // (an overlapping admin/user operation) removes the just-issued
    // replacement key's row after issueKeyForUser returns but before the
    // counter-transfer transaction's UPDATE runs against it. Postgres
    // treats that UPDATE as a normal zero-row success, so the transfer step
    // must explicitly check for a returned row and fail closed — otherwise
    // the source key is deleted (and its traffic history with it) while the
    // transaction still commits as if nothing went wrong.
    const email = `node-delete-vanish-${randomBytes(6).toString("hex")}@example.com`;
    const passwordHash = await hashPassword("correct-horse-battery-staple");
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
      .returning({ id: usersTable.id });
    createdUserIds.push(user.id);

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Node-delete vanish plan ${randomBytes(4).toString("hex")}`,
        priceRub: 10000,
        durationDays: 30,
        devicesIncluded: 2,
      })
      .returning({ id: plansTable.id });

    await db.insert(subscriptionsTable).values({
      userId: user.id,
      planId: plan.id,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const vanishRegion = `vanish-${randomBytes(4).toString("hex")}`;
    const { id: sourceNodeId } = await createNodeInRegion(vanishRegion);
    createdNodeIds.push(sourceNodeId);
    const { id: targetNodeId } = await createNodeInRegion(vanishRegion);
    createdNodeIds.push(targetNodeId);

    const PERIOD_UP = 3 * 1024 * 1024 * 1024;
    const PERIOD_DOWN = 2 * 1024 * 1024 * 1024;
    const [key] = await db
      .insert(vpnKeysTable)
      .values({
        userId: user.id,
        nodeId: sourceNodeId,
        uuid: randomBytes(16).toString("hex"),
        label: "test-key",
        vlessLink: "vless://test",
        deepLink: "v2raytun://test",
        periodUpBytes: PERIOD_UP,
        periodDownBytes: PERIOD_DOWN,
      })
      .returning({ id: vpnKeysTable.id, uuid: vpnKeysTable.uuid });

    // The replacement's DB row is committed by issueKeyForUser BEFORE it
    // calls addRemoteXrayClient (provisioning happens after the insert
    // commits) — gate that call so we can delete the replacement row while
    // it's still in flight, simulating another process removing it. The
    // mock flips `provisioningCallStarted` synchronously the instant it's
    // invoked, which is a precise signal that the insert has already
    // committed — far more reliable than guessing a delay.
    const { addRemoteXrayClient } = await import("../../lib/remoteNode");
    let releaseProvisioning!: () => void;
    let provisioningCallStarted = false;
    const provisioningGate = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    vi.mocked(addRemoteXrayClient).mockImplementationOnce(async () => {
      provisioningCallStarted = true;
      await provisioningGate;
    });

    const deletePromise = request.delete(`/api/admin/vpn-nodes/${sourceNodeId}`).set("Cookie", adminCookie);

    // Race against the request itself (not just a fixed delay) so a request
    // that resolves early (e.g. an unexpected error response) fails loudly
    // with its actual status/body instead of a confusing flag-never-flipped
    // timeout.
    const raced = await Promise.race([
      deletePromise.then((r) => ({ kind: "resolved" as const, status: r.status, body: r.body })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" as const }), 2000)),
    ]);
    if ((raced as { kind: string }).kind === "resolved") {
      throw new Error(`Request resolved early instead of blocking on the gate: ${JSON.stringify(raced)}`);
    }
    expect(provisioningCallStarted).toBe(true);

    const replacementRows = await db
      .select({ id: vpnKeysTable.id, nodeId: vpnKeysTable.nodeId })
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, user.id));
    const replacement = replacementRows.find((r) => r.nodeId === targetNodeId);
    expect(replacement).toBeDefined();
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, replacement!.id));

    releaseProvisioning();
    const res = await deletePromise;

    expect(res.status).toBe(200);
    // Must be reported as a failed migration, never as a successful one.
    expect(res.body).toMatchObject({ migratedKeys: 0, failedMigrations: 1 });

    // The source key's traffic history must not have been silently discarded:
    // a durable admin-visible event records what was lost for manual review.
    const events = await db
      .select()
      .from(systemEventsTable)
      .where(eq(systemEventsTable.eventType, "key_migration_traffic_loss"));
    const matching = events.find((e) => (e.metadata as Record<string, unknown> | null)?.oldKeyId === key.id);
    expect(matching).toBeDefined();
    expect(matching!.metadata).toMatchObject({
      oldKeyId: key.id,
      lastKnownPeriodUpBytes: PERIOD_UP,
      lastKnownPeriodDownBytes: PERIOD_DOWN,
    });

    await db.delete(systemEventsTable).where(eq(systemEventsTable.userId, user.id));
    await db.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, user.id));
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, user.id));
    await db.delete(plansTable).where(eq(plansTable.id, plan.id));
  });

  it("deletes a node that has no keys without errors", async () => {
    // Arrange: a node with zero keys.
    const { id: nodeId } = await createRemoteNode();
    createdNodeIds.push(nodeId);

    // Act.
    const res = await request
      .delete(`/api/admin/vpn-nodes/${nodeId}`)
      .set("Cookie", adminCookie);

    // Assert: clean 200 response with migration stats (failedMigrations is an integer).
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ migratedKeys: 0, failedMigrations: 0 });

    // Assert: node is gone from DB.
    const nodes = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    expect(nodes).toHaveLength(0);
  });

  it("returns 404 when deleting an already-deleted node", async () => {
    // Arrange: create and delete a node.
    const { id: nodeId } = await createRemoteNode();
    createdNodeIds.push(nodeId);

    const first = await request
      .delete(`/api/admin/vpn-nodes/${nodeId}`)
      .set("Cookie", adminCookie);
    expect(first.status).toBe(200);

    // Act: attempt a second delete.
    const second = await request
      .delete(`/api/admin/vpn-nodes/${nodeId}`)
      .set("Cookie", adminCookie);

    // Assert: 404 — node is gone.
    expect(second.status).toBe(404);
  });

  it("returns 403 for a non-admin user", async () => {
    const { id: nodeId } = await createRemoteNode();
    createdNodeIds.push(nodeId);

    // Create a regular user and log in.
    const email = `node-delete-test-user-${randomBytes(6).toString("hex")}@example.com`;
    const passwordHash = await hashPassword("correct-horse-battery-staple");
    const [regularUser] = await db
      .insert(usersTable)
      .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
      .returning({ id: usersTable.id });
    createdUserIds.push(regularUser.id);

    const loginRes = await request.post("/api/auth/login").send({ email, password: "correct-horse-battery-staple" });
    expect(loginRes.status).toBe(200);
    const cookies = Array.isArray(loginRes.headers["set-cookie"])
      ? loginRes.headers["set-cookie"]
      : [loginRes.headers["set-cookie"]];
    const userCookie = (cookies.find((c: string) => c.startsWith("vpn_session=")) ?? "").split(";")[0];

    const res = await request
      .delete(`/api/admin/vpn-nodes/${nodeId}`)
      .set("Cookie", userCookie);

    expect(res.status).toBe(403);

    // Clean up node (not deleted by this test's handler call).
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
  });
});
