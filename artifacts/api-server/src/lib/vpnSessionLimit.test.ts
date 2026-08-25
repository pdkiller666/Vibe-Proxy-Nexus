import { afterEach, describe, expect, it, vi } from "vitest";
import type { VpnNode } from "@workspace/db";
import {
  buildVpnSessionId,
  buildVpnWebSocketPath,
  getVpnSessionIdFromRequestUrl,
  isVpnSessionLimitEnabledForUuid,
  VpnSessionRegistry,
} from "./vpnSessionLimit";
import { buildVlessLink } from "./vless";

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_UUID = "11111111-2222-3333-4444-555555555555";
const SECRET = "test-session-secret";
const TEST_NODE = {
  host: "vpn.example.test",
  sni: "vpn.example.test",
  port: 443,
  region: "Germany",
  managementApiUrl: null,
} as VpnNode;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("VPN concurrent-session rollout", () => {
  it("keeps the feature off unless explicitly enabled", () => {
    expect(buildVpnWebSocketPath("/vpnws", UUID, { SESSION_SECRET: SECRET })).toBe("/vpnws");
  });

  it("enables only an explicitly selected canary UUID", () => {
    const env = {
      VPN_SESSION_LIMIT_MODE: "canary",
      VPN_SESSION_LIMIT_CANARY_UUIDS: UUID,
      SESSION_SECRET: SECRET,
    };

    expect(isVpnSessionLimitEnabledForUuid(UUID, env)).toBe(true);
    expect(isVpnSessionLimitEnabledForUuid(OTHER_UUID, env)).toBe(false);
    expect(buildVpnWebSocketPath("/vpnws", OTHER_UUID, env)).toBe("/vpnws");
  });

  it("derives a stable opaque identity for a selected key", () => {
    const env = { VPN_SESSION_LIMIT_MODE: "all", SESSION_SECRET: SECRET };
    const first = buildVpnSessionId(UUID, env);
    const second = buildVpnSessionId(UUID, env);

    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second).toBe(first);
    expect(buildVpnSessionId(OTHER_UUID, env)).not.toBe(first);
    expect(buildVpnWebSocketPath("/vpnws", UUID, env)).toBe(`/vpnws?sid=${first}`);
  });

  it("adds sid only to a selected key's generated VLESS URI", () => {
    vi.stubEnv("VPN_SESSION_LIMIT_MODE", "canary");
    vi.stubEnv("VPN_SESSION_LIMIT_CANARY_UUIDS", UUID);
    vi.stubEnv("SESSION_SECRET", SECRET);

    const canaryUri = new URL(buildVlessLink(TEST_NODE, UUID, "Canary"));
    const legacyUri = new URL(buildVlessLink(TEST_NODE, OTHER_UUID, "Legacy"));

    expect(canaryUri.searchParams.get("path")).toMatch(/^\/vpnws\?sid=[A-Za-z0-9_-]{32}$/);
    expect(legacyUri.searchParams.get("path")).toBe("/vpnws");
  });

  it("extracts only generated-looking session IDs from a WebSocket URL", () => {
    expect(
      getVpnSessionIdFromRequestUrl("/vpnws?sid=abcdefghijklmnopqrstuvwxyz012345"),
    ).toBe("abcdefghijklmnopqrstuvwxyz012345");
    expect(getVpnSessionIdFromRequestUrl("/vpnws?sid=short")).toBeNull();
    expect(getVpnSessionIdFromRequestUrl("/vpnws")).toBeNull();
  });

  it("allows one socket reservation and releases it idempotently", () => {
    const registry = new VpnSessionRegistry<object>();
    const first = {};
    const second = {};

    expect(registry.tryAcquire("stable-session-id-12345678", first)).toBe(true);
    expect(registry.tryAcquire("stable-session-id-12345678", second)).toBe(false);
    expect(registry.count("stable-session-id-12345678")).toBe(1);

    registry.release("stable-session-id-12345678", first);
    registry.release("stable-session-id-12345678", first);
    expect(registry.count("stable-session-id-12345678")).toBe(0);
    expect(registry.tryAcquire("stable-session-id-12345678", second)).toBe(true);
  });
});