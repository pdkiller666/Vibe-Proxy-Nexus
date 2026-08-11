import { Router, type IRouter } from "express";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { db, paymentsTable, paymentSettingsTable, plansTable, subscriptionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { generatePaymentReference } from "../lib/vless";
import { confirmPaymentById } from "../lib/confirmPayment";

const router: IRouter = Router();

router.post("/extra-traffic-order", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const [activeSub] = await db
    .select({
      id: subscriptionsTable.id,
      trafficLimitGb: plansTable.trafficLimitGb,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(and(eq(subscriptionsTable.userId, user.id), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  if (!activeSub) {
    res.status(403).json({ error: "Нужна активная подписка для покупки дополнительного трафика." });
    return;
  }

  if (activeSub.trafficLimitGb == null) {
    res.status(409).json({ error: "У вашего тарифа нет лимита трафика — докупка не требуется." });
    return;
  }

  const [existingPending] = await db
    .select({ id: paymentsTable.id })
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.userId, user.id),
        eq(paymentsTable.type, "extra_traffic"),
        eq(paymentsTable.status, "pending"),
      ),
    )
    .limit(1);

  if (existingPending) {
    res.status(409).json({
      error: "У вас уже есть ожидающий платёж за дополнительный трафик.",
      paymentId: existingPending.id,
    });
    return;
  }

  const [settings] = await db.select().from(paymentSettingsTable).limit(1);
  const amountRub = settings?.extraTrafficPriceRub ?? 0;
  const packageGb = settings?.extraTrafficPackageGb ?? 0;

  if (packageGb <= 0) {
    res.status(403).json({ error: "Покупка дополнительного трафика временно недоступна." });
    return;
  }

  // Price 0 normally means "not configured" — block purchases unless the
  // admin has explicitly opted into granting free top-ups. When free grants
  // are enabled, we still go through the payments table (provider "free_grant")
  // so that grants are auditable and rate-limited by the cooldown settings.
  if (amountRub <= 0) {
    if (!settings?.allowFreeExtraTraffic) {
      res.status(403).json({ error: "Покупка дополнительного трафика временно недоступна." });
      return;
    }

    // Rate-limit free grants: count confirmed free grants the user received
    // within the rolling cooldown window (default: 1 per 24 hours).
    const cooldownHours = settings?.freeTrafficGrantCooldownHours ?? 24;
    const grantsPerCooldown = settings?.freeTrafficGrantsPerCooldown ?? 1;
    const since = new Date(Date.now() - cooldownHours * 3_600_000);

    const [{ recentCount }] = await db
      .select({ recentCount: count() })
      .from(paymentsTable)
      .where(
        and(
          eq(paymentsTable.userId, user.id),
          eq(paymentsTable.type, "extra_traffic"),
          eq(paymentsTable.amountRub, 0),
          eq(paymentsTable.status, "confirmed"),
          gte(paymentsTable.confirmedAt, since),
        ),
      );

    if (recentCount >= grantsPerCooldown) {
      res.status(429).json({
        error: `Бесплатный пакет трафика уже был выдан. Следующий доступен через ${cooldownHours} ч.`,
      });
      return;
    }

    // Create a pending payment record (provider "free_grant") and confirm it
    // immediately through the shared confirmPaymentById path. This gives free
    // grants an auditable trail in the payments table and ensures
    // ensureActiveKeyForUser is called if the user's keys were previously revoked.
    const reference = generatePaymentReference(user.id * 10000 + (Date.now() % 10000));
    const [pendingPayment] = await db
      .insert(paymentsTable)
      .values({
        userId: user.id,
        subscriptionId: activeSub.id,
        type: "extra_traffic",
        provider: "free_grant",
        amountRub: 0,
        extraTrafficGb: packageGb,
        status: "pending",
        reference,
      })
      .returning();

    const confirmResult = await confirmPaymentById(pendingPayment.id);
    if (!confirmResult.ok) {
      // Roll back the orphaned pending record so it cannot block future grants.
      await db
        .update(paymentsTable)
        .set({ status: "rejected", rejectionReason: "Auto-confirm failed" })
        .where(eq(paymentsTable.id, pendingPayment.id));
      res.status(500).json({ error: "Не удалось выдать бесплатный трафик — попробуйте ещё раз." });
      return;
    }

    res.status(200).json({ freeGranted: true, amountRub: 0, extraTrafficGb: packageGb });
    return;
  }

  const reference = generatePaymentReference(user.id * 10000 + (Date.now() % 10000));

  let payment: typeof paymentsTable.$inferSelect | undefined;
  try {
    [payment] = await db
      .insert(paymentsTable)
      .values({
        subscriptionId: activeSub.id,
        userId: user.id,
        type: "extra_traffic",
        provider: "manual_sbp",
        amountRub,
        extraTrafficGb: packageGb,
        status: "pending",
        reference,
      })
      .returning();
  } catch (err) {
    // PostgreSQL unique_violation (23505) means Amvera retried a request that
    // already committed. Re-fetch the existing pending row and return 409 —
    // same shape as the app-level guard — so the client never sees a 500 for
    // what is effectively a successful prior creation.
    const pgCode =
      (err as { code?: string; cause?: { code?: string } })?.code ??
      (err as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === "23505") {
      const [existing] = await db
        .select({ id: paymentsTable.id })
        .from(paymentsTable)
        .where(
          and(
            eq(paymentsTable.userId, user.id),
            eq(paymentsTable.type, "extra_traffic"),
            eq(paymentsTable.status, "pending"),
          ),
        )
        .limit(1);
      if (existing) {
        res.status(409).json({
          error: "У вас уже есть ожидающий платёж за дополнительный трафик.",
          paymentId: existing.id,
        });
        return;
      }
    }
    throw err;
  }

  if (!payment) {
    res.status(500).json({ error: "Failed to create payment" });
    return;
  }

  res.status(201).json({ paymentId: payment.id, amountRub, freeGranted: false, extraTrafficGb: packageGb });
});

router.delete("/extra-traffic-order/:paymentId", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const paymentId = Number(req.params.paymentId);

  if (!paymentId || Number.isNaN(paymentId)) {
    res.status(400).json({ error: "Invalid payment id" });
    return;
  }

  const [payment] = await db
    .select()
    .from(paymentsTable)
    .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.userId, user.id)));

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  if (payment.type !== "extra_traffic") {
    res.status(400).json({ error: "Not an extra traffic payment" });
    return;
  }

  if (payment.status !== "pending") {
    res.status(409).json({ error: "Можно отменить только ожидающий платёж." });
    return;
  }

  await db
    .update(paymentsTable)
    .set({ status: "rejected", rejectionReason: "Отменено пользователем" })
    .where(and(eq(paymentsTable.id, paymentId), eq(paymentsTable.status, "pending")));

  res.json({ ok: true });
});

export default router;
