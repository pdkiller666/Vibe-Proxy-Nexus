import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, paymentsTable, paymentSettingsTable, plansTable, subscriptionsTable, usersTable, vpnKeysTable, balanceTransactionsTable } from "@workspace/db";
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

  // Extra device slot: increment the slot count on the subscription the
  // order was placed against (extraDeviceSlots lives on subscriptions, not
  // users — see schema comment) instead of activating a new subscription.
  if (payment.type === "extra_device_slot") {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, payment.userId));

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (!payment.subscriptionId) {
      res.status(409).json({ error: "У платежа не указана подписка — невозможно начислить слот." });
      return;
    }

    let updatedPayment;
    try {
      updatedPayment = await db.transaction(async (tx) => {
        const [sub] = await tx
          .select({ id: subscriptionsTable.id, status: subscriptionsTable.status, extraDeviceSlots: subscriptionsTable.extraDeviceSlots })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.id, payment.subscriptionId!));

        if (!sub || sub.status !== "active") {
          throw new Error("SUBSCRIPTION_NOT_ACTIVE");
        }

        await tx
          .update(subscriptionsTable)
          .set({ extraDeviceSlots: sub.extraDeviceSlots + 1 })
          .where(eq(subscriptionsTable.id, sub.id));

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
    } catch (err) {
      if (err instanceof Error && err.message === "SUBSCRIPTION_NOT_ACTIVE") {
        res.status(409).json({ error: "Подписка, к которой относится платёж, больше не активна — слот не начислен." });
        return;
      }
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
        // Atomically increment balance in the SQL itself (not read-then-write
        // in application code) so two concurrent confirmations never lose an
        // update under read-committed isolation.
        await tx
          .update(usersTable)
          .set({ balanceKopecks: sql`${usersTable.balanceKopecks} + ${amountKopecks}` })
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
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
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

      // Retire any other subscription still marked "active" for this user
      // (e.g. an hourly plan with no endsAt, or a plan the user just
      // switched away from). Without this, two rows can both say "active"
      // at once: the dashboard's "/me" and the admin panel's "current plan"
      // queries pick between them differently, so one screen shows the old
      // plan and the other shows the new one. Only one subscription should
      // ever be "active" for a user at a time.
      await tx
        .update(subscriptionsTable)
        .set({ status: "expired", endsAt: now })
        .where(
          and(
            eq(subscriptionsTable.userId, subscription.userId),
            eq(subscriptionsTable.status, "active"),
            sql`${subscriptionsTable.id} != ${updatedSubscription.id}`,
          ),
        );

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

      // Referral commission: only for real subscription payments (not
      // extra-slot or balance-topup purchases — those branches return
      // earlier above and never reach here), and only if the payer was
      // referred by someone and the admin has set a non-zero rate.
      const [payer] = await tx.select({ referredByUserId: usersTable.referredByUserId }).from(usersTable).where(eq(usersTable.id, subscription.userId));
      if (payer?.referredByUserId) {
        const [settings] = await tx.select({ referralCommissionPercent: paymentSettingsTable.referralCommissionPercent }).from(paymentSettingsTable).limit(1);
        const percent = settings?.referralCommissionPercent ?? 0;
        if (percent > 0) {
          const commissionKopecks = Math.round((payment.amountRub * percent * 100) / 100);
          const [referrer] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, payer.referredByUserId));
          if (referrer) {
            // Atomic increment (see balance_topup branch above) — avoids a
            // lost update if two of this referrer's referrals are confirmed
            // concurrently.
            await tx
              .update(usersTable)
              .set({ balanceKopecks: sql`${usersTable.balanceKopecks} + ${commissionKopecks}` })
              .where(eq(usersTable.id, payer.referredByUserId));

            await tx.insert(balanceTransactionsTable).values({
              userId: payer.referredByUserId,
              amountKopecks: commissionKopecks,
              type: "referral",
              paymentId: payment.id,
              description: `Реферальное вознаграждение (${percent}%) за оплату подписки — ${payment.amountRub} ₽`,
            });
          }
        }
      }

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
