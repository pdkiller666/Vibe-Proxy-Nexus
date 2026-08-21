import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
  vpnNodesTable,
} from "@workspace/db";
import { hashPassword } from "../lib/password";

const provisioning = vi.hoisted(() => ({
  targetNodeName: "",
  calls: 0,
  release: null as (() => void) | null,
}));

import app from "../app";
import { setReplayPollingForTests } from "../lib/keyIssuance";

const request = supertest(app);

describe("VPN key relocation across API instances", () => {
  let planId: number;
  let sourceNodeId: number;
  let targetNodeId: number;
  const userIds: number[] = [];
  const subscriptionIds: number[] = [];
  const keyIds: number[] = [];

  async function waitForRemoteProvisioning(): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (provisioning.calls === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(provisioning.calls).toBe(1);
  }

  beforeAll(async () => {
    setReplayPollingForTests(10, 50);

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Multi-instance relocation ${randomBytes(4).toString("hex")}`,
        priceRub: 1000,
        durationDays: 30,
        devicesIncluded: 1,
      })
      .returning({ id: plansTable.id });
    planId = plan.id;

    const [source] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Multi-instance source ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "multi-source.example.com",
        sni: "multi-source.example.com",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id });
    sourceNodeId = source.id;

    const [target] = await db
      .insert(vpnNodesTable)
      .values({
        name: `Multi-instance target ${randomBytes(4).toString("hex")}`,
        region: "test",
        host: "multi-target.example.com",
        sni: "multi-target.example.com",
        managementApiUrl: "http://delayed-node.test",
        isActive: true,
      })
      .returning({ id: vpnNodesTable.id, name: vpnNodesTable.name });
    targetNodeId = target.id;
    provisioning.targetNodeName = target.name;
  });

  afterAll(async () => {
    provisioning.release?.();
    for (const id of keyIds) {
      await db.delete(vpnKeysTable).where(eq(vpnKeysTable.id, id));
    }
    for (const id of subscriptionIds) {
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    }
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, sourceNodeId));
    await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, targetNodeId));
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    for (const id of userIds) {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    }
  });

  it("returns retriable pending, then one key and one source revoke", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/clients")) {
          provisioning.calls += 1;
          await new Promise<void>((resolve) => {
            provisioning.release = resolve;
          });
        }
        return new Response(null, { status: 200 });
      }),
    );

    const email = `multi-instance-${randomBytes(6).toString("hex")}@example.com`;
    const password = "correct-horse-battery-staple";
    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(usersTable)
      .values({
        email,
        passwordHash,
        role: "user",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userIds.push(user.id);

    const login = await request.post("/api/auth/login").send({ email, password });
    expect(login.status).toBe(200);
    const cookies = login.headers["set-cookie"] as unknown as string[];
    const cookie = cookies.find((value) => value.startsWith("vpn_session="))?.split(";")[0];
    if (!cookie) throw new Error("Login did not set a session cookie");

    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: user.id,
        planId,
        status: "active",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription.id);

    const initial = await request
      .post("/api/vpn-keys")
      .set("Cookie", cookie)
      .send({ nodeId: sourceNodeId });
    expect(initial.status).toBe(201);
    const sourceKeyId = initial.body.id as number;
    keyIds.push(sourceKeyId);

    const relocationPath = `/api/vpn-keys/${sourceKeyId}/relocate`;
    const relocationBody = {
      nodeId: targetNodeId,
      idempotencyKey: randomBytes(16).toString("hex"),
    };
    const [targetBefore] = await db
      .select({ managementApiUrl: vpnNodesTable.managementApiUrl })
      .from(vpnNodesTable)
      .where(eq(vpnNodesTable.id, targetNodeId));
    expect(targetBefore.managementApiUrl).toBe("http://delayed-node.test");
    const firstRequest = request
      .post(relocationPath)
      .set("Cookie", cookie)
      .send(relocationBody);
    const earlyResponse = await Promise.race([
      firstRequest,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    if (earlyResponse) {
      throw new Error(`Relocation completed before provisioning: ${earlyResponse.status}`);
    }
    await waitForRemoteProvisioning();

    const pendingRetry = await request
      .post(relocationPath)
      .set("Cookie", cookie)
      .send(relocationBody);
    expect(pendingRetry.status).toBe(409);
    expect(pendingRetry.body.error).toContain("ещё выполняется");

    provisioning.release?.();
    const firstResponse = await firstRequest;
    expect(firstResponse.status).toBe(200);
    const replacementKeyId = firstResponse.body.id as number;
    keyIds.push(replacementKeyId);

    const completedRetry = await request
      .post(relocationPath)
      .set("Cookie", cookie)
      .send(relocationBody);
    expect(completedRetry.status).toBe(200);
    expect(completedRetry.body.id).toBe(replacementKeyId);

    const rows = await db
      .select({ id: vpnKeysTable.id, nodeId: vpnKeysTable.nodeId, revokedAt: vpnKeysTable.revokedAt })
      .from(vpnKeysTable)
      .where(eq(vpnKeysTable.userId, user.id));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revokedAt === null)).toEqual([
      { id: replacementKeyId, nodeId: targetNodeId, revokedAt: null },
    ]);
    expect(rows.find((row) => row.id === sourceKeyId)?.revokedAt).not.toBeNull();
    expect(provisioning.calls).toBe(1);
  });
});