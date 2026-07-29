/**
 * Background job that periodically checks the health and resource usage of all
 * active VPN nodes and writes SystemEvents when something is wrong.
 *
 * Two alert types are emitted:
 *  - "node_overloaded"   — CPU > 90% or RAM > 90% on a single poll
 *  - "node_unavailable"  — node failed to respond 3 polls in a row
 *
 * Both are deduplicated: a new event is only inserted when there is no
 * existing unacknowledged event of the same type for the same node, so the
 * notification bell doesn't flood after the first alert.
 *
 * Recovery: once a node comes back up after being "unavailable", a
 * "node_recovered" event is written so the admin knows it resolved itself.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import os from "node:os";
import { promises as fs } from "node:fs";
import { jobsDb, systemEventsTable, vpnNodesTable } from "@workspace/db";
import { logger } from "./logger";

const NODE_MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const CPU_THRESHOLD_PERCENT = 90;
const RAM_THRESHOLD_PERCENT = 90;
const FAILURE_ALERT_THRESHOLD = 3;

interface SystemStatus {
  cpuPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
}

// Per-node in-memory state. Reset on process restart (intentional — a
// restarted process re-probes from scratch; old "unavailable" counters are
// stale anyway since we don't know what happened while we were down).
const consecutiveFailures = new Map<number, number>();
// Track which nodes we most recently reported as "unavailable", so we know
// when to emit a "node_recovered" event on the next successful poll.
const reportedUnavailable = new Set<number>();

// ─── Status fetchers ──────────────────────────────────────────────────────────

async function getLocalSystemStatus(): Promise<SystemStatus> {
  const loadAvg1m = os.loadavg()[0];
  const cpuCount = os.cpus().length;
  const cpuPercent = Math.min(100, Math.round((loadAvg1m / cpuCount) * 1000) / 10);

  const memInfo = await fs.readFile("/proc/meminfo", "utf8").catch(() => "");
  const getValue = (key: string) => {
    const m = memInfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1]) * 1024 : 0;
  };
  const ramTotalBytes = getValue("MemTotal");
  const ramUsedBytes = ramTotalBytes - getValue("MemAvailable");

  return { cpuPercent, ramUsedBytes, ramTotalBytes };
}

async function fetchRemoteSystemStatus(
  managementApiUrl: string,
  managementApiSecret: string | null,
): Promise<SystemStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (managementApiSecret) headers["X-Management-Secret"] = managementApiSecret;

  try {
    const r = await fetch(`${managementApiUrl}/system/status`, {
      signal: controller.signal,
      headers,
    });
    clearTimeout(timeout);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as SystemStatus;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─── Event helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if there is already an unacknowledged system_event of the
 * given type for this node, so we can skip redundant inserts.
 */
async function hasUnacknowledgedEvent(eventType: string, nodeId: number): Promise<boolean> {
  const rows = await jobsDb
    .select({ id: systemEventsTable.id })
    .from(systemEventsTable)
    .where(
      and(
        eq(systemEventsTable.eventType, eventType),
        isNull(systemEventsTable.acknowledgedAt),
        sql`${systemEventsTable.metadata} @> ${JSON.stringify({ nodeId })}::jsonb`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function emitEvent(
  eventType: string,
  nodeId: number,
  nodeName: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await jobsDb.insert(systemEventsTable).values({
    eventType,
    metadata: { nodeId, nodeName, ...extra },
  });
  logger.info({ eventType, nodeId, nodeName, ...extra }, `nodeMonitoring: emitted ${eventType}`);
}

// ─── Per-node poll logic ──────────────────────────────────────────────────────

async function pollNode(node: {
  id: number;
  name: string;
  managementApiUrl: string | null;
  managementApiSecret: string | null;
}): Promise<void> {
  let status: SystemStatus;

  try {
    if (node.managementApiUrl) {
      status = await fetchRemoteSystemStatus(node.managementApiUrl, node.managementApiSecret);
    } else {
      status = await getLocalSystemStatus();
    }
  } catch (err) {
    const failures = (consecutiveFailures.get(node.id) ?? 0) + 1;
    consecutiveFailures.set(node.id, failures);
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ nodeId: node.id, nodeName: node.name, failures, err: msg }, "nodeMonitoring: node poll failed");

    if (failures >= FAILURE_ALERT_THRESHOLD) {
      const alreadyReported = await hasUnacknowledgedEvent("node_unavailable", node.id);
      if (!alreadyReported) {
        await emitEvent("node_unavailable", node.id, node.name, { consecutiveFailures: failures, lastError: msg });
        reportedUnavailable.add(node.id);
      }
    }
    return;
  }

  // Successful poll — reset failure counter.
  const prevFailures = consecutiveFailures.get(node.id) ?? 0;
  consecutiveFailures.set(node.id, 0);

  // If this node was previously reported as unavailable, emit a recovery event.
  if (reportedUnavailable.has(node.id)) {
    reportedUnavailable.delete(node.id);
    await emitEvent("node_recovered", node.id, node.name, {
      prevConsecutiveFailures: prevFailures,
      cpuPercent: status.cpuPercent,
    });
  }

  // Check resource thresholds.
  const ramPercent =
    status.ramTotalBytes > 0
      ? Math.round((status.ramUsedBytes / status.ramTotalBytes) * 1000) / 10
      : 0;

  const cpuOverloaded = status.cpuPercent > CPU_THRESHOLD_PERCENT;
  const ramOverloaded = ramPercent > RAM_THRESHOLD_PERCENT;

  if (cpuOverloaded || ramOverloaded) {
    const alreadyReported = await hasUnacknowledgedEvent("node_overloaded", node.id);
    if (!alreadyReported) {
      await emitEvent("node_overloaded", node.id, node.name, {
        cpuPercent: status.cpuPercent,
        ramPercent,
        cpuOverloaded,
        ramOverloaded,
      });
    }
  }
}

// ─── Job entry point ──────────────────────────────────────────────────────────

async function runNodeMonitoringCycle(): Promise<void> {
  // Only remote nodes need monitoring via management API; local node is
  // queried directly. Include the local node (managementApiUrl IS NULL) too
  // so admins get CPU/RAM alerts even on all-in-one deployments.
  const nodes = await jobsDb
    .select({
      id: vpnNodesTable.id,
      name: vpnNodesTable.name,
      managementApiUrl: vpnNodesTable.managementApiUrl,
      managementApiSecret: vpnNodesTable.managementApiSecret,
    })
    .from(vpnNodesTable)
    .where(eq(vpnNodesTable.isActive, true));

  if (nodes.length === 0) return;

  // Poll all nodes in parallel — each probe has its own timeout, so one slow
  // node doesn't hold up the rest.
  await Promise.allSettled(nodes.map((node) => pollNode(node)));
}

export function startNodeMonitoringJob(): NodeJS.Timeout {
  const run = () => {
    runNodeMonitoringCycle().catch((err) => {
      logger.error({ err }, "nodeMonitoring: monitoring cycle failed");
    });
  };

  // Stagger the first run by 30 seconds so startup traffic polling and session
  // cleanup don't all fire at the exact same moment.
  const warmupTimer = setTimeout(() => {
    run();
    setInterval(run, NODE_MONITOR_INTERVAL_MS);
  }, 30_000);

  // Return a handle that, when cleared, cancels the warmup (if it hasn't
  // fired yet). After warmup the interval runs until process exit.
  return warmupTimer;
}
