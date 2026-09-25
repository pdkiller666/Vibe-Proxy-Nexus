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
  // Note: use \bXX\b (word boundary) NOT ^XX$ for two-letter codes — the haystack
  // is a joined multi-word string ("nl 87.199.200.19 87.199.200.19"), so ^...$ anchors
  // never match when there are additional tokens in the string.
  { match: /poland|польш|warsaw|варшав|warszawa|\bwaw\d*\b|\bpl\b/i, flag: "🇵🇱" },
  // Note: "vdsina" removed — VDSina is a multi-country hosting provider, not
  // a Russia indicator. Use the node's `region` field (e.g. "ru") or its
  // Amvera/technical hostname (e.g. "mow0.amvera.tech") to detect Russian nodes.
  { match: /russia|россия|moscow|москв|\bmow\d*\b|\bru\b/i,  flag: "🇷🇺" },
  { match: /germany|германия|frankfurt|франкфурт|berlin|берлин|hetzner|\bde\b/i, flag: "🇩🇪" },
  { match: /netherlands|нидерланды|amsterdam|амстердам|\bnl\b/i,    flag: "🇳🇱" },
  { match: /finland|финляндия|helsinki|хельсинки|\bfi\b/i,          flag: "🇫🇮" },
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
 * Builds the client URI for a node's explicitly configured transport.
 *
 * WS+TLS remains the default and is used by the local Amvera node. Reality is
 * only supported on a remote VPS with raw TCP; node validation and node-side
 * config keep it away from Amvera's TLS-terminating ingress.
 */
/** Returns true for bare IPv4 addresses (e.g. "1.2.3.4"). */
function isIpAddress(value: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(value);
}

export function buildVlessLink(
  node: VpnNode,
  uuid: string,
  label: string,
): string {
  const host = node.host || node.sni;
  const port = node.port ?? 443;

  // Self-signed certificates are used when the node has no real domain (bare IP).
  // Older Xray cores used `allowInsecure=1`; newer cores (Xray 26+, used by Happ
  // 2.17+) removed that parameter and require `pinnedPeerCertSha256` (SHA256 of
  // the server's DER-encoded TLS certificate, in base64) instead.
  //
  // When the node has a `certSha256` stored (admin-entered after running
  // `openssl s_client … | openssl x509 -outform DER | openssl dgst -sha256 -binary | base64`),
  // we emit `pinnedPeerCertSha256`. If that field is absent we fall back to
  // `allowInsecure=1` so older clients and non-Happ apps keep working.
  const isIpNode = isIpAddress(host) || isIpAddress(node.sni);
  const certSha256 = "certSha256" in node ? (node as { certSha256: string | null }).certSha256 : null;

  let params: URLSearchParams;
  if (node.transport === "reality") {
    if (!node.publicKey || !node.shortId) {
      throw new Error(`Reality node "${node.name}" is missing its public key or short ID`);
    }
    params = new URLSearchParams({
      type: "tcp",
      security: "reality",
      sni: node.sni,
      fp: "chrome",
      pbk: node.publicKey,
      sid: node.shortId,
      flow: "xtls-rprx-vision",
      encryption: "none",
    });
  } else {
    params = new URLSearchParams({
      type: "ws",
      security: "tls",
      sni: node.sni,
      fp: "chrome",
      host: node.sni,
      path: VPN_WS_PATH,
      encryption: "none",
      ...(isIpNode && certSha256 ? { pinnedPeerCertSha256: certSha256 } : {}),
      ...(isIpNode && !certSha256 ? { allowInsecure: "1" } : {}),
    });
  }

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
  // Domain failover (vpnexus.pro ↔ technical Amvera domain) is only meaningful
  // for the LOCAL Amvera node — both domains resolve to the same Amvera edge.
  //
  // Remote VPS nodes have their own IP/host and must NEVER be redirected to
  // vpnexus.pro: that would send the client to the Amvera server instead of
  // the VPS, and Amvera's Xray doesn't know the UUID → traffic silently drops
  // while the client shows "connected".
  //
  // Local node = managementApiUrl IS NULL (no external management API).
  const isLocalNode = !node.managementApiUrl;

  const address = isLocalNode
    ? await resolvePublicAddress({ host: node.host || node.sni, sni: node.sni })
    : { host: node.host || node.sni, sni: node.sni };

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
