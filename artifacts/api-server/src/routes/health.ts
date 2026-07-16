import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  // `build` is a deploy marker (not in the zod schema on purpose) so we can
  // verify which build Amvera is actually serving. Bump on FK-related deploys.
  res.json({ ...data, build: "2026-07-16-fk42" });
});

export default router;
