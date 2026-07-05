import { Router, type IRouter } from "express";
import { GetMeResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { buildMeData } from "../lib/meResponse";

const router: IRouter = Router();

router.get("/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  res.json(GetMeResponse.parse(await buildMeData(user)));
});

export default router;
