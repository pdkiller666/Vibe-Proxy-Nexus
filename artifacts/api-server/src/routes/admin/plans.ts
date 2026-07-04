import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, plansTable } from "@workspace/db";
import {
  CreatePlanBody,
  CreatePlanResponse,
  DeletePlanParams,
  UpdatePlanBody,
  UpdatePlanParams,
  UpdatePlanResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

router.post("/admin/plans", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreatePlanBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [plan] = await db.insert(plansTable).values(parsed.data).returning();
  res.status(201).json(CreatePlanResponse.parse(plan));
});

router.patch("/admin/plans/:planId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdatePlanParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePlanBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [plan] = await db
    .update(plansTable)
    .set(parsed.data)
    .where(eq(plansTable.id, params.data.planId))
    .returning();

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  res.json(UpdatePlanResponse.parse(plan));
});

router.delete("/admin/plans/:planId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = DeletePlanParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [plan] = await db.delete(plansTable).where(eq(plansTable.id, params.data.planId)).returning();

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
