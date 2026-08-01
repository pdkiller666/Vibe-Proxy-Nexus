/**
 * Builds a client-side Xray JSON configuration with automatic Russian-bypass
 * routing rules.
 *
 * The config contains:
 *  - One VLESS outbound per user key (first tagged "proxy", rest "proxy-N")
 *  - A freedom outbound ("direct") for traffic that should bypass the tunnel
 *  - A blackhole outbound ("blocked") for explicitly-blocked traffic
 *  - Routing rules that transparently send Russian IPs/domains direct so that
 *    domestic apps (banking, government portals, etc.) work without any
 *    manual split-tunneling configuration by the user.
 *
 * Geo databases (geoip.dat / geosite.dat) are NOT bundled here — clients such
 * as Happ and v2rayN download and manage them automatically using the community
 * Loyalsoldier/v2ray-rules-dat releases. The generated config only *references*
 * geoip:ru / geosite:ru tags; the client resolves them against its local copy.
 */

import { VPN_WS_PATH } from "./vless";
import { BRAND_NAME } from "./subscription";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface XrayOutboundParams {
  /** Xray client UUID for this key. */
  uuid: string;
  /** Human-readable label (may include flag emoji). */
  label: string;
  /** Resolved host/IP to connect to (may differ from node.host after domain failover). */
  address: string;
  /** TLS SNI value. */
  sni: string;
  /** TCP port (typically 443). */
  port: number;
  /**
   * When the node has a bare IP address rather than a domain name, TLS
   * verification must be handled specially (pinned cert or allow-insecure).
   */
  isIpNode: boolean;
  /**
   * SHA-256 of the server's DER-encoded TLS certificate, base64-encoded.
   * Required when isIpNode is true AND the client supports pinnedPeerCertificate256.
   * If absent for an IP node, allowInsecure falls back to true.
   */
  certSha256?: string | null;
}

// ─── Internal constants ───────────────────────────────────────────────────────

export const XRAY_TAG_PROXY   = "proxy";
export const XRAY_TAG_DIRECT  = "direct";
export const XRAY_TAG_BLOCKED = "blocked";

/** Regex that matches bare IPv4 addresses (e.g. "1.2.3.4"). Mirrors vless.ts. */
export function isIpAddress(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Returns a plain-JS object representing a valid Xray client config.
 * Callers are responsible for JSON-serialising it and setting the correct
 * Content-Type header.
 *
 * @param outbounds - One entry per active VPN key. Passing an empty array
 *   returns a config with no proxy outbounds; the catch-all routing rule falls
 *   back to "direct" so the config remains valid (though useless as a proxy).
 */
export function buildXrayClientConfig(
  outbounds: XrayOutboundParams[],
): Record<string, unknown> {
  const vlessOutbounds = outbounds.map((params, i) =>
    buildVlessOutbound(params, i === 0 ? XRAY_TAG_PROXY : `proxy-${i + 1}`),
  );

  // When there are no proxy outbounds the catch-all rule must not reference
  // a non-existent tag, so we fall back to "direct".
  const catchAllTag = outbounds.length > 0 ? XRAY_TAG_PROXY : XRAY_TAG_DIRECT;

  return {
    log:     { loglevel: "warning" },
    remarks: BRAND_NAME,
    outbounds: [
      ...vlessOutbounds,
      { protocol: "freedom",   tag: XRAY_TAG_DIRECT  },
      { protocol: "blackhole", tag: XRAY_TAG_BLOCKED  },
    ],
    routing: {
      // IPIfNonMatch: resolve domain to IP only when no domain rule matches,
      // minimising extra DNS lookups for the common case.
      domainStrategy: "IPIfNonMatch",
      rules: [
        // 1. Local / RFC-1918 networks — always direct
        {
          type:        "field",
          ip:          ["geoip:private"],
          outboundTag: XRAY_TAG_DIRECT,
        },
        // 2. Russian IP ranges — direct so domestic banking/gov apps work
        {
          type:        "field",
          ip:          ["geoip:ru"],
          outboundTag: XRAY_TAG_DIRECT,
        },
        // 3. Russian domains — direct (no geosite.dat required)
        //    regexp:\\.ru$       catches all .ru TLD (Сбербанк, Госуслуги, …)
        //    regexp:\\.xn--p1ai$ catches .рф TLD (punycode form Xray expects)
        //    Explicit domain: entries cover major Russian services that operate
        //    on international domains (yandex.com, vk.com) not in .ru TLD.
        //
        //    geosite:ru/yandex/mailru intentionally removed — Happ 3.26.x ships
        //    a geosite.dat without the RU category, causing a hard start error.
        {
          type:   "field",
          domain: [
            "regexp:\\.ru$",
            "regexp:\\.xn--p1ai$",
            "domain:yandex.com",
            "domain:yandex.net",
            "domain:vk.com",
            "domain:vk.me",
          ],
          outboundTag: XRAY_TAG_DIRECT,
        },
        // 4. Everything else → tunnel
        {
          type:        "field",
          network:     "tcp,udp",
          outboundTag: catchAllTag,
        },
      ],
    },
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildVlessOutbound(
  params: XrayOutboundParams,
  tag: string,
): Record<string, unknown> {
  const tlsSettings: Record<string, unknown> = {
    serverName:   params.sni,
    fingerprint:  "chrome",
    allowInsecure: false,
  };

  if (params.isIpNode) {
    if (params.certSha256) {
      // Prefer explicit certificate pinning — more secure than allow-insecure.
      tlsSettings.pinnedPeerCertificate256 = params.certSha256;
    } else {
      // No cert available: fall back to insecure.  Mirrors vless.ts behaviour.
      tlsSettings.allowInsecure = true;
    }
  }

  return {
    protocol: "vless",
    tag,
    settings: {
      vnext: [
        {
          address: params.address,
          port:    params.port,
          users:   [{ id: params.uuid, encryption: "none" }],
        },
      ],
    },
    streamSettings: {
      network:  "ws",
      security: "tls",
      tlsSettings,
      wsSettings: {
        path:    VPN_WS_PATH,
        headers: { Host: params.sni },
      },
    },
  };
}
