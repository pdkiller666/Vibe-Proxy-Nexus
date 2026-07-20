import { Router, type IRouter } from "express";
import { db, paymentSettingsTable } from "@workspace/db";
import { GetPaymentSettingsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/** Strip the raw QR blob from the DB row and replace it with a boolean flag. */
function withHasSbpQr<
  T extends { sbpQrCodeData: string | null; sbpQrCodeMimeType: string | null },
>(settings: T) {
  const { sbpQrCodeData: _data, sbpQrCodeMimeType: _mime, ...rest } = settings;
  return { ...rest, hasSbpQr: Boolean(settings.sbpQrCodeData) };
}

router.get("/payment-settings", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(paymentSettingsTable).limit(1);

  if (!settings) {
    res.json(
      GetPaymentSettingsResponse.parse({
        sbpPhone: "",
        sbpBank: "",
        sbpRecipientName: "",
        instructions: "Платёжные реквизиты ещё не настроены администратором.",
        yookassaEnabled: true,
        sbpEnabled: true,
        extraDeviceSlotPriceRub: 0,
        allowFreeExtraDeviceSlot: false,
        extraTrafficPriceRub: 0,
        extraTrafficPackageGb: 0,
        allowFreeExtraTraffic: false,
        trialEnabled: false,
        trialDays: 5,
        minHourlyTopupRub: 0,
        sbpPaymentUrl: "",
        showManualSbpDetails: false,
        hasSbpQr: false,
      }),
    );
    return;
  }

  res.json(GetPaymentSettingsResponse.parse(withHasSbpQr(settings)));
});

// Public: serve the admin-uploaded SBP QR code image as binary.
// Returns 404 when no QR has been uploaded yet.
router.get("/payment-settings/sbp-qr-image", async (_req, res): Promise<void> => {
  const [settings] = await db
    .select({
      sbpQrCodeData: paymentSettingsTable.sbpQrCodeData,
      sbpQrCodeMimeType: paymentSettingsTable.sbpQrCodeMimeType,
    })
    .from(paymentSettingsTable)
    .limit(1);

  if (!settings?.sbpQrCodeData) {
    res.status(404).end();
    return;
  }

  res.setHeader("Content-Type", settings.sbpQrCodeMimeType ?? "image/png");
  res.setHeader("Cache-Control", "public, max-age=60");
  res.send(Buffer.from(settings.sbpQrCodeData, "base64"));
});

export default router;
