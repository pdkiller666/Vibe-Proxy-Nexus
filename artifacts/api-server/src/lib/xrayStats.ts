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
 * Queries every per-user traffic counter Xray has accumulated since it last
 * started (or since Xray's own internal reset, if anything else ever resets
 * it). Returns a map of Xray client "email" (== VPN key UUID, see
 * keyIssuance.ts) to the *absolute* uplink/downlink byte counts Xray is
 * currently holding — NOT a delta.
 *
 * Deliberately uses reset:false, not reset:true. Xray's counters are the
 * only record of a client's traffic between polls; a reset:true poll that
 * successfully zeroes Xray's copy but then crashes before the delta is
 * committed to Postgres would permanently lose that window's traffic, and a
 * mid-cycle Xray restart (e.g. supervisorctl restart after a key add/remove
 * in xray.ts) would silently discard whatever had accumulated since the
 * last poll. Leaving Xray's counters untouched means the only place any
 * conversion from absolute reads to deltas happens is trafficPolling.ts,
 * which persists the last-seen absolute value alongside the running totals
 * in a single atomic UPDATE — so a crash there just means the next poll
 * recomputes the same delta from the same lastSeen baseline, and an Xray
 * restart (counters drop back to 0) is detected as current < lastSeen
 * rather than silently swallowed.
 */
export async function pollUserTrafficCounters(): Promise<Map<string, { uplinkBytes: number; downlinkBytes: number }>> {
  const counters = new Map<string, { uplinkBytes: number; downlinkBytes: number }>();
  if (!isXrayStatsEnabled()) return counters;

  let response: { stat: StatEntry[] };
  try {
    response = await new Promise((resolve, reject) => {
      getClient().QueryStats({ pattern: "user>>>", reset: false }, (err, resp) => {
        if (err) reject(err);
        else resolve(resp ?? { stat: [] });
      });
    });
  } catch (err) {
    logger.error({ err }, "pollUserTrafficCounters: failed to query Xray StatsService");
    return counters;
  }

  // Stat names look like "user>>>{email}>>>traffic>>>uplink" / ">>>downlink".
  for (const stat of response.stat) {
    const match = /^user>>>(.+)>>>traffic>>>(uplink|downlink)$/.exec(stat.name);
    if (!match) continue;
    const [, email, direction] = match;
    const value = Number(stat.value);
    if (!Number.isFinite(value)) continue;

    const entry = counters.get(email) ?? { uplinkBytes: 0, downlinkBytes: 0 };
    if (direction === "uplink") entry.uplinkBytes += value;
    else entry.downlinkBytes += value;
    counters.set(email, entry);
  }

  return counters;
}
