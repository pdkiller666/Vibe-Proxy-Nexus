import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { startProvisioning, getJob, getJobFromDb } from "../../lib/sshProvisioner";

// Defined inline to avoid workspace-package resolution issues during tsc.
// The shape must stay in sync with the openapi.yaml VpnNodeProvisionInput schema.
const ProvisionVpnNodeBody = z.object({
  sshHost:     z.string().min(1),
  sshUser:     z.string().min(1),
  sshPassword: z.string().min(1),
  domain:      z.string().min(1),
  nodeName:    z.string().min(1),
  nodeRegion:  z.string().min(1),
});

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /admin/vpn-nodes/provision
// Start an automated SSH provisioning job. Returns { jobId } immediately;
// the client polls GET /admin/vpn-nodes/provision/:jobId/logs for progress.
// ---------------------------------------------------------------------------
router.post(
  "/admin/vpn-nodes/provision",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = ProvisionVpnNodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const jobId = await startProvisioning(parsed.data);
    res.status(202).json({ jobId });
  },
);

// ---------------------------------------------------------------------------
// GET /admin/vpn-nodes/provision/:jobId/logs  (Server-Sent Events)
// Streams provisioning progress to the client.
//
// On connect the server replays all buffered log lines so the client always
// sees the full history — whether the job is still running, already finished,
// or was loaded from the database after a server restart.
//
// Event format:
//   data: { "type": "log",   "ts": 123, "text": "...", "level": "info" }
//   data: { "type": "done",  "nodeId": 5 }
//   data: { "type": "error", "message": "..." }
// ---------------------------------------------------------------------------
router.get(
  "/admin/vpn-nodes/provision/:jobId/logs",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const { jobId } = req.params;

    // Fast path: job is still alive in memory (active or recently finished).
    const liveJob = getJob(jobId as string);

    if (liveJob) {
      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
      res.flushHeaders();

      const send = (payload: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      // Replay already-buffered log lines
      for (const line of liveJob.logs) {
        send({ type: "log", ...line });
      }

      // If job is already finished, send the terminal event and close
      if (liveJob.status === "done") {
        send({ type: "done", nodeId: liveJob.nodeId });
        res.end();
        return;
      }
      if (liveJob.status === "error") {
        send({ type: "error", message: liveJob.errorMessage });
        res.end();
        return;
      }

      // Subscribe to future events
      const onLog = (line: { ts: number; text: string; level: string }) => {
        send({ type: "log", ...line });
      };
      const onDone = (nodeId: number) => {
        send({ type: "done", nodeId });
        res.end();
      };
      const onError = (message: string) => {
        send({ type: "error", message });
        res.end();
      };

      liveJob.emitter.on("log", onLog);
      liveJob.emitter.once("done", onDone);
      liveJob.emitter.once("error", onError);

      // Clean up listeners when the client disconnects
      req.on("close", () => {
        liveJob.emitter.off("log", onLog);
        liveJob.emitter.off("done", onDone);
        liveJob.emitter.off("error", onError);
      });

      return;
    }

    // Slow path: job is no longer in memory — load historical state from DB.
    // This covers the case where the server restarted while the job was running
    // or after a TTL eviction of a completed job.
    const dbJob = await getJobFromDb(jobId as string);

    if (!dbJob) {
      res.status(404).json({ error: "Provisioning job not found" });
      return;
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (payload: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Replay all persisted log lines
    for (const line of dbJob.logs) {
      send({ type: "log", ...line });
    }

    if (dbJob.status === "done") {
      send({ type: "done", nodeId: dbJob.nodeId });
    } else if (dbJob.status === "error") {
      send({ type: "error", message: dbJob.errorMessage });
    } else {
      // Job was "running" when the server crashed — treat as error so the UI
      // doesn't hang forever waiting for an SSE event that will never arrive.
      send({ type: "error", message: "Сервер был перезапущен во время провижинга. Проверьте состояние VPS вручную." });
    }

    res.end();
  },
);

export default router;
