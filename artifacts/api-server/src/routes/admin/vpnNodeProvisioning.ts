import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { startProvisioning, getJob } from "../../lib/sshProvisioner";

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

    const jobId = startProvisioning(parsed.data);
    res.status(202).json({ jobId });
  },
);

// ---------------------------------------------------------------------------
// GET /admin/vpn-nodes/provision/:jobId/logs  (Server-Sent Events)
// Streams provisioning progress to the client.
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
  (req, res): void => {
    const { jobId } = req.params;
    const job = getJob(jobId as string);

    if (!job) {
      res.status(404).json({ error: "Provisioning job not found" });
      return;
    }

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
    for (const line of job.logs) {
      send({ type: "log", ...line });
    }

    // If job is already finished, send the terminal event and close
    if (job.status === "done") {
      send({ type: "done", nodeId: job.nodeId });
      res.end();
      return;
    }
    if (job.status === "error") {
      send({ type: "error", message: job.errorMessage });
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

    job.emitter.on("log", onLog);
    job.emitter.once("done", onDone);
    job.emitter.once("error", onError);

    // Clean up listeners when the client disconnects
    req.on("close", () => {
      job.emitter.off("log", onLog);
      job.emitter.off("done", onDone);
      job.emitter.off("error", onError);
    });
  },
);

export default router;
