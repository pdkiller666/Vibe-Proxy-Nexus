import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
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

  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, subscription.planId));

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

  await db
    .update(subscriptionsTable)
    .set({ status: "active", startsAt, endsAt })
    .where(eq(subscriptionsTable.id, subscription.id));

  const [updatedPayment] = await db
    .update(paymentsTable)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(eq(paymentsTable.id, payment.id))
    .returning();

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

  await db
    .update(subscriptionsTable)
    .set({ status: "rejected" })
    .where(eq(subscriptionsTable.id, payment.subscriptionId));

  const [updatedPayment] = await db
    .update(paymentsTable)
    .set({ status: "rejected", rejectionReason: parsed.data.reason })
    .where(eq(paymentsTable.id, payment.id))
    .returning();

  res.json(RejectPaymentResponse.parse(updatedPayment));
});

export default router;
