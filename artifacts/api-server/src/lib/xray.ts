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
import { db, vpnKeysTable, vpnNodesTable, systemEventsTable } from "@workspace/db";
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
  /** Compatibility hint for custom Xray builds; ignored by the pinned vanilla core. */
  limitIp?: number;
}

export interface LocalXrayReconciliationResult {
  changed: boolean;
  added: number;
  removed: number;
  normalized: number;
  activeCount: number;
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

function clientForUuid(uuid: string): XrayClient {
  return {
    id: uuid,
    email: uuid,
    limitIp: 1,
  };
}

/**
 * Read the DB-owned set of clients for the local Xray instance.
 *
 * A successful query is required before any reconciliation can write the
 * config. This is deliberate: a transient DB outage must never be interpreted
 * as "there are no active clients", which would disconnect every local user.
 */
async function getActiveLocalXrayClients(): Promise<XrayClient[]> {
  const activeKeys = await db
    .select({ uuid: vpnKeysTable.uuid })
    .from(vpnKeysTable)
    .innerJoin(vpnNodesTable, eq(vpnKeysTable.nodeId, vpnNodesTable.id))
    .where(
      and(
        isNull(vpnKeysTable.revokedAt),
        isNull(vpnNodesTable.managementApiUrl),
      ),
    );

  return [...new Set(activeKeys.map(({ uuid }) => uuid))]
    .sort((a, b) => a.localeCompare(b))
    .map(clientForUuid);
}

async function readConfig(restoreClients?: XrayClient[]): Promise<Record<string, any>> {
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
      //
      // A caller that already performed a successful active-key query can pass
      // those clients in. This avoids a second DB query during reconciliation,
      // where a transient failure between the two reads must not turn recovery
      // into an empty config.
      let clients: XrayClient[] = [];
      if (restoreClients !== undefined) {
        clients = restoreClients;
      } else {
        try {
          clients = await getActiveLocalXrayClients();
        } catch (dbErr) {
          logger.error(
            { err: dbErr },
            "xray: failed to query DB for active keys during ENOENT recovery — starting with empty clients list",
          );
        }
      }

      try {
        if (Array.isArray(freshConfig?.["inbounds"]?.[0]?.["settings"]?.["clients"])) {
          freshConfig["inbounds"][0]["settings"]["clients"] = clients;
        }

        logger.info(
          { count: clients.length },
          "xray: restored active clients from DB into fresh config",
        );
      } catch (configErr) {
        logger.error(
          { err: configErr },
          "xray: failed to populate fresh config with active clients",
        );
      }

      await writeConfig(freshConfig);

      // Persist a system event so the admin dashboard can surface a banner
      // ("VPN config was lost and restored at <time>") with the key count.
      // Fire-and-forget: failure to write the event must not break recovery.
      const restoredKeyCount = freshConfig?.["inbounds"]?.[0]?.["settings"]?.["clients"]?.length ?? 0;
      db.insert(systemEventsTable)
        .values({
          eventType: "xray_config_remount",
          metadata: {
            restoredKeyCount,
            configPath: CONFIG_PATH,
          },
        })
        .catch((err) =>
          logger.error({ err }, "xray: failed to write xray_config_remount system event"),
        );

      // Restart Xray immediately so the restored clients become active right
      // away, without waiting for the next container restart.
      void reloadXray();
      return freshConfig;
    }
    logger.error(
      { err, configPath: CONFIG_PATH },
      "xray: readConfig failed",
    );
    throw err;
  }
}

async function writeConfig(config: Record<string, any>): Promise<void> {
  const tmp = `${CONFIG_PATH!}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    logger.error(
      { err, tmpPath: tmp },
      "xray: writeConfig failed writing .tmp file",
    );
    throw err;
  }
  try {
    await fs.rename(tmp, CONFIG_PATH!);
  } catch (err) {
    logger.error(
      { err, tmpPath: tmp, configPath: CONFIG_PATH },
      "xray: writeConfig failed renaming .tmp → config",
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

/**
 * Reconcile the running local Xray client list against the DB source of truth.
 *
 * The DB owns which UUIDs are active on the local node. The on-disk Xray
 * config is a durable cache of that set, and Xray's in-memory config is
 * refreshed only when the cache changes. Keeping this operation behind the
 * same write lock as add/remove prevents a monitoring pass from overwriting a
 * concurrent key issuance or revoke.
 *
 * The operation is intentionally fail-closed:
 * - If the DB query fails, no config read/write is attempted.
 * - If the config is malformed, the error is propagated and the next cycle
 *   retries without changing anything.
 * - A restart is scheduled only when the client list actually changes.
 */
export async function reconcileLocalXrayClients(): Promise<LocalXrayReconciliationResult> {
  const unchanged: LocalXrayReconciliationResult = {
    changed: false,
    added: 0,
    removed: 0,
    normalized: 0,
    activeCount: 0,
  };

  if (!isLocalXrayEnabled()) return unchanged;

  return withLock(async () => {
    const desiredClients = await getActiveLocalXrayClients();
    const desiredById = new Map(desiredClients.map((client) => [client.id, client]));
    const config = await readConfig(desiredClients);
    const clients = getClients(config);

    const next: XrayClient[] = [];
    const seen = new Set<string>();
    let added = 0;
    let removed = 0;
    let normalized = 0;

    for (const client of clients) {
      const desired = desiredById.get(client.id);
      if (!desired || seen.has(client.id)) {
        removed += 1;
        continue;
      }

      seen.add(client.id);
      if (client.email !== desired.email || client.limitIp !== desired.limitIp) {
        normalized += 1;
      }
      next.push({
        ...client,
        id: desired.id,
        email: desired.email,
        limitIp: desired.limitIp,
      });
    }

    for (const desired of desiredClients) {
      if (seen.has(desired.id)) continue;
      next.push(desired);
      added += 1;
    }

    const changed = added > 0 || removed > 0 || normalized > 0;
    if (!changed) {
      return {
        changed: false,
        added: 0,
        removed: 0,
        normalized: 0,
        activeCount: desiredClients.length,
      };
    }

    config["inbounds"][0]["settings"]["clients"] = next;
    await writeConfig(config);
    scheduleXrayRestart();

    logger.info(
      {
        activeCount: desiredClients.length,
        added,
        removed,
        normalized,
      },
      "xray: reconciled local clients against active DB keys",
    );

    return {
      changed: true,
      added,
      removed,
      normalized,
      activeCount: desiredClients.length,
    };
  });
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
