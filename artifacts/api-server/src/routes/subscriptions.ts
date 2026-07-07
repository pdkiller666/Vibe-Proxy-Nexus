import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, paymentsTable } from "@workspace/db";
import { CreateSubscriptionBody, CreateSubscriptionResponse, ListMySubscriptionsResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { generatePaymentReference } from "../lib/vless";
import { logger } from "../lib/logger";

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

  // #3 — Yookassa is not integrated. Block at API level to prevent orphaned
  // pending subscriptions that will never be auto-confirmed.
  if (parsed.data.provider === "yookassa") {
    res.status(400).json({ error: "Оплата через Yookassa временно недоступна. Используйте СБП." });
    return;
  }

  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, parsed.data.planId));

  if (!plan || !plan.isActive) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  // #1 — Prevent multiple pending subscriptions. A user must pay for the
  // existing one or cancel it before opening a new one. Without this check,
  // a user could spam the "Subscribe" button and flood the admin queue.
  const [existingPending] = await db
    .select({ id: subscriptionsTable.id })
    .from(subscriptionsTable)
    .where(
      and(
        eq(subscriptionsTable.userId, user.id),
        eq(subscriptionsTable.status, "pending_payment"),
      ),
    )
    .limit(1);

  if (existingPending) {
    res.status(409).json({
      error: "У вас уже есть подписка, ожидающая оплаты. Оплатите её или отмените, прежде чем создавать новую.",
      existingSubscriptionId: existingPending.id,
    });
    return;
  }

  // Both writes must land together: if the process died between them we'd
  // otherwise end up with a "pending_payment" subscription that has no
  // payment record to ever confirm it, leaving the user stuck.
  let created;
  try {
    created = await db.transaction(async (tx) => {
      const [subscription] = await tx
        .insert(subscriptionsTable)
        .values({
          userId: user.id,
          planId: plan.id,
          status: "pending_payment",
        })
        .returning();

      if (!subscription) {
        throw new Error("Failed to create subscription");
      }

      const [payment] = await tx
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
        throw new Error("Failed to create payment");
      }

      return { subscription, payment };
    });
  } catch (err) {
    logger.error({ err }, "Failed to create subscription with payment");
    res.status(500).json({ error: "Failed to create subscription" });
    return;
  }

  const { subscription, payment } = created;

  res.status(201).json(
    CreateSubscriptionResponse.parse({
      subscription: { ...subscription, plan },
      payment,
    }),
  );
});

// #5 — Allow the user to cancel their own pending_payment subscription.
// Only subscriptions that have not yet been confirmed by an admin can be
// cancelled. Atomically sets subscription → cancelled and payment → rejected.
router.delete("/subscriptions/:id", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const subscriptionId = Number(req.params.id);

  if (!subscriptionId || Number.isNaN(subscriptionId)) {
    res.status(400).json({ error: "Invalid subscription id" });
    return;
  }

  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(
      and(
        eq(subscriptionsTable.id, subscriptionId),
        eq(subscriptionsTable.userId, user.id),
      ),
    );

  if (!subscription) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }

  if (subscription.status !== "pending_payment") {
    res.status(409).json({
      error: "Можно отменить только подписку в статусе ожидания оплаты.",
    });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      // Optimistic lock: if another request changed the status concurrently,
      // this WHERE clause won't match, throwing via the check below.
      const [updated] = await tx
        .update(subscriptionsTable)
        .set({ status: "cancelled" })
        .where(
          and(
            eq(subscriptionsTable.id, subscription.id),
            eq(subscriptionsTable.status, "pending_payment"),
          ),
        )
        .returning({ id: subscriptionsTable.id });

      if (!updated) {
        throw new Error("Subscription status changed concurrently");
      }

      await tx
        .update(paymentsTable)
        .set({ status: "rejected", rejectionReason: "Отменено пользователем" })
        .where(
          and(
            eq(paymentsTable.subscriptionId, subscription.id),
            eq(paymentsTable.status, "pending"),
          ),
        );
    });
  } catch {
    res.status(409).json({ error: "Не удалось отменить подписку. Возможно, её уже обработал администратор." });
    return;
  }

  res.json({ ok: true });
});

export default router;
