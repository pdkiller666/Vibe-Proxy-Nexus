import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, plansTable } from "@workspace/db";
import { ListPlansResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/plans", async (_req, res): Promise<void> => {
  // Promo plans are hidden from the public listing — they can only be assigned
  // via admin invite links (referral campaigns, limited-time offers, etc.).
  const plans = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.isPromo, false))
    .orderBy(asc(plansTable.priceRub));
  res.json(ListPlansResponse.parse(plans));
});

export default router;
