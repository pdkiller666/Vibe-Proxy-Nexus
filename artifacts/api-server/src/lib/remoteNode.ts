/**
 * HTTP client helpers for the remote-node Management REST API.
 *
 * The remote node runs `deploy/amvera-vpn-node/bot/api_server.py`, which
 * exposes POST /clients, GET /clients, DELETE /clients/{uuid}, and GET /stats.
 *
 * All call sites must guard with `node.managementApiUrl != null` before
 * calling these functions — the local Amvera node has managementApiUrl = null
 * and is managed via the local Xray disk config instead (see xray.ts).
 */
import type { VpnNode } from "@workspace/db";
import { logger } from "./logger";

export interface RemoteNodePollHealth {
  nodeName: string;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
}

/**
 * Per-node polling health state, keyed by node name. Tracked in memory (not DB)
 * for the same reason as the global trafficPollingHealth — this is about the
 * liveness of the background job, not user data. Exported for the admin health
 * endpoint (GET /admin/health/traffic-polling).
 */
export const remoteNodePollingHealth = new Map<string, RemoteNodePollHealth>();

export type RemoteNodeRef = Pick<VpnNode, "managementApiUrl" | "managementApiSecret" | "name">;

const REMOTE_FETCH_TIMEOUT_MS = 15_000;

export interface RemoteXrayClient {
  uuid: string;
  label: string | null;
  limitIp: number | null;
}

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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REMOTE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, headers, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Adds a VLESS client to a remote node via POST /clients.
 * Throws on HTTP error — callers must catch and compensate (revoke DB row).
 */
export async function addRemoteXrayClient(
  node: RemoteNodeRef,
  uuid: string,
  label: string,
  limitIp?: number,
): Promise<void> {
  const body: Record<string, unknown> = { uuid, label };
  if (limitIp !== undefined) body.limitIp = limitIp;
  const res = await remoteNodeFetch(node, "/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
 * Lists the clients currently present in a remote node's Xray config.
 *
 * The management API returns Xray client objects with `id` and `email`
 * properties. Keep the normalized shape here so reconciliation does not
 * depend on the remote node's config field names.
 */
export async function listRemoteXrayClients(node: RemoteNodeRef): Promise<RemoteXrayClient[]> {
  const res = await remoteNodeFetch(node, "/clients", { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Remote node ${node.name}: HTTP ${res.status} on GET /clients: ${text}`);
  }

  const raw = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error(`Remote node ${node.name}: invalid response from GET /clients`);
  }

  const clients: RemoteXrayClient[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Remote node ${node.name}: invalid client entry from GET /clients`);
    }
    const record = entry as Record<string, unknown>;
    const rawUuid = typeof record.id === "string"
      ? record.id
      : typeof record.uuid === "string"
        ? record.uuid
        : null;
    const uuid = rawUuid?.trim();
    if (!uuid) {
      throw new Error(`Remote node ${node.name}: client entry has no UUID`);
    }

    clients.push({
      uuid,
      label: typeof record.email === "string"
        ? record.email
        : typeof record.label === "string"
          ? record.label
          : null,
      limitIp: typeof record.limitIp === "number" ? record.limitIp : null,
    });
  }
  return clients;
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

  // Ensure a health entry exists for this node before the attempt.
  if (!remoteNodePollingHealth.has(node.name)) {
    remoteNodePollingHealth.set(node.name, {
      nodeName: node.name,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      lastError: null,
    });
  }
  const health = remoteNodePollingHealth.get(node.name)!;

  try {
    const res = await remoteNodeFetch(node, "/stats", { method: "GET" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn({ nodeName: node.name, status: res.status, text }, "pollRemoteNodeStats: HTTP error");
      health.consecutiveFailures += 1;
      health.lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
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
    // Success — reset failure counters.
    health.lastSuccessAt = new Date();
    health.consecutiveFailures = 0;
    health.lastError = null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, nodeName: node.name }, "pollRemoteNodeStats: failed to fetch /stats");
    health.consecutiveFailures += 1;
    health.lastError = msg.slice(0, 200);
  }
  return counters;
}
