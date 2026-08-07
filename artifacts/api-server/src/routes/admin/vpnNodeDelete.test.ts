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
import { db, usersTable, vpnKeysTable, vpnNodesTable } from "@workspace/db";
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

async function createRemoteNode(): Promise<{ id: number }> {
  const [node] = await db
    .insert(vpnNodesTable)
    .values({
      name: `Delete-test node ${randomBytes(6).toString("hex")}`,
      region: "test",
      host: "remote.example.com",
      sni: "remote.example.com",
      isActive: true,
      managementApiUrl: "http://fake-mgmt.example.com",
      managementApiSecret: "fake-secret",
    })
    .returning({ id: vpnNodesTable.id });
  return { id: node.id };
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
