/**
 * balanceCheckout.ts — thin orchestrator for instant balance-funded payments.
 *
 * Pattern (ТЗ v2.1 §4.1):
 *   tx1: lock user row → check balance → insert payment(pending, provider='balance')
 *        → debit balance → insert balance_transaction(debit)
 *   outside tx: confirmPaymentById(paymentId)   ← existing, unmodified
 *   on confirm error → tx2 compensation: reject payment + refund balance
 *
 * All downstream logic (subscription activation, referral commission, key
 * issuance) runs inside confirmPaymentById unchanged — for the system this is
 * just another confirmed payment.
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  db,
  paymentsTable,
  paymentSettingsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
  balanceTransactionsTable,
  type Payment,
  type Subscription,
} from "@workspace/db";
import { confirmPaymentById } from "./confirmPayment";
import { generatePaymentReference } from "./vless";
import { logger } from "./logger";

// ── Types ────────────────────────────────────────────────────────────────────

export type BalanceCheckoutTarget =
  | { kind: "subscription"; planId: number }
  | { kind: "extra_device_slot" }
  | { kind: "extra_traffic" };

export type BalanceCheckoutResult = {
  paymentId: number;
  type: "subscription" | "extra_device_slot" | "extra_traffic";
  amountRub: number;
  subscription: Subscription | null;
};

export type BalanceCheckoutError =
  | { status: 409; error: "feature_disabled" }
  | { status: 400; error: string }
  | { status: 402; error: "insufficient_balance"; balanceKopecks: number; requiredKopecks: number }
  | { status: 500; error: string };

export type BalanceCheckoutOutcome =
  | { ok: true; result: BalanceCheckoutResult }
  | { ok: false } & BalanceCheckoutError;

// ── Double-click guard window (ms) ───────────────────────────────────────────
const DEDUP_WINDOW_MS = 60_000;

// ── Main function ─────────────────────────────────────────────────────────────

export async function checkoutFromBalance(
  userId: number,
  target: BalanceCheckoutTarget,
): Promise<BalanceCheckoutOutcome> {
  // 1. Feature flag check
  const [settings] = await db.select().from(paymentSettingsTable).limit(1);
  if (!settings?.balancePaymentsEnabled) {
    return { ok: false, status: 409, error: "feature_disabled" };
  }

  // 2. Resolve amount, paymentType, and subscriptionId
  const resolved = await resolveTarget(userId, target, settings);
  if (!resolved.ok) return resolved;

  const { amountRub, paymentType, subscriptionId, extraTrafficGb, description } = resolved;

  // Amount 0 = not configured (or free grant path should be used)
  if (amountRub <= 0) {
    return {
      ok: false,
      status: 400,
      error: "Цена не установлена. Обратитесь к администратору или используйте стандартный способ оплаты.",
    };
  }

  const requiredKopecks = amountRub * 100;

  // 3. Double-click / retry dedup guard (before tx — low cost SELECT)
  const dedupResult = await checkDedup(userId, paymentType, amountRub);
  if (dedupResult) return { ok: true, result: dedupResult };

  // 4. tx1: lock user → check balance → insert payment(pending) → debit → debit tx
  let paymentId: number;
  try {
    paymentId = await db.transaction(async (tx) => {
      // FOR UPDATE locks the user row so concurrent checkouts serialize
      const [user] = await tx.execute(
        sql`SELECT id, balance_kopecks FROM users WHERE id = ${userId} FOR UPDATE`,
      ) as unknown as [{ id: number; balance_kopecks: number }];

      const balance = user?.balance_kopecks ?? 0;
      if (balance < requiredKopecks) {
        // Throw a typed sentinel to surface as 402 outside the transaction
        throw Object.assign(new Error("INSUFFICIENT_BALANCE"), {
          balanceKopecks: balance,
          requiredKopecks,
        });
      }

      const reference = generatePaymentReference(userId * 10_000 + (Date.now() % 10_000));

      const [payment] = await tx
        .insert(paymentsTable)
        .values({
          userId,
          subscriptionId: subscriptionId ?? undefined,
          type: paymentType,
          provider: "balance",
          amountRub,
          extraTrafficGb: extraTrafficGb ?? undefined,
          status: "pending",
          reference,
        })
        .returning({ id: paymentsTable.id });

      if (!payment) throw new Error("Failed to insert payment");

      // Debit balance (atomic SQL decrement — no read-modify-write)
      await tx
        .update(usersTable)
        .set({ balanceKopecks: sql`${usersTable.balanceKopecks} - ${requiredKopecks}` })
        .where(eq(usersTable.id, userId));

      // Audit trail
      await tx.insert(balanceTransactionsTable).values({
        userId,
        amountKopecks: -requiredKopecks,
        type: "debit",
        paymentId: payment.id,
        description,
      });

      return payment.id;
    });
  } catch (err: unknown) {
    // Typed sentinel from the balance check above
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
      const e = err as Error & { balanceKopecks: number; requiredKopecks: number };
      logger.warn({ userId, requiredKopecks: e.requiredKopecks, balanceKopecks: e.balanceKopecks },
        "balance_checkout: insufficient_balance");
      return {
        ok: false,
        status: 402,
        error: "insufficient_balance",
        balanceKopecks: e.balanceKopecks,
        requiredKopecks: e.requiredKopecks,
      };
    }
    logger.error({ err, userId }, "balance_checkout: tx1 failed");
    return { ok: false, status: 500, error: "Ошибка при обработке платежа. Попробуйте позже." };
  }

  // 5. Outside transaction: confirmPaymentById (activates subscription / grants slot-traffic / referral)
  const confirmResult = await confirmPaymentById(paymentId);

  if (!confirmResult.ok) {
    // tx2 compensation: reject payment + refund balance
    await compensate(paymentId, userId, requiredKopecks, confirmResult.error);
    logger.error({ paymentId, userId, confirmError: confirmResult.error },
      "balance_checkout: confirm failed — compensated");
    return { ok: false, status: 500, error: "Ошибка при активации. Баланс возвращён." };
  }

  // 6. Fetch activated subscription (for target=subscription responses)
  let subscription: Subscription | null = null;
  if (paymentType === "subscription" && subscriptionId != null) {
    const rows = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.id, subscriptionId));
    subscription = rows[0] ?? null;
  }

  return {
    ok: true,
    result: { paymentId, type: paymentType, amountRub, subscription },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type ResolvedTarget =
  | { ok: true; amountRub: number; paymentType: "subscription" | "extra_device_slot" | "extra_traffic"; subscriptionId: number | null; extraTrafficGb: number | null; description: string }
  | { ok: false; status: 400; error: string };

async function resolveTarget(
  userId: number,
  target: BalanceCheckoutTarget,
  settings: typeof paymentSettingsTable.$inferSelect,
): Promise<ResolvedTarget> {
  if (target.kind === "subscription") {
    const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, target.planId));
    if (!plan || !plan.isActive) {
      return { ok: false, status: 400, error: "Тариф не найден или недоступен." };
    }
    if (plan.billingType === "hourly") {
      return { ok: false, status: 400, error: "Почасовые тарифы оплачиваются с баланса автоматически. Используйте стандартный способ подключения." };
    }
    if (plan.priceRub <= 0) {
      return { ok: false, status: 400, error: "Этот тариф бесплатный — используйте стандартный способ активации." };
    }

    // Create a pending subscription row (confirmPaymentById needs a subscriptionId)
    const now = new Date();
    // Re-read current active subscription to compute chain correctly (mirrors subscriptions.ts)
    const [currentActive] = await db
      .select({ endsAt: subscriptionsTable.endsAt })
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
      .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
      .limit(1);

    // Pending subscription — confirmPaymentById activates it and sets startsAt/endsAt
    const [newSub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId: plan.id,
        status: "pending_payment",
        // Pre-compute tentative startsAt (confirmPaymentById will recalculate inside FOR UPDATE)
        startsAt: currentActive?.endsAt && currentActive.endsAt > now ? currentActive.endsAt : now,
      })
      .returning({ id: subscriptionsTable.id });

    if (!newSub) return { ok: false, status: 500 as never, error: "Не удалось создать подписку." };

    return {
      ok: true,
      amountRub: plan.priceRub,
      paymentType: "subscription",
      subscriptionId: newSub.id,
      extraTrafficGb: null,
      description: `Оплата с баланса: тариф ${plan.name} — ${plan.priceRub} ₽`,
    };
  }

  if (target.kind === "extra_device_slot") {
    const [activeSub] = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
      .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
      .limit(1);
    if (!activeSub) {
      return { ok: false, status: 400, error: "Нужна активная подписка для покупки дополнительного устройства." };
    }
    const amountRub = settings.extraDeviceSlotPriceRub ?? 0;
    return {
      ok: true,
      amountRub,
      paymentType: "extra_device_slot",
      subscriptionId: activeSub.id,
      extraTrafficGb: null,
      description: `Оплата с баланса: доп. устройство — ${amountRub} ₽`,
    };
  }

  // extra_traffic
  const [activeSub] = await db
    .select({ id: subscriptionsTable.id, trafficLimitGb: plansTable.trafficLimitGb })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  if (!activeSub) {
    return { ok: false, status: 400, error: "Нужна активная подписка для покупки дополнительного трафика." };
  }
  if (activeSub.trafficLimitGb == null) {
    return { ok: false, status: 400, error: "У вашего тарифа нет лимита трафика — докупка не требуется." };
  }
  const amountRub = settings.extraTrafficPriceRub ?? 0;
  const packageGb = settings.extraTrafficPackageGb ?? 0;
  if (packageGb <= 0) {
    return { ok: false, status: 400, error: "Покупка дополнительного трафика временно недоступна." };
  }
  return {
    ok: true,
    amountRub,
    paymentType: "extra_traffic",
    subscriptionId: activeSub.id,
    extraTrafficGb: packageGb,
    description: `Оплата с баланса: доп. трафик ${packageGb} ГБ — ${amountRub} ₽`,
  };
}

/** Returns an existing confirmed balance-payment made within DEDUP_WINDOW_MS — prevents double-charge on rapid retry. */
async function checkDedup(
  userId: number,
  paymentType: "subscription" | "extra_device_slot" | "extra_traffic",
  amountRub: number,
): Promise<BalanceCheckoutResult | null> {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const [existing] = await db
    .select({ id: paymentsTable.id, subscriptionId: paymentsTable.subscriptionId })
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.userId, userId),
        eq(paymentsTable.provider, "balance"),
        eq(paymentsTable.type, paymentType),
        eq(paymentsTable.amountRub, amountRub),
        eq(paymentsTable.status, "confirmed"),
        gt(paymentsTable.createdAt, since),
      ),
    )
    .limit(1);

  if (!existing) return null;

  let subscription: Subscription | null = null;
  if (paymentType === "subscription" && existing.subscriptionId != null) {
    const rows = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, existing.subscriptionId));
    subscription = rows[0] ?? null;
  }

  logger.info({ userId, paymentId: existing.id }, "balance_checkout: dedup hit — returning existing");
  return { paymentId: existing.id, type: paymentType, amountRub, subscription };
}

/** tx2 compensation: reject the pending payment and refund the balance. */
async function compensate(
  paymentId: number,
  userId: number,
  refundKopecks: number,
  reason: string,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(paymentsTable)
        .set({ status: "rejected", rejectionReason: `balance_confirm_failed: ${reason}` })
        .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending")));

      await tx
        .update(usersTable)
        .set({ balanceKopecks: sql`${usersTable.balanceKopecks} + ${refundKopecks}` })
        .where(eq(usersTable.id, userId));

      await tx.insert(balanceTransactionsTable).values({
        userId,
        amountKopecks: refundKopecks,
        type: "refund",
        paymentId,
        description: `Возврат: оплата с баланса отменена (${reason})`,
      });
    });
  } catch (err) {
    // Log but don't rethrow — the outer error already surfaces a 500
    logger.error({ err, paymentId, userId, refundKopecks }, "balance_checkout: compensation tx failed");
  }
}
