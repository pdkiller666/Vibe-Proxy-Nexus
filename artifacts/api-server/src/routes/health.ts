import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  // `build` is a deploy marker (not in the zod schema on purpose) so we can
  // verify which build Amvera is actually serving after a production deploy.
  res.json({ ...data, build: "2026-09-27-ws-tls-pin" });
});

export default router;
