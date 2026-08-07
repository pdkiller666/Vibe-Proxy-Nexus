/**
 * balanceCheckout.ts — thin orchestrator for instant balance-funded payments.
 *
 * Pattern (ТЗ v2.1 §4.1):
 *   fast-path: pre-tx dedup check (confirmed only, avoids lock on browser retries)
 *   tx1: lock user row (FOR UPDATE)
 *        → dedup re-check (confirmed OR pending) — catches concurrent requests
 *        → create pending_payment subscription (subscription type only, INSIDE tx)
 *        → check balance → insert payment(pending, provider='balance')
 *        → debit balance → insert balance_transaction(debit)
 *   outside tx: confirmPaymentById(paymentId)
 *   on confirm error → compensate(): reject payment (only if still pending) + refund
 *
 * Concurrency/idempotency guarantees:
 *   - FOR UPDATE serialises concurrent checkouts for the same user.
 *   - Inner dedup re-checks after the lock: a concurrent loser finds the winner's
 *     pending payment and returns 409 payment_in_progress; no second debit.
 *   - Subscription creation is inside tx1, so retries/losers never create orphaned
 *     pending_payment subscription rows.
 *   - compensate() gates the balance refund on a successful pending→rejected
 *     transition: if confirmPaymentById somehow confirmed the payment before
 *     returning failure, the WHERE-status guard prevents a double-credit.
 */

import { and, desc, eq, gt, or, sql } from "drizzle-orm";
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

// ── Public types ─────────────────────────────────────────────────────────────

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
  | { status: 409; error: "feature_disabled" | "payment_in_progress" }
  | { status: 400; error: string }
  | { status: 402; error: "insufficient_balance"; balanceKopecks: number; requiredKopecks: number }
  | { status: 500; error: string };

export type BalanceCheckoutOutcome =
  | { ok: true; result: BalanceCheckoutResult }
  | { ok: false } & BalanceCheckoutError;

// ── Internal types ───────────────────────────────────────────────────────────

/** Resolved BEFORE the tx — no DB writes, only validation reads. */
type TargetMeta =
  | {
      ok: true;
      paymentType: "subscription";
      amountRub: number;
      planId: number;
      planName: string;
      /** subscriptionId is null until created inside tx1. */
      subscriptionId: null;
      extraTrafficGb: null;
    }
  | {
      ok: true;
      paymentType: "extra_device_slot" | "extra_traffic";
      amountRub: number;
      subscriptionId: number;
      extraTrafficGb: number | null;
    }
  | { ok: false; status: 400; error: string };

/** Discriminated result from tx1. */
type TxOutcome =
  | { kind: "new"; paymentId: number; subscriptionId: number | null }
  | { kind: "dedup_confirmed"; paymentId: number; subscriptionId: number | null }
  | { kind: "dedup_pending" };

// ── Constants ────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 60_000;

// ── Main export ───────────────────────────────────────────────────────────────

export async function checkoutFromBalance(
  userId: number,
  target: BalanceCheckoutTarget,
): Promise<BalanceCheckoutOutcome> {
  // 1. Feature flag
  const [settings] = await db.select().from(paymentSettingsTable).limit(1);
  if (!settings?.balancePaymentsEnabled) {
    return { ok: false, status: 409, error: "feature_disabled" };
  }

  // 2. Resolve amount & type — validation reads only, NO DB writes
  const meta = await resolveTargetMeta(userId, target, settings);
  if (!meta.ok) return meta;

  const { amountRub, paymentType } = meta;

  if (amountRub <= 0) {
    return {
      ok: false,
      status: 400,
      error: "Цена не установлена. Обратитесь к администратору или используйте стандартный способ оплаты.",
    };
  }

  const requiredKopecks = amountRub * 100;

  // 3. Fast-path dedup (confirmed only) — skips the lock for sequential retries
  const fastDedup = await checkDedup(userId, paymentType, amountRub, false);
  if (fastDedup) return { ok: true, result: fastDedup };

  // 4. tx1: lock → inner dedup → create sub (if new) → check balance → debit
  let txOutcome: TxOutcome;
  try {
    txOutcome = await db.transaction(async (tx) => {
      // FOR UPDATE serialises concurrent checkouts for the same user row.
      const [user] = await tx
        .select({ id: usersTable.id, balanceKopecks: usersTable.balanceKopecks })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .for("update");

      // Inner dedup: re-check after lock (catches concurrent races).
      // Covers both confirmed and pending so a concurrent in-flight request
      // is detected before a second debit occurs.
      const since = new Date(Date.now() - DEDUP_WINDOW_MS);
      const [existingPayment] = await tx
        .select({ id: paymentsTable.id, status: paymentsTable.status, subscriptionId: paymentsTable.subscriptionId })
        .from(paymentsTable)
        .where(
          and(
            eq(paymentsTable.userId, userId),
            eq(paymentsTable.provider, "balance"),
            eq(paymentsTable.type, paymentType),
            eq(paymentsTable.amountRub, amountRub),
            gt(paymentsTable.createdAt, since),
            or(eq(paymentsTable.status, "confirmed"), eq(paymentsTable.status, "pending")),
          ),
        )
        .limit(1);

      if (existingPayment) {
        if (existingPayment.status === "confirmed") {
          return {
            kind: "dedup_confirmed" as const,
            paymentId: existingPayment.id,
            subscriptionId: existingPayment.subscriptionId ?? null,
          };
        }
        // Pending = concurrent request in-flight — block the second one
        return { kind: "dedup_pending" as const };
      }

      // ── New payment path ─────────────────────────────────────────────────

      // Balance check (after lock, so value is fresh)
      const balance = user?.balanceKopecks ?? 0;
      if (balance < requiredKopecks) {
        throw Object.assign(new Error("INSUFFICIENT_BALANCE"), { balanceKopecks: balance, requiredKopecks });
      }

      // Create pending_payment subscription INSIDE tx (only for subscription type).
      // This ensures retries and concurrent losers never produce orphaned rows.
      let subscriptionId: number | null = meta.subscriptionId; // null for subscription type
      if (meta.paymentType === "subscription") {
        const now = new Date();
        const [currentActive] = await tx
          .select({ endsAt: subscriptionsTable.endsAt })
          .from(subscriptionsTable)
          .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
          .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
          .limit(1);

        const [newSub] = await tx
          .insert(subscriptionsTable)
          .values({
            userId,
            planId: meta.planId,
            status: "pending_payment",
            startsAt: currentActive?.endsAt && currentActive.endsAt > now ? currentActive.endsAt : now,
          })
          .returning({ id: subscriptionsTable.id });

        if (!newSub) throw new Error("Failed to create subscription");
        subscriptionId = newSub.id;
      }

      // Build audit description (needs subscriptionId / plan name resolved above)
      const description = buildDescription(meta, subscriptionId);

      const reference = generatePaymentReference(userId * 10_000 + (Date.now() % 10_000));

      const [payment] = await tx
        .insert(paymentsTable)
        .values({
          userId,
          subscriptionId: subscriptionId ?? undefined,
          type: paymentType,
          provider: "balance",
          amountRub,
          extraTrafficGb: meta.extraTrafficGb ?? undefined,
          status: "pending",
          reference,
        })
        .returning({ id: paymentsTable.id });

      if (!payment) throw new Error("Failed to insert payment");

      // Atomic balance debit (no read-modify-write)
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

      return { kind: "new" as const, paymentId: payment.id, subscriptionId };
    });
  } catch (err: unknown) {
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

  // 5. Handle inner-dedup outcomes (no new debit happened)
  if (txOutcome.kind === "dedup_confirmed") {
    const subscription = await fetchSubscription(paymentType, txOutcome.subscriptionId);
    logger.info({ userId, paymentId: txOutcome.paymentId }, "balance_checkout: inner dedup hit (confirmed)");
    return { ok: true, result: { paymentId: txOutcome.paymentId, type: paymentType, amountRub, subscription } };
  }

  if (txOutcome.kind === "dedup_pending") {
    logger.info({ userId }, "balance_checkout: inner dedup hit (pending) — concurrent request blocked");
    return { ok: false, status: 409, error: "payment_in_progress" };
  }

  const { paymentId, subscriptionId } = txOutcome;

  // 6. Confirm outside tx (activates subscription / grants slot-traffic / referral)
  const confirmResult = await confirmPaymentById(paymentId);

  if (!confirmResult.ok) {
    await compensate(paymentId, userId, requiredKopecks, confirmResult.error);
    logger.error({ paymentId, userId, confirmError: confirmResult.error },
      "balance_checkout: confirm failed — compensated");
    return { ok: false, status: 500, error: "Ошибка при активации. Баланс возвращён." };
  }

  const subscription = await fetchSubscription(paymentType, subscriptionId);

  return {
    ok: true,
    result: { paymentId, type: paymentType, amountRub, subscription },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveTargetMeta(
  userId: number,
  target: BalanceCheckoutTarget,
  settings: typeof paymentSettingsTable.$inferSelect,
): Promise<TargetMeta> {
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
    return {
      ok: true,
      paymentType: "subscription",
      amountRub: plan.priceRub,
      planId: plan.id,
      planName: plan.name,
      subscriptionId: null,
      extraTrafficGb: null,
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
    return {
      ok: true,
      paymentType: "extra_device_slot",
      amountRub: settings.extraDeviceSlotPriceRub ?? 0,
      subscriptionId: activeSub.id,
      extraTrafficGb: null,
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
  const packageGb = settings.extraTrafficPackageGb ?? 0;
  if (packageGb <= 0) {
    return { ok: false, status: 400, error: "Покупка дополнительного трафика временно недоступна." };
  }
  return {
    ok: true,
    paymentType: "extra_traffic",
    amountRub: settings.extraTrafficPriceRub ?? 0,
    subscriptionId: activeSub.id,
    extraTrafficGb: packageGb,
  };
}

function buildDescription(meta: TargetMeta & { ok: true }, _subscriptionId: number | null): string {
  if (meta.paymentType === "subscription") {
    return `Оплата с баланса: тариф ${meta.planName} — ${meta.amountRub} ₽`;
  }
  if (meta.paymentType === "extra_device_slot") {
    return `Оплата с баланса: доп. устройство — ${meta.amountRub} ₽`;
  }
  return `Оплата с баланса: доп. трафик ${meta.extraTrafficGb ?? 0} ГБ — ${meta.amountRub} ₽`;
}

async function fetchSubscription(
  paymentType: "subscription" | "extra_device_slot" | "extra_traffic",
  subscriptionId: number | null,
): Promise<Subscription | null> {
  if (paymentType !== "subscription" || subscriptionId == null) return null;
  const rows = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, subscriptionId));
  return rows[0] ?? null;
}

/**
 * Returns an existing balance-payment made within DEDUP_WINDOW_MS.
 * includePending=false (fast path): confirmed only.
 * includePending=true (inner lock): confirmed OR pending.
 */
async function checkDedup(
  userId: number,
  paymentType: "subscription" | "extra_device_slot" | "extra_traffic",
  amountRub: number,
  includePending: boolean,
): Promise<BalanceCheckoutResult | null> {
  const since = new Date(Date.now() - DEDUP_WINDOW_MS);
  const statusFilter = includePending
    ? or(eq(paymentsTable.status, "confirmed"), eq(paymentsTable.status, "pending"))
    : eq(paymentsTable.status, "confirmed");

  const [existing] = await db
    .select({ id: paymentsTable.id, subscriptionId: paymentsTable.subscriptionId })
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.userId, userId),
        eq(paymentsTable.provider, "balance"),
        eq(paymentsTable.type, paymentType),
        eq(paymentsTable.amountRub, amountRub),
        gt(paymentsTable.createdAt, since),
        statusFilter,
      ),
    )
    .limit(1);

  if (!existing) return null;

  const subscription = await fetchSubscription(paymentType, existing.subscriptionId ?? null);
  logger.info({ userId, paymentId: existing.id }, "balance_checkout: fast-path dedup hit");
  return { paymentId: existing.id, type: paymentType, amountRub, subscription };
}

/**
 * Compensation tx: reject the pending payment and refund the balance.
 *
 * The refund is GATED on a successful pending→rejected transition: if
 * confirmPaymentById somehow confirmed the payment before returning failure
 * (e.g. post-confirm key issuance throws), the WHERE status='pending' guard
 * prevents the payment from being re-rejected, and since no rows are updated
 * the balance credit is also skipped — avoiding a double-credit.
 */
async function compensate(
  paymentId: number,
  userId: number,
  refundKopecks: number,
  reason: string,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // Only proceed if the payment is still pending (not already confirmed by a partial confirm).
      const [updated] = await tx
        .update(paymentsTable)
        .set({ status: "rejected", rejectionReason: `balance_confirm_failed: ${reason}` })
        .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending")))
        .returning({ id: paymentsTable.id });

      if (!updated) {
        // Payment was already confirmed (partial-success from confirmPaymentById).
        // Do NOT refund — the user received the service.
        logger.warn({ paymentId, userId }, "balance_checkout: compensate skipped — payment not pending (already confirmed)");
        return;
      }

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
    logger.error({ err, paymentId, userId, refundKopecks }, "balance_checkout: compensation tx failed");
  }
}
