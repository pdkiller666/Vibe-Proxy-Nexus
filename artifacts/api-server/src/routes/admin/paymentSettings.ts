import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, paymentSettingsTable } from "@workspace/db";
import { UpdatePaymentSettingsBody, UpdatePaymentSettingsResponse, UploadSbpQrBody } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

// ── PATCH /admin/payment-settings ────────────────────────────────────────────
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
          yookassaEnabled: parsed.data.yookassaEnabled ?? true,
          sbpEnabled: parsed.data.sbpEnabled ?? true,
          extraDeviceSlotPriceRub: parsed.data.extraDeviceSlotPriceRub,
          trialEnabled: parsed.data.trialEnabled ?? false,
          trialDays: parsed.data.trialDays ?? 5,
          minHourlyTopupRub: parsed.data.minHourlyTopupRub ?? 0,
          primaryDomain: parsed.data.primaryDomain ?? "",
          referralCommissionPercent: parsed.data.referralCommissionPercent ?? 0,
          sbpPaymentUrl: parsed.data.sbpPaymentUrl ?? "",
          showManualSbpDetails: parsed.data.showManualSbpDetails ?? false,
        })
        .returning();

  // Strip QR blob from response (hasSbpQr comes via /payment-settings GET)
  const { sbpQrCodeData: _d, sbpQrCodeMimeType: _m, ...rest } = settings!;
  res.json(UpdatePaymentSettingsResponse.parse({ ...rest, hasSbpQr: Boolean(_d) }));
});

// ── PUT /admin/payment-settings/sbp-qr ───────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

router.put("/admin/payment-settings/sbp-qr", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = UploadSbpQrBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid QR payload." });
    return;
  }
  if (!ALLOWED_MIME_TYPES.has(parsed.data.mimeType)) {
    res.status(400).json({ error: "mimeType must be image/png, image/jpeg, image/webp, or image/gif." });
    return;
  }
  // Rough base64-size guard: 8 MB decoded ≈ 10.7 MB base64
  if (parsed.data.data.length > 11 * 1024 * 1024) {
    res.status(413).json({ error: "QR image too large (max 8 MB)." });
    return;
  }

  const [existing] = await db.select({ id: paymentSettingsTable.id }).from(paymentSettingsTable).limit(1);

  if (existing) {
    await db
      .update(paymentSettingsTable)
      .set({ sbpQrCodeData: parsed.data.data, sbpQrCodeMimeType: parsed.data.mimeType })
      .where(eq(paymentSettingsTable.id, existing.id));
  } else {
    await db.insert(paymentSettingsTable).values({
      sbpPhone: "",
      sbpBank: "",
      sbpRecipientName: "",
      sbpQrCodeData: parsed.data.data,
      sbpQrCodeMimeType: parsed.data.mimeType,
    });
  }

  res.status(200).json({ ok: true });
});

// ── DELETE /admin/payment-settings/sbp-qr ────────────────────────────────────
router.delete("/admin/payment-settings/sbp-qr", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const [existing] = await db.select({ id: paymentSettingsTable.id }).from(paymentSettingsTable).limit(1);
  if (existing) {
    await db
      .update(paymentSettingsTable)
      .set({ sbpQrCodeData: null, sbpQrCodeMimeType: null })
      .where(eq(paymentSettingsTable.id, existing.id));
  }
  res.status(200).json({ ok: true });
});

export default router;
