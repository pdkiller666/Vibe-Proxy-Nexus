import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { jobsDb, systemEventsTable, vpnNodesTable } from "@workspace/db";
import { logger } from "./logger";
import { probeVpnWsIngress } from "./vpnIngressProbe";

const INGRESS_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const INGRESS_FAILURE_THRESHOLD = 3;
const PROBE_SOURCE = "amvera-api";

interface NodeIngressState {
  consecutiveFailures: number;
  alertOpen: boolean;
}

const stateByNodeId = new Map<number, NodeIngressState>();

async function hasOpenFailure(nodeId: number): Promise<boolean> {
  const rows = await jobsDb
    .select({ eventType: systemEventsTable.eventType })
    .from(systemEventsTable)
    .where(
      and(
        inArray(systemEventsTable.eventType, ["vpn_ingress_unreachable", "vpn_ingress_recovered"]),
        isNull(systemEventsTable.userId),
        sql`${systemEventsTable.metadata} @> ${JSON.stringify({ nodeId })}::jsonb`,
      ),
    )
    .orderBy(desc(systemEventsTable.createdAt), desc(systemEventsTable.id))
    .limit(1);
  return rows[0]?.eventType === "vpn_ingress_unreachable";
}

async function emitIngressEvent(
  eventType: "vpn_ingress_unreachable" | "vpn_ingress_recovered",
  metadata: Record<string, unknown>,
): Promise<void> {
  await jobsDb.insert(systemEventsTable).values({ eventType, metadata });
}

async function recordFailure(
  node: { id: number; name: string; host: string | null; sni: string | null; port: number | null },
  state: NodeIngressState,
  result: Awaited<ReturnType<typeof probeVpnWsIngress>>,
): Promise<void> {
  if (state.consecutiveFailures < INGRESS_FAILURE_THRESHOLD || state.alertOpen) return;

  try {
    const metadata = {
      nodeId: node.id,
      nodeName: node.name,
      host: node.host,
      sni: node.sni,
      port: node.port ?? 443,
      probeSource: PROBE_SOURCE,
      probeStage: result.stage,
      consecutiveFailures: state.consecutiveFailures,
      lastError: result.error,
      httpStatus: result.statusCode,
      elapsedMs: result.elapsedMs,
    };

    if (await hasOpenFailure(node.id)) {
      state.alertOpen = true;
      return;
    }
    await emitIngressEvent("vpn_ingress_unreachable", metadata);
    logger.error(metadata, "vpnIngressMonitoring: public WS ingress failed repeatedly");
    state.alertOpen = true;
  } catch (err) {
    logger.error({ err, nodeId: node.id, nodeName: node.name }, "vpnIngressMonitoring: failed to record ingress alert");
  }
}

async function recordRecovery(
  node: { id: number; name: string; host: string | null; sni: string | null; port: number | null },
  state: NodeIngressState,
  elapsedMs: number,
): Promise<void> {
  if (!state.alertOpen) return;

  try {
    await emitIngressEvent("vpn_ingress_recovered", {
      nodeId: node.id,
      nodeName: node.name,
      host: node.host,
      sni: node.sni,
      port: node.port ?? 443,
      probeSource: PROBE_SOURCE,
      elapsedMs,
    });
    state.alertOpen = false;
  } catch (err) {
    logger.warn({ err, nodeId: node.id, nodeName: node.name }, "vpnIngressMonitoring: failed to record recovery");
  }
}

async function checkActiveWsNodes(): Promise<void> {
  const nodes = await jobsDb
    .select({
      id: vpnNodesTable.id,
      name: vpnNodesTable.name,
      host: vpnNodesTable.host,
      sni: vpnNodesTable.sni,
      port: vpnNodesTable.port,
    })
    .from(vpnNodesTable)
    .where(and(eq(vpnNodesTable.isActive, true), eq(vpnNodesTable.transport, "ws")));

  const activeIds = new Set(nodes.map((node) => node.id));
  for (const nodeId of stateByNodeId.keys()) {
    if (!activeIds.has(nodeId)) stateByNodeId.delete(nodeId);
  }

  await Promise.all(
    nodes.map(async (node) => {
      const state = stateByNodeId.get(node.id) ?? { consecutiveFailures: 0, alertOpen: false };
      stateByNodeId.set(node.id, state);
      const result = await probeVpnWsIngress(node);

      if (result.ok) {
        // Preserve the recovery notification if the process restarted during
        // an outage and lost its in-memory state.
        if (!state.alertOpen) state.alertOpen = await hasOpenFailure(node.id);
        await recordRecovery(node, state, result.elapsedMs);
        state.consecutiveFailures = 0;
        return;
      }

      state.consecutiveFailures += 1;
      logger.warn(
        {
          nodeId: node.id,
          nodeName: node.name,
          host: node.host,
          probeSource: PROBE_SOURCE,
          probeStage: result.stage,
          consecutiveFailures: state.consecutiveFailures,
          httpStatus: result.statusCode,
          elapsedMs: result.elapsedMs,
          error: result.error,
        },
        "vpnIngressMonitoring: public WS ingress probe failed",
      );
      await recordFailure(node, state, result);
    }),
  );
}

export const runVpnIngressMonitoringCycleForTests = checkActiveWsNodes;

export function startVpnIngressMonitoringJob(): NodeJS.Timeout {
  let isRunning = false;
  const run = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await checkActiveWsNodes();
    } catch (err) {
      logger.error({ err }, "vpnIngressMonitoring: cycle failed");
    } finally {
      isRunning = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), INGRESS_MONITOR_INTERVAL_MS);
  timer.unref();
  return timer;
}