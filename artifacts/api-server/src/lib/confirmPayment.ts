import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  paymentsTable,
  subscriptionsTable,
  plansTable,
  usersTable,
  vpnKeysTable,
  balanceTransactionsTable,
  paymentSettingsTable,
  systemEventsTable,
  type Payment,
} from "@workspace/db";
import { ensureActiveKeyForUser } from "./keyIssuance";

type PaymentNotificationOptions = {
  /** Background renewals use their own Dashboard notification and must never open the first-payment modal. */
  suppressReferralFirstOffer?: boolean;
};

/** Insert user-facing confirmation events. Best-effort — never throws. */
async function notifyPaymentConfirmed(payment: Payment, options: PaymentNotificationOptions = {}): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(systemEventsTable).values({
        eventType: "payment_confirmed",
        userId: payment.userId,
        metadata: {
          paymentId: payment.id,
          amountRub: payment.amountRub,
          type: payment.type,
        },
      });

      if (
        options.suppressReferralFirstOffer ||
        (payment.type !== "subscription" && payment.type !== "balance_topup")
      ) {
        return;
      }

      // Serialise referral-offer creation per user. This prevents two concurrent
      // confirmed payments from creating duplicate first-payment dialogs.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${payment.userId})`);
      const [settings] = await tx
        .select({ referralCommissionPercent: paymentSettingsTable.referralCommissionPercent })
        .from(paymentSettingsTable)
        .limit(1);
      if ((settings?.referralCommissionPercent ?? 0) <= 0) return;

      // This event is intentionally separate from payment_confirmed. The
      // referral card claims it cross-device, while the normal payment
      // confirmation stays visible until the user dismisses it themselves.
      await tx.insert(systemEventsTable).values({
        eventType: "referral_payment_offer",
        userId: payment.userId,
        metadata: { paymentId: payment.id, type: payment.type },
      });

      const [alreadyOffered] = await tx
        .select({ id: systemEventsTable.id })
        .from(systemEventsTable)
        .where(
          and(
            eq(systemEventsTable.userId, payment.userId),
            eq(systemEventsTable.eventType, "referral_first_payment_offer"),
          ),
        )
        .limit(1);
      if (alreadyOffered) return;

      await tx.insert(systemEventsTable).values({
        eventType: "referral_first_payment_offer",
        userId: payment.userId,
        metadata: { paymentId: payment.id, type: payment.type },
      });
    });
  } catch {
    // non-critical
  }
}

export type ConfirmResult =
  | { ok: true; payment: Payment }
  | { ok: false; status: number; error: string };

/**
 * Shared payment confirmation logic used by both the admin manual-confirm
 * endpoint and the YooMoney auto-webhook. Any change to the fulfillment
 * logic (subscription activation, balance credit, referral commission, etc.)
 * must be made here — not duplicated across callers.
 */
export async function confirmPaymentById(
  paymentId: number,
  notificationOptions: PaymentNotificationOptions = {},
): Promise<ConfirmResult> {
  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.id, paymentId));

  if (!payment) return { ok: false, status: 404, error: "Payment not found" };
  if (payment.status !== "pending")
    return { ok: false, status: 409, error: "Payment is not pending" };

  if (payment.type === "extra_device_slot") {
    if (!payment.subscriptionId) {
      return {
        ok: false,
        status: 409,
        error: "У платежа не указана подписка — невозможно начислить слот.",
      };
    }
    try {
      const updatedPayment = await db.transaction(async (tx) => {
        const [sub] = await tx
          .select({
            id: subscriptionsTable.id,
            status: subscriptionsTable.status,
          })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.id, payment.subscriptionId!));
        if (!sub || sub.status !== "active")
          throw new Error("SUBSCRIPTION_NOT_ACTIVE");
        // Atomic SQL increment — prevents lost update under concurrent confirmations
        await tx
          .update(subscriptionsTable)
          .set({
            extraDeviceSlots: sql`${subscriptionsTable.extraDeviceSlots} + 1`,
          })
          .where(eq(subscriptionsTable.id, sub.id));
        const [updatedPay] = await tx
          .update(paymentsTable)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(
            and(
              eq(paymentsTable.id, payment.id),
              eq(paymentsTable.status, "pending"),
            ),
          )
          .returning();
        if (!updatedPay) throw new Error("Payment state changed concurrently");
        return updatedPay;
      });
      await notifyPaymentConfirmed(updatedPayment, notificationOptions);
      return { ok: true, payment: updatedPayment };
    } catch (err) {
      if (err instanceof Error && err.message === "SUBSCRIPTION_NOT_ACTIVE") {
        return {
          ok: false,
          status: 409,
          error:
            "Подписка, к которой относится платёж, больше не активна — слот не начислен.",
        };
      }
      return {
        ok: false,
        status: 409,
        error: "Payment state changed concurrently, please retry",
      };
    }
  }

  if (payment.type === "extra_traffic") {
    if (!payment.subscriptionId) {
      return {
        ok: false,
        status: 409,
        error: "У платежа не указана подписка — невозможно начислить трафик.",
      };
    }
    const grantedGb = payment.extraTrafficGb ?? 0;
    try {
      const updatedPayment = await db.transaction(async (tx) => {
        const [sub] = await tx
          .select({ id: subscriptionsTable.id, status: subscriptionsTable.status, userId: subscriptionsTable.userId })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.id, payment.subscriptionId!));

        // If the original subscription is no longer active (e.g. the user
        // renewed between creating the payment and admin confirming it), fall
        // back to the user's current active subscription so the paid traffic
        // is not silently lost.
        let targetSubId: number;
        let targetUserId: number;
        if (!sub || sub.status !== "active") {
          const [currentActive] = await tx
            .select({ id: subscriptionsTable.id, userId: subscriptionsTable.userId })
            .from(subscriptionsTable)
            .where(
              and(
                eq(subscriptionsTable.userId, payment.userId),
                eq(subscriptionsTable.status, "active"),
              ),
            )
            .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
            .limit(1);
          if (!currentActive) throw new Error("SUBSCRIPTION_NOT_ACTIVE");
          targetSubId = currentActive.id;
          targetUserId = currentActive.userId;
        } else {
          targetSubId = sub.id;
          targetUserId = sub.userId;
        }

        // Atomic increment (same pattern as extra_device_slot above) plus
        // clearing the exceeded flag so a blocked user regains the ability
        // to issue a key immediately, without waiting for the next
        // enforcement poll or a full renewal.
        await tx
          .update(subscriptionsTable)
          .set({
            extraTrafficGb: sql`${subscriptionsTable.extraTrafficGb} + ${grantedGb}`,
            trafficLimitExceededAt: null,
          })
          .where(eq(subscriptionsTable.id, targetSubId));

        // If we redirected to a different subscription, update the payment
        // record so the audit trail reflects where traffic was actually applied.
        if (targetSubId !== payment.subscriptionId!) {
          await tx
            .update(paymentsTable)
            .set({ subscriptionId: targetSubId })
            .where(eq(paymentsTable.id, payment.id));
        }

        const [updatedPay] = await tx
          .update(paymentsTable)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(
            and(
              eq(paymentsTable.id, payment.id),
              eq(paymentsTable.status, "pending"),
            ),
          )
          .returning();
        if (!updatedPay) throw new Error("Payment state changed concurrently");
        return { updatedPay, userId: targetUserId };
      });
      // Outside the transaction, same rationale as the subscription branch
      // below: if the user's keys were revoked for exceeding the old limit,
      // make sure they end up with at least one usable key again now that
      // the cap has been raised.
      await ensureActiveKeyForUser(updatedPayment.userId);
      await notifyPaymentConfirmed(updatedPayment.updatedPay, notificationOptions);
      return { ok: true, payment: updatedPayment.updatedPay };
    } catch (err) {
      if (err instanceof Error && err.message === "SUBSCRIPTION_NOT_ACTIVE") {
        return {
          ok: false,
          status: 409,
          error:
            "Подписка, к которой относится платёж, больше не активна — трафик не начислен.",
        };
      }
      return {
        ok: false,
        status: 409,
        error: "Payment state changed concurrently, please retry",
      };
    }
  }

  if (payment.type === "balance_topup") {
    const amountKopecks = payment.amountRub * 100;
    const providerLabel =
      payment.provider === "yoomoney" ? "ЮMoney" : "СБП";
    try {
      const updatedPayment = await db.transaction(async (tx) => {
        await tx
          .update(usersTable)
          .set({
            balanceKopecks: sql`${usersTable.balanceKopecks} + ${amountKopecks}`,
          })
          .where(eq(usersTable.id, payment.userId));
        await tx.insert(balanceTransactionsTable).values({
          userId: payment.userId,
          amountKopecks,
          type: "topup",
          paymentId: payment.id,
          description: `Пополнение через ${providerLabel} — ${payment.amountRub} ₽`,
        });
        const [updatedPay] = await tx
          .update(paymentsTable)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(
            and(
              eq(paymentsTable.id, payment.id),
              eq(paymentsTable.status, "pending"),
            ),
          )
          .returning();
        if (!updatedPay) throw new Error("Payment state changed concurrently");
        // Acknowledge any open balance_low warnings — the wallet is now topped up
        await tx
          .update(systemEventsTable)
          .set({ acknowledgedAt: new Date() })
          .where(
            and(
              eq(systemEventsTable.userId, payment.userId),
              eq(systemEventsTable.eventType, "balance_low"),
              isNull(systemEventsTable.acknowledgedAt),
            ),
          );
        return updatedPay;
      });
      await notifyPaymentConfirmed(updatedPayment, notificationOptions);
      return { ok: true, payment: updatedPayment };
    } catch {
      return {
        ok: false,
        status: 409,
        error: "Payment state changed concurrently, please retry",
      };
    }
  }

  // Subscription payment
  if (!payment.subscriptionId) {
    return {
      ok: false,
      status: 409,
      error: "Subscription payment has no subscriptionId",
    };
  }
  const [subscription] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.id, payment.subscriptionId));
  if (!subscription)
    return { ok: false, status: 404, error: "Subscription not found" };
  if (subscription.status === "active")
    return { ok: false, status: 409, error: "Subscription is already active" };

  const [plan] = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.id, subscription.planId));
  if (!plan) return { ok: false, status: 404, error: "Plan not found" };

  try {
    const updatedPayment = await db.transaction(async (tx) => {
      // Lock the subscription row being activated so two concurrent
      // confirmations (e.g. admin + YooMoney webhook arriving simultaneously)
      // cannot both read the same currentActive and compute the same startsAt,
      // which would make both subscriptions start at the same time instead of
      // in sequence. The FOR UPDATE lock serialises this critical section.
      await tx.execute(
        sql`SELECT id FROM subscriptions WHERE id = ${subscription.id} FOR UPDATE`,
      );

      // Re-read currentActive *inside* the transaction (after the lock) so
      // startsAt/endsAt reflect the true DB state at this moment, not a
      // snapshot taken before the transaction started.
      const now = new Date();
      const [currentActive] = await tx
        .select()
        .from(subscriptionsTable)
        .where(
          and(
            eq(subscriptionsTable.userId, subscription.userId),
            eq(subscriptionsTable.status, "active"),
          ),
        )
        .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
        .limit(1);

      // For hourly (usage-based) plans, always start immediately — never queue
      // behind a prior monthly subscription's endsAt. Queueing would place
      // startsAt in the future, causing ticksElapsed to be negative every tick
      // so billing silently skips forever until an admin manually fixes it.
      // Hourly plans also have no fixed end date (billing controls expiry).
      const isHourly = plan.billingType === "hourly";
      const startsAt = isHourly
        ? now
        : currentActive?.endsAt && currentActive.endsAt > now
          ? currentActive.endsAt
          : now;
      const endsAt = isHourly
        ? null
        : new Date(startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);

      const [updatedSubscription] = await tx
        .update(subscriptionsTable)
        .set({ status: "active", startsAt, endsAt })
        .where(
          and(
            eq(subscriptionsTable.id, subscription.id),
            eq(subscriptionsTable.status, subscription.status),
          ),
        )
        .returning();
      if (!updatedSubscription)
        throw new Error("Subscription state changed concurrently");

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
        .where(
          and(
            eq(paymentsTable.id, payment.id),
            eq(paymentsTable.status, "pending"),
          ),
        )
        .returning();
      if (!updatedPay) throw new Error("Payment state changed concurrently");

      // Acknowledge any open balance_low warnings — the user just activated a plan
      await tx
        .update(systemEventsTable)
        .set({ acknowledgedAt: new Date() })
        .where(
          and(
            eq(systemEventsTable.userId, subscription.userId),
            eq(systemEventsTable.eventType, "balance_low"),
            isNull(systemEventsTable.acknowledgedAt),
          ),
        );

      await tx
        .update(vpnKeysTable)
        .set({
          periodUpBytes: 0,
          periodDownBytes: 0,
          periodStartedAt: new Date(),
        })
        .where(
          and(
            eq(vpnKeysTable.userId, subscription.userId),
            isNull(vpnKeysTable.revokedAt),
          ),
        );

      const [payer] = await tx
        .select({ referredByUserId: usersTable.referredByUserId })
        .from(usersTable)
        .where(eq(usersTable.id, subscription.userId));
      if (payer?.referredByUserId) {
        const [settings] = await tx
          .select({
            referralCommissionPercent:
              paymentSettingsTable.referralCommissionPercent,
          })
          .from(paymentSettingsTable)
          .limit(1);
        const percent = settings?.referralCommissionPercent ?? 0;
        if (percent > 0) {
          const commissionKopecks = Math.round(
            (payment.amountRub * percent * 100) / 100,
          );
          const [referrer] = await tx
            .select({ id: usersTable.id })
            .from(usersTable)
            .where(eq(usersTable.id, payer.referredByUserId));
          if (referrer) {
            await tx
              .update(usersTable)
              .set({
                balanceKopecks: sql`${usersTable.balanceKopecks} + ${commissionKopecks}`,
              })
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
    // Outside the transaction — a hiccup here must never undo an already
    // confirmed payment. See ensureActiveKeyForUser's doc comment for why
    // this guarantee is needed even though nothing here deletes keys.
    await ensureActiveKeyForUser(subscription.userId);
    await notifyPaymentConfirmed(updatedPayment, notificationOptions);

    return { ok: true, payment: updatedPayment };
  } catch {
    return {
      ok: false,
      status: 409,
      error: "Payment or subscription state changed concurrently, please retry",
    };
  }
}
