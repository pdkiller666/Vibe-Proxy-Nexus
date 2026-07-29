/**
 * Local Xray-core client management.
 *
 * Used only in the all-in-one Amvera deployment, where the Express backend and
 * Xray-core run in the same container. When `XRAY_CONFIG_PATH` is set, the
 * backend:
 *
 *  1. Persists the client list into the on-disk Xray config (so the client
 *     survives container restarts — see entrypoint.sh, which preserves
 *     `inbounds[0].settings.clients` across re-renders of the config
 *     template on every boot).
 *  2. Restarts Xray via supervisorctl so the updated config takes effect
 *     immediately without waiting for the next redeploy.
 *
 * In the Replit dev environment `XRAY_CONFIG_PATH` is unset, so all of these
 * become no-ops and key issuance behaves as before (link generated locally,
 * not yet connectable).
 */
import { promises as fs } from "fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { db, vpnKeysTable, vpnNodesTable } from "@workspace/db";
import { logger } from "./logger";

const execAsync = promisify(exec);

const CONFIG_PATH = process.env["XRAY_CONFIG_PATH"];

// Bundled template (written by the Dockerfile into the image layer — not on the
// persistent volume). Used as a fallback when the on-disk config is missing,
// e.g. if the persistent volume was re-attached empty while Xray was already
// running from a previously loaded in-memory config.
const TEMPLATE_PATH = "/app/xray/config.json.template";

interface XrayClient {
  id: string;
  email?: string;
  flow?: string;
  /** Maximum simultaneous source IPs allowed for this client (Xray enforces at protocol level). */
  limitIp?: number;
}

export function isLocalXrayEnabled(): boolean {
  return Boolean(CONFIG_PATH);
}

let writeChain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readConfig(): Promise<Record<string, any>> {
  try {
    const raw = await fs.readFile(CONFIG_PATH!, "utf-8");
    return JSON.parse(raw) as Record<string, any>;
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      // Config file has gone missing — most likely the persistent volume was
      // re-attached empty after a pod reschedule while Xray was still running
      // from its previously loaded in-memory config. Re-initialize from the
      // bundled template, but immediately re-populate clients from the DB so
      // users whose keys are active in the DB see no interruption (at most a
      // ~2 s reconnect delay while Xray restarts with the restored config).
      logger.warn(
        { configPath: CONFIG_PATH, templatePath: TEMPLATE_PATH },
        "xray: config.json not found on persistent volume — re-initializing from template and restoring active keys from DB",
      );
      const templateRaw = await fs.readFile(TEMPLATE_PATH, "utf-8");
      const freshConfig = JSON.parse(templateRaw) as Record<string, any>;

      // Query all active (non-revoked) VPN keys for the local Xray node
      // (identified by managementApiUrl IS NULL — remote nodes use a REST API).
      // If the DB is unreachable we fall back to an empty clients list so
      // subsequent key issuance still works; the error is logged clearly.
      try {
        const activeKeys = await db
          .select({ uuid: vpnKeysTable.uuid })
          .from(vpnKeysTable)
          .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
          .where(and(
            isNull(vpnKeysTable.revokedAt),
            isNull(vpnNodesTable.managementApiUrl),
          ));

        const clients: XrayClient[] = activeKeys.map(({ uuid }) => ({
          id: uuid,
          email: uuid,
          limitIp: 1,
        }));

        if (Array.isArray(freshConfig?.["inbounds"]?.[0]?.["settings"]?.["clients"])) {
          freshConfig["inbounds"][0]["settings"]["clients"] = clients;
        }

        logger.info(
          { count: clients.length },
          "xray: restored active clients from DB into fresh config",
        );
      } catch (dbErr) {
        logger.error(
          { err: dbErr },
          "xray: failed to query DB for active keys during ENOENT recovery — starting with empty clients list",
        );
      }

      await writeConfig(freshConfig);
      // Restart Xray immediately so the restored clients become active right
      // away, without waiting for the next container restart.
      void reloadXray();
      return freshConfig;
    }
    // For EACCES or any other error, surface the code and message clearly
    // so Amvera's log viewer shows a human-readable string rather than a
    // collapsed JSON object.
    logger.error(
      { code: nodeErr.code, message: nodeErr.message, configPath: CONFIG_PATH },
      `xray: readConfig failed — ${nodeErr.code ?? "ERR"}: ${nodeErr.message}`,
    );
    throw err;
  }
}

async function writeConfig(config: Record<string, any>): Promise<void> {
  const tmp = `${CONFIG_PATH!}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    logger.error(
      { code: nodeErr.code, message: nodeErr.message, tmpPath: tmp },
      `xray: writeConfig failed writing .tmp file — ${nodeErr.code ?? "ERR"}: ${nodeErr.message}`,
    );
    throw err;
  }
  try {
    await fs.rename(tmp, CONFIG_PATH!);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    logger.error(
      { code: nodeErr.code, message: nodeErr.message, tmpPath: tmp, configPath: CONFIG_PATH },
      `xray: writeConfig failed renaming .tmp → config — ${nodeErr.code ?? "ERR"}: ${nodeErr.message}`,
    );
    throw err;
  }
}

function getClients(config: Record<string, any>): XrayClient[] {
  const clients = config?.["inbounds"]?.[0]?.["settings"]?.["clients"];
  if (!Array.isArray(clients)) {
    throw new Error("Unexpected Xray config shape: inbounds[0].settings.clients missing");
  }
  return clients as XrayClient[];
}

// Debounced, fire-and-forget Xray restart. Callers (addXrayClient /
// removeXrayClient) must NOT await the restart: the on-disk config is already
// durably written by the time this is called, so the change is guaranteed to
// take effect — either via this restart or the next container boot. Awaiting
// the restart inside the HTTP request path kept the response open long enough
// for Amvera's reverse proxy to time out AND RETRY the POST against the
// upstream, which created two keys from a single admin click. Debouncing also
// coalesces bursts (e.g. several revocations in one traffic-enforcement tick)
// into a single restart.
let restartQueued = false;
function scheduleXrayRestart(): void {
  if (restartQueued) return;
  restartQueued = true;
  setTimeout(() => {
    restartQueued = false;
    void reloadXray();
  }, 300);
}

async function reloadXray(): Promise<void> {
  // Restarting Xray zeroes its in-memory Stats API counters (see
  // xrayStats.ts / trafficPolling.ts). Start flushing whatever has accumulated
  // since the last scheduled poll into Postgres, but do NOT await the result.
  //
  // Why fire-and-forget: reloadXray() is always called from inside withLock(),
  // which serialises all Xray config writes. flushTrafficDeltas() → pollUserTrafficCounters()
  // issues a gRPC call to Xray's Stats API; if Xray is momentarily busy or
  // mid-restart, that gRPC call can hang for tens of seconds. Awaiting it here
  // blocks the HTTP response even though the on-disk config has already been
  // written (writeConfig() runs before reloadXray()), so Amvera's proxy times
  // out and the caller sees "Ошибка выдачи ключа" — but the key IS active
  // in the DB and will be loaded by Xray on its next restart.
  //
  // Worst case when flushing loses the race with the restart: the next scheduled
  // poll picks up the gap correctly via the lastSeen / restart-detection logic.
  import("./trafficPolling")
    .then(({ flushTrafficDeltas }) => flushTrafficDeltas())
    .catch((err) => logger.error({ err }, "Failed to flush traffic deltas before restarting Xray"));

  // Restart Xray via supervisorctl so the updated on-disk config takes effect.
  // Takes ~2 s normally; existing connected clients reconnect automatically.
  //
  // Hard timeout of 10 s: if supervisord is stalled (e.g. Xray is slow to
  // stop while draining connections), execAsync would block indefinitely —
  // long enough for Amvera's reverse-proxy to drop the HTTP connection. The
  // caller would see a network error even though the key is already in the DB
  // and the config was already written to disk, causing admins to retry and
  // create duplicate keys. With the timeout, after 10 s we log and proceed;
  // supervisord continues the restart in the background and the new client
  // becomes active once Xray comes back up (the on-disk config already has it).
  try {
    await execAsync("supervisorctl restart xray", { timeout: 10_000 });
  } catch (err) {
    // The on-disk config was already durably written before this call (see
    // callers below), so the new client takes effect on the next container
    // restart even if this immediate reload fails or times out. Log and swallow
    // rather than fail the whole request — the config write is the part that
    // must succeed, and it already happened.
    logger.warn({ err }, "Xray restart timed out or failed; client will activate on next Xray boot");
  }
}

export async function addXrayClient(uuid: string, email: string, limitIp?: number): Promise<void> {
  if (!isLocalXrayEnabled()) return;
  await withLock(async () => {
    const config = await readConfig();
    const clients = getClients(config);
    // If this exact UUID is already registered, nothing to do.
    if (clients.some((c) => c.id === uuid)) return;
    // Remove any stale entry with the same email but a different UUID — this
    // happens when a key was re-issued (DB assigned a new UUID but the old UUID
    // still sits in the on-disk config). The DB record is the source of truth.
    const cleaned = clients.filter((c) => c.email !== email);
    const newClient: XrayClient = { id: uuid, email };
    if (limitIp !== undefined) newClient.limitIp = limitIp;
    cleaned.push(newClient);
    config["inbounds"][0]["settings"]["clients"] = cleaned;
    // Persist first — the client survives a container restart even if the
    // reload below fails; the next boot will pick this client up automatically.
    await writeConfig(config);
    scheduleXrayRestart();
  });
}

export async function removeXrayClient(uuid: string): Promise<void> {
  if (!isLocalXrayEnabled()) return;
  await withLock(async () => {
    const config = await readConfig();
    const clients = getClients(config);
    if (!clients.some((c) => c.id === uuid)) return;
    const next = clients.filter((c) => c.id !== uuid);
    config["inbounds"][0]["settings"]["clients"] = next;
    await writeConfig(config);
    scheduleXrayRestart();
  });
}
