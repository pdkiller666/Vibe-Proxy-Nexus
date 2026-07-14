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
  type Payment,
} from "@workspace/db";
import { ensureActiveKeyForUser } from "./keyIssuance";

export type ConfirmResult =
  | { ok: true; payment: Payment }
  | { ok: false; status: number; error: string };

/**
 * Shared payment confirmation logic used by both the admin manual-confirm
 * endpoint and the FreeKassa auto-webhook. Any change to the fulfillment
 * logic (subscription activation, balance credit, referral commission, etc.)
 * must be made here — not duplicated across callers.
 */
export async function confirmPaymentById(
  paymentId: number,
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
        if (!sub || sub.status !== "active")
          throw new Error("SUBSCRIPTION_NOT_ACTIVE");
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
        return { updatedPay, userId: sub.userId };
      });
      // Outside the transaction, same rationale as the subscription branch
      // below: if the user's keys were revoked for exceeding the old limit,
      // make sure they end up with at least one usable key again now that
      // the cap has been raised.
      await ensureActiveKeyForUser(updatedPayment.userId);
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
      payment.provider === "freekassa" ? "FreeKassa" : "СБП";
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
        return updatedPay;
      });
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

  const [currentActive] = await db
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

  const now = new Date();
  const startsAt =
    currentActive?.endsAt && currentActive.endsAt > now
      ? currentActive.endsAt
      : now;
  const endsAt = new Date(
    startsAt.getTime() + plan.durationDays * 24 * 60 * 60 * 1000,
  );

  try {
    const updatedPayment = await db.transaction(async (tx) => {
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

    return { ok: true, payment: updatedPayment };
  } catch {
    return {
      ok: false,
      status: 409,
      error: "Payment or subscription state changed concurrently, please retry",
    };
  }
}
