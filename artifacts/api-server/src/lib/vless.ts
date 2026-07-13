import { randomUUID } from "crypto";
import type { VpnNode } from "@workspace/db";
import { resolvePublicAddress } from "./domain";

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

/**
 * Maps a node to a flag emoji Happ can render as the server-row icon. Happ
 * only shows a custom icon when the server name's *first* character is a
 * flag emoji (see .agents/memory — Happ client only supports flag emoji as
 * a custom row icon, nothing else); anything unmapped here falls back to
 * Happ's default generic globe icon, which is safe and matches prior
 * behavior.
 *
 * The admin-entered `region` field is free text and often just a coarse
 * label like "EU" (not the actual country), so this also checks the node's
 * technical host/SNI: Amvera's own hostnames encode the datacenter with an
 * IATA-style airport code (our current node is on `waw0.amvera.tech` —
 * "WAW" = Warsaw), which is a more reliable per-node location signal than
 * the region field alone.
 *
 * Extend this list as nodes are added in new countries.
 */
const LOCATION_FLAG_RULES: Array<{ match: RegExp; flag: string }> = [
  { match: /poland|польш|warsaw|варшав|warszawa|\bwaw\d*\b|^pl$/i, flag: "🇵🇱" },
];

export function flagEmojiForNode(
  node: Pick<VpnNode, "region" | "host" | "sni">,
): string | undefined {
  const haystack = [node.region, node.host, node.sni]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!haystack) return undefined;
  return LOCATION_FLAG_RULES.find((rule) => rule.match.test(haystack))?.flag;
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
export function buildVlessLink(
  node: VpnNode,
  uuid: string,
  label: string,
): string {
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

  const flag = flagEmojiForNode(node);
  const fragment = flag ? `${flag} ${label}` : label;

  return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(fragment)}`;
}

/**
 * Same as buildVlessLink, but for links actually handed to a user/client
 * (subscription body, "me" key list): swaps in the primary public domain
 * (vpnexus.pro) when it's healthy, otherwise keeps the node's own technical
 * Amvera host/SNI. The persisted `vlessLink` column always uses the raw node
 * address (see buildVlessLink call sites in keyIssuance.ts / admin/vpnKeys.ts)
 * so this never needs to "unwind" a baked-in domain choice.
 */
export async function buildServingVlessLink(
  node: VpnNode,
  uuid: string,
  label: string,
): Promise<string> {
  const address = await resolvePublicAddress({
    host: node.host || node.sni,
    sni: node.sni,
  });
  // Detect the location flag from the node's real technical host/SNI
  // (e.g. "waw0.amvera.tech") BEFORE swapping in the branded public domain
  // below — otherwise the flag lookup would only ever see "vpnexus.pro",
  // which carries no location signal at all.
  const flag = flagEmojiForNode(node);
  const flaggedLabel = flag ? `${flag} ${label}` : label;
  return buildVlessLink(
    { ...node, host: address.host, sni: address.sni },
    uuid,
    flaggedLabel,
  );
}

export function buildDeepLink(vlessLink: string): string {
  return vlessLink;
}
