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
import {
  isReferralCommissionEligible,
  isReferralCommissionProvider,
} from "./referralEligibility";
import { lockCurrentSubscription } from "./subscription";

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
        !isReferralCommissionEligible(payment)
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
        // Lock and re-read the payment before touching the subscription. The
        // database FK only guarantees that the subscription exists; ownership
        // is a separate invariant that must be checked before the increment.
        const [lockedPayment] = await tx
          .select({
            status: paymentsTable.status,
            userId: paymentsTable.userId,
            subscriptionId: paymentsTable.subscriptionId,
          })
          .from(paymentsTable)
          .where(eq(paymentsTable.id, payment.id))
          .for("update");
        if (
          !lockedPayment ||
          lockedPayment.status !== "pending" ||
          lockedPayment.subscriptionId !== payment.subscriptionId
        ) {
          throw new Error("PAYMENT_STATE_CHANGED");
        }

        const [sub] = await tx
          .select({
            id: subscriptionsTable.id,
            userId: subscriptionsTable.userId,
            status: subscriptionsTable.status,
          })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.id, payment.subscriptionId!))
          .for("update");
        if (!sub || sub.userId !== lockedPayment.userId) {
          throw new Error("PAYMENT_SUBSCRIPTION_OWNER_MISMATCH");
        }
        if (sub.status !== "active")
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
      if (err instanceof Error && err.message === "PAYMENT_SUBSCRIPTION_OWNER_MISMATCH") {
        return {
          ok: false,
          status: 409,
          error: "Payment does not belong to the selected subscription",
        };
      }
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
        // The balance checkout path may replace a pending manual-SBP order
        // while this confirmation is in flight. Lock and re-check the payment
        // before granting traffic so a stale read cannot grant twice.
        const [lockedPayment] = await tx
          .select({
            status: paymentsTable.status,
            userId: paymentsTable.userId,
            subscriptionId: paymentsTable.subscriptionId,
          })
          .from(paymentsTable)
          .where(eq(paymentsTable.id, payment.id))
          .for("update");
        if (
          !lockedPayment ||
          lockedPayment.status !== "pending" ||
          lockedPayment.subscriptionId !== payment.subscriptionId
        ) {
          throw new Error("PAYMENT_STATE_CHANGED");
        }

        // Extra-traffic policy: payment.userId is authoritative, while a
        // linked subscription may be redirected only when it belongs to that
        // same user (for example, after a renewal). Reject malformed or
        // imported cross-owner pairs before changing either row.
        const [linkedSub] = await tx
          .select({ userId: subscriptionsTable.userId })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.id, lockedPayment.subscriptionId!))
          .for("update");
        if (!linkedSub || linkedSub.userId !== lockedPayment.userId) {
          throw new Error("PAYMENT_SUBSCRIPTION_OWNER_MISMATCH");
        }

        // Lock and read the user's CURRENT subscription in one step —
        // lockCurrentSubscription (subscription.ts) is the single canonical
        // "most-recently-started, not-yet-expired, status='active'" row
        // selector shared by issueKeyForUser's serialization lock
        // (keyIssuance.ts) and enforceTrafficLimits' re-check
        // (trafficPolling.ts). Always crediting THIS exact row — never a
        // separately-queried "fallback" — guarantees all three code paths
        // lock and act on the same subscription, so their locks actually
        // serialize against each other instead of silently targeting
        // different rows when the user happens to have more than one
        // 'active' row (e.g. payment.subscriptionId pointing at one that
        // has since lapsed by date but hasn't been swept yet).
        const currentSub = await lockCurrentSubscription(tx, payment.userId);
        if (!currentSub) throw new Error("SUBSCRIPTION_NOT_ACTIVE");
        const targetSubId = currentSub.id;
        const targetUserId = currentSub.userId;

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
      if (err instanceof Error && err.message === "PAYMENT_SUBSCRIPTION_OWNER_MISMATCH") {
        return {
          ok: false,
          status: 409,
          error: "Payment does not belong to the selected subscription",
        };
      }
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
      // Lock and re-read both rows before taking any fulfillment action.
      // The FK on payments.subscriptionId only guarantees that the
      // subscription exists; it does not guarantee that both rows belong to
      // the same user. Imported or manually edited data must never activate
      // one user's subscription from another user's payment.
      const [lockedPayment] = await tx
        .select({
          status: paymentsTable.status,
          userId: paymentsTable.userId,
          subscriptionId: paymentsTable.subscriptionId,
        })
        .from(paymentsTable)
        .where(eq(paymentsTable.id, payment.id))
        .for("update");
      if (!lockedPayment || lockedPayment.status !== "pending") {
        throw new Error("Payment state changed concurrently");
      }
      if (lockedPayment.subscriptionId !== subscription.id) {
        throw new Error("Payment state changed concurrently");
      }

      const [lockedSubscription] = await tx
        .select({
          status: subscriptionsTable.status,
          userId: subscriptionsTable.userId,
        })
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.id, subscription.id))
        .for("update");
      if (!lockedSubscription || lockedSubscription.status === "active") {
        throw new Error("Subscription state changed concurrently");
      }
      if (lockedPayment.userId !== lockedSubscription.userId) {
        throw new Error("PAYMENT_SUBSCRIPTION_OWNER_MISMATCH");
      }

      // Subscription activation is a per-user critical section. Locking only
      // the subscription being activated is insufficient: two confirmations
      // for different pending rows would take different locks and could both
      // calculate the same startsAt. The shared user-row lock makes every
      // activation for this subscriber run strictly in sequence.
      await tx.execute(
        sql`SELECT id FROM users WHERE id = ${lockedPayment.userId} FOR UPDATE`,
      );

      // Lock and re-check the exact rows after acquiring the per-user lock.
      // This also protects against a same-payment retry whose pre-transaction
      // reads became stale while it waited for another confirmation to commit.
      const [paymentAfterUserLock] = await tx
        .select({ status: paymentsTable.status })
        .from(paymentsTable)
        .where(eq(paymentsTable.id, payment.id))
        .for("update");
      if (!paymentAfterUserLock || paymentAfterUserLock.status !== "pending") {
        throw new Error("Payment state changed concurrently");
      }

      const [subscriptionAfterUserLock] = await tx
        .select({ status: subscriptionsTable.status })
        .from(subscriptionsTable)
        .where(eq(subscriptionsTable.id, subscription.id))
        .for("update");
      if (!subscriptionAfterUserLock || subscriptionAfterUserLock.status === "active") {
        throw new Error("Subscription state changed concurrently");
      }

      // Re-read currentActive inside the transaction after the user lock so
      // startsAt/endsAt reflect the preceding confirmation's committed row.
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
            eq(subscriptionsTable.status, lockedSubscription.status),
          ),
        )
        .returning();
      if (!updatedSubscription)
        throw new Error("Subscription state changed concurrently");

      await tx
        .update(subscriptionsTable)
        // A fixed-duration predecessor already ends exactly where this new
        // paid period starts. Retire its status without truncating endsAt;
        // overwriting it with now would discard the period just chained above.
        // Hourly activation is an immediate switch, so it still closes the
        // previous period at the switch instant.
        .set(isHourly ? { status: "expired", endsAt: now } : { status: "expired" })
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
      if (
        isReferralCommissionEligible(payment) &&
        payer?.referredByUserId &&
        payer.referredByUserId !== subscription.userId
      ) {
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
            // The partial unique index is the source of truth for exactly-once
            // crediting. Only the transaction that inserted the ledger row may
            // mutate the referrer's balance.
            const [commission] = await tx
              .insert(balanceTransactionsTable)
              .values({
                userId: payer.referredByUserId,
                amountKopecks: commissionKopecks,
                type: "referral",
                paymentId: payment.id,
                description: `Реферальное вознаграждение (${percent}%) за оплату подписки — ${payment.amountRub} ₽`,
              })
              .onConflictDoNothing()
              .returning({ id: balanceTransactionsTable.id });
            if (commission) {
              await tx
                .update(usersTable)
                .set({
                  balanceKopecks: sql`${usersTable.balanceKopecks} + ${commissionKopecks}`,
                })
                .where(eq(usersTable.id, payer.referredByUserId));
            }
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
  } catch (err) {
    if (err instanceof Error && err.message === "PAYMENT_SUBSCRIPTION_OWNER_MISMATCH") {
      return {
        ok: false,
        status: 409,
        error: "Payment does not belong to the selected subscription",
      };
    }
    return {
      ok: false,
      status: 409,
      error: "Payment or subscription state changed concurrently, please retry",
    };
  }
}

export type PaymentRefundKind = "refund" | "chargeback";

export type RefundResult =
  | { ok: true; payment: Payment }
  | { ok: false; status: number; error: string };

/**
 * Mark a confirmed external payment as returned/charged back. Subscription
 * payments reverse their referral commission, while balance top-ups reverse
 * the wallet credit itself. Payment state, balance mutation, and ledger
 * entries share one transaction so provider/admin retries cannot duplicate
 * either correction.
 *
 * This does not pretend to send money back to the provider and does not
 * silently revoke service already delivered; it records the provider-side
 * refund/chargeback and removes the corresponding internal liability.
 */
export async function refundPaymentById(
  paymentId: number,
  kind: PaymentRefundKind = "refund",
  reason?: string,
): Promise<RefundResult> {
  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.id, paymentId));

  if (!payment) return { ok: false, status: 404, error: "Payment not found" };
  if (payment.status === "refunded") return { ok: true, payment };
  if (payment.status !== "confirmed") {
    return {
      ok: false,
      status: 409,
      error: "Only a confirmed payment can be refunded",
    };
  }
  if (!isReferralCommissionProvider(payment.provider)) {
    return {
      ok: false,
      status: 409,
      error: "Only external payments can be refunded",
    };
  }

  try {
    const updatedPayment = await db.transaction(async (tx) => {
      const [lockedPayment] = await tx
        .select()
        .from(paymentsTable)
        .where(eq(paymentsTable.id, payment.id))
        .for("update");

      if (!lockedPayment) throw new Error("PAYMENT_REFUND_STATE_CHANGED");
      if (lockedPayment.status === "refunded") return lockedPayment;
      if (lockedPayment.status !== "confirmed") {
        throw new Error("PAYMENT_REFUND_STATE_CHANGED");
      }
      if (!isReferralCommissionProvider(lockedPayment.provider)) {
        throw new Error("PAYMENT_REFUND_PROVIDER_NOT_ALLOWED");
      }

      if (lockedPayment.type === "balance_topup") {
        // A confirmed top-up created this wallet credit. Reverse that exact
        // amount, not a referral commission. The payment row is locked above,
        // so the status transition and this correction are one idempotent
        // critical section. A negative balance is intentional when the user
        // already spent the credited funds.
        const [existingRefund] = await tx
          .select({ id: balanceTransactionsTable.id })
          .from(balanceTransactionsTable)
          .where(
            and(
              eq(balanceTransactionsTable.paymentId, lockedPayment.id),
              eq(balanceTransactionsTable.type, "refund"),
            ),
          )
          .limit(1)
          .for("update");

        if (!existingRefund) {
          const refundKopecks = lockedPayment.amountRub * 100;
          await tx
            .update(usersTable)
            .set({
              balanceKopecks: sql`${usersTable.balanceKopecks} - ${refundKopecks}`,
            })
            .where(eq(usersTable.id, lockedPayment.userId));
          await tx.insert(balanceTransactionsTable).values({
            userId: lockedPayment.userId,
            amountKopecks: -refundKopecks,
            type: "refund",
            paymentId: lockedPayment.id,
            description:
              kind === "chargeback"
                ? `Возврат пополнения: chargeback по платежу #${lockedPayment.id}`
                : `Возврат пополнения по платежу #${lockedPayment.id}`,
          });
        }
      } else {
        const [commission] = await tx
          .select({
            id: balanceTransactionsTable.id,
            userId: balanceTransactionsTable.userId,
            amountKopecks: balanceTransactionsTable.amountKopecks,
          })
          .from(balanceTransactionsTable)
          .where(
            and(
              eq(balanceTransactionsTable.paymentId, lockedPayment.id),
              eq(balanceTransactionsTable.type, "referral"),
            ),
          )
          .for("update");

        if (commission && commission.amountKopecks > 0) {
          const [reversal] = await tx
            .insert(balanceTransactionsTable)
            .values({
              userId: commission.userId,
              amountKopecks: -commission.amountKopecks,
              type: "referral_reversal",
              paymentId: lockedPayment.id,
              description:
                kind === "chargeback"
                  ? `Отмена реферального вознаграждения: chargeback по платежу #${lockedPayment.id}`
                  : `Отмена реферального вознаграждения: возврат по платежу #${lockedPayment.id}`,
            })
            .onConflictDoNothing()
            .returning({ id: balanceTransactionsTable.id });

          if (reversal) {
            // A negative balance is intentional: spending the commission before
            // a chargeback must not turn the returned amount into free credit.
            await tx
              .update(usersTable)
              .set({
                balanceKopecks: sql`${usersTable.balanceKopecks} - ${commission.amountKopecks}`,
              })
              .where(eq(usersTable.id, commission.userId));
          }
        }
      }

      const [updated] = await tx
        .update(paymentsTable)
        .set({
          status: "refunded",
          refundKind: kind,
          refundReason: reason ?? null,
          refundedAt: new Date(),
        })
        .where(
          and(
            eq(paymentsTable.id, lockedPayment.id),
            eq(paymentsTable.status, "confirmed"),
          ),
        )
        .returning();
      if (!updated) throw new Error("PAYMENT_REFUND_STATE_CHANGED");
      return updated;
    });

    return { ok: true, payment: updatedPayment };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "PAYMENT_REFUND_PROVIDER_NOT_ALLOWED"
    ) {
      return {
        ok: false,
        status: 409,
        error: "Only external payments can be refunded",
      };
    }
    if (err instanceof Error && err.message === "PAYMENT_REFUND_STATE_CHANGED") {
      return {
        ok: false,
        status: 409,
        error: "Payment state changed concurrently, please retry",
      };
    }
    throw err;
  }
}
