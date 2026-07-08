/**
 * gRPC client for Xray-core's StatsService, used to read (and reset) each
 * VPN client's uplink/downlink traffic counters.
 *
 * Only meaningful in the all-in-one Amvera deployment, where Xray runs in
 * the same container and its API is enabled in xray-config.json.template
 * (an "api"-tagged dokodemo-door inbound plus "stats"/"policy" sections —
 * already present there). Gated by the same `isLocalXrayEnabled()` check as
 * the rest of src/lib/xray.ts.
 *
 * The proto here is xray-core's own app/stats/command/command.proto, vendored
 * verbatim (it has no cross-file imports, so no include-root path juggling is
 * needed — see .agents/memory/xray-grpc-proto-loading.md for the pitfalls
 * that *do* apply to Xray's other protos).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { isLocalXrayEnabled } from "./xray";
import { logger } from "./logger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, "xray-proto", "app", "stats", "command", "command.proto");
const API_ADDR = process.env["XRAY_API_ADDR"] || "127.0.0.1:10085";

interface StatEntry {
  name: string;
  value: string;
}

interface StatsServiceClient extends grpc.Client {
  QueryStats(
    request: { pattern: string; reset: boolean },
    callback: (err: grpc.ServiceError | null, response?: { stat: StatEntry[] }) => void,
  ): void;
}

let client: StatsServiceClient | undefined;

function getClient(): StatsServiceClient {
  if (client) return client;
  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDef) as any;
  const StatsService = proto.xray.app.stats.command.StatsService;
  client = new StatsService(API_ADDR, grpc.credentials.createInsecure()) as StatsServiceClient;
  return client;
}

export function isXrayStatsEnabled(): boolean {
  return isLocalXrayEnabled();
}

/**
 * Queries and atomically resets every per-user traffic counter Xray has
 * accumulated since the last call (or since Xray started, on the first
 * call). Returns a map of Xray client "email" (== VPN key UUID, see
 * keyIssuance.ts) to the uplink/downlink bytes accumulated in that window.
 *
 * Resetting on read is intentional and matches Xray's own StatsService
 * design: this call is the only place these counters are ever read, so
 * accumulating the delta into Postgres and resetting Xray's copy keeps a
 * single source of truth (the DB) instead of two counters that can drift.
 */
export async function pollUserTrafficDeltas(): Promise<Map<string, { uplinkBytes: number; downlinkBytes: number }>> {
  const deltas = new Map<string, { uplinkBytes: number; downlinkBytes: number }>();
  if (!isXrayStatsEnabled()) return deltas;

  let response: { stat: StatEntry[] };
  try {
    response = await new Promise((resolve, reject) => {
      getClient().QueryStats({ pattern: "user>>>", reset: true }, (err, resp) => {
        if (err) reject(err);
        else resolve(resp ?? { stat: [] });
      });
    });
  } catch (err) {
    logger.error({ err }, "pollUserTrafficDeltas: failed to query Xray StatsService");
    return deltas;
  }

  // Stat names look like "user>>>{email}>>>traffic>>>uplink" / ">>>downlink".
  for (const stat of response.stat) {
    const match = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(stat.name);
    if (!match) continue;
    const [, email, direction] = match;
    const value = Number(stat.value);
    if (!Number.isFinite(value) || value === 0) continue;

    const entry = deltas.get(email) ?? { uplinkBytes: 0, downlinkBytes: 0 };
    if (direction === "uplink") entry.uplinkBytes += value;
    else entry.downlinkBytes += value;
    deltas.set(email, entry);
  }

  return deltas;
}
