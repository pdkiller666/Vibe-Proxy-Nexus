import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import {
  balanceTransactionsTable,
  db,
  paymentSettingsTable,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  systemEventsTable,
  usersTable,
  vpnKeysTable,
} from "@workspace/db";
import app from "../app";
import { confirmPaymentById, refundPaymentById } from "../lib/confirmPayment";
import { hashPassword } from "../lib/password";

const request = supertest(app);
const password = "correct-horse-battery-staple";
const uid = () => randomBytes(6).toString("hex");

type TestUser = {
  id: number;
  email: string;
  cookie: string;
};

async function createUser(options: { role?: "user" | "admin"; referredByUserId?: number } = {}): Promise<TestUser> {
  const email = `referral-offer-${uid()}@example.com`;
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      referralCode: uid(),
      role: options.role,
      referredByUserId: options.referredByUserId,
    })
    .returning({ id: usersTable.id });

  const login = await request.post("/api/auth/login").send({ email, password });
  expect(login.status).toBe(200);
  const cookies = Array.isArray(login.headers["set-cookie"])
    ? login.headers["set-cookie"]
    : [login.headers["set-cookie"]];
  const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");

  return { id: user!.id, email, cookie: sessionCookie.split(";")[0] };
}

async function loginAgain(email: string): Promise<string> {
  const login = await request.post("/api/auth/login").send({ email, password });
  expect(login.status).toBe(200);
  const cookies = Array.isArray(login.headers["set-cookie"])
    ? login.headers["set-cookie"]
    : [login.headers["set-cookie"]];
  const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  return sessionCookie.split(";")[0];
}

describe("referral offer notifications", () => {
  let planId: number;
  let settingsId: number | null = null;
  let insertedSettings = false;
  let originalCommission = 0;
  const userIds: number[] = [];
  const subscriptionIds: number[] = [];
  const paymentIds: number[] = [];

  beforeAll(async () => {
    const [existing] = await db.select().from(paymentSettingsTable).limit(1);
    if (existing) {
      settingsId = existing.id;
      originalCommission = existing.referralCommissionPercent;
    } else {
      const [created] = await db
        .insert(paymentSettingsTable)
        .values({
          sbpPhone: "",
          sbpBank: "",
          sbpRecipientName: "",
          referralCommissionPercent: 10,
        })
        .returning({ id: paymentSettingsTable.id });
      settingsId = created!.id;
      insertedSettings = true;
    }

    const [plan] = await db
      .insert(plansTable)
      .values({
        name: `Referral offer plan ${uid()}`,
        priceRub: 100,
        durationDays: 30,
      })
      .returning({ id: plansTable.id });
    planId = plan!.id;
  });

  beforeEach(async () => {
    await db
      .update(paymentSettingsTable)
      .set({ referralCommissionPercent: 10 })
      .where(eq(paymentSettingsTable.id, settingsId!));
  });

  afterEach(async () => {
    const ids = userIds.splice(0);
    const paymentIdList = paymentIds.splice(0);
    const subscriptionIdList = subscriptionIds.splice(0);

    if (ids.length > 0) {
      await db.delete(systemEventsTable).where(inArray(systemEventsTable.userId, ids));
      await db.delete(balanceTransactionsTable).where(inArray(balanceTransactionsTable.userId, ids));
      await db.delete(vpnKeysTable).where(inArray(vpnKeysTable.userId, ids));
    }
    if (paymentIdList.length > 0) {
      await db.delete(paymentsTable).where(inArray(paymentsTable.id, paymentIdList));
    }
    if (subscriptionIdList.length > 0) {
      await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.id, subscriptionIdList));
    }
    if (ids.length > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, ids));
    }
  });

  afterAll(async () => {
    await db.delete(plansTable).where(eq(plansTable.id, planId));
    if (insertedSettings && settingsId !== null) {
      await db.delete(paymentSettingsTable).where(eq(paymentSettingsTable.id, settingsId));
    } else if (settingsId !== null) {
      await db
        .update(paymentSettingsTable)
        .set({ referralCommissionPercent: originalCommission })
        .where(eq(paymentSettingsTable.id, settingsId));
    }
  });

  async function seedSubscriptionPayment(
    userId: number,
    provider: "manual_sbp" | "balance" | "free_grant" = "manual_sbp",
  ): Promise<number> {
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({ userId, planId, status: "pending_payment" })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription!.id);

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId,
        subscriptionId: subscription!.id,
        type: "subscription",
        provider,
        amountRub: 100,
        status: "pending",
        reference: `REF-SUB-${uid()}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(payment!.id);
    return payment!.id;
  }

  async function seedBalanceTopupPayment(userId: number): Promise<number> {
    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId,
        type: "balance_topup",
        provider: "manual_sbp",
        amountRub: 100,
        status: "pending",
        reference: `REF-TOPUP-${uid()}`,
      })
      .returning({ id: paymentsTable.id });
    paymentIds.push(payment!.id);
    return payment!.id;
  }

  it("queues the subscription referral card and lets exactly one of two sessions claim the first-payment dialog", async () => {
    const user = await createUser();
    userIds.push(user.id);
    const secondSessionCookie = await loginAgain(user.email);
    const paymentId = await seedSubscriptionPayment(user.id);

    const result = await confirmPaymentById(paymentId);
    expect(result.ok).toBe(true);

    const notifications = await request.get("/api/notifications").set("Cookie", user.cookie);
    expect(notifications.status).toBe(200);
    const paymentEvent = notifications.body.find(
      (event: { eventType: string; metadata: { paymentId?: number } }) =>
        event.eventType === "payment_confirmed" && event.metadata.paymentId === paymentId,
    );
    const referralCardEvent = notifications.body.find(
      (event: { eventType: string; metadata: { paymentId?: number } }) =>
        event.eventType === "referral_payment_offer" && event.metadata.paymentId === paymentId,
    );
    const firstOfferEvent = notifications.body.find(
      (event: { eventType: string }) => event.eventType === "referral_first_payment_offer",
    );
    expect(paymentEvent).toBeDefined();
    expect(referralCardEvent).toBeDefined();
    expect(firstOfferEvent).toBeDefined();

    // This is the same atomic claim that runs before the first-payment dialog
    // is rendered. A reload or another device must lose the race.
    const claims = await Promise.all([
      request
        .post(`/api/notifications/${firstOfferEvent.id}/acknowledge`)
        .set("Cookie", user.cookie),
      request
        .post(`/api/notifications/${firstOfferEvent.id}/acknowledge`)
        .set("Cookie", secondSessionCookie),
    ]);
    expect(claims.map((claim) => claim.status).sort()).toEqual([200, 404]);

    const afterDialogClaim = await request.get("/api/notifications").set("Cookie", user.cookie);
    expect(afterDialogClaim.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstOfferEvent.id })]),
    );

    // The referral-specific event drives ReferralPaymentOffer on the confirmed
    // checkout page. Exactly one device can claim it, while payment_confirmed
    // remains available as the normal confirmation notification.
    const cardClaims = await Promise.all([
      request
        .post(`/api/notifications/${referralCardEvent.id}/acknowledge`)
        .set("Cookie", user.cookie),
      request
        .post(`/api/notifications/${referralCardEvent.id}/acknowledge`)
        .set("Cookie", secondSessionCookie),
    ]);
    expect(cardClaims.map((claim) => claim.status).sort()).toEqual([200, 404]);
    const afterReload = await request.get("/api/notifications").set("Cookie", secondSessionCookie);
    expect(afterReload.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: referralCardEvent.id })]),
    );
    expect(afterReload.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: paymentEvent.id })]),
    );
  });

  it("does not queue referral offers for a balance top-up", async () => {
    const user = await createUser();
    userIds.push(user.id);
    const paymentId = await seedBalanceTopupPayment(user.id);

    const result = await confirmPaymentById(paymentId);
    expect(result.ok).toBe(true);

    const notifications = await request.get("/api/notifications").set("Cookie", user.cookie);
    expect(notifications.status).toBe(200);
    expect(notifications.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "payment_confirmed",
          metadata: expect.objectContaining({ paymentId, type: "balance_topup" }),
        }),
      ]),
    );
    expect(notifications.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "referral_payment_offer",
          metadata: expect.objectContaining({ paymentId, type: "balance_topup" }),
        }),
      ]),
    );
    expect(notifications.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "referral_first_payment_offer",
          metadata: expect.objectContaining({ paymentId, type: "balance_topup" }),
        }),
      ]),
    );
  });

  it("does not queue referral offers for balance-funded or free-grant subscriptions", async () => {
    for (const provider of ["balance", "free_grant"] as const) {
      const user = await createUser();
      userIds.push(user.id);
      const paymentId = await seedSubscriptionPayment(user.id, provider);

      const result = await confirmPaymentById(paymentId);
      expect(result.ok).toBe(true);

      const notifications = await request
        .get("/api/notifications")
        .set("Cookie", user.cookie);
      expect(notifications.status).toBe(200);
      expect(notifications.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "payment_confirmed",
            metadata: expect.objectContaining({ paymentId, type: "subscription" }),
          }),
        ]),
      );
      expect(notifications.body).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "referral_payment_offer",
            metadata: expect.objectContaining({ paymentId }),
          }),
        ]),
      );
      expect(notifications.body).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "referral_first_payment_offer",
            metadata: expect.objectContaining({ paymentId }),
          }),
        ]),
      );
    }
  });

  it("does not create a first-payment dialog for background renewal or a zero referral commission", async () => {
    const renewalUser = await createUser();
    userIds.push(renewalUser.id);
    const renewalPaymentId = await seedSubscriptionPayment(renewalUser.id);

    const renewalResult = await confirmPaymentById(renewalPaymentId, {
      suppressReferralFirstOffer: true,
    });
    expect(renewalResult.ok).toBe(true);
    const renewalNotifications = await request
      .get("/api/notifications")
      .set("Cookie", renewalUser.cookie);
    expect(renewalNotifications.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "payment_confirmed",
          metadata: expect.objectContaining({ paymentId: renewalPaymentId }),
        }),
      ]),
    );
    expect(renewalNotifications.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "referral_first_payment_offer" }),
        expect.objectContaining({ eventType: "referral_payment_offer" }),
      ]),
    );

    await db
      .update(paymentSettingsTable)
      .set({ referralCommissionPercent: 0 })
      .where(eq(paymentSettingsTable.id, settingsId!));
    const noCommissionUser = await createUser();
    userIds.push(noCommissionUser.id);
    const topupPaymentId = await seedBalanceTopupPayment(noCommissionUser.id);

    const noCommissionResult = await confirmPaymentById(topupPaymentId);
    expect(noCommissionResult.ok).toBe(true);
    const noCommissionNotifications = await request
      .get("/api/notifications")
      .set("Cookie", noCommissionUser.cookie);
    expect(noCommissionNotifications.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "payment_confirmed",
          metadata: expect.objectContaining({ paymentId: topupPaymentId }),
        }),
      ]),
    );
    expect(noCommissionNotifications.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "referral_first_payment_offer" }),
        expect.objectContaining({ eventType: "referral_payment_offer" }),
      ]),
    );
  });

  it("keeps user and admin referral analytics aligned across payment states and repeated payments", async () => {
    const referrer = await createUser();
    userIds.push(referrer.id);
    const admin = await createUser({ role: "admin" });
    userIds.push(admin.id);
    const adminCookie = admin.cookie;

    const registeredOnly = await createUser({ referredByUserId: referrer.id });
    const pendingPayer = await createUser({ referredByUserId: referrer.id });
    const topupPayer = await createUser({ referredByUserId: referrer.id });
    const balancePayer = await createUser({ referredByUserId: referrer.id });
    const freeGrantPayer = await createUser({ referredByUserId: referrer.id });
    const payingPayer = await createUser({ referredByUserId: referrer.id });
    userIds.push(
      registeredOnly.id,
      pendingPayer.id,
      topupPayer.id,
      balancePayer.id,
      freeGrantPayer.id,
      payingPayer.id,
    );

    // Six registrations count immediately, but a pending subscription does
    // not make its owner a paying referral.
    await seedSubscriptionPayment(pendingPayer.id);
    const pendingMe = await request.get("/api/me").set("Cookie", referrer.cookie);
    expect(pendingMe.status).toBe(200);
    expect(pendingMe.body.referredUserCount).toBe(6);
    expect(pendingMe.body.referredPayingUserCount).toBe(0);
    expect(pendingMe.body.referralEarningsKopecks).toBe(0);

    // A confirmed wallet top-up is still not subscription revenue, referral
    // progress, or a commission.
    const topupPaymentId = await seedBalanceTopupPayment(topupPayer.id);
    const topupResult = await confirmPaymentById(topupPaymentId);
    expect(topupResult.ok).toBe(true);

    const afterTopupMe = await request.get("/api/me").set("Cookie", referrer.cookie);
    expect(afterTopupMe.status).toBe(200);
    expect(afterTopupMe.body.referredUserCount).toBe(6);
    expect(afterTopupMe.body.referredPayingUserCount).toBe(0);
    expect(afterTopupMe.body.referralEarningsKopecks).toBe(0);

    // Subscription rows funded from the wallet or granted for free are also
    // excluded, even though their payment type is "subscription".
    const balanceSubscriptionPaymentId = await seedSubscriptionPayment(
      balancePayer.id,
      "balance",
    );
    const balanceSubscriptionResult = await confirmPaymentById(
      balanceSubscriptionPaymentId,
    );
    expect(balanceSubscriptionResult.ok).toBe(true);
    const freeGrantSubscriptionPaymentId = await seedSubscriptionPayment(
      freeGrantPayer.id,
      "free_grant",
    );
    const freeGrantSubscriptionResult = await confirmPaymentById(
      freeGrantSubscriptionPaymentId,
    );
    expect(freeGrantSubscriptionResult.ok).toBe(true);

    const afterInternalSubscriptionsMe = await request
      .get("/api/me")
      .set("Cookie", referrer.cookie);
    expect(afterInternalSubscriptionsMe.status).toBe(200);
    expect(afterInternalSubscriptionsMe.body.referredUserCount).toBe(6);
    expect(afterInternalSubscriptionsMe.body.referredPayingUserCount).toBe(0);
    expect(afterInternalSubscriptionsMe.body.referralEarningsKopecks).toBe(0);

    // Confirm two subscription payments for the same referred user. The
    // analytics must count one paying user, sum both real payments once, and
    // match the two ledger commissions.
    const firstSubscriptionPaymentId = await seedSubscriptionPayment(payingPayer.id);
    const firstSubscriptionResult = await confirmPaymentById(firstSubscriptionPaymentId);
    expect(firstSubscriptionResult.ok).toBe(true);
    const secondSubscriptionPaymentId = await seedSubscriptionPayment(payingPayer.id);
    const secondSubscriptionResult = await confirmPaymentById(secondSubscriptionPaymentId);
    expect(secondSubscriptionResult.ok).toBe(true);

    const me = await request.get("/api/me").set("Cookie", referrer.cookie);
    expect(me.status).toBe(200);
    expect(me.body.referredUserCount).toBe(6);
    expect(me.body.referredPayingUserCount).toBe(1);
    expect(me.body.referralEarningsKopecks).toBe(2_000);

    const adminReferrals = await request
      .get("/api/admin/referrals")
      .set("Cookie", adminCookie);
    expect(adminReferrals.status).toBe(200);
    expect(adminReferrals.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: referrer.id,
          referredCount: 6,
          payingReferredCount: 1,
          totalRevenueRub: 200,
          commissionsRub: 20,
        }),
      ]),
    );

    // A returned subscription payment must remove its commission from both
    // user-facing and admin-facing lifetime analytics, not only from balance.
    const refundResult = await refundPaymentById(secondSubscriptionPaymentId);
    expect(refundResult.ok).toBe(true);

    const afterRefundMe = await request.get("/api/me").set("Cookie", referrer.cookie);
    expect(afterRefundMe.status).toBe(200);
    expect(afterRefundMe.body.referredPayingUserCount).toBe(1);
    expect(afterRefundMe.body.referralEarningsKopecks).toBe(1_000);

    const afterRefundAdminReferrals = await request
      .get("/api/admin/referrals")
      .set("Cookie", adminCookie);
    expect(afterRefundAdminReferrals.status).toBe(200);
    expect(afterRefundAdminReferrals.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: referrer.id,
          referredCount: 6,
          payingReferredCount: 1,
          totalRevenueRub: 100,
          commissionsRub: 10,
        }),
      ]),
    );

  });
});