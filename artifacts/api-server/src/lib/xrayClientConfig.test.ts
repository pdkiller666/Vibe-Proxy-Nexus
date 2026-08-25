/**
 * Unit tests for buildXrayClientConfig.
 *
 * The function is pure (no IO, no DB, no env) so no mocking is needed.
 * We verify:
 *  - Routing rules are always present and contain the correct geo tags
 *  - VLESS outbounds are structured correctly for domain nodes and IP nodes
 *  - Multiple keys produce correct tag naming (proxy, proxy-2, proxy-3, …)
 *  - Empty outbounds produce a valid (if proxy-less) config
 *  - IP nodes with / without certSha256 get the right TLS settings
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildXrayClientConfig,
  isIpAddress,
  XRAY_TAG_BLOCKED,
  XRAY_TAG_DIRECT,
  XRAY_TAG_PROXY,
  type XrayOutboundParams,
} from "./xrayClientConfig";
import { VPN_WS_PATH } from "./vless";
import { BRAND_NAME } from "./subscription";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DOMAIN_OUTBOUND: XrayOutboundParams = {
  uuid:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  label:     "🇳🇱 NL-1",
  address:   "vpnexus.pro",
  sni:       "vpnexus.pro",
  port:      443,
  isIpNode:  false,
};

const IP_OUTBOUND_WITH_CERT: XrayOutboundParams = {
  uuid:      "11111111-2222-3333-4444-555555555555",
  label:     "🇩🇪 DE-1",
  address:   "1.2.3.4",
  sni:       "1.2.3.4",
  port:      443,
  isIpNode:  true,
  certSha256: "abc123==",
};

const IP_OUTBOUND_NO_CERT: XrayOutboundParams = {
  uuid:      "66666666-7777-8888-9999-aaaaaaaaaaaa",
  label:     "🇩🇪 DE-2",
  address:   "5.6.7.8",
  sni:       "5.6.7.8",
  port:      8443,
  isIpNode:  true,
};

// ─── isIpAddress helper ───────────────────────────────────────────────────────

describe("isIpAddress", () => {
  it("returns true for a bare IPv4 address", () => {
    expect(isIpAddress("1.2.3.4")).toBe(true);
    expect(isIpAddress("192.168.0.1")).toBe(true);
    expect(isIpAddress("255.255.255.255")).toBe(true);
  });

  it("returns false for hostnames and domains", () => {
    expect(isIpAddress("vpnexus.pro")).toBe(false);
    expect(isIpAddress("node.example.com")).toBe(false);
    expect(isIpAddress("localhost")).toBe(false);
    expect(isIpAddress("")).toBe(false);
  });
});

// ─── Top-level config structure ───────────────────────────────────────────────

describe("buildXrayClientConfig — top-level structure", () => {
  it("always includes log, remarks, outbounds, and routing", () => {
    const config = buildXrayClientConfig([]);
    expect(config).toHaveProperty("log");
    expect(config).toHaveProperty("remarks", BRAND_NAME);
    expect(config).toHaveProperty("outbounds");
    expect(config).toHaveProperty("routing");
  });

  it("always includes a freedom (direct) outbound", () => {
    const config = buildXrayClientConfig([]);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    expect(outbounds.some((o) => o.protocol === "freedom" && o.tag === XRAY_TAG_DIRECT)).toBe(true);
  });

  it("always includes a blackhole (blocked) outbound", () => {
    const config = buildXrayClientConfig([]);
    const outbounds = config.outbounds as Array<Record<string, unknown>>;
    expect(outbounds.some((o) => o.protocol === "blackhole" && o.tag === XRAY_TAG_BLOCKED)).toBe(true);
  });
});

// ─── Routing rules ────────────────────────────────────────────────────────────

describe("buildXrayClientConfig — routing rules", () => {
  it("uses IPIfNonMatch domain strategy", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { domainStrategy: string; rules: unknown[] };
    };
    expect(routing.domainStrategy).toBe("IPIfNonMatch");
  });

  it("contains a rule that sends geoip:private direct", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ ip?: string[]; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.ip?.includes("geoip:private"));
    expect(rule).toBeDefined();
    expect(rule?.outboundTag).toBe(XRAY_TAG_DIRECT);
  });

  it("does NOT use geoip:ru tag (Happ iOS ships a minimal geoip.dat that lacks the 'ru' category — causes hard start error)", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ ip?: string[] }> };
    };
    const hasGeoipRu = routing.rules.some((r) => r.ip?.includes("geoip:ru"));
    expect(hasGeoipRu).toBe(false);
  });

  it("contains a rule that sends .ru TLD direct via regexp", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ domain?: string[]; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.domain?.includes("regexp:\\.ru$"));
    expect(rule).toBeDefined();
    expect(rule?.outboundTag).toBe(XRAY_TAG_DIRECT);
  });

  it("contains a rule that sends .рф TLD (punycode) direct via regexp", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ domain?: string[]; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.domain?.includes("regexp:\\.xn--p1ai$"));
    expect(rule).toBeDefined();
    expect(rule?.outboundTag).toBe(XRAY_TAG_DIRECT);
  });

  it("contains a rule that sends yandex.com direct", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ domain?: string[]; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.domain?.includes("domain:yandex.com"));
    expect(rule).toBeDefined();
    expect(rule?.outboundTag).toBe(XRAY_TAG_DIRECT);
  });

  it("contains a rule that sends vk.com direct", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ domain?: string[]; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.domain?.includes("domain:vk.com"));
    expect(rule).toBeDefined();
    expect(rule?.outboundTag).toBe(XRAY_TAG_DIRECT);
  });

  it("does NOT use geosite: tags (incompatible with Happ 3.26.x geosite.dat)", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ domain?: string[] }> };
    };
    const allDomains = routing.rules.flatMap((r) => r.domain ?? []);
    expect(allDomains.some((d) => d.startsWith("geosite:"))).toBe(false);
  });

  it("contains a catch-all rule pointing to proxy when outbounds present", () => {
    const { routing } = buildXrayClientConfig([DOMAIN_OUTBOUND]) as {
      routing: { rules: Array<{ network?: string; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.network === "tcp,udp");
    expect(rule).toBeDefined();
    expect(rule?.outboundTag).toBe(XRAY_TAG_PROXY);
  });

  it("catch-all falls back to direct when there are no proxy outbounds", () => {
    const { routing } = buildXrayClientConfig([]) as {
      routing: { rules: Array<{ network?: string; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.network === "tcp,udp");
    expect(rule?.outboundTag).toBe(XRAY_TAG_DIRECT);
  });
});

// ─── VLESS outbound structure ─────────────────────────────────────────────────

describe("buildXrayClientConfig — VLESS outbound (domain node)", () => {
  let outbounds: Array<Record<string, unknown>>;

  beforeEach(() => {
    const config = buildXrayClientConfig([DOMAIN_OUTBOUND]);
    outbounds = (config.outbounds as Array<Record<string, unknown>>).filter(
      (o) => o.protocol === "vless",
    );
  });

  it("produces exactly one VLESS outbound for a single key", () => {
    expect(outbounds).toHaveLength(1);
  });

  it("tags the first outbound as 'proxy'", () => {
    expect(outbounds[0]?.tag).toBe(XRAY_TAG_PROXY);
  });

  it("sets the correct address, port, and uuid", () => {
    const settings = outbounds[0]?.settings as {
      vnext: Array<{ address: string; port: number; users: Array<{ id: string }> }>;
    };
    expect(settings.vnext[0]?.address).toBe(DOMAIN_OUTBOUND.address);
    expect(settings.vnext[0]?.port).toBe(DOMAIN_OUTBOUND.port);
    expect(settings.vnext[0]?.users[0]?.id).toBe(DOMAIN_OUTBOUND.uuid);
  });

  it("uses WebSocket transport", () => {
    const stream = outbounds[0]?.streamSettings as Record<string, unknown>;
    expect(stream.network).toBe("ws");
  });

  it("uses TLS security with chrome fingerprint", () => {
    const stream = outbounds[0]?.streamSettings as {
      security: string;
      tlsSettings: { serverName: string; fingerprint: string; allowInsecure: boolean };
    };
    expect(stream.security).toBe("tls");
    expect(stream.tlsSettings.serverName).toBe(DOMAIN_OUTBOUND.sni);
    expect(stream.tlsSettings.fingerprint).toBe("chrome");
    expect(stream.tlsSettings.allowInsecure).toBe(false);
  });

  it("sets the correct WebSocket path and Host header", () => {
    const stream = outbounds[0]?.streamSettings as {
      wsSettings: { path: string; headers: { Host: string } };
    };
    expect(stream.wsSettings.path).toBe(VPN_WS_PATH);
    expect(stream.wsSettings.headers.Host).toBe(DOMAIN_OUTBOUND.sni);
  });

  it("preserves a canary session ID in the WebSocket path when supplied", () => {
    const config = buildXrayClientConfig([
      { ...DOMAIN_OUTBOUND, wsPath: "/vpnws?sid=abcdefghijklmnopqrstuvwxyz012345" },
    ]);
    const vlessOutbound = (config.outbounds as Array<Record<string, unknown>>).find(
      (outbound) => outbound.protocol === "vless",
    );
    const stream = vlessOutbound?.streamSettings as {
      wsSettings: { path: string };
    };

    expect(stream.wsSettings.path).toBe("/vpnws?sid=abcdefghijklmnopqrstuvwxyz012345");
  });
});

// ─── IP node TLS handling ─────────────────────────────────────────────────────

describe("buildXrayClientConfig — IP node with certSha256", () => {
  it("uses pinnedPeerCertificate256 instead of allowInsecure", () => {
    const config = buildXrayClientConfig([IP_OUTBOUND_WITH_CERT]);
    const outbounds = (config.outbounds as Array<Record<string, unknown>>).filter(
      (o) => o.protocol === "vless",
    );
    const tls = (outbounds[0]?.streamSettings as { tlsSettings: Record<string, unknown> })
      .tlsSettings;
    expect(tls.pinnedPeerCertificate256).toBe(IP_OUTBOUND_WITH_CERT.certSha256);
    expect(tls.allowInsecure).toBe(false);
  });
});

describe("buildXrayClientConfig — IP node without certSha256", () => {
  it("falls back to allowInsecure: true", () => {
    const config = buildXrayClientConfig([IP_OUTBOUND_NO_CERT]);
    const outbounds = (config.outbounds as Array<Record<string, unknown>>).filter(
      (o) => o.protocol === "vless",
    );
    const tls = (outbounds[0]?.streamSettings as { tlsSettings: Record<string, unknown> })
      .tlsSettings;
    expect(tls.allowInsecure).toBe(true);
    expect(tls.pinnedPeerCertificate256).toBeUndefined();
  });
});

// ─── Multiple outbounds ───────────────────────────────────────────────────────

describe("buildXrayClientConfig — multiple outbounds", () => {
  const THREE = [DOMAIN_OUTBOUND, IP_OUTBOUND_WITH_CERT, IP_OUTBOUND_NO_CERT];

  it("produces the correct number of VLESS outbounds", () => {
    const config = buildXrayClientConfig(THREE);
    const vless = (config.outbounds as Array<Record<string, unknown>>).filter(
      (o) => o.protocol === "vless",
    );
    expect(vless).toHaveLength(3);
  });

  it("tags them proxy, proxy-2, proxy-3", () => {
    const config = buildXrayClientConfig(THREE);
    const tags = (config.outbounds as Array<Record<string, unknown>>)
      .filter((o) => o.protocol === "vless")
      .map((o) => o.tag);
    expect(tags).toEqual([XRAY_TAG_PROXY, "proxy-2", "proxy-3"]);
  });

  it("catch-all still points to proxy (the first outbound)", () => {
    const { routing } = buildXrayClientConfig(THREE) as {
      routing: { rules: Array<{ network?: string; outboundTag: string }> };
    };
    const rule = routing.rules.find((r) => r.network === "tcp,udp");
    expect(rule?.outboundTag).toBe(XRAY_TAG_PROXY);
  });
});
