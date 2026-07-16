import { Router, type IRouter, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { confirmPaymentById } from "../lib/confirmPayment";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// YooMoney (ЮMoney) wallet payments — quickpay links + HTTP notifications.
//
// Flow:
//   1. GET /payments/yoomoney/checkout/:paymentId?method=card|wallet
//      → 302 to https://yoomoney.ru/quickpay/confirm with label=<payment.id>
//   2. User pays (bank card via AC, or their YooMoney wallet via PC).
//   3. YooMoney POSTs an x-www-form-urlencoded notification to
//      /payments/yoomoney/webhook with `label` and `sign` (HMAC-SHA256).
//   4. We verify the signature + amount and confirm the payment.
//
// Env: YOOMONEY_RECEIVER (wallet number 4100...), YOOMONEY_NOTIFICATION_SECRET
// (the secret from the wallet's HTTP-notification settings page).
// ─────────────────────────────────────────────────────────────────────────────

// quickpay paymentType values: AC = bank card, PC = YooMoney wallet.
// СБП is not selectable via quickpay params — it appears on YooMoney's own
// payment page when available for the receiver's wallet.
const YM_PAYMENT_TYPES = { card: "AC", wallet: "PC" } as const;
type YmMethod = keyof typeof YM_PAYMENT_TYPES;

const LABEL_PREFIX = "vpnexus-";

/**
 * Verify the `sign` parameter of a YooMoney HTTP notification.
 * Per docs: drop `sign`, sort keys A-Z, RFC-3986-encode each value,
 * join as key=value with "&", then HMAC-SHA256 (hex, lowercase) with the
 * notification secret.
 */
export function verifyYmSign(params: Record<string, string>, secret: string): boolean {
  const received = params.sign;
  if (!received || !/^[0-9a-f]{64}$/i.test(received)) return false;
  const str = Object.keys(params)
    .filter((k) => k !== "sign")
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k] ?? "")}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(str).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Checkout: redirect the user to the YooMoney quickpay page ───────────────
router.get("/payments/yoomoney/checkout/:paymentId", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const paymentId = Number(req.params.paymentId);

  if (!paymentId || Number.isNaN(paymentId)) {
    res.status(400).json({ error: "Invalid payment id" });
    return;
  }

  const receiver = process.env.YOOMONEY_RECEIVER ?? "";
  if (!receiver) {
    res.status(503).json({ error: "Оплата через ЮMoney не настроена" });
    return;
  }

  const [payment] = await db
    .select({
      id: paymentsTable.id,
      userId: paymentsTable.userId,
      amountRub: paymentsTable.amountRub,
      status: paymentsTable.status,
      type: paymentsTable.type,
      subscriptionId: paymentsTable.subscriptionId,
    })
    .from(paymentsTable)
    .where(eq(paymentsTable.id, paymentId));

  if (!payment || payment.userId !== user.id) {
    res.status(404).json({ error: "Платёж не найден" });
    return;
  }

  // Return URL — YooMoney redirects the user back after a successful payment.
  const origin = `${req.protocol}://${req.get("host")}`;
  let returnPath: string;
  if (payment.type === "balance_topup") {
    returnPath = `/balance-topup/${payment.id}`;
  } else if (payment.type === "extra_device_slot") {
    returnPath = `/checkout/slot/${payment.id}`;
  } else if (payment.type === "extra_traffic") {
    returnPath = `/checkout/traffic/${payment.id}`;
  } else {
    returnPath = `/checkout/${payment.subscriptionId ?? payment.id}`;
  }
  const successUrl = `${origin}${returnPath}`;

  if (payment.status !== "pending") {
    // Already confirmed/rejected — just send the user back to the status page.
    res.redirect(302, successUrl);
    return;
  }

  // Mark the payment as going through YooMoney (it may have been created as
  // manual_sbp by default) so admin/labels reflect the actual provider.
  await db.update(paymentsTable).set({ provider: "yoomoney" }).where(eq(paymentsTable.id, payment.id));

  const rawMethod = (req.query.method as string | undefined)?.toLowerCase();
  const method: YmMethod = rawMethod === "wallet" ? "wallet" : "card";

  // quickpay/confirm accepts GET params and shows the payment page.
  const url = new URL("https://yoomoney.ru/quickpay/confirm");
  url.searchParams.set("receiver", receiver);
  url.searchParams.set("quickpay-form", "button");
  url.searchParams.set("paymentType", YM_PAYMENT_TYPES[method]);
  url.searchParams.set("sum", String(payment.amountRub));
  url.searchParams.set("label", `${LABEL_PREFIX}${payment.id}`);
  url.searchParams.set("successURL", successUrl);

  logger.info({ paymentId: payment.id, method, amountRub: payment.amountRub, type: payment.type }, "YooMoney checkout — redirecting to quickpay");
  res.redirect(302, url.toString());
});

// ── Webhook: HTTP notification about an incoming transfer ───────────────────
// No session auth — verified via the HMAC-SHA256 `sign` parameter only.
// Must answer 200 for the notification to be considered delivered.
async function handleWebhook(req: Request, res: Response): Promise<void> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(req.query as Record<string, unknown>), ...(req.body as Record<string, unknown>) })) {
    params[k] = String(v ?? "");
  }

  const secret = process.env.YOOMONEY_NOTIFICATION_SECRET ?? "";

  // "Протестировать" button in YooMoney settings sends test_notification=true.
  const isTest = params.test_notification === "true";

  logger.info(
    { notification_type: params.notification_type, operation_id: params.operation_id, amount: params.amount, withdraw_amount: params.withdraw_amount, label: params.label, test: isTest },
    "YooMoney notification received",
  );

  if (!secret) {
    logger.error("YooMoney webhook: YOOMONEY_NOTIFICATION_SECRET not set");
    res.status(503).send("Not configured");
    return;
  }

  if (!verifyYmSign(params, secret)) {
    logger.warn({ operation_id: params.operation_id, label: params.label }, "YooMoney webhook: signature mismatch");
    res.status(400).send("Invalid signature");
    return;
  }

  if (isTest) {
    res.status(200).send("OK");
    return;
  }

  // codepro/unaccepted are documented as always false nowadays, but a held
  // transfer must never activate a subscription — reject defensively.
  if (params.codepro === "true" || params.unaccepted === "true") {
    logger.warn({ operation_id: params.operation_id }, "YooMoney webhook: held/protected transfer — ignoring");
    res.status(200).send("OK");
    return;
  }

  const label = params.label ?? "";
  if (!label.startsWith(LABEL_PREFIX)) {
    // Transfer unrelated to the shop (personal transfer etc.) — acknowledge.
    logger.info({ label }, "YooMoney webhook: foreign/no label, ignoring");
    res.status(200).send("OK");
    return;
  }

  const paymentId = Number(label.slice(LABEL_PREFIX.length));
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    logger.warn({ label }, "YooMoney webhook: malformed label");
    res.status(200).send("OK");
    return;
  }

  const [payment] = await db
    .select({ id: paymentsTable.id, status: paymentsTable.status, amountRub: paymentsTable.amountRub })
    .from(paymentsTable)
    .where(eq(paymentsTable.id, paymentId));

  if (!payment) {
    logger.error({ paymentId, label }, "YooMoney webhook: no payment found for label");
    res.status(200).send("OK");
    return;
  }

  if (payment.status === "confirmed") {
    res.status(200).send("OK"); // idempotent
    return;
  }

  // Amount check. `withdraw_amount` is what the sender paid (our quoted sum);
  // `amount` is what lands on the wallet after YooMoney's commission.
  // Primary check: sender paid the full quoted price. If withdraw_amount is
  // absent (some notification variants omit it), fall back to requiring the
  // credited amount to be at least the price minus a 5% commission allowance.
  // Compare in kopecks (integer minor units) — no float rounding that could
  // let e.g. 99.50 satisfy a 100 ₽ invoice.
  const toKopecks = (v: string | undefined): number | null => {
    const n = parseFloat(v ?? "");
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };
  const withdrawKop = toKopecks(params.withdraw_amount);
  const creditedKop = toKopecks(params.amount);
  const priceKop = payment.amountRub * 100;
  const paidEnough = withdrawKop !== null
    ? withdrawKop >= priceKop
    : creditedKop !== null && creditedKop >= Math.ceil(priceKop * 0.95);

  if (!paidEnough) {
    logger.error(
      { paymentId, expected: payment.amountRub, withdraw_amount: params.withdraw_amount, amount: params.amount },
      "YooMoney webhook: amount too small — leaving payment pending for manual review",
    );
    // 200 so YooMoney stops retrying; underpaid orders go to manual review.
    res.status(200).send("OK");
    return;
  }

  const result = await confirmPaymentById(payment.id);
  if (!result.ok) {
    if (result.status === 409) {
      // Concurrent confirmation — idempotent success.
      res.status(200).send("OK");
      return;
    }
    logger.error({ error: result.error, paymentId: payment.id }, "YooMoney webhook: confirm failed");
    // Non-200 → YooMoney retries (10 min, then 1 h) — gives transient DB
    // errors a chance to heal.
    res.status(500).send(result.error);
    return;
  }

  logger.info({ paymentId: payment.id, operation_id: params.operation_id }, "YooMoney webhook: payment auto-confirmed");
  res.status(200).send("OK");
}

router.post("/payments/yoomoney/webhook", handleWebhook);

export default router;
