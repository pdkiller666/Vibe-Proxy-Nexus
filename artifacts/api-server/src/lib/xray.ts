/**
 * Local Xray-core client management.
 *
 * Used only in the all-in-one Amvera deployment, where the Express backend and
 * Xray-core run in the same container. When `XRAY_CONFIG_PATH` is set, the
 * backend edits the live Xray config on disk to add/remove VLESS clients and
 * asks supervisord to reload the xray process.
 *
 * In the Replit dev environment `XRAY_CONFIG_PATH` is unset, so all of these
 * become no-ops and key issuance behaves as before (link generated locally,
 * not yet connectable).
 */
import { promises as fs } from "fs";
import { spawn } from "child_process";

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

function reloadXray(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "supervisorctl",
      ["-c", "/app/supervisord.conf", "restart", "xray"],
      { stdio: "ignore" },
    );
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`supervisorctl restart xray exited with code ${code}`));
    });
  });
}

function getClients(config: Record<string, any>): XrayClient[] {
  const clients = config?.["inbounds"]?.[0]?.["settings"]?.["clients"];
  if (!Array.isArray(clients)) {
    throw new Error("Unexpected Xray config shape: inbounds[0].settings.clients missing");
  }
  return clients as XrayClient[];
}

export async function addXrayClient(uuid: string, email: string): Promise<void> {
  if (!isLocalXrayEnabled()) return;
  await withLock(async () => {
    const config = await readConfig();
    const clients = getClients(config);
    if (clients.some((c) => c.id === uuid)) return;
    clients.push({ id: uuid, email });
    await writeConfig(config);
    await reloadXray();
  });
}

export async function removeXrayClient(uuid: string): Promise<void> {
  if (!isLocalXrayEnabled()) return;
  await withLock(async () => {
    const config = await readConfig();
    const clients = getClients(config);
    const next = clients.filter((c) => c.id !== uuid);
    if (next.length === clients.length) return;
    config["inbounds"][0]["settings"]["clients"] = next;
    await writeConfig(config);
    await reloadXray();
  });
}
