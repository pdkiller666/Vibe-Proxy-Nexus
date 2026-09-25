import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { db, vpnNodesTable } from "@workspace/db";
import app from "../app";

const request = supertest(app);

describe("public VPN node locations", () => {
  const nodeIds: number[] = [];

  beforeAll(async () => {
    const suffix = randomBytes(6).toString("hex");
    const nodes = await db.insert(vpnNodesTable).values([
      {
        name: `Public WS ${suffix}`,
        region: "test",
        host: "ws-public.example.com",
        sni: "ws-public.example.com",
        transport: "ws",
        isActive: true,
      },
      {
        name: `Public Reality ${suffix}`,
        region: "test",
        host: "203.0.113.40",
        port: 443,
        sni: "example.com",
        transport: "reality",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        shortId: "a1b2c3d4",
        isActive: true,
      },
      {
        name: `Inactive Reality ${suffix}`,
        region: "test",
        host: "203.0.113.41",
        port: 443,
        sni: "example.com",
        transport: "reality",
        publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        shortId: "a1b2c3d4",
        isActive: false,
      },
    ]).returning({ id: vpnNodesTable.id });
    nodeIds.push(...nodes.map((node) => node.id));
  });

  afterAll(async () => {
    await db.delete(vpnNodesTable).where(inArray(vpnNodesTable.id, nodeIds));
  });

  it("returns active WS and Reality locations but excludes inactive nodes", async () => {
    const response = await request.get("/api/vpn-nodes");

    expect(response.status).toBe(200);
    const ids = new Set(response.body.map((node: { id: number }) => node.id));
    expect([...ids]).toEqual(expect.arrayContaining(nodeIds.slice(0, 2)));
    expect(ids.has(nodeIds[2])).toBe(false);
  });
});