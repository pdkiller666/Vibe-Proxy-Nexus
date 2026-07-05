import { randomUUID } from "crypto";
import type { VpnNode } from "@workspace/db";

/**
 * WebSocket path that Xray listens on inside the container and that the Node
 * web server proxies to the local Xray instance. Must stay in sync with:
 *   - deploy/amvera-all-in-one/xray-config.json.template (wsSettings.path)
 *   - artifacts/api-server/src/index.ts (upgrade proxy)
 */
export const VPN_WS_PATH = "/vpnws";

export function generateKeyUuid(): string {
  return randomUUID();
}

export function generatePaymentReference(subscriptionId: number): string {
  const suffix = randomUUID().split("-")[0]?.toUpperCase() ?? "0000";
  return `VPN-${subscriptionId}-${suffix}`;
}

/**
 * Builds a VLESS + WebSocket + TLS connection URI for a given node + client
 * UUID.
 *
 * Amvera's edge (Traefik) always terminates TLS with a real Let's Encrypt
 * certificate for the node's domain. Raw-TCP VLESS through Amvera's TCP ("MONGO")
 * ingress does NOT work: that controller treats the TLS-terminated stream as
 * HTTP (via ALPN) and returns plaintext, corrupting a raw VLESS payload — and
 * Reality is fundamentally incompatible with edge TLS termination anyway (see
 * .agents/memory/amvera-raw-tcp-port.md).
 *
 * The elegant, robust solution is VLESS over WebSocket on the normal HTTPS web
 * domain: the WS upgrade is legitimate HTTP, so Traefik forwards it cleanly to
 * the container, where the Node server proxies the upgrade to a local Xray
 * WebSocket inbound (security "none"). Clients connect with security=tls +
 * sni=<web domain> + type=ws + path=<VPN_WS_PATH> and speak VLESS over that
 * standard HTTPS/WebSocket tunnel.
 */
export function buildVlessLink(node: VpnNode, uuid: string, label: string): string {
  const host = node.host || node.sni;
  const port = node.port ?? 443;
  const params = new URLSearchParams({
    type: "ws",
    security: "tls",
    sni: node.sni,
    fp: "chrome",
    host: node.sni,
    path: VPN_WS_PATH,
    encryption: "none",
  });

  return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(label)}`;
}

export function buildDeepLink(vlessLink: string): string {
  return vlessLink;
}
