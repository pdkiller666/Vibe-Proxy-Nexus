/**
 * Builds a client-side Sing-box JSON configuration with Russian-bypass routing
 * rules. Used by the subscription endpoint (?format=singbox) for iOS VPN
 * clients (e.g. Happ on iOS) that run on a Sing-box core and cannot parse
 * Xray-specific routing/DNS syntax.
 *
 * Design:
 *  - One VLESS outbound for the user's key (VLESS + WebSocket + TLS, same
 *    transport as the Xray config so the same server handles both).
 *  - A "direct" outbound for bypassed traffic.
 *  - A "block" outbound (safety valve).
 *  - Route rules that send Russian domains (.ru, .xn--p1ai / .рф, and popular
 *    Russian services on non-.ru TLDs) straight through without the tunnel.
 *  - Catch-all final rule routes everything else via the proxy.
 *
 * Geo databases are NOT used: Sing-box on iOS clients (Happ) bundles its own
 * geoip/geosite data whose availability varies by version — relying on them
 * would silently break on devices that have an old or missing DB. Plain
 * domain_suffix + domain rules are completely self-contained.
 */

import { VPN_WS_PATH } from "./vless";
import { BRAND_NAME } from "./subscription";

// ─── Public types (mirrors XrayOutboundParams shape) ─────────────────────────

export interface SingboxOutboundParams {
  uuid:       string;
  label:      string;
  address:    string;
  sni:        string;
  port:       number;
  isIpNode:   boolean;
  /** SHA-256 of server TLS cert (base64). Only used to detect IP nodes; Sing-box
   *  does not support cert-pinning in its config — insecure falls back instead. */
  certSha256?: string | null;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Returns a plain-JS object representing a valid Sing-box client config.
 * Callers should JSON-serialise and set Content-Type: application/json.
 *
 * @param params   Single outbound params (one VPN key → one proxy outbound).
 * @param remarks  Optional label shown as the server/group name in the client.
 */
export function buildSingboxClientConfig(
  params: SingboxOutboundParams,
  options?: { remarks?: string },
): Record<string, unknown> {
  const label = options?.remarks ?? params.label ?? BRAND_NAME;

  return {
    log: {
      level:     "warn",
      timestamp: true,
    },

    // ── Outbounds ────────────────────────────────────────────────────────────
    outbounds: [
      buildVlessOutbound(params, label),
      { type: "direct", tag: "direct" },
      { type: "block",  tag: "block"  },
    ],

    // ── Route ────────────────────────────────────────────────────────────────
    route: {
      rules: [
        // 1. RFC-1918 / loopback — always direct
        {
          ip_is_private: true,
          outbound: "direct",
        },

        // 2. Russian TLDs (.ru and .рф in punycode) — direct
        //    domain_suffix matches the domain itself and all its subdomains,
        //    so ".ru" catches both "sberbank.ru" and "online.sberbank.ru".
        {
          domain_suffix: [".ru", ".xn--p1ai"],
          outbound: "direct",
        },

        // 3. Popular Russian services on non-.ru domains — direct
        //    (Yandex, VK operate on international TLDs and must also bypass)
        {
          domain: [
            "yandex.com",
            "yandex.net",
            "vk.com",
            "vk.me",
          ],
          outbound: "direct",
        },
      ],

      // Everything else → tunnel via the VLESS proxy
      final: "proxy",
    },
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildVlessOutbound(
  params: SingboxOutboundParams,
  tag: string,
): Record<string, unknown> {
  const tls: Record<string, unknown> = {
    enabled:     true,
    server_name: params.sni,
    utls: {
      enabled:     true,
      fingerprint: "chrome",
    },
  };

  // IP-addressed nodes have self-signed certs.  Sing-box does not support
  // explicit cert-pinning in its JSON config (unlike Xray), so we set
  // insecure = true as a fallback — the same path Happ takes for VLESS URIs
  // that include allowInsecure=1.
  if (params.isIpNode) {
    tls.insecure = true;
  }

  return {
    type:        "vless",
    tag:         "proxy",
    server:      params.address,
    server_port: params.port,
    uuid:        params.uuid,
    transport: {
      type: "ws",
      path: VPN_WS_PATH,
      headers: {
        Host: params.sni,
      },
    },
    tls,
  };
}
