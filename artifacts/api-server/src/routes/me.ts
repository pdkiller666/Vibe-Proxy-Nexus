import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, plansTable, subscriptionsTable } from "@workspace/db";
import { GetMeResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.get("/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const [activeSubscription] = await db
    .select({
      endsAt: subscriptionsTable.endsAt,
      planName: plansTable.name,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(and(eq(subscriptionsTable.userId, user.id), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.endsAt))
    .limit(1);

  res.json(
    GetMeResponse.parse({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      hasActiveSubscription: Boolean(activeSubscription),
      currentPlanName: activeSubscription?.planName ?? null,
      subscriptionEndsAt: activeSubscription?.endsAt ?? null,
    }),
  );
});

export default router;
