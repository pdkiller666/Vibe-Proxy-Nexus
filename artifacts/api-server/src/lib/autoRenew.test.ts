/**
 * Integration tests for runAutoRenew() — ТЗ §6 scenarios 7–9.
 *
 * confirmPaymentById is mocked (transitively through balanceCheckout) so
 * no VPN keys or real subscription activation happens. The tests exercise
 * the real DB queries in runAutoRenew and checkoutFromBalance.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  db,
  balanceTransactionsTable,
  paymentsTable,
  paymentSettingsTable,
  plansTable,
  subscriptionsTable,
  systemEventsTable,
  usersTable,
} from "@workspace/db";

// Plain stub — implementation set in beforeEach to avoid ESM-hoisting closure issues.
vi.mock("./confirmPayment", () => ({
  confirmPaymentById: vi.fn(),
}));

import { confirmPaymentById } from "./confirmPayment";
import { runAutoRenew } from "./autoRenew";

const uid = () => randomBytes(6).toString("hex");

async function seedUser(balanceKopecks: number, autoRenew = true) {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `auto-renew-test-${uid()}@example.com`,
      passwordHash: "not-a-real-hash",
      referralCode: uid(),
      balanceKopecks,
      autoRenewFromBalance: autoRenew,
    })
    .returning({ id: usersTable.id });
  return user!;
}

describe("runAutoRenew", () => {
  let planId: number;
  const PLAN_PRICE_RUB = 300;

  const userIds: number[] = [];
  const subIds: number[] = [];
  const paymentIds: number[] = [];
  const txIds: number[] = [];
  const eventIds: number[] = [];

  let settingsId: number | null = null;
  let settingsInserted = false;
  let originalEnabled = false;

  beforeEach(() => {
    // Default: successful confirm — writes confirmed status to DB.
    vi.mocked(confirmPaymentById).mockImplementation(async (paymentId: number) => {
      await db
        .update(paymentsTable)
        .set({ status: "confirmed" })
        .where(eq(paymentsTable.id, paymentId));
      const [p] = await db.select().from(paymentsTable).where(eq(paymentsTable.id, paymentId));
      return { ok: true as const, payment: p! };
    });
  });

  afterEach(async () => {
    vi.mocked(confirmPaymentById).mockReset();

    for (const id of eventIds.splice(0))
      await db.delete(systemEventsTable).where(eq(systemEventsTable.id, id));
    for (const id of txIds.splice(0))
      await db.delete(balanceTransactionsTable).where(eq(balanceTransactionsTable.id, id));
    for (const id of paymentIds.splice(0))
      await db.delete(paymentsTable).where(eq(paymentsTable.id, id));
    for (const id of subIds.splice(0))
      await db.delete(subscriptionsTable).where(eq(subscriptionsTable.id, id));
    for (const id of userIds.splice(0))
      await db.delete(usersTable).where(eq(usersTable.id, id));
  });

  beforeAll(async () => {
    const [existing] = await db.select().from(paymentSettingsTable).limit(1);
    if (!existing) {
      const [row] = await db
        .insert(paymentSettingsTable)
        .values({ sbpPhone: "", sbpBank: "", sbpRecipientName: "", balancePaymentsEnabled: true })
        .returning({ id: paymentSettingsTable.id });
      settingsId = row!.id;
      settingsInserted = true;
    } else {
      settingsId = existing.id;
      originalEnabled = existing.balancePaymentsEnabled;
      await db.update(paymentSettingsTable).set({ balancePaymentsEnabled: true }).where(eq(paymentSettingsTable.id, settingsId!));
    }

    const [plan] = await db
      .insert(plansTable)
      .values({ name: `AutoRenew test plan ${uid()}`, priceRub: PLAN_PRICE_RUB, durationDays: 30, billingType: "monthly" })
      .returning({ id: plansTable.id });
    planId = plan!.id;
  });

  afterAll(async () => {
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    if (settingsInserted && settingsId !== null) {
      await db.delete(paymentSettingsTable).where(eq(paymentSettingsTable.id, settingsId));
    } else if (settingsId !== null) {
      await db.update(paymentSettingsTable).set({ balancePaymentsEnabled: originalEnabled }).where(eq(paymentSettingsTable.id, settingsId));
    }
  });

  async function seedExpiringSubscription(userId: number, hoursUntilExpiry = 12) {
    const endsAt = new Date(Date.now() + hoursUntilExpiry * 60 * 60 * 1_000);
    const [sub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId,
        status: "active",
        startsAt: new Date(Date.now() - 18 * 24 * 60 * 60 * 1_000),
        endsAt,
      })
      .returning({ id: subscriptionsTable.id });
    return sub!;
  }

  async function collectCreated(userId: number) {
    userIds.push(userId);
    const subs = await db.select({ id: subscriptionsTable.id }).from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    subIds.push(...subs.map((s) => s.id));
    const payments = await db.select({ id: paymentsTable.id }).from(paymentsTable).where(eq(paymentsTable.userId, userId));
    paymentIds.push(...payments.map((p) => p.id));
    const txs = await db.select({ id: balanceTransactionsTable.id }).from(balanceTransactionsTable).where(eq(balanceTransactionsTable.userId, userId));
    txIds.push(...txs.map((t) => t.id));
    const events = await db.select({ id: systemEventsTable.id }).from(systemEventsTable).where(eq(systemEventsTable.userId, userId));
    eventIds.push(...events.map((e) => e.id));
  }

  // ── Scenario 7: Auto-renew success ──────────────────────────────────────────
  it("scenario 7: balance available → subscription renewed, auto_renew_success event emitted", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 3;
    const { id: userId } = await seedUser(initialBalance);
    await seedExpiringSubscription(userId);

    await runAutoRenew();

    // Balance debited
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance - PLAN_PRICE_RUB * 100);

    // auto_renew_success event created
    const events = await db
      .select()
      .from(systemEventsTable)
      .where(and(eq(systemEventsTable.userId, userId), eq(systemEventsTable.eventType, "auto_renew_success")));
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ amountRub: PLAN_PRICE_RUB });

    await collectCreated(userId);
  });

  // ── Scenario 8: Auto-renew — insufficient balance ───────────────────────────
  it("scenario 8: no balance → auto_renew_failed event emitted, subscription NOT renewed", async () => {
    const { id: userId } = await seedUser(10); // 0.1 ₽ — far below plan price
    const { id: subId } = await seedExpiringSubscription(userId);
    subIds.push(subId);

    await runAutoRenew();

    // Balance unchanged
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(10);

    // Subscription still active (expiry job handles normal expiry)
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.id, subId));
    expect(sub!.status).toBe("active");

    // auto_renew_failed event
    const events = await db
      .select()
      .from(systemEventsTable)
      .where(and(eq(systemEventsTable.userId, userId), eq(systemEventsTable.eventType, "auto_renew_failed")));
    expect(events).toHaveLength(1);

    await collectCreated(userId);
  });

  // ── Scenario 9: Already renewed guard ───────────────────────────────────────
  it("scenario 9: already has a future active subscription → skipped, no debit", async () => {
    const initialBalance = PLAN_PRICE_RUB * 100 * 5;
    const { id: userId } = await seedUser(initialBalance);

    // Current expiring subscription
    const { id: expiringSubId } = await seedExpiringSubscription(userId, 12);
    subIds.push(expiringSubId);

    // A future active subscription (already renewed manually)
    const futureStartsAt = new Date(Date.now() + 2 * 60 * 60 * 1_000);
    const [futureSub] = await db
      .insert(subscriptionsTable)
      .values({
        userId,
        planId,
        status: "active",
        startsAt: futureStartsAt,
        endsAt: new Date(futureStartsAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
      })
      .returning({ id: subscriptionsTable.id });
    subIds.push(futureSub!.id);

    await runAutoRenew();

    // Balance must not have been touched
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    expect(user!.balanceKopecks).toBe(initialBalance);

    // No auto_renew_success event
    const events = await db
      .select()
      .from(systemEventsTable)
      .where(and(eq(systemEventsTable.userId, userId), eq(systemEventsTable.eventType, "auto_renew_success")));
    expect(events).toHaveLength(0);

    // confirmPaymentById never called
    expect(vi.mocked(confirmPaymentById)).not.toHaveBeenCalled();

    userIds.push(userId);
  });
});
