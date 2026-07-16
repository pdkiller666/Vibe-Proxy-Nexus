import { Router, type IRouter, type Request, type Response } from "express";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { confirmPaymentById } from "../lib/confirmPayment";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function md5(str: string): string {
  return createHash("md5").update(str).digest("hex");
}

/**
 * Build the payment-link signature for FreeKassa (freekassa.net new API).
 * Format: MD5(shopId:amount:secret1:currency:orderId)
 */
function buildCheckoutSign(shopId: string, amount: number, secret1: string, orderId: string): string {
  return md5(`${shopId}:${amount}:${secret1}:RUB:${orderId}`);
}

/**
 * Verify FreeKassa IPN webhook signature.
 * Format: MD5(shopId:amount:secret2:orderId)
 */
function verifyWebhookSign(shopId: string, amount: string, secret2: string, orderId: string, received: string): boolean {
  const expected = md5(`${shopId}:${amount}:${secret2}:${orderId}`);
  return expected === received;
}

// Redirect authenticated user to FreeKassa payment page for a pending payment
router.get("/payments/freekassa/checkout/:paymentId", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const paymentId = Number(req.params.paymentId);

  if (!paymentId || Number.isNaN(paymentId)) {
    res.status(400).json({ error: "Invalid payment id" });
    return;
  }

  const FK_SHOP_ID = process.env.FK_SHOP_ID ?? "";
  const FK_SECRET1 = process.env.FK_SECRET1 ?? "";

  if (!FK_SHOP_ID || !FK_SECRET1) {
    res.status(503).json({ error: "FreeKassa не настроена" });
    return;
  }

  const [payment] = await db
    .select({ id: paymentsTable.id, userId: paymentsTable.userId, amountRub: paymentsTable.amountRub, status: paymentsTable.status, reference: paymentsTable.reference, type: paymentsTable.type, subscriptionId: paymentsTable.subscriptionId })
    .from(paymentsTable)
    .where(eq(paymentsTable.id, paymentId));

  if (!payment || payment.userId !== user.id) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  if (payment.status !== "pending") {
    res.status(409).json({ error: "Payment is not pending" });
    return;
  }

  // Mark the payment as freekassa at the moment the user chooses card payment.
  // balance_topup / extra_slot / extra_traffic orders are created with
  // provider="manual_sbp" as a default; override here so that the balance
  // transaction description and admin view show the correct provider.
  // The UPDATE is idempotent — harmless if already "freekassa".
  await db
    .update(paymentsTable)
    .set({ provider: "freekassa" })
    .where(eq(paymentsTable.id, payment.id));

  const sign = buildCheckoutSign(FK_SHOP_ID, payment.amountRub, FK_SECRET1, payment.reference);
  const url = new URL("https://pay.freekassa.net/");
  url.searchParams.set("m", FK_SHOP_ID);
  url.searchParams.set("oa", String(payment.amountRub));
  url.searchParams.set("currency", "RUB");
  url.searchParams.set("o", payment.reference);
  url.searchParams.set("s", sign);
  url.searchParams.set("lang", "ru");

  // Return URLs — FreeKassa redirects the user back after payment.
  // us = success redirect, uf = failure redirect.
  const origin = `${req.protocol}://${req.get("host")}`;
  let returnPath: string;
  if (payment.type === "balance_topup") {
    returnPath = `/balance-topup/${payment.id}`;
  } else if (payment.type === "extra_device_slot") {
    returnPath = `/checkout/slot/${payment.id}`;
  } else if (payment.type === "extra_traffic") {
    returnPath = `/checkout/traffic/${payment.id}`;
  } else {
    // subscription payment
    returnPath = `/checkout/${payment.subscriptionId ?? payment.id}`;
  }
  url.searchParams.set("us", `${origin}${returnPath}`);
  url.searchParams.set("uf", `${origin}${returnPath}?failed=1`);

  logger.info({ paymentId, reference: payment.reference, amountRub: payment.amountRub, type: payment.type }, "Redirecting to FreeKassa checkout");
  res.redirect(302, url.toString());
});

// FreeKassa IPN — no session auth, verified via secret2 signature only.
// FreeKassa can be configured for GET or POST; we handle both.
async function handleWebhook(req: Request, res: Response): Promise<void> {
  const params: Record<string, string> = { ...req.query as Record<string, string>, ...req.body };

  // FreeKassa documentation shows MERCHANT_ORDER_ID in uppercase, but some
  // configurations send it in lowercase. Accept both for resilience.
  const orderId = params.MERCHANT_ORDER_ID ?? params.merchant_order_id;
  const { MERCHANT_ID, AMOUNT, SIGN, intid } = params;

  logger.info({ MERCHANT_ID, AMOUNT, orderId, intid }, "FreeKassa IPN received");

  const FK_SHOP_ID = process.env.FK_SHOP_ID ?? "";
  const FK_SECRET2 = process.env.FK_SECRET2 ?? "";

  if (!MERCHANT_ID || !AMOUNT || !orderId || !SIGN) {
    logger.warn({ params }, "FreeKassa IPN: missing required params");
    res.status(400).send("Missing params");
    return;
  }

  if (!FK_SHOP_ID || !FK_SECRET2) {
    logger.error("FreeKassa IPN: FK_SHOP_ID or FK_SECRET2 env vars not set");
    res.status(503).send("Not configured");
    return;
  }

  if (String(MERCHANT_ID) !== FK_SHOP_ID) {
    logger.warn({ received: MERCHANT_ID, expected: FK_SHOP_ID }, "FreeKassa IPN: MERCHANT_ID mismatch");
    res.status(400).send("Invalid merchant");
    return;
  }

  if (!verifyWebhookSign(FK_SHOP_ID, String(AMOUNT), FK_SECRET2, String(orderId), String(SIGN))) {
    logger.warn({ SIGN }, "FreeKassa IPN: signature mismatch");
    res.status(400).send("Invalid signature");
    return;
  }

  const [payment] = await db
    .select({ id: paymentsTable.id, status: paymentsTable.status })
    .from(paymentsTable)
    .where(eq(paymentsTable.reference, String(orderId)));

  if (!payment) {
    logger.error({ orderId }, "FreeKassa IPN: no payment found for reference");
    // Return YES to stop FreeKassa retrying a genuinely unknown order
    res.send("YES");
    return;
  }

  if (payment.status === "confirmed") {
    // Already handled — idempotent
    res.send("YES");
    return;
  }

  // Validate amount matches our record (prevents manipulated webhook amounts)
  const [fullPayment] = await db
    .select({ amountRub: paymentsTable.amountRub, provider: paymentsTable.provider })
    .from(paymentsTable)
    .where(eq(paymentsTable.id, payment.id));

  if (!fullPayment) {
    res.send("YES");
    return;
  }

  // FreeKassa sends AMOUNT as a decimal string e.g. "100.00", while
  // amountRub is stored as an integer. Compare numerically after rounding.
  if (Math.round(parseFloat(String(AMOUNT))) !== fullPayment.amountRub) {
    logger.error({ expected: fullPayment.amountRub, received: AMOUNT, paymentId: payment.id }, "FreeKassa IPN: amount mismatch");
    res.status(400).send("Amount mismatch");
    return;
  }

  const result = await confirmPaymentById(payment.id);
  if (!result.ok) {
    // 409 = concurrent race, already confirmed — idempotent success
    if (result.status === 409) {
      logger.info({ paymentId: payment.id }, "FreeKassa IPN: concurrent confirm, treating as success");
      res.send("YES");
      return;
    }
    logger.error({ error: result.error, paymentId: payment.id }, "FreeKassa IPN: confirm failed");
    res.status(500).send(result.error);
    return;
  }

  logger.info({ paymentId: payment.id }, "FreeKassa IPN: payment auto-confirmed");
  res.send("YES");
}

router.get("/payments/freekassa/webhook", handleWebhook);
router.post("/payments/freekassa/webhook", handleWebhook);

export default router;
