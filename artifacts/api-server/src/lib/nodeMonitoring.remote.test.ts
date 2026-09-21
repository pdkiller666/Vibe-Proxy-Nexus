import { randomBytes } from "node:crypto";
import { beforeEach, vi } from "vitest";

const remoteMocks = vi.hoisted(() => ({
  add: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("./remoteNode", () => ({
  addRemoteXrayClient: remoteMocks.add,
  listRemoteXrayClients: remoteMocks.list,
  removeRemoteXrayClient: remoteMocks.remove,
}));

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  db,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { reconcileRemoteXrayNode } from "./nodeMonitoring";

describe("remote Xray client reconciliation", () => {
  const suffix = randomBytes(8).toString("hex");
  let userId: number;
  let foreignUserId: number;
  let remoteNodeId: number;
  let foreignNodeId: number;
  let activeUuid: string;
  let staleUuid: string;
  let foreignUuid: string;
  const keyIds: number[] = [];
  const nodeIds: number[] = [];
  const userIds: number[] = [];

  const node = () => ({
    id: remoteNodeId,
    name: `Remote reconcile ${suffix}`,
    managementApiUrl: "https://remote.example.com",
    managementApiSecret: "test-secret",
  });

  beforeAll(async () => {
    const [user, foreignUser] = await db
      .insert(usersTable)
      .values([
        {
          email: `remote-reconcile-${suffix}@example.com`,
          passwordHash: "test-only",
          role: "user",
          referralCode: `remote-reconcile-${suffix}`,
        },
        {
          email: `remote-reconcile-foreign-${suffix}@example.com`,
          passwordHash: "test-only",
          role: "user",
          referralCode: `remote-reconcile-foreign-${suffix}`,
        },
      ])
      .returning({ id: usersTable.id });
    userId = user!.id;
    foreignUserId = foreignUser!.id;
    userIds.push(userId, foreignUserId);

    const [remoteNode] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Remote reconcile ${suffix}`,
        region: "test",
        host: `remote-reconcile-${suffix}.example.com`,
        sni: `remote-reconcile-${suffix}.example.com`,
        managementApiUrl: "https://remote.example.com",
        managementApiSecret: "test-secret",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    remoteNodeId = remoteNode!.id;
    nodeIds.push(remoteNodeId);

    const [foreignNode] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Remote reconcile foreign ${suffix}`,
        region: "test",
        host: `remote-reconcile-foreign-${suffix}.example.com`,
        sni: `remote-reconcile-foreign-${suffix}.example.com`,
        managementApiUrl: "https://foreign.example.com",
        managementApiSecret: "test-secret",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    foreignNodeId = foreignNode!.id;
    nodeIds.push(foreignNodeId);

    activeUuid = randomBytes(16).toString("hex");
    staleUuid = randomBytes(16).toString("hex");
    foreignUuid = randomBytes(16).toString("hex");

    const [activeKey, staleKey, foreignKey] = await db
      .insert(vpnKeysTable)
      .values([
        {
          userId,
          nodeId: remoteNodeId,
          uuid: activeUuid,
          label: "Active remote device",
          vlessLink: "vless://active",
          deepLink: "happ://active",
          provisionedAt: new Date(),
        },
        {
          userId,
          nodeId: remoteNodeId,
          uuid: staleUuid,
          label: "Revoked remote device",
          vlessLink: "vless://stale",
          deepLink: "happ://stale",
          revokedAt: new Date(),
          revokedReason: "admin",
          provisionedAt: new Date(),
        },
        {
          userId: foreignUserId,
          nodeId: foreignNodeId,
          uuid: foreignUuid,
          label: "Foreign node device",
          vlessLink: "vless://foreign",
          deepLink: "happ://foreign",
          provisionedAt: new Date(),
        },
      ])
      .returning({ id: vpnKeysTable.id });
    keyIds.push(activeKey!.id, staleKey!.id, foreignKey!.id);
  });

  beforeEach(async () => {
    remoteMocks.add.mockClear();
    remoteMocks.list.mockClear();
    remoteMocks.remove.mockClear();
    await db
      .update(vpnKeysTable)
      .set({ nodeId: remoteNodeId, revokedAt: null, revokedReason: null })
      .where(inArray(vpnKeysTable.uuid, [activeUuid]));
  });

  afterAll(async () => {
    await db.delete(vpnKeysTable).where(inArray(vpnKeysTable.id, keyIds));
    await db.delete(vpnNodesTable).where(inArray(vpnNodesTable.id, nodeIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  });

  it("restores missing clients and leaves unknown clients untouched", async () => {
    remoteMocks.list.mockResolvedValueOnce([
      { uuid: foreignUuid, label: "Foreign node device", limitIp: 1 },
    ]);

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
      activeUuid,
      1,
    );
    expect(remoteMocks.remove).not.toHaveBeenCalled();
  });

  it("removes stale own clients and repairs duplicate active clients", async () => {
    remoteMocks.list.mockResolvedValueOnce([
      { uuid: activeUuid, label: "Active remote device", limitIp: 1 },
      { uuid: activeUuid, label: "Active remote device", limitIp: 1 },
      { uuid: staleUuid, label: "Revoked remote device", limitIp: 1 },
      { uuid: foreignUuid, label: "Foreign node device", limitIp: 1 },
    ]);

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
    );
    expect(remoteMocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      staleUuid,
    );
    expect(remoteMocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
      activeUuid,
      1,
    );
    expect(remoteMocks.remove).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      foreignUuid,
    );
  });

  it("repairs a singleton client whose identity or IP limit is not canonical", async () => {
    remoteMocks.list.mockResolvedValueOnce([
      { uuid: activeUuid, label: "Legacy device label", limitIp: null },
    ]);

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
    );
    expect(remoteMocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
      activeUuid,
      1,
    );
  });

  it("does not restore a missing client revoked after the initial DB snapshot", async () => {
    remoteMocks.list.mockImplementationOnce(async () => {
      await db
        .update(vpnKeysTable)
        .set({ revokedAt: new Date(), revokedReason: "admin" })
        .where(eq(vpnKeysTable.uuid, activeUuid));
      return [];
    });

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.add).not.toHaveBeenCalled();
  });

  it("compensates when a missing client is revoked during remote provisioning", async () => {
    remoteMocks.list.mockResolvedValueOnce([]);
    remoteMocks.add.mockImplementationOnce(async () => {
      await db
        .update(vpnKeysTable)
        .set({ revokedAt: new Date(), revokedReason: "admin" })
        .where(eq(vpnKeysTable.uuid, activeUuid));
    });

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
      activeUuid,
      1,
    );
    expect(remoteMocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
    );
  });

  it("removes but never re-adds a duplicate client revoked after the initial snapshot", async () => {
    remoteMocks.list.mockImplementationOnce(async () => {
      await db
        .update(vpnKeysTable)
        .set({ revokedAt: new Date(), revokedReason: "admin" })
        .where(eq(vpnKeysTable.uuid, activeUuid));
      return [
        { uuid: activeUuid, label: activeUuid, limitIp: 1 },
        { uuid: activeUuid, label: activeUuid, limitIp: 1 },
      ];
    });

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
    );
    expect(remoteMocks.add).not.toHaveBeenCalled();
  });

  it("removes a canonical singleton revoked after the initial snapshot", async () => {
    remoteMocks.list.mockImplementationOnce(async () => {
      await db
        .update(vpnKeysTable)
        .set({ revokedAt: new Date(), revokedReason: "admin" })
        .where(eq(vpnKeysTable.uuid, activeUuid));
      return [{ uuid: activeUuid, label: activeUuid, limitIp: 1 }];
    });

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: node().name }),
      activeUuid,
    );
    expect(remoteMocks.add).not.toHaveBeenCalled();
  });

  it("fails closed when remote inventory is unavailable", async () => {
    remoteMocks.list.mockRejectedValueOnce(new Error("remote timeout"));

    await reconcileRemoteXrayNode(node());

    expect(remoteMocks.add).not.toHaveBeenCalled();
    expect(remoteMocks.remove).not.toHaveBeenCalled();
  });
});