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
 * Builds a VLESS + TLS connection URI for a given node + client UUID.
 *
 * Amvera's edge (Traefik) always terminates TLS with a real Let's Encrypt
 * certificate for the node's domain and forwards the decrypted TCP stream to
 * the container, so we ride on top of that TLS instead of using Reality (which
 * requires owning the raw TLS handshake and is therefore incompatible with
 * Amvera's TLS termination — see .agents/memory/amvera-raw-tcp-port.md). The
 * client speaks plain VLESS over the TLS tunnel Amvera provides; Xray inside
 * the container listens for plain VLESS (security "none").
 */
export function buildVlessLink(node: VpnNode, uuid: string, label: string): string {
  const host = node.host || node.sni;
  const port = node.port ?? 443;
  const params = new URLSearchParams({
    type: "tcp",
    security: "tls",
    sni: node.sni,
    fp: "chrome",
    encryption: "none",
  });

  return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(label)}`;
}

export function buildDeepLink(vlessLink: string): string {
  return vlessLink;
}
