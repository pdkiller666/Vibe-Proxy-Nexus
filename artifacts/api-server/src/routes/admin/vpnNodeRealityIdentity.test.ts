import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { db, usersTable, vpnNodesTable } from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";
import { getRemoteRealityIdentity } from "../../lib/remoteNode";

vi.mock("../../lib/remoteNode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/remoteNode")>();
  return { ...actual, getRemoteRealityIdentity: vi.fn() };
});

const request = supertest(app);
const getRemoteRealityIdentityMock = vi.mocked(getRemoteRealityIdentity);

describe("admin Reality identity comparison", () => {
  const password = "correct-horse-battery-staple";
  const email = `reality-identity-${randomBytes(6).toString("hex")}@example.com`;
  const nodeName = `Reality identity ${randomBytes(4).toString("hex")}`;
  let adminId: number;
  let nodeId: number;
  let adminCookie: string;

  beforeAll(async () => {
    const [admin] = await db.insert(usersTable).values({
      email,
      passwordHash: await hashPassword(password),
      role: "admin",
      referralCode: randomBytes(8).toString("hex"),
    }).returning({ id: usersTable.id });
    adminId = admin.id;

    const login = await request.post("/api/auth/login").send({ email, password });
    expect(login.status).toBe(200);
    const cookies = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"]
      : [login.headers["set-cookie"]];
    const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
    if (!sessionCookie) throw new Error("Admin login did not set a session cookie");
    adminCookie = sessionCookie.split(";")[0];

    const [node] = await db.insert(vpnNodesTable).values({
      name: nodeName,
      region: "test",
      host: "192.0.2.44",
      port: 443,
      transport: "reality",
      sni: "reality.example.test",
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      shortId: "0123456789abcdef",
      managementApiUrl: "http://127.0.0.1:1",
      managementApiSecret: "test-only-secret",
    }).returning({ id: vpnNodesTable.id });
    nodeId = node.id;
  });

  afterAll(async () => {
    if (nodeId) await db.delete(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    if (adminId) await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  it("returns only public live identity and reports a full match", async () => {
    getRemoteRealityIdentityMock.mockResolvedValue({
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      port: 443,
      network: "tcp",
      security: "reality",
      serverNames: ["reality.example.test"],
      shortIds: ["0123456789abcdef"],
      dest: "example.org:443",
    });

    const response = await request
      .get(`/api/admin/vpn-nodes/${nodeId}/reality-identity`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(200);
    expect(response.body.matches).toEqual({
      publicKey: true,
      port: true,
      sni: true,
      shortId: true,
      transport: true,
      all: true,
    });
    expect(response.body.live).not.toHaveProperty("privateKey");
    expect(response.body.stored).not.toHaveProperty("managementApiSecret");
  });

  it("reports profile mismatches without changing the saved node", async () => {
    getRemoteRealityIdentityMock.mockResolvedValue({
      publicKey: "different-public-key",
      port: 8443,
      network: "tcp",
      security: "none",
      serverNames: ["other.example.test"],
      shortIds: ["fedcba9876543210"],
      dest: null,
    });

    const response = await request
      .get(`/api/admin/vpn-nodes/${nodeId}/reality-identity`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(200);
    expect(response.body.matches).toEqual({
      publicKey: false,
      port: false,
      sni: false,
      shortId: false,
      transport: false,
      all: false,
    });
    const [savedNode] = await db.select().from(vpnNodesTable).where(eq(vpnNodesTable.id, nodeId));
    expect(savedNode.publicKey).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(savedNode.port).toBe(443);
  });

  it("hides remote errors behind a generic response", async () => {
    getRemoteRealityIdentityMock.mockRejectedValue(new Error("private remote response text"));

    const response = await request
      .get(`/api/admin/vpn-nodes/${nodeId}/reality-identity`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(502);
    expect(response.body.error).not.toContain("private remote response text");
  });
});
