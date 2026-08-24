import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { PostBalanceCheckoutBody } from "@workspace/api-zod";
import { checkoutFromBalance } from "../lib/balanceCheckout";

const router: IRouter = Router();

/**
 * POST /api/balance-checkout
 *
 * Instantly pays for a subscription, extra device slot, or extra traffic
 * from the user's wallet balance. Never creates a pending/moderated payment —
 * the payment is created as pending, immediately confirmed via confirmPaymentById,
 * and the balance is debited atomically. On confirm failure the balance is refunded.
 *
 * Errors:
 *   409 — feature flag balancePaymentsEnabled=false
 *   400 — invalid target (hourly plan, zero price, no active subscription, etc.)
 *   402 — insufficient balance { error: "insufficient_balance", balanceKopecks, requiredKopecks }
 *   500 — unexpected technical error (balance refunded automatically)
 */
router.post("/balance-checkout", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const parsed = PostBalanceCheckoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { target, planId, pendingPaymentId } = parsed.data;

  // A new subscription needs its planId. An existing pending subscription
  // checkout can provide pendingPaymentId instead; the service reads the plan
  // from the locked source order.
  if (target === "subscription" && !planId && !pendingPaymentId) {
    res.status(400).json({ error: "planId обязателен для target=subscription" });
    return;
  }

  const checkoutTarget =
    target === "subscription"
      ? { kind: "subscription" as const, planId, pendingPaymentId }
      : target === "extra_device_slot"
        ? { kind: "extra_device_slot" as const }
        : { kind: "extra_traffic" as const, pendingPaymentId };

  const outcome = await checkoutFromBalance(user.id, checkoutTarget);

  if (!outcome.ok) {
    if (outcome.status === 402) {
      res.status(402).json({
        error: outcome.error,
        balanceKopecks: outcome.balanceKopecks,
        requiredKopecks: outcome.requiredKopecks,
      });
      return;
    }
    if (outcome.status === 409) {
      const messages = {
        feature_disabled: "Оплата с баланса временно отключена.",
        payment_in_progress: "Оплата с баланса уже обрабатывается. Подождите несколько секунд.",
        pending_payment_not_found: "Эта заявка на оплату не найдена. Обновите страницу.",
        pending_payment_not_pending: "Этот платёж уже обработан. Обновите страницу, чтобы увидеть актуальный статус.",
        pending_payment_id_required: "Для оплаты этой заявки с баланса обновите страницу и попробуйте ещё раз.",
      } as const;
      res.status(409).json({ error: messages[outcome.error] });
      return;
    }
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }

  res.json({
    paymentId: outcome.result.paymentId,
    type: outcome.result.type,
    amountRub: outcome.result.amountRub,
    subscription: outcome.result.subscription ?? null,
  });
});

export default router;
