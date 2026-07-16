import { Router, type IRouter, type Request, type Response } from "express";
import { createHash, createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../lib/auth";
import { confirmPaymentById } from "../lib/confirmPayment";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function md5(str: string): string {
  return createHash("md5").update(str).digest("hex");
}

/**
 * Build the payment-link signature for FreeKassa form-redirect (legacy).
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

// ─────────────────────────────────────────────────────────────────────────────
// FK API helpers
// ─────────────────────────────────────────────────────────────────────────────

// FK payment method IDs confirmed active for this merchant (2026-07-16 cabinet check)
// QIWI (35) removed — QIWI Bank licence revoked 2024, method absent from FK cabinet
const FK_METHOD_IDS = {
  card: 36,   // Card RUB API — Visa / MasterCard / МИР
  sbp:  44,   // СБП API (НСПК)
} as const;

type FkMethod = keyof typeof FK_METHOD_IDS;

// Official FK API host per merchant cabinet (merchant.freekassa.net).
// api.fk.life is FK's newer domain but may behave differently for method selection.
const FK_API_HOSTS = ["https://api.freekassa.net/v1", "https://api.fk.life/v1"];

/**
 * Send a signed POST request to the FK REST API.
 * Signature: ksort all body fields (excl. signature), join values with "|", HMAC-SHA256.
 * Tries FK_API_HOSTS in order; falls back on network error.
 */
async function fkApiRequest<T = Record<string, unknown>>(
  path: string,
  shopId: string,
  apiKey: string,
  extraFields: Record<string, string | number> = {},
): Promise<T> {
  const nonce = Date.now();
  const body: Record<string, string | number> = {
    ...extraFields,
    nonce,
    shopId: Number(shopId),
  };

  // Sort alphabetically by key, join VALUES with "|", then HMAC-SHA256
  const signStr = Object.keys(body).sort().map((k) => String(body[k])).join("|");
  const signature = createHmac("sha256", apiKey).update(signStr).digest("hex");
  const payload = { ...body, signature };

  let lastErr: unknown;
  for (const host of FK_API_HOSTS) {
    try {
      const resp = await fetch(`${host}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json() as T;
      logger.debug({ host, path }, "FK API call succeeded");
      return data;
    } catch (err) {
      lastErr = err;
      logger.warn({ host, path, err }, "FK API host unreachable, trying next");
    }
  }
  throw lastErr;
}

/**
 * Check whether a FK payment method is available for this shop.
 * Uses POST /currencies/{id}/status per FK docs section 2.5.
 * Returns { available: true } or { available: false, reason: string }.
 */
async function checkFkMethodAvailable(
  shopId: string,
  apiKey: string,
  methodId: number,
): Promise<{ available: boolean; reason?: string }> {
  try {
    const data = await fkApiRequest<{ type?: string; message?: string }>(
      `/currencies/${methodId}/status`,
      shopId,
      apiKey,
    );
    if (data.type === "success") return { available: true };
    return { available: false, reason: data.message ?? JSON.stringify(data) };
  } catch (err) {
    return { available: false, reason: String(err) };
  }
}

/**
 * Create a FK order via POST /orders/create and return the redirect URL.
 *
 * Per FK docs:
 *   - `i` is REQUIRED (method ID); without it FK defaults to FK Wallet
 *   - `success_url` / `failure_url` need explicit FK support activation;
 *     including them without activation causes signature mismatch → omitted here
 *   - `paymentId` is optional (string); used as MERCHANT_ORDER_ID in webhook
 *   - `/currencies` check (2026-07-16): methods 36 (Card RUB) and 44 (СБП НСПК)
 *     are enabled (is_enabled:1) and require only `email` — already sent.
 *     Pre-flight /currencies/{id}/status check removed: it caused two rapid FK API
 *     calls in succession which can produce nonce conflicts on FK's side.
 */
async function createFkOrder(opts: {
  shopId: string;
  apiKey: string;
  amount: number;
  paymentId: number;   // payment.id (integer) — FK requires numeric merchant order ID; webhook resolves by numeric id first
  email: string;
  ip: string;
  method: FkMethod;   // always required — caller provides default
}): Promise<string> {
  const methodId = FK_METHOD_IDS[opts.method];

  const data = await fkApiRequest<{
    type?: string;
    orderId?: number;
    orderHash?: string;
    location?: string;
    message?: string;
  }>("/orders/create", opts.shopId, opts.apiKey, {
    amount: opts.amount,
    currency: "RUB",
    email: opts.email,
    i: methodId,
    ip: opts.ip,
    paymentId: opts.paymentId,
  });

  logger.info(
    { fkResponse: data, methodId, method: opts.method, paymentId: opts.paymentId },
    "FK /orders/create response",
  );

  if (data.type !== "success" || !data.location) {
    throw new Error(`FreeKassa API error: ${data.message ?? JSON.stringify(data)}`);
  }

  // FK silently creates a FK Wallet order (fkwallet.io) when the requested
  // method isn't activated for this merchant — `i` is ignored and method 1
  // (FK Wallet) is used as default.  Detect this so the caller can fall back
  // to the form-redirect which shows the standard FK payment page.
  if (data.location.includes("fkwallet.io") || data.location.includes("fkwallet.ru")) {
    logger.warn(
      { fkOrderId: data.orderId, location: data.location, methodId, method: opts.method },
      "FK API ignored `i` and created a FK Wallet order — method not activated for merchant; will fall back to form-redirect",
    );
    throw new Error("FK_WALLET_FALLBACK");
  }

  return data.location;
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

  // Mark the payment as freekassa at the moment the user initiates card/СБП payment.
  // balance_topup / extra_slot / extra_traffic orders are created with
  // provider="manual_sbp" as a default; override here so that the balance
  // transaction description and admin view show the correct provider.
  // The UPDATE is idempotent — harmless if already "freekassa".
  await db
    .update(paymentsTable)
    .set({ provider: "freekassa" })
    .where(eq(paymentsTable.id, payment.id));

  // Build return URLs — FreeKassa redirects the user back after payment.
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
  const successUrl = `${origin}${returnPath}`;
  const failureUrl = `${origin}${returnPath}?failed=1`;

  const FK_API_KEY = process.env.FK_API_KEY ?? "";

  if (FK_API_KEY) {
    // ── REST API path (required for СБП / НСПК and all modern FK methods) ──
    // Creates the order server-side; FreeKassa returns a ready payment URL.
    const userIp =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "127.0.0.1";

    // Accept ?method=card|sbp|qiwi to pre-select FK payment method (i param).
    // Default to "card" — `i` is required by the FK API; omitting it causes FK
    // to silently fall back to FK Wallet regardless of what methods are enabled.
    const rawMethod = (req.query.method as string | undefined)?.toLowerCase();
    const method: FkMethod =
      rawMethod === "card" || rawMethod === "sbp" || rawMethod === "qiwi"
        ? rawMethod
        : "card";

    try {
      const location = await createFkOrder({
        shopId: FK_SHOP_ID,
        apiKey: FK_API_KEY,
        amount: payment.amountRub,
        paymentId: payment.id,   // integer required by FK API — webhook resolves by numeric id first
        email: user.email,
        ip: userIp,
        method,
      });
      logger.info({ paymentId, method, amountRub: payment.amountRub, type: payment.type }, "FreeKassa API order created — redirecting");
      res.redirect(302, location);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "FK_WALLET_FALLBACK") {
        // Hard API error (network, signature, etc.).
        // Never return 5xx: Amvera intercepts it and shows its own error page.
        logger.error({ err: msg, paymentId, method }, "FreeKassa API order creation failed — redirecting to failure URL");
        res.redirect(302, failureUrl);
        return;
      }
      // FK_WALLET_FALLBACK: FK API ignored `i` (API methods 36/44 not activated for this merchant).
      // Fall through to form-redirect WITHOUT `i` — FK shows whatever methods the merchant has
      // enabled for form payments. Merchant must contact FK support to activate API card/SBP.
      logger.warn({ paymentId, method }, "FK API returned FK Wallet — falling back to generic form-redirect (no i)");
    }
  }

  // ── Form-redirect path ────────────────────────────────────────────────────
  // Reached when: (a) FK_API_KEY not set, OR (b) API returned FK Wallet fallback.
  // Do NOT pass `i` — methods 36/44 are API-only; pay.freekassa.net rejects them
  // with "только по API". Without `i` FK shows all merchant-enabled form methods.
  const sign = buildCheckoutSign(FK_SHOP_ID, payment.amountRub, FK_SECRET1, payment.reference);
  const url = new URL("https://pay.freekassa.net/");
  url.searchParams.set("m", FK_SHOP_ID);
  url.searchParams.set("oa", String(payment.amountRub));
  url.searchParams.set("currency", "RUB");
  url.searchParams.set("o", payment.reference);
  url.searchParams.set("s", sign);
  url.searchParams.set("lang", "ru");
  url.searchParams.set("us", successUrl);
  url.searchParams.set("uf", failureUrl);

  logger.info({ paymentId, reference: payment.reference, amountRub: payment.amountRub }, "Redirecting to FK form-redirect (no i)");
  res.redirect(302, url.toString());
});

// ── Admin: debug endpoint to inspect FK available currencies and required fields ──
// GET /api/admin/fk/currencies  (admin auth required)
// Calls FK POST /currencies and returns raw response so we can see which
// methods are available and what extra fields (e.g. `tel`) they require.
router.get("/admin/fk/currencies", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const FK_SHOP_ID = process.env.FK_SHOP_ID ?? "";
  const FK_API_KEY = process.env.FK_API_KEY ?? "";
  if (!FK_SHOP_ID || !FK_API_KEY) {
    res.status(503).json({ error: "FK_SHOP_ID / FK_API_KEY not set" });
    return;
  }
  try {
    const data = await fkApiRequest("/currencies", FK_SHOP_ID, FK_API_KEY);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
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

  // FK "Проверить статус" button hits the URL with no params — just a connectivity
  // ping. Return 200/YES so the cabinet shows the URL as reachable.
  if (!MERCHANT_ID && !AMOUNT && !orderId && !SIGN) {
    res.status(200).send("YES");
    return;
  }

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

  // API-path orders send our numeric payment.id as paymentId; legacy form-redirect
  // orders send the string reference (e.g. "VPN-123-XXXX"). Try numeric id first.
  const numericId = Number(orderId);
  let [payment] = numericId > 0 && Number.isInteger(numericId)
    ? await db.select({ id: paymentsTable.id, status: paymentsTable.status }).from(paymentsTable).where(eq(paymentsTable.id, numericId))
    : [];

  if (!payment) {
    // Fallback: legacy form-redirect orders use the string reference
    [payment] = await db
      .select({ id: paymentsTable.id, status: paymentsTable.status })
      .from(paymentsTable)
      .where(eq(paymentsTable.reference, String(orderId)));
  }

  if (!payment) {
    logger.error({ orderId }, "FreeKassa IPN: no payment found for id or reference");
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
