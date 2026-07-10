import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, paymentSettingsTable } from "@workspace/db";
import { UpdatePaymentSettingsBody, UpdatePaymentSettingsResponse } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

router.patch("/admin/payment-settings", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = UpdatePaymentSettingsBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db.select().from(paymentSettingsTable).limit(1);

  const [settings] = existing
    ? await db
        .update(paymentSettingsTable)
        .set(parsed.data)
        .where(eq(paymentSettingsTable.id, existing.id))
        .returning()
    : await db
        .insert(paymentSettingsTable)
        .values({
          sbpPhone: parsed.data.sbpPhone ?? "",
          sbpBank: parsed.data.sbpBank ?? "",
          sbpRecipientName: parsed.data.sbpRecipientName ?? "",
          instructions: parsed.data.instructions,
          yookassaEnabled: parsed.data.yookassaEnabled ?? false,
          extraDeviceSlotPriceRub: parsed.data.extraDeviceSlotPriceRub,
          trialEnabled: parsed.data.trialEnabled ?? false,
          trialDays: parsed.data.trialDays ?? 5,
          minHourlyTopupRub: parsed.data.minHourlyTopupRub ?? 0,
          primaryDomain: parsed.data.primaryDomain ?? "",
        })
        .returning();

  res.json(UpdatePaymentSettingsResponse.parse(settings));
});

export default router;
