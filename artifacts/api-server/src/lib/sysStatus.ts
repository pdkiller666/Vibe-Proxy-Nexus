/**
 * Container-aware system status helpers.
 *
 * Uses cgroup v2 for accurate container-level CPU and RAM metrics, with a
 * transparent fallback to /proc sources when cgroup v2 is unavailable.
 *
 * IMPORTANT — single source of truth:
 * Both the manual status endpoint (routes/admin/vpnNodes.ts) and the
 * background monitoring loop (lib/nodeMonitoring.ts) import from this module.
 * Never duplicate this logic; edit here only.
 */

import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface SystemStatus {
  cpuPercent: number;
  ramUsedBytes: number;
  ramTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  /** Node.js process uptime in seconds (since last restart, not host uptime). */
  uptimeSeconds: number;
}

// ─── CPU helpers ──────────────────────────────────────────────────────────────

/** Sample /proc/stat twice ~200 ms apart for host-level CPU utilisation.
 *  Used as a fallback when cgroup v2 is unavailable. */
async function getCpuPercentFromProc(): Promise<number> {
  const readStat = async () => {
    const text = await fs.readFile("/proc/stat", "utf8").catch(() => "");
    const line = text.split("\n")[0] ?? "";
    const nums = line.replace(/^cpu\s+/, "").split(/\s+/).map(Number).filter(n => !isNaN(n));
    const idle  = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
    const total = nums.reduce((a, b) => a + b, 0);
    return { idle, total };
  };
  const before = await readStat();
  await new Promise<void>(resolve => setTimeout(resolve, 200));
  const after = await readStat();
  const totalDelta = after.total - before.total;
  const idleDelta  = after.idle  - before.idle;
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10);
}

/** cgroup v2 CPU: measures container-level usage_usec delta over 200 ms.
 *  Accounts for the container's CPU quota so 100% means "quota exhausted". */
async function getCpuPercentFromCgroup(): Promise<number> {
  const readUsageUsec = async (): Promise<number> => {
    const text = await fs.readFile("/sys/fs/cgroup/cpu.stat", "utf8");
    const m = text.match(/^usage_usec\s+(\d+)/m);
    if (!m) throw new Error("usage_usec not found");
    return parseInt(m[1]!);
  };

  // Determine the container's CPU quota (e.g. "50000 100000" → 0.5 CPUs).
  // "max 100000" means no limit — treat as 1 CPU so the percentage is absolute.
  const cpuMaxText = await fs.readFile("/sys/fs/cgroup/cpu.max", "utf8").catch(() => "max 100000");
  const [quotaStr, periodStr] = cpuMaxText.trim().split(/\s+/);
  const period   = parseInt(periodStr  ?? "100000") || 100000;
  const quota    = quotaStr === "max" ? null : (parseInt(quotaStr ?? "0") || null);
  const cpuLimit = quota !== null ? quota / period : 1.0; // fraction of 1 physical CPU

  const before    = await readUsageUsec();
  const t0        = Date.now();
  await new Promise<void>(resolve => setTimeout(resolve, 200));
  const after     = await readUsageUsec();
  const elapsedUs = (Date.now() - t0) * 1000; // ms → µs

  const usedUs = after - before;
  if (elapsedUs <= 0 || cpuLimit <= 0) return 0;
  // CPU% relative to allocated limit (0–100).
  return Math.min(100, Math.round((usedUs / elapsedUs / cpuLimit) * 1000) / 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the local node's system status in a container-aware way.
 *
 * CPU: tries cgroup v2 (/sys/fs/cgroup/cpu.stat) first — gives container-level
 *   utilisation relative to the allocated quota. Falls back to /proc/stat
 *   (host-level) when cgroup v2 is unavailable.
 *
 * RAM: tries cgroup v2 (memory.current / memory.max) — gives container-level
 *   usage against the container memory limit. Falls back to /proc/meminfo
 *   (host-level) when cgroup memory accounting is disabled.
 *
 * Disk: reads df -B1 / (no standard cgroup interface for disk capacity).
 *
 * uptimeSeconds: Node.js process uptime (time since last deploy/restart),
 *   NOT /proc/uptime which on Amvera reflects the host machine lifetime.
 */
export async function getLocalSystemStatus(): Promise<SystemStatus> {

  // ── CPU ─────────────────────────────────────────────────────────────────────
  let cpuPercent: number;
  try {
    cpuPercent = await getCpuPercentFromCgroup();
  } catch {
    cpuPercent = await getCpuPercentFromProc();
  }

  // ── RAM ─────────────────────────────────────────────────────────────────────
  let ramUsedBytes: number;
  let ramTotalBytes: number;
  try {
    const currentText = await fs.readFile("/sys/fs/cgroup/memory.current", "utf8");
    const maxText     = await fs.readFile("/sys/fs/cgroup/memory.max",     "utf8");
    if (maxText.trim() === "max") throw new Error("no cgroup memory limit");
    ramUsedBytes  = parseInt(currentText.trim()) || 0;
    ramTotalBytes = parseInt(maxText.trim())     || 0;
    if (!ramTotalBytes) throw new Error("zero limit");
  } catch {
    // Fallback: /proc/meminfo (reflects host RAM — only happens if cgroup
    // memory accounting is disabled, which is unusual on modern kernels).
    const memInfo  = await fs.readFile("/proc/meminfo", "utf8").catch(() => "");
    const getValue = (key: string) => {
      const m = memInfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? parseInt(m[1]!) * 1024 : 0;
    };
    ramTotalBytes = getValue("MemTotal");
    ramUsedBytes  = ramTotalBytes - getValue("MemAvailable");
  }

  // ── Disk ────────────────────────────────────────────────────────────────────
  const dfOut        = await execAsync("df -B1 / | tail -1", { timeout: 5_000 }).catch(() => ({ stdout: "" }));
  const dfParts      = dfOut.stdout.trim().split(/\s+/);
  const diskTotalBytes = parseInt(dfParts[1] ?? "0") || 0;
  const diskUsedBytes  = parseInt(dfParts[2] ?? "0") || 0;

  // ── Uptime ──────────────────────────────────────────────────────────────────
  const uptimeSeconds = Math.floor(process.uptime());

  return { cpuPercent, ramUsedBytes, ramTotalBytes, diskUsedBytes, diskTotalBytes, uptimeSeconds };
}
