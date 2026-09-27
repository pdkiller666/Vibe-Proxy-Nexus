import { describe, expect, it } from "vitest";
import type { VpnNode } from "@workspace/db";
import { buildVlessLink } from "./vless";

function node(overrides: Partial<VpnNode> = {}): VpnNode {
  return {
    id: 1,
    name: "Reality test VPS",
    region: "test",
    host: "203.0.113.10",
    port: 8443,
    transport: "reality",
    managementApiUrl: "https://mgmt.example.test",
    managementApiSecret: null,
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    shortId: "a1b2c3d4",
    sni: "example.com",
    isActive: true,
    consecutiveFailures: 0,
    maxUsers: null,
    certSha256: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("buildVlessLink transport serialization", () => {
  it("emits VLESS+Reality fields from the node", () => {
    const url = new URL(buildVlessLink(node(), "11111111-2222-3333-4444-555555555555", "test"));
    expect(url.hostname).toBe("203.0.113.10");
    expect(url.port).toBe("8443");
    expect(url.searchParams.get("type")).toBe("tcp");
    expect(url.searchParams.get("security")).toBe("reality");
    expect(url.searchParams.get("sni")).toBe("example.com");
    expect(url.searchParams.get("pbk")).toBe(node().publicKey);
    expect(url.searchParams.get("sid")).toBe("a1b2c3d4");
    expect(url.searchParams.get("flow")).toBe("xtls-rprx-vision");
    expect(url.searchParams.get("path")).toBeNull();
  });

  it("keeps existing WS+TLS serialization as the default", () => {
    const url = new URL(
      buildVlessLink(
        node({
          transport: "ws",
          managementApiUrl: null,
          publicKey: null,
          shortId: null,
          port: 443,
          sni: "ws.example.test",
        }),
        "11111111-2222-3333-4444-555555555555",
        "test",
      ),
    );
    expect(url.searchParams.get("type")).toBe("ws");
    expect(url.searchParams.get("security")).toBe("tls");
    expect(url.searchParams.get("path")).toBe("/vpnws");
    expect(url.searchParams.get("host")).toBe("ws.example.test");
    expect(url.searchParams.get("flow")).toBeNull();
    expect(url.searchParams.get("pbk")).toBeNull();
  });

  it("pins a self-signed certificate for a domain-backed WS node", () => {
    const certSha256 = "YXNkZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OQ==";
    const url = new URL(buildVlessLink(
      node({
        transport: "ws",
        managementApiUrl: null,
        publicKey: null,
        shortId: null,
        host: "v1023041.hosted-by-vdsina.com",
        port: 443,
        sni: "v1023041.hosted-by-vdsina.com",
        certSha256,
      }),
      "11111111-2222-3333-4444-555555555555",
      "test",
    ));
    expect(url.searchParams.get("pinnedPeerCertSha256")).toBe(certSha256);
    expect(url.searchParams.has("allowInsecure")).toBe(false);
  });

  it("keeps the legacy allowInsecure fallback for an IP node without a pin", () => {
    const url = new URL(buildVlessLink(
      node({
        transport: "ws",
        managementApiUrl: null,
        publicKey: null,
        shortId: null,
        host: "203.0.113.10",
        port: 443,
        sni: "203.0.113.10",
      }),
      "11111111-2222-3333-4444-555555555555",
      "test",
    ));
    expect(url.searchParams.get("allowInsecure")).toBe("1");
    expect(url.searchParams.has("pinnedPeerCertSha256")).toBe(false);
  });
});