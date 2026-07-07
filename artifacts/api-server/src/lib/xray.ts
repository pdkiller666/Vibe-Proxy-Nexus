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
import { execSync } from "node:child_process";

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

function reloadXray(): void {
  // Restart Xray via supervisorctl so the updated on-disk config takes effect.
  // Takes ~2 s; existing connected clients reconnect automatically.
  execSync("supervisorctl restart xray", { stdio: "pipe" });
}

export async function addXrayClient(uuid: string, email: string): Promise<void> {
  if (!isLocalXrayEnabled()) return;
  await withLock(async () => {
    const config = await readConfig();
    const clients = getClients(config);
    // Guard by both UUID and email: Xray rejects configs with duplicate emails.
    if (clients.some((c) => c.id === uuid || c.email === email)) return;
    clients.push({ id: uuid, email });
    // Persist first — the client survives a container restart even if the
    // reload below fails; the next boot will pick this client up automatically.
    await writeConfig(config);
    reloadXray();
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
    reloadXray();
  });
}
