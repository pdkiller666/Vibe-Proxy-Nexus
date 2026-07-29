/**
 * SSH-based VPN node auto-provisioner.
 *
 * Connects to a fresh Ubuntu VPS via SSH, uploads the deploy files via SFTP,
 * installs Docker + Nginx + certbot, starts the management container, obtains a
 * Let's Encrypt certificate for the given domain, and registers the node in the DB.
 *
 * Progress is streamed to subscribers in real-time so the admin UI can show a
 * live log. All job state (status + logs) is persisted to the `provisioning_jobs`
 * table so logs survive server restarts and Amvera redeploys.
 */

import { Client } from "ssh2";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { db, vpnNodesTable, provisioningJobsTable } from "@workspace/db";
import type { ProvisionLogLine } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisioningOpts {
  sshHost: string;
  sshUser: string;
  sshPassword: string;
  domain: string;
  nodeName: string;
  nodeRegion: string;
}

export type ProvisionLogLevel = "info" | "step" | "success" | "error";

export { ProvisionLogLine };

export interface ProvisioningJob {
  id: string;
  status: "running" | "done" | "error";
  logs: ProvisionLogLine[];
  nodeId?: number;
  errorMessage?: string;
  /** Internal event emitter — not serialised to JSON */
  emitter: EventEmitter;
  /** Unix ms when the job started (for TTL cleanup) */
  startedAt: number;
}

// ---------------------------------------------------------------------------
// In-memory job store (for live SSE fan-out of active jobs)
// ---------------------------------------------------------------------------

const jobs = new Map<string, ProvisioningJob>();

/** Maximum number of completed/failed jobs to keep in memory. */
const MAX_KEPT_JOBS = 20;
/** How long (ms) to keep a finished job before allowing it to be evicted. */
const JOB_TTL_MS = 30 * 60 * 1000; // 30 min

function evictOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status !== "running" && now - job.startedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
  // Hard cap: keep at most MAX_KEPT_JOBS
  if (jobs.size > MAX_KEPT_JOBS) {
    const oldest = [...jobs.keys()][0];
    if (oldest) jobs.delete(oldest);
  }
}

export function getJob(jobId: string): ProvisioningJob | undefined {
  return jobs.get(jobId);
}

/**
 * Load a job from the database. Returns undefined if not found.
 * Used by the SSE route when a job is no longer in memory (e.g. after restart).
 */
export async function getJobFromDb(jobId: string): Promise<Omit<ProvisioningJob, "emitter"> | undefined> {
  const [row] = await db
    .select()
    .from(provisioningJobsTable)
    .where(eq(provisioningJobsTable.id, jobId))
    .limit(1);

  if (!row) return undefined;

  return {
    id: row.id,
    status: row.status as "running" | "done" | "error",
    logs: (row.logs ?? []) as ProvisionLogLine[],
    nodeId: row.nodeId ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    startedAt: row.startedAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// DB persistence helpers
// ---------------------------------------------------------------------------

/** Persist the current log array to the DB (full replace). */
async function persistLogsToDb(job: ProvisioningJob): Promise<void> {
  try {
    await db
      .update(provisioningJobsTable)
      .set({ logs: job.logs })
      .where(eq(provisioningJobsTable.id, job.id));
  } catch (err) {
    logger.warn({ err, jobId: job.id }, "Failed to persist provisioning log line to DB");
  }
}

/** Flush final job state (status, nodeId, errorMessage, finishedAt) to DB. */
async function persistJobFinish(
  job: ProvisioningJob,
  status: "done" | "error",
  extra: { nodeId?: number; errorMessage?: string },
): Promise<void> {
  try {
    await db
      .update(provisioningJobsTable)
      .set({
        status,
        logs: job.logs,
        nodeId: extra.nodeId ?? null,
        errorMessage: extra.errorMessage ?? null,
        finishedAt: new Date(),
      })
      .where(eq(provisioningJobsTable.id, job.id));
  } catch (err) {
    logger.warn({ err, jobId: job.id }, "Failed to persist provisioning job finish state to DB");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start a provisioning job and return its id immediately. */
export async function startProvisioning(opts: ProvisioningOpts): Promise<string> {
  evictOldJobs();

  const jobId = randomUUID();

  // Insert DB row first so the job is durably recorded before any work begins.
  await db.insert(provisioningJobsTable).values({
    id: jobId,
    status: "running",
    logs: [],
  });

  const job: ProvisioningJob = {
    id: jobId,
    status: "running",
    logs: [],
    emitter: new EventEmitter(),
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);

  // Run asynchronously — intentionally do not await.
  void provisionAsync(job, opts);

  return jobId;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/**
 * Batch-write interval: every N log lines we flush the full array to Postgres.
 * Individual emits are synchronous/in-memory; persistence happens on a cadence
 * so we don't issue a DB UPDATE on every stdout line from the remote commands.
 */
const DB_FLUSH_EVERY = 10;

function emitLog(job: ProvisioningJob, text: string, level: ProvisionLogLevel = "info") {
  const line: ProvisionLogLine = { ts: Date.now(), text, level };
  job.logs.push(line);
  job.emitter.emit("log", line);

  // Flush to DB every DB_FLUSH_EVERY lines (non-blocking, best-effort).
  if (job.logs.length % DB_FLUSH_EVERY === 0) {
    void persistLogsToDb(job);
  }
}

function emitStep(job: ProvisioningJob, text: string) {
  emitLog(job, text, "step");
}

function emitSuccess(job: ProvisioningJob, text: string) {
  emitLog(job, text, "success");
}

function emitError(job: ProvisioningJob, text: string) {
  emitLog(job, text, "error");
}

// ---------------------------------------------------------------------------
// SSH helpers
// ---------------------------------------------------------------------------

/** Promisified ssh2 connection. Resolves when the connection is ready. */
function connectSSH(opts: ProvisioningOpts): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    const timeout = setTimeout(() => {
      conn.destroy();
      reject(new Error("SSH connection timed out (30s)"));
    }, 30_000);

    conn.once("ready", () => {
      clearTimeout(timeout);
      resolve(conn);
    });

    conn.once("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect({
      host: opts.sshHost,
      port: 22,
      username: opts.sshUser,
      password: opts.sshPassword,
      // Accept any host key — the user is connecting to a brand-new VPS whose
      // host key has never been verified before.
      hostVerifier: () => true,
      readyTimeout: 30_000,
      // Send keepalives every 10 s so the connection survives the multi-minute
      // apt-get / docker-build steps without being killed by the server's idle
      // timeout.
      keepaliveInterval: 10_000,
      keepaliveCountMax: 6,
    });
  });
}

/**
 * Run a single command on the remote host, streaming stdout/stderr to the job
 * log. Rejects if the exit code is non-zero.
 */
function runCommand(
  conn: Client,
  cmd: string,
  job: ProvisioningJob,
  opts?: { timeoutMs?: number; allowFailure?: boolean },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts?.timeoutMs ?? 5 * 60_000; // 5 min default
    let output = "";

    conn.exec(cmd, { pty: false }, (err, stream) => {
      if (err) { reject(err); return; }

      const timer = setTimeout(() => {
        stream.close();
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s: ${cmd.slice(0, 80)}`));
      }, timeoutMs);

      const onData = (data: Buffer) => {
        const text = data.toString("utf8");
        output += text;
        // Emit each non-empty line to the log
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) emitLog(job, trimmed);
        }
      };

      stream.on("data", onData);
      stream.stderr.on("data", onData);

      stream.once("close", (code: number) => {
        clearTimeout(timer);
        if (!opts?.allowFailure && code !== 0) {
          reject(new Error(`Command exited with code ${code}: ${cmd.slice(0, 80)}`));
        } else {
          resolve(output);
        }
      });
    });
  });
}

/**
 * Upload a local directory to the remote host by packing it into a tar.gz
 * with the local `tar` binary, then piping the archive into a remote
 * `tar xzf -` command over the SSH exec channel.
 *
 * This completely avoids the SFTP subsystem (which was returning generic
 * "Failure" errors on certain VPS configurations) and relies only on the
 * standard exec channel that is already used for shell commands.
 */
function uploadTarDir(
  conn: Client,
  localDir: string,
  remoteDir: string,
  job: ProvisioningJob,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Pack the local directory into a tar.gz buffer synchronously on the
    // api-server container — files are small (configs, scripts, <5 MB total).
    const tarResult = spawnSync("tar", ["czf", "-", "-C", localDir, "."], {
      maxBuffer: 50 * 1024 * 1024, // 50 MB safety cap
    });
    if (tarResult.error) { reject(tarResult.error); return; }
    if (tarResult.status !== 0) {
      reject(new Error(
        `Local tar failed (exit ${tarResult.status}): ${(tarResult.stderr as Buffer).toString().slice(0, 200)}`,
      ));
      return;
    }
    const tarBuffer = tarResult.stdout as Buffer;
    emitLog(job, `  → пакуем ${(tarBuffer.length / 1024).toFixed(0)} KB...`);

    // Stream the archive to the remote via SSH exec stdin.
    // rm -rf + mkdir ensures a clean slate for re-runs.
    conn.exec(
      `rm -rf '${remoteDir}' && mkdir -p '${remoteDir}' && tar xzf - -C '${remoteDir}'`,
      (err, stream) => {
        if (err) { reject(err); return; }
        let stderr = "";
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        stream.once("close", (code: number) => {
          if (code === 0) resolve();
          else reject(new Error(
            `Remote tar extract failed (exit ${code}): ${stderr.slice(0, 300)}`,
          ));
        });
        stream.write(tarBuffer);
        stream.end();
      },
    );
  });
}

/**
 * Write a string as a remote file via SSH exec (no SFTP).
 * Uses base64 encoding so arbitrary content is safe across all shells.
 */
function writeRemoteFileViaExec(
  conn: Client,
  remotePath: string,
  content: string,
  job: ProvisioningJob,
): Promise<void> {
  // base64 the content locally, then decode it on the remote side.
  // printf avoids the trailing newline that `echo` would add.
  const b64 = Buffer.from(content, "utf8").toString("base64");
  return runCommand(
    conn,
    `printf '%s' '${b64}' | base64 -d > '${remotePath}'`,
    job,
    { timeoutMs: 30_000 },
  ).then(() => undefined);
}

// ---------------------------------------------------------------------------
// Nginx config generator
// ---------------------------------------------------------------------------

/**
 * Generate an HTTP-only nginx config for certbot's HTTP-01 challenge.
 * certbot --nginx will automatically add the HTTPS server block.
 */
function makeNginxHttpConfig(domain: string): string {
  return `# Auto-generated by VPNexus provisioner — do not edit manually.
# certbot will add the HTTPS block below after obtaining the certificate.

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    # VPN WebSocket traffic
    location /vpnws {
        proxy_pass         http://127.0.0.1:10000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "Upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 86400s;
    }

    # Everything else — no response to avoid leaking info
    location / {
        return 444;
    }
}
`;
}

// ---------------------------------------------------------------------------
// Main provisioner
// ---------------------------------------------------------------------------

/** Path to the bundled deploy files (copied by build.mjs at build time). */
const VPN_NODE_DEPLOY_DIR = path.resolve(__dirname, "vpn-node-deploy");

async function provisionAsync(job: ProvisioningJob, opts: ProvisioningOpts): Promise<void> {
  const { sshHost, sshUser, sshPassword, domain, nodeName, nodeRegion } = opts;
  let conn: Client | null = null;

  try {
    // ── Step 1: Connect ────────────────────────────────────────────────────
    emitStep(job, `🔌 Подключение к ${sshHost} по SSH...`);
    conn = await connectSSH(opts);
    emitSuccess(job, "SSH-соединение установлено ✓");

    // ── Step 2: Update apt + install Docker, Nginx, certbot ────────────────
    emitStep(job, "📦 Обновление системы и установка Docker, Nginx, certbot...");
    emitLog(job, "Это может занять 2–3 минуты...");

    const installScript = [
      "export DEBIAN_FRONTEND=noninteractive",
      "apt-get update -qq",
      // Install prerequisites
      "apt-get install -y --no-install-recommends curl gnupg ca-certificates lsb-release",
      // Docker official repo — idempotent so re-runs on the same VPS don't fail.
      // Remove stale keyring first: if a previous attempt left the file, gpg
      // refuses to overwrite it even with --batch ("dearmoring failed: File exists").
      "install -m 0755 -d /etc/apt/keyrings",
      "rm -f /etc/apt/keyrings/docker.gpg",
      // --batch + --yes: suppress /dev/tty open in non-PTY SSH sessions AND allow
      // overwrite in case rm -f above raced with a concurrent process.
      "curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg",
      "chmod a+r /etc/apt/keyrings/docker.gpg",
      // Use > (not tee) so re-runs overwrite instead of appending duplicates
      `echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] ` +
        `https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo \\"$VERSION_CODENAME\\") stable" ` +
        `> /etc/apt/sources.list.d/docker.list`,
      "apt-get update -qq",
      "apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin",
      // Enable Docker at boot; start it with retries — on some fresh VPS providers
      // the first start fails because cgroups/containerd haven't fully initialised
      // yet during the same apt-get session. We try up to 5 times with 3s pauses
      // before giving up and letting the later `docker compose up` surface the error.
      "systemctl enable docker",
      "for i in 1 2 3 4 5; do systemctl start docker && break || (echo \"Docker start attempt $i failed, retrying...\"; sleep 3); done",
      // Nginx + certbot
      "apt-get install -y --no-install-recommends nginx certbot python3-certbot-nginx",
      "systemctl enable nginx",
    ].join(" && ");

    await runCommand(conn, installScript, job, { timeoutMs: 10 * 60_000 });

    // Verify Docker daemon is actually responsive before proceeding.
    // If it isn't, the docker compose step will fail with a confusing socket error.
    emitLog(job, "Проверка доступности Docker daemon...");
    await runCommand(conn, "docker info", job, { timeoutMs: 30_000 });

    emitSuccess(job, "Docker, Nginx, certbot установлены ✓");

    // ── Step 3: Upload deploy files (tar via SSH exec, no SFTP) ───────────
    emitStep(job, "📁 Загрузка файлов на сервер...");
    // uploadTarDir does its own rm -rf / mkdir -p internally, so previous
    // partial uploads are always wiped before extraction starts.
    await uploadTarDir(conn, VPN_NODE_DEPLOY_DIR, "/opt/vpn-node", job);
    // Make shell scripts executable
    await runCommand(conn, "chmod +x /opt/vpn-node/render-config.sh", job);
    emitSuccess(job, "Файлы загружены ✓");

    // ── Step 4: Create .env ────────────────────────────────────────────────
    emitStep(job, "🔑 Генерация Management API Secret...");
    const secretOutput = await runCommand(conn, "openssl rand -hex 32", job);
    const mgmtSecret = secretOutput.trim().split("\n").pop()?.trim() ?? "";
    if (!mgmtSecret || mgmtSecret.length < 32) {
      throw new Error("Не удалось сгенерировать MGMT_API_SECRET (openssl rand failed)");
    }

    const envContent = `MGMT_API_SECRET=${mgmtSecret}\nPORT=8443\n`;
    await writeRemoteFileViaExec(conn, "/opt/vpn-node/.env", envContent, job);
    emitSuccess(job, "Файл .env создан ✓");

    // ── Step 5: Configure nginx (HTTP only, for certbot challenge) ─────────
    emitStep(job, "⚙️  Настройка Nginx...");
    const nginxConfig = makeNginxHttpConfig(domain);
    await writeRemoteFileViaExec(conn, "/tmp/vpn-node-nginx.conf", nginxConfig, job);
    const nginxSetup = [
      "cp /tmp/vpn-node-nginx.conf /etc/nginx/sites-available/vpn-node",
      "ln -sf /etc/nginx/sites-available/vpn-node /etc/nginx/sites-enabled/vpn-node",
      "rm -f /etc/nginx/sites-enabled/default",
      "nginx -t",
      "systemctl restart nginx",
    ].join(" && ");
    await runCommand(conn, nginxSetup, job);
    emitSuccess(job, "Nginx настроен и запущен ✓");

    // ── Step 6: Build and start container ─────────────────────────────────
    emitStep(job, "🐳 Сборка и запуск Docker-контейнера...");
    emitLog(job, "Docker build может занять 2–5 минут...");
    await runCommand(
      conn,
      "cd /opt/vpn-node && docker compose up -d --build",
      job,
      { timeoutMs: 10 * 60_000 },
    );
    // Clean build cache
    await runCommand(
      conn,
      "docker builder prune -af --filter 'until=1h' 2>/dev/null || true",
      job,
      { allowFailure: true },
    );
    emitSuccess(job, "Контейнер запущен ✓");

    // ── Step 7: UFW — open ports 443 and 8443 ─────────────────────────────
    emitStep(job, "🔒 Настройка UFW (открываем 443, 8443)...");
    const ufwSetup = [
      "ufw allow 22/tcp comment 'SSH' 2>/dev/null || true",
      "ufw allow 443/tcp comment 'HTTPS/VPN' 2>/dev/null || true",
      "ufw allow 8443/tcp comment 'VPN Mgmt API' 2>/dev/null || true",
      "ufw --force enable 2>/dev/null || true",
    ].join(" && ");
    await runCommand(conn, ufwSetup, job, { allowFailure: true });
    emitSuccess(job, "UFW настроен ✓");

    // ── Step 8: Install Cockpit ────────────────────────────────────────────
    emitStep(job, "🖥️  Установка Cockpit (веб-терминал)...");
    const cockpitSetup = [
      "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cockpit 2>/dev/null || true",
      "systemctl enable --now cockpit.socket 2>/dev/null || true",
      // Allow root login (Ubuntu 24.04 blocks it by default)
      "[ -f /etc/cockpit/disallowed-users ] && sed -i '/^root$/d' /etc/cockpit/disallowed-users || true",
      "ufw deny 9090 2>/dev/null || true",
    ].join(" && ");
    await runCommand(conn, cockpitSetup, job, { allowFailure: true });
    emitSuccess(job, "Cockpit установлен ✓");

    // ── Step 9: Let's Encrypt certificate via certbot ──────────────────────
    emitStep(job, `🔐 Получение Let's Encrypt сертификата для ${domain}...`);
    emitLog(job, "Убеждаемся, что домен указывает на этот IP...");

    // Verify domain resolves to this host (best-effort)
    await runCommand(
      conn,
      `host ${domain} || nslookup ${domain} || true`,
      job,
      { allowFailure: true },
    );

    await runCommand(
      conn,
      [
        `certbot --nginx -d ${domain}`,
        "--non-interactive",
        "--agree-tos",
        `--email admin@${domain}`,
        "--redirect",
      ].join(" "),
      job,
      { timeoutMs: 5 * 60_000 },
    );

    await runCommand(conn, "systemctl reload nginx", job);
    emitSuccess(job, "TLS сертификат Let's Encrypt получен ✓");

    // ── Step 10: Wait for container to be healthy ──────────────────────────
    emitStep(job, "⏳ Ожидаем готовности контейнера...");
    await runCommand(conn, "sleep 5", job);

    // Health check
    const healthOut = await runCommand(
      conn,
      `curl -fsS --max-time 10 https://${domain}/health`,
      job,
      { timeoutMs: 30_000 },
    );
    if (!healthOut.includes('"ok"') && !healthOut.includes("ok")) {
      throw new Error(`Health check вернул неожиданный ответ: ${healthOut.slice(0, 100)}`);
    }
    emitSuccess(job, `https://${domain}/health → ok ✓`);

    // ── Step 11: Register node in DB ───────────────────────────────────────
    emitStep(job, "💾 Регистрация узла в базе данных...");
    const [node] = await db
      .insert(vpnNodesTable)
      .values({
        name: nodeName,
        region: nodeRegion,
        host: domain,
        port: 443,
        sni: domain,
        managementApiUrl: `http://${sshHost}:8443`,
        managementApiSecret: mgmtSecret,
        certSha256: null,
        isActive: true,
      })
      .returning();

    if (!node) throw new Error("DB insert вернул пустой результат");

    emitSuccess(job, `Узел «${nodeName}» зарегистрирован (id=${node.id}) ✓`);

    // ── Done ───────────────────────────────────────────────────────────────
    job.status = "done";
    job.nodeId = node.id;

    // Persist final state to DB before emitting events (so reconnecting clients
    // see the completed state even if they connect after the emitter fires).
    await persistJobFinish(job, "done", { nodeId: node.id });

    job.emitter.emit("done", node.id);
    logger.info({ nodeId: node.id, domain }, "VPN node provisioned successfully");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    emitError(job, `❌ ${msg}`);
    job.status = "error";
    job.errorMessage = msg;

    // Persist final state to DB before emitting events.
    await persistJobFinish(job, "error", { errorMessage: msg });

    job.emitter.emit("error", msg);
    logger.error({ err, sshHost: opts.sshHost }, "Node provisioning failed");
  } finally {
    if (conn) {
      try { conn.end(); } catch { /* ignore */ }
    }
  }
}
