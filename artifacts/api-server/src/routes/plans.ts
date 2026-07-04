import { Router, type IRouter } from "express";
import { asc } from "drizzle-orm";
import { db, plansTable } from "@workspace/db";
import { ListPlansResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/plans", async (_req, res): Promise<void> => {
  const plans = await db.select().from(plansTable).orderBy(asc(plansTable.priceRub));
  res.json(ListPlansResponse.parse(plans));
});

export default router;
