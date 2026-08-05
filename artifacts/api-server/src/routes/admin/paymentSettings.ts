import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, paymentSettingsTable } from "@workspace/db";
import { UpdatePaymentSettingsBody, UpdatePaymentSettingsResponse, UploadSbpQrBody } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import {
  buildHappIosRoutingUrl,
  resolveHappIosRoutingProfile,
  type HappIosRoutingProfile,
} from "../../lib/happIosRouting";
import {
  resolveAppDownloadLinks,
  type AppDownloadLinks,
} from "../../lib/appDownloadLinks";

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
          trialPlanId: parsed.data.trialPlanId ?? null,
          minHourlyTopupRub: parsed.data.minHourlyTopupRub ?? 0,
          primaryDomain: parsed.data.primaryDomain ?? "",
          referralCommissionPercent: parsed.data.referralCommissionPercent ?? 0,
          sbpPaymentUrl: parsed.data.sbpPaymentUrl ?? "",
          showManualSbpDetails: parsed.data.showManualSbpDetails ?? false,
          happIosRoutingProfile: parsed.data.happIosRoutingProfile ?? null,
        })
        .returning();

  // Compute derived fields from saved values (or defaults when null).
  const storedProfile = settings!.happIosRoutingProfile as HappIosRoutingProfile | null;
  const happIosRoutingProfile = resolveHappIosRoutingProfile(storedProfile);
  const happIosRoutingUrl = buildHappIosRoutingUrl(happIosRoutingProfile);

  const storedLinks = settings!.appDownloadLinks as AppDownloadLinks | null;
  const appDownloadLinks = resolveAppDownloadLinks(storedLinks);

  // Strip QR blob and raw JSON columns from response — replace with derived fields.
  const {
    sbpQrCodeData: _d,
    sbpQrCodeMimeType: _m,
    happIosRoutingProfile: _hp,
    appDownloadLinks: _al,
    ...rest
  } = settings!;

  res.json(UpdatePaymentSettingsResponse.parse({
    ...rest,
    hasSbpQr: Boolean(_d),
    primaryDomainHealthy: true, // live check skipped on write — client refetches
    happIosRoutingUrl,
    happIosRoutingProfile,
    appDownloadLinks,
  }));
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
