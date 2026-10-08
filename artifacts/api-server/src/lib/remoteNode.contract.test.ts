import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addRemoteXrayClient,
  getRemoteRealityIdentity,
  listRemoteXrayClients,
  removeRemoteXrayClient,
  type RemoteNodeRef,
} from "./remoteNode";

const contractUrl = process.env["VPN_NODE_CONTRACT_URL"];
const contractSecret = process.env["VPN_NODE_CONTRACT_SECRET"];
const contractDescribe = contractUrl && contractSecret ? describe : describe.skip;

contractDescribe("TypeScript client ↔ local vpn-node management API contract", () => {
  const node: RemoteNodeRef = {
    name: "local Reality contract fixture",
    managementApiUrl: contractUrl!,
    managementApiSecret: contractSecret!,
    transport: "reality",
    port: 443,
    sni: "reality.contract.test",
    publicKey: "contract-test-public-key",
    shortId: "0123456789abcdef",
  };

  it("authenticates, reads public identity, and migrates one UUID WS → Reality → WS", async () => {
    await expect(getRemoteRealityIdentity({
      ...node,
      managementApiSecret: "intentionally-wrong-test-secret",
    })).rejects.toThrow("HTTP 401");

    const identity = await getRemoteRealityIdentity(node);
    expect(identity).toEqual({
      publicKey: "contract-test-public-key",
      port: 443,
      network: "tcp",
      security: "reality",
      serverNames: ["reality.contract.test"],
      shortIds: ["0123456789abcdef"],
      dest: "example.org:443",
    });

    const uuid = randomUUID();
    const wsNode: RemoteNodeRef = { ...node, transport: "ws" };
    try {
      await addRemoteXrayClient(wsNode, uuid, "contract-user", 1);
      expect((await listRemoteXrayClients(wsNode)).filter((client) => client.uuid === uuid))
        .toEqual([expect.objectContaining({ transport: "ws" })]);

      await addRemoteXrayClient(node, uuid, "contract-user", 1);
      expect((await listRemoteXrayClients(node)).filter((client) => client.uuid === uuid))
        .toEqual([expect.objectContaining({ transport: "reality" })]);

      await addRemoteXrayClient(wsNode, uuid, "contract-user", 1);
      expect((await listRemoteXrayClients(wsNode)).filter((client) => client.uuid === uuid))
        .toEqual([expect.objectContaining({ transport: "ws" })]);
    } finally {
      await removeRemoteXrayClient(node, uuid);
    }
  }, 60_000);
});
