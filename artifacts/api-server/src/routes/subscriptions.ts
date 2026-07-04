import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, paymentsTable } from "@workspace/db";
import { CreateSubscriptionBody, CreateSubscriptionResponse, ListMySubscriptionsResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { generatePaymentReference } from "../lib/vless";

const router: IRouter = Router();

router.get("/subscriptions/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const rows = await db
    .select({
      subscription: subscriptionsTable,
      plan: plansTable,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(eq(subscriptionsTable.userId, user.id))
    .orderBy(desc(subscriptionsTable.createdAt));

  res.json(
    ListMySubscriptionsResponse.parse(
      rows.map(({ subscription, plan }) => ({ ...subscription, plan })),
    ),
  );
});

router.post("/subscriptions", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const parsed = CreateSubscriptionBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, parsed.data.planId));

  if (!plan || !plan.isActive) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const [subscription] = await db
    .insert(subscriptionsTable)
    .values({
      userId: user.id,
      planId: plan.id,
      status: "pending_payment",
    })
    .returning();

  if (!subscription) {
    res.status(500).json({ error: "Failed to create subscription" });
    return;
  }

  const [payment] = await db
    .insert(paymentsTable)
    .values({
      subscriptionId: subscription.id,
      userId: user.id,
      provider: parsed.data.provider ?? "manual_sbp",
      amountRub: plan.priceRub,
      status: "pending",
      reference: generatePaymentReference(subscription.id),
    })
    .returning();

  if (!payment) {
    res.status(500).json({ error: "Failed to create payment" });
    return;
  }

  res.status(201).json(
    CreateSubscriptionResponse.parse({
      subscription: { ...subscription, plan },
      payment,
    }),
  );
});

export default router;
