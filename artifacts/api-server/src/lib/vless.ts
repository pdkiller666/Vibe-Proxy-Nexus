import { randomUUID } from "crypto";
import type { VpnNode } from "@workspace/db";

export function generateKeyUuid(): string {
  return randomUUID();
}

export function generatePaymentReference(subscriptionId: number): string {
  const suffix = randomUUID().split("-")[0]?.toUpperCase() ?? "0000";
  return `VPN-${subscriptionId}-${suffix}`;
}

/**
 * Builds a VLESS-XTLS-Reality connection URI for a given node + client UUID.
 *
 * NOTE: Until a real Xray-core node (see deploy/amvera-vpn-node) is deployed and
 * this node's connection details are filled in via the admin panel, the link is
 * syntactically valid but not connectable — there is no live Reality endpoint
 * behind it yet.
 */
export function buildVlessLink(node: VpnNode, uuid: string, label: string): string {
  const host = node.host || node.sni;
  const port = 443;
  const params = new URLSearchParams({
    type: "tcp",
    security: "reality",
    pbk: node.publicKey ?? "",
    fp: "chrome",
    sni: node.sni,
    sid: node.shortId ?? "",
    flow: "xtls-rprx-vision",
  });

  return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(label)}`;
}

export function buildDeepLink(vlessLink: string): string {
  return vlessLink;
}
