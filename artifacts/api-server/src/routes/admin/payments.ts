import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, paymentsTable, plansTable, subscriptionsTable, usersTable } from "@workspace/db";
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
    .innerJoin(subscriptionsTable, eq(paymentsTable.subscriptionId, subscriptionsTable.id))
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(query.data.status ? eq(paymentsTable.status, query.data.status) : undefined)
    .orderBy(desc(paymentsTable.createdAt));

  res.json(
    ListAdminPaymentsResponse.parse(
      rows.map(({ payment, userEmail, planName }) => ({ ...payment, userEmail, planName })),
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

  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.id, payment.subscriptionId));

  if (!subscription) {
    res.status(404).json({ error: "Subscription not found" });
    return;
  }

  // Idempotency guard: the payment.status check above already blocks most
  // double-confirm races, but this catches the case where the subscription
  // row itself was already activated (e.g. by a concurrent request that won
  // the race between the two selects above).
  if (subscription.status === "active") {
    res.status(409).json({ error: "Subscription is already active" });
    return;
  }

  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, subscription.planId));

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  // If the user already has another currently-active subscription (e.g. they
  // paid for a renewal before their current period ran out), chain the new
  // period onto the end of it instead of restarting the clock from now and
  // silently discarding the remaining paid-for time.
  const [currentActive] = await db
    .select()
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, subscription.userId), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.endsAt))
    .limit(1);

  const now = new Date();
  const startsAt = currentActive?.endsAt && currentActive.endsAt > now ? currentActive.endsAt : now;
  const endsAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  // Both writes must land together: if the process died between them we'd
  // otherwise end up with either an activated subscription backed by an
  // unconfirmed payment, or a confirmed payment for a subscription that was
  // never actually activated.
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

      return updatedPay;
    });
  } catch {
    res.status(409).json({ error: "Payment or subscription state changed concurrently, please retry" });
    return;
  }

  res.json(ConfirmPaymentResponse.parse(updatedPayment));
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
      await tx
        .update(subscriptionsTable)
        .set({ status: "rejected" })
        .where(
          and(eq(subscriptionsTable.id, payment.subscriptionId), eq(subscriptionsTable.status, "pending_payment")),
        );

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

  res.json(RejectPaymentResponse.parse(updatedPayment));
});

export default router;
