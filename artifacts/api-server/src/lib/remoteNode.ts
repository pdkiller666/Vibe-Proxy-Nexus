/**
 * HTTP client helpers for the remote-node Management REST API.
 *
 * The remote node runs `deploy/amvera-vpn-node/bot/api_server.py`, which
 * exposes POST /clients, DELETE /clients/{uuid}, and GET /stats.
 *
 * All call sites must guard with `node.managementApiUrl != null` before
 * calling these functions — the local Amvera node has managementApiUrl = null
 * and is managed via the local Xray disk config instead (see xray.ts).
 */
import type { VpnNode } from "@workspace/db";
import { logger } from "./logger";

export type RemoteNodeRef = Pick<VpnNode, "managementApiUrl" | "managementApiSecret" | "name">;

async function remoteNodeFetch(
  node: RemoteNodeRef,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${node.managementApiUrl}${path}`;
  const headers = new Headers(options.headers as Record<string, string> | [string, string][] | Headers | undefined);
  if (node.managementApiSecret) {
    headers.set("X-Management-Secret", node.managementApiSecret);
  }
  return fetch(url, { ...options, headers });
}

/**
 * Adds a VLESS client to a remote node via POST /clients.
 * Throws on HTTP error — callers must catch and compensate (revoke DB row).
 */
export async function addRemoteXrayClient(
  node: RemoteNodeRef,
  uuid: string,
  label: string,
): Promise<void> {
  const res = await remoteNodeFetch(node, "/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uuid, label }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Remote node ${node.name}: HTTP ${res.status} on POST /clients: ${text}`);
  }
}

/**
 * Removes a VLESS client from a remote node via DELETE /clients/{uuid}.
 * 404 is treated as idempotent success (already removed).
 * Throws on other HTTP errors — callers decide whether to surface or swallow.
 */
export async function removeRemoteXrayClient(
  node: RemoteNodeRef,
  uuid: string,
): Promise<void> {
  const res = await remoteNodeFetch(node, `/clients/${uuid}`, { method: "DELETE" });
  if (res.status === 404) return; // already gone — idempotent
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Remote node ${node.name}: HTTP ${res.status} on DELETE /clients/${uuid}: ${text}`);
  }
}

/**
 * Polls per-UUID traffic counters from a remote node's GET /stats endpoint.
 *
 * The remote node uses reset:false semantics (absolute cumulative byte counts),
 * identical to the local Xray gRPC flow in xrayStats.ts. The returned Map is
 * therefore compatible with applyTrafficDeltas(), which computes deltas against
 * lastSeen stored in the DB — no special handling for remote nodes is needed.
 *
 * Returns an empty map on network/HTTP error (non-fatal: the next poll will
 * accumulate the missed bytes, same as a local Xray restart).
 */
export async function pollRemoteNodeStats(
  node: RemoteNodeRef,
): Promise<Map<string, { uplinkBytes: number; downlinkBytes: number }>> {
  const counters = new Map<string, { uplinkBytes: number; downlinkBytes: number }>();
  try {
    const res = await remoteNodeFetch(node, "/stats", { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn({ nodeName: node.name, status: res.status, text }, "pollRemoteNodeStats: HTTP error");
      return counters;
    }
    const raw = (await res.json()) as Array<{
      uuid: string;
      uplinkBytes: number;
      downlinkBytes: number;
    }>;
    for (const entry of raw) {
      if (!entry.uuid) continue;
      counters.set(entry.uuid, {
        uplinkBytes: Number(entry.uplinkBytes) || 0,
        downlinkBytes: Number(entry.downlinkBytes) || 0,
      });
    }
  } catch (err) {
    logger.error({ err, nodeName: node.name }, "pollRemoteNodeStats: failed to fetch /stats");
  }
  return counters;
}
