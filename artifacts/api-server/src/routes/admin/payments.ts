import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, paymentsTable, plansTable, subscriptionsTable, usersTable, vpnKeysTable, balanceTransactionsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import {
  ConfirmPaymentParams,
  ConfirmPaymentResponse,
  ListAdminPaymentsQueryParams,
  ListAdminPaymentsResponse,
  RejectPaymentBody,
  RejectPaymentParams,
  RejectPaymentResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

function withHasScreenshot<T extends { screenshotData: string | null; screenshotMimeType: string | null }>(
  payment: T,
) {
  const { screenshotData, screenshotMimeType: _screenshotMimeType, ...rest } = payment;
  return { ...rest, hasScreenshot: Boolean(screenshotData) };
}

router.get("/admin/payments", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const query = ListAdminPaymentsQueryParams.safeParse(req.query);

  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const rows = await db
    .select({
      payment: paymentsTable,
      userEmail: usersTable.email,
      planName: plansTable.name,
    })
    .from(paymentsTable)
    .innerJoin(usersTable, eq(paymentsTable.userId, usersTable.id))
    .leftJoin(subscriptionsTable, eq(paymentsTable.subscriptionId, subscriptionsTable.id))
    .leftJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(query.data.status ? eq(paymentsTable.status, query.data.status) : undefined)
    .orderBy(desc(paymentsTable.createdAt));

  res.json(
    ListAdminPaymentsResponse.parse(
      rows.map(({ payment, userEmail, planName }) => {
        const { screenshotData, screenshotMimeType: _screenshotMimeType, ...rest } = payment;
        return { ...rest, userEmail, planName: planName ?? null, hasScreenshot: Boolean(screenshotData) };
      }),
    ),
  );
});

router.post("/admin/payments/:paymentId/confirm", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = ConfirmPaymentParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.id, params.data.paymentId));

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  if (payment.status !== "pending") {
    res.status(409).json({ error: "Payment is not pending" });
    return;
  }

  // Extra device slot: increment user's extra slots instead of activating a subscription
  if (payment.type === "extra_device_slot") {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payment.userId));

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    let updatedPayment;
    try {
      updatedPayment = await db.transaction(async (tx) => {
        await tx
          .update(usersTable)
          .set({ extraDeviceSlots: user.extraDeviceSlots + 1 })
          .where(eq(usersTable.id, user.id));

        const [updatedPay] = await tx
          .update(paymentsTable)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(and(eq(paymentsTable.id, payment.id), eq(paymentsTable.status, "pending")))
          .returning();

        if (!updatedPay) {
          throw new Error("Payment state changed concurrently");
        }

        return updatedPay;
      });
    } catch {
      res.status(409).json({ error: "Payment state changed concurrently, please retry" });
      return;
    }

    res.json(ConfirmPaymentResponse.parse(withHasScreenshot(updatedPayment)));
    return;
  }

  // Balance top-up: credit balance_kopecks and log the transaction
  if (payment.type === "balance_topup") {
    const amountKopecks = payment.amountRub * 100;
    let updatedPayment;
    try {
      updatedPayment = await db.transaction(async (tx) => {
        // Atomically increment balance
        await tx
          .update(usersTable)
          .set({ balanceKopecks: (await tx.select({ bal: usersTable.balanceKopecks }).from(usersTable).where(eq(usersTable.id, payment.userId)).then(([r]) => (r?.bal ?? 0))) + amountKopecks })
          .where(eq(usersTable.id, payment.userId));

        await tx.insert(balanceTransactionsTable).values({
          userId: payment.userId,
          amountKopecks,
          type: "topup",
          paymentId: payment.id,
          description: `Пополнение через СБП — ${payment.amountRub} ₽`,
        });

        const [updatedPay] = await tx
          .update(paymentsTable)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(and(eq(paymentsTable.id, payment.id), eq(paymentsTable.status, "pending")))
          .returning();

        if (!updatedPay) {
          throw new Error("Payment state changed concurrently");
        }

        return updatedPay;
      });
    } catch {
      res.status(409).json({ error: "Payment state changed concurrently, please retry" });
      return;
    }

    res.json(ConfirmPaymentResponse.parse(withHasScreenshot(updatedPayment)));
    return;
  }

  // Subscription payment
  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.id, payment.subscriptionId!));

  if (!subscription) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }

  if (subscription.status === "active") {
    res.status(409).json({ error: "Subscription is already active" });
    return;
  }

  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, subscription.planId));

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const [currentActive] = await db
    .select()
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, subscription.userId), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.endsAt))
    .limit(1);

  const now = new Date();
  const startsAt = currentActive?.endsAt && currentActive.endsAt > now ? currentActive.endsAt : now;
  const endsAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  let updatedPayment;
  try {
    updatedPayment = await db.transaction(async (tx) => {
      const [updatedSubscription] = await tx
        .update(subscriptionsTable)
        .set({ status: "active", startsAt, endsAt })
        .where(and(eq(subscriptionsTable.id, subscription.id), eq(subscriptionsTable.status, subscription.status)))
        .returning();

      if (!updatedSubscription) {
        throw new Error("Subscription state changed concurrently");
      }

      const [updatedPay] = await tx
        .update(paymentsTable)
        .set({ status: "confirmed", confirmedAt: new Date() })
        .where(and(eq(paymentsTable.id, payment.id), eq(paymentsTable.status, "pending")))
        .returning();

      if (!updatedPay) {
        throw new Error("Payment state changed concurrently");
      }

      // Renewal starts a fresh traffic-tracking period for this user's
      // active keys: zero the "period" counters (lifetime counters are
      // untouched) so the admin panel's per-period traffic view reflects
      // consumption since this activation/renewal, not the account's
      // entire history.
      await tx
        .update(vpnKeysTable)
        .set({ periodUpBytes: 0, periodDownBytes: 0, periodStartedAt: new Date() })
        .where(and(eq(vpnKeysTable.userId, subscription.userId), isNull(vpnKeysTable.revokedAt)));

      return updatedPay;
    });
  } catch {
    res.status(409).json({ error: "Payment or subscription state changed concurrently, please retry" });
    return;
  }

  res.json(ConfirmPaymentResponse.parse(withHasScreenshot(updatedPayment)));
});

router.post("/admin/payments/:paymentId/reject", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = RejectPaymentParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = RejectPaymentBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.id, params.data.paymentId));

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  if (payment.status !== "pending") {
    res.status(409).json({ error: "Payment is not pending" });
    return;
  }

  let updatedPayment;
  try {
    updatedPayment = await db.transaction(async (tx) => {
      // Only update subscription status if this is a subscription payment
      if (payment.type === "subscription" && payment.subscriptionId) {
        await tx
          .update(subscriptionsTable)
          .set({ status: "rejected" })
          .where(
            and(eq(subscriptionsTable.id, payment.subscriptionId), eq(subscriptionsTable.status, "pending_payment")),
          );
      }

      const [updatedPay] = await tx
        .update(paymentsTable)
        .set({ status: "rejected", rejectionReason: parsed.data.reason })
        .where(and(eq(paymentsTable.id, payment.id), eq(paymentsTable.status, "pending")))
        .returning();

      if (!updatedPay) {
        throw new Error("Payment state changed concurrently");
      }

      return updatedPay;
    });
  } catch {
    res.status(409).json({ error: "Payment or subscription state changed concurrently, please retry" });
    return;
  }

  res.json(RejectPaymentResponse.parse(withHasScreenshot(updatedPayment)));
});

export default router;
