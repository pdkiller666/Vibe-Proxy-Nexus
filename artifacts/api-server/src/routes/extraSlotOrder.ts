import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, paymentsTable, paymentSettingsTable, subscriptionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { generatePaymentReference } from "../lib/vless";

const router: IRouter = Router();

router.post("/extra-slot-order", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const [activeSub] = await db
    .select({ id: subscriptionsTable.id })
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, user.id), eq(subscriptionsTable.status, "active")))
    .limit(1);

  if (!activeSub) {
    res.status(403).json({ error: "Нужна активная подписка для покупки дополнительного слота устройства." });
    return;
  }

  const [existingPending] = await db
    .select({ id: paymentsTable.id })
    .from(paymentsTable)
    .where(
      and(
        eq(paymentsTable.userId, user.id),
        eq(paymentsTable.type, "extra_device_slot"),
        eq(paymentsTable.status, "pending"),
      ),
    )
    .limit(1);

  if (existingPending) {
    res.status(409).json({
      error: "У вас уже есть ожидающий платёж за дополнительное устройство.",
      paymentId: existingPending.id,
    });
    return;
  }

  const [settings] = await db.select().from(paymentSettingsTable).limit(1);
  const amountRub = settings?.extraDeviceSlotPriceRub ?? 0;

  const reference = generatePaymentReference(user.id * 10000 + (Date.now() % 10000));

  const [payment] = await db
    .insert(paymentsTable)
    .values({
      subscriptionId: null,
      userId: user.id,
      type: "extra_device_slot",
      provider: "manual_sbp",
      amountRub,
      status: "pending",
      reference,
    })
    .returning();

  if (!payment) {
    res.status(500).json({ error: "Failed to create payment" });
    return;
  }

  res.status(201).json({ paymentId: payment.id, amountRub });
});

router.delete("/extra-slot-order/:paymentId", requireAuth, async (req, res): Promise<void> => {
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

  if (payment.type !== "extra_device_slot") {
    res.status(400).json({ error: "Not an extra device slot payment" });
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
