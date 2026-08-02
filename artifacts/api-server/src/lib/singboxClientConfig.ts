/**
 * Builds a Sing-box client JSON configuration with:
 *  - A `selector` outbound that lets the user pick between their devices
 *    (Happ shows this as an interactive dropdown if it supports sing-box)
 *  - Automatic Russian-bypass routing rules (mirrors xrayClientConfig.ts logic)
 *
 * This is a TEST / EXPERIMENTAL format to verify whether Happ renders the
 * `selector` outbound as a per-device choice UI.  If the test passes, this
 * module will be promoted to production.
 *
 * Differences from Xray JSON (xrayClientConfig.ts):
 *  - `type` instead of `protocol` for outbounds
 *  - Sing-box TLS / transport schema (utls, not fingerprint at top level)
 *  - `selector` outbound wraps all nodes — user can switch between them
 *  - `route.final` instead of a catch-all rule
 *  - geoip/domain rule syntax uses sing-box fields (geoip, domain_suffix, domain)
 */

import { VPN_WS_PATH } from "./vless";
import { BRAND_NAME } from "./subscription";
import type { XrayOutboundParams } from "./xrayClientConfig";

// Re-export the same param type — the data shape is identical.
export type SingboxOutboundParams = XrayOutboundParams;

const SELECTOR_TAG = BRAND_NAME; // shown as the server name in Happ

/**
 * Returns a plain-JS object representing a valid Sing-box client config.
 *
 * @param outbounds - One entry per active VPN key.
 * @param options.remarks - Label used for the selector tag / profile title.
 */
export function buildSingboxClientConfig(
  outbounds: SingboxOutboundParams[],
  options?: { remarks?: string },
): Record<string, unknown> {
  const selectorTag = options?.remarks ?? SELECTOR_TAG;
  const nodeTags    = outbounds.map((p) => p.label);

  const nodeOutbounds = outbounds.map((p) => buildSingboxVlessOutbound(p));

  return {
    log: { level: "warn" },

    outbounds: [
      // ── Selector (interactive device picker) ─────────────────────────────
      // Happ/Hiddify renders this as a dropdown on the Proxy tab if the
      // sing-box engine is active and the client supports selector UI.
      {
        type:                        "selector",
        tag:                         selectorTag,
        outbounds:                   nodeTags.length > 0 ? nodeTags : ["direct"],
        default:                     nodeTags[0] ?? "direct",
        interrupt_exist_connections: false,
      },

      // ── Per-device VLESS nodes ────────────────────────────────────────────
      ...nodeOutbounds,

      // ── Utility outbounds ─────────────────────────────────────────────────
      { type: "direct", tag: "direct" },
      { type: "block",  tag: "block"  },
    ],

    route: {
      rules: [
        // 1. Local / private networks — always direct
        { ip_is_private: true, outbound: "direct" },

        // 2. Russian IP ranges
        { geoip: ["ru"], outbound: "direct" },

        // 3. Russian TLDs — .ru and .рф (Punycode: .xn--p1ai)
        {
          domain_suffix: [".ru", ".xn--p1ai"],
          outbound: "direct",
        },

        // 4. Major Russian services on non-.ru domains
        {
          domain: ["yandex.com", "yandex.net", "vk.com", "vk.me"],
          outbound: "direct",
        },
      ],

      // Everything else → selector (user picks which device to route through)
      final: selectorTag,

      auto_detect_interface: true,
    },
  };
}

// ─── Internal helper ──────────────────────────────────────────────────────────

function buildSingboxVlessOutbound(
  params: SingboxOutboundParams,
): Record<string, unknown> {
  const tls: Record<string, unknown> = {
    enabled:     true,
    server_name: params.sni,
    utls:        { enabled: true, fingerprint: "chrome" },
  };

  if (params.isIpNode) {
    // Sing-box doesn't support SHA-256 pinning the same way Xray does;
    // fall back to insecure for IP nodes (mirrors xrayClientConfig.ts).
    tls.insecure = true;
  }

  return {
    type:        "vless",
    tag:         params.label,
    server:      params.address,
    server_port: params.port,
    uuid:        params.uuid,
    tls,
    transport: {
      type:    "ws",
      path:    VPN_WS_PATH,
      headers: { Host: params.sni },
    },
  };
}
