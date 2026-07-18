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
import { logger } from "./logger";

const execAsync = promisify(exec);

const CONFIG_PATH = process.env["XRAY_CONFIG_PATH"];

interface XrayClient {
  id: string;
  email?: string;
  flow?: string;
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
  const raw = await fs.readFile(CONFIG_PATH!, "utf-8");
  return JSON.parse(raw) as Record<string, any>;
}

async function writeConfig(config: Record<string, any>): Promise<void> {
  const tmp = `${CONFIG_PATH!}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf-8");
  await fs.rename(tmp, CONFIG_PATH!);
}

function getClients(config: Record<string, any>): XrayClient[] {
  const clients = config?.["inbounds"]?.[0]?.["settings"]?.["clients"];
  if (!Array.isArray(clients)) {
    throw new Error("Unexpected Xray config shape: inbounds[0].settings.clients missing");
  }
  return clients as XrayClient[];
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
  // Takes ~2 s; existing connected clients reconnect automatically.
  //
  // Uses the async `exec` (not `execSync`) so this does not block the whole
  // Node event loop — a synchronous restart used to freeze every other
  // in-flight request (including other admins' key issuance) for the full
  // ~2 s, which risked client/proxy timeouts that made a *successful* issue
  // look like a failure to the caller, prompting a retry that created a
  // second key for the same user.
  try {
    await execAsync("supervisorctl restart xray");
  } catch (err) {
    // The on-disk config was already durably written before this call (see
    // callers below), so the new client takes effect on the next container
    // restart even if this immediate reload fails. Log and swallow rather
    // than fail the whole request — the config write, which is the part
    // that must succeed, already happened.
    logger.error({ err }, "Failed to restart Xray after config change; change will apply on next restart");
  }
}

export async function addXrayClient(uuid: string, email: string): Promise<void> {
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
    cleaned.push({ id: uuid, email });
    config["inbounds"][0]["settings"]["clients"] = cleaned;
    // Persist first — the client survives a container restart even if the
    // reload below fails; the next boot will pick this client up automatically.
    await writeConfig(config);
    await reloadXray();
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
    await reloadXray();
  });
}
