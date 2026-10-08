import { describe, expect, it } from "vitest";
import { ProvisionVpnNodeBody } from "./vpnNodeProvisioning";

const sharedInput = {
  sshUser: "root",
  sshPassword: "test-password",
  nodeName: "Reality test",
  nodeRegion: "nl",
};

describe("ProvisionVpnNodeBody", () => {
  it("accepts Reality without the WebSocket domain field", () => {
    const parsed = ProvisionVpnNodeBody.parse({
      ...sharedInput,
      sshHost: "194.4.50.111",
      transport: "reality",
      realitySni: "cover.example.com",
    });

    expect(parsed.domain).toBeUndefined();
  });

  it("requires a bare IPv4 address and valid SNI for Reality", () => {
    const input = {
      ...sharedInput,
      transport: "reality",
      realitySni: "cover.example.com",
    };

    expect(ProvisionVpnNodeBody.safeParse({ ...input, sshHost: "node.example.com" }).success).toBe(false);
    expect(ProvisionVpnNodeBody.safeParse({ ...input, sshHost: "194.4.50.111" }).success).toBe(true);
    expect(ProvisionVpnNodeBody.safeParse({
      ...sharedInput,
      sshHost: "194.4.50.111",
      transport: "reality",
      realitySni: "not a hostname",
    }).success).toBe(false);
  });

  it("continues to require a host and domain for WebSocket provisioning", () => {
    expect(ProvisionVpnNodeBody.safeParse({
      ...sharedInput,
      sshHost: "ssh.example.com",
      domain: "vpn.example.com",
      transport: "ws",
    }).success).toBe(true);

    expect(ProvisionVpnNodeBody.safeParse({
      ...sharedInput,
      sshHost: "ssh.example.com",
      transport: "ws",
    }).success).toBe(false);
  });
});
