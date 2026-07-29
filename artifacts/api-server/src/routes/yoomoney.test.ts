/**
 * YooMoney webhook deduplication tests.
 *
 * Tests every branch of the atomic-claim / double-charge-detection path inside
 * handleWebhook without requiring a real YooMoney connection.  confirmPaymentById
 * is mocked so each test can control its outcome independently.
 */

import { createHmac } from "node:crypto";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { and, eq } from "drizzle-orm";
import {
  db,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
  vpnKeysTable,
} from "@workspace/db";
import { inArray, eq as drizzleEq } from "drizzle-orm";
import app from "../app";
import { hashPassword } from "../lib/password";

// ── Mock confirmPaymentById ───────────────────────────────────────────────────
// We test the dedup/claim logic here, not the fulfillment path (which has its
// own tests in admin/payments.test.ts). Mocking keeps each case deterministic.
vi.mock("../lib/confirmPayment", () => ({
  confirmPaymentById: vi.fn(),
}));

import { confirmPaymentById } from "../lib/confirmPayment";
const mockConfirm = vi.mocked(confirmPaymentById);

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_SECRET = "test-notification-secret-xyz";
const LABEL_PREFIX = "vpnexus-";

/**
 * Build a valid YooMoney notification POST body (URL-encoded fields) including
 * a correct HMAC-SHA256 `sign` parameter.
 *
 * Mirrors the algorithm in verifyYmSign so the webhook handler accepts it.
 */
function buildSignedParams(fields: Record<string, string>): string {
  const str = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(fields[k] ?? "")}`)
    .join("&");
  const sign = createHmac("sha256", TEST_SECRET).update(str).digest("hex");
  return new URLSearchParams({ ...fields, sign }).toString();
}

function notificationBody(paymentId: number, operationId: string, amountRub = 500): string {
  return buildSignedParams({
    notification_type: "incoming-transfer",
    operation_id: operationId,
    amount: String(amountRub),
    withdraw_amount: String(amountRub),
    currency: "643",
    datetime: new Date().toISOString(),
    sender: "41001000000000",
    codepro: "false",
    label: `${LABEL_PREFIX}${paymentId}`,
    unaccepted: "false",
  });
}

const request = supertest(app);

// ── Test fixture management ───────────────────────────────────────────────────

let planId: number;
const createdUserIds: number[] = [];
const createdSubscriptionIds: number[] = [];
const createdPaymentIds: number[] = [];

beforeAll(async () => {
  // Inject the test secret so the webhook handler accepts our signatures.
  process.env.YOOMONEY_NOTIFICATION_SECRET = TEST_SECRET;

  const [plan] = await db
    .insert(plansTable)
    .values({ name: `ym-dedup-plan-${randomBytes(4).toString("hex")}`, priceRub: 500, durationDays: 30 })
    .returning({ id: plansTable.id });
  planId = plan.id;
});

afterAll(async () => {
  delete process.env.YOOMONEY_NOTIFICATION_SECRET;

  for (const id of createdPaymentIds) {
    await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
  }
  for (const id of createdSubscriptionIds) {
    await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
  }
  await db.delete(vpnKeysTable).where(inArray(vpnKeysTable.userId, createdUserIds.length ? createdUserIds : [-1]));
  await db.delete(plansTable).where(eq(plansTable.id, planId));
  for (const id of createdUserIds) {
    await db.delete(usersTable).where(eq(usersTable.id, id));
  }
});

/**
 * Seeds a fresh user + pending subscription payment and registers all IDs for
 * cleanup. Using a fresh user per test avoids hitting the partial unique index
 * `payments_one_pending_per_user_type_idx` (one pending subscription payment
 * per user) when multiple tests each leave a payment in pending state.
 */
async function seedPendingPayment(amountRub = 500): Promise<{ paymentId: number; subscriptionId: number; userId: number }> {
  const email = `ym-dedup-${randomBytes(6).toString("hex")}@example.com`;
  const passwordHash = await hashPassword("irrelevant-password");
  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash, role: "user", referralCode: randomBytes(8).toString("hex") })
    .returning({ id: usersTable.id });
  createdUserIds.push(user.id);

  const [subscription] = await db
    .insert(subscriptionsTable)
    .values({ userId: user.id, planId, status: "pending_payment" })
    .returning({ id: subscriptionsTable.id });
  createdSubscriptionIds.push(subscription.id);

  const [payment] = await db
    .insert(paymentsTable)
    .values({
      userId: user.id,
      subscriptionId: subscription.id,
      provider: "yoomoney",
      amountRub,
      status: "pending",
      reference: `YM-TEST-${randomBytes(4).toString("hex")}`,
    })
    .returning({ id: paymentsTable.id });
  createdPaymentIds.push(payment.id);

  return { paymentId: payment.id, subscriptionId: subscription.id, userId: user.id };
}

// ── Webhook dedup scenarios ───────────────────────────────────────────────────

describe("YooMoney webhook dedup", () => {
  beforeEach(() => {
    mockConfirm.mockReset();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. First delivery: sets webhookEventId and calls confirmPaymentById once.
  // ──────────────────────────────────────────────────────────────────────────
  it("first delivery: claims webhookEventId and confirms the payment", async () => {
    const { paymentId } = await seedPendingPayment();
    const operationId = `op-${randomBytes(6).toString("hex")}`;

    mockConfirm.mockResolvedValueOnce({ ok: true, payment: { id: paymentId } as any });

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(notificationBody(paymentId, operationId));

    expect(res.status).toBe(200);
    expect(mockConfirm).toHaveBeenCalledOnce();
    expect(mockConfirm).toHaveBeenCalledWith(paymentId);

    // webhookEventId must be persisted to enable idempotent retries.
    const [row] = await db
      .select({ webhookEventId: paymentsTable.webhookEventId })
      .from(paymentsTable)
      .where(eq(paymentsTable.id, paymentId));
    expect(row?.webhookEventId).toBe(operationId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Retry with the same operation_id after the payment was confirmed:
  //    no second call to confirmPaymentById.
  // ──────────────────────────────────────────────────────────────────────────
  it("retry with same operation_id on already-confirmed payment: idempotent 200, no re-confirm", async () => {
    const { paymentId } = await seedPendingPayment();
    const operationId = `op-${randomBytes(6).toString("hex")}`;

    // Pre-set the row to look like it was confirmed by a previous delivery.
    await db
      .update(paymentsTable)
      .set({ status: "confirmed", webhookEventId: operationId, confirmedAt: new Date() })
      .where(eq(paymentsTable.id, paymentId));

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(notificationBody(paymentId, operationId));

    expect(res.status).toBe(200);
    // The handler must detect the matching event id and short-circuit before
    // calling confirmPaymentById a second time.
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3a. Early short-circuit: initial read already shows "confirmed"
  //     (manual admin confirm before webhook fires) → idempotent 200 before
  //     the atomic-claim UPDATE path is even reached.
  // ──────────────────────────────────────────────────────────────────────────
  it("already-confirmed on initial read: exits before atomic claim, 200, no re-confirm", async () => {
    const { paymentId } = await seedPendingPayment();
    const operationId = `op-${randomBytes(6).toString("hex")}`;

    // Pre-confirm (no webhookEventId set — simulates a manual admin confirm).
    await db
      .update(paymentsTable)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(paymentsTable.id, paymentId));

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(notificationBody(paymentId, operationId));

    expect(res.status).toBe(200);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3b. True concurrent-race path: initial read sees "pending", but a second
  //     delivery confirms the payment just before our atomic UPDATE runs.
  //     The UPDATE WHERE status='pending' finds 0 rows; the re-fetch sees
  //     "confirmed" → 200, no second confirm.
  // ──────────────────────────────────────────────────────────────────────────
  it("concurrent race: atomic claim returns 0 rows, re-fetch sees confirmed → 200, no re-confirm", async () => {
    const { paymentId } = await seedPendingPayment();
    const operationId = `op-${randomBytes(6).toString("hex")}`;

    // Capture the real db.update before installing the spy, so we can call
    // it from inside the interceptor without triggering the spy recursively.
    // `origUpdate` is bound at this point, before the spy replaces db.update.
    const origUpdate = db.update.bind(db);
    let claimIntercepted = false;

    const updateSpy = vi.spyOn(db as any, "update").mockImplementation((table: any) => {
      // Only intercept the first update on paymentsTable — that is the
      // atomic webhookEventId claim.  All other updates (including the
      // "confirm" side-effect below) call origUpdate directly and bypass this spy.
      if (!claimIntercepted && table === paymentsTable) {
        claimIntercepted = true;

        // Return a fake builder that absorbs the .set().where() chain and
        // resolves to [] when .returning() is eventually called, after first
        // slipping in a concurrent confirmation of the payment.
        const fakeBuilder: any = {
          set: () => fakeBuilder,
          where: () => fakeBuilder,
          returning: async (_fields?: any) => {
            // Simulate: another process confirms the payment right here,
            // just before our WHERE status='pending' UPDATE would run.
            await origUpdate(paymentsTable)
              .set({ status: "confirmed", confirmedAt: new Date() })
              .where(drizzleEq(paymentsTable.id, paymentId));
            // The atomic UPDATE WHERE status='pending' would now match 0 rows.
            return [];
          },
        };
        return fakeBuilder;
      }

      // All other updates (the internal "confirm" above uses origUpdate
      // directly, so this branch handles any other db.update calls).
      return origUpdate(table);
    });

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(notificationBody(paymentId, operationId));

    updateSpy.mockRestore();

    expect(res.status).toBe(200);
    // The re-fetch sees "confirmed" and the handler must return 200 without
    // calling confirmPaymentById a second time.
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Different operation_id on an already-confirmed payment:
  //    DOUBLE-CHARGE branch — must return 200 (ack to stop retries) without
  //    calling confirmPaymentById again.
  // ──────────────────────────────────────────────────────────────────────────
  it("different operation_id on confirmed payment: double-charge detected, 200, no re-confirm", async () => {
    const { paymentId } = await seedPendingPayment();
    const originalOpId = `op-${randomBytes(6).toString("hex")}`;
    const secondOpId = `op-${randomBytes(6).toString("hex")}`;

    // Confirmed by the first (original) operation.
    await db
      .update(paymentsTable)
      .set({ status: "confirmed", webhookEventId: originalOpId, confirmedAt: new Date() })
      .where(eq(paymentsTable.id, paymentId));

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(notificationBody(paymentId, secondOpId));

    expect(res.status).toBe(200);
    // Must NOT re-confirm — a second transfer needs manual review, not
    // automatic crediting.
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Different operation_id on a still-pending payment:
  //    An event id is already set (previous partial delivery), a new distinct
  //    one arrives → skip with warning, 200, no re-confirm.
  // ──────────────────────────────────────────────────────────────────────────
  it("different operation_id on still-pending payment: conflicting event id → skipped, 200, no re-confirm", async () => {
    const { paymentId } = await seedPendingPayment();
    const existingOpId = `op-${randomBytes(6).toString("hex")}`;
    const conflictingOpId = `op-${randomBytes(6).toString("hex")}`;

    // A previous partial delivery already claimed the event id but never
    // completed confirmation (e.g. the server crashed after the UPDATE).
    await db
      .update(paymentsTable)
      .set({ webhookEventId: existingOpId })
      .where(eq(paymentsTable.id, paymentId));

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(notificationBody(paymentId, conflictingOpId));

    expect(res.status).toBe(200);
    expect(mockConfirm).not.toHaveBeenCalled();

    // The existing event id must not be overwritten.
    const [row] = await db
      .select({ webhookEventId: paymentsTable.webhookEventId })
      .from(paymentsTable)
      .where(eq(paymentsTable.id, paymentId));
    expect(row?.webhookEventId).toBe(existingOpId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bonus: invalid signature → 400 before any DB work.
  // ──────────────────────────────────────────────────────────────────────────
  it("invalid signature is rejected with 400", async () => {
    const { paymentId } = await seedPendingPayment();

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(
        new URLSearchParams({
          notification_type: "incoming-transfer",
          operation_id: "op-bad",
          amount: "500",
          withdraw_amount: "500",
          currency: "643",
          datetime: new Date().toISOString(),
          sender: "41001000000000",
          codepro: "false",
          label: `${LABEL_PREFIX}${paymentId}`,
          unaccepted: "false",
          sign: "0".repeat(64), // wrong
        }).toString(),
      );

    expect(res.status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bonus: test notification (test_notification=true) → 200, no DB work.
  // ──────────────────────────────────────────────────────────────────────────
  it("test notification (test_notification=true) is acked without DB work", async () => {
    const { paymentId } = await seedPendingPayment();

    const fields: Record<string, string> = {
      notification_type: "incoming-transfer",
      operation_id: `op-${randomBytes(6).toString("hex")}`,
      amount: "500",
      withdraw_amount: "500",
      currency: "643",
      datetime: new Date().toISOString(),
      sender: "41001000000000",
      codepro: "false",
      label: `${LABEL_PREFIX}${paymentId}`,
      unaccepted: "false",
      test_notification: "true",
    };

    const res = await request
      .post("/api/payments/yoomoney/webhook")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(buildSignedParams(fields));

    expect(res.status).toBe(200);
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
