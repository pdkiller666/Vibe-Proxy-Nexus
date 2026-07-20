import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const paymentSettingsTable = pgTable("payment_settings", {
  id: serial("id").primaryKey(),
  sbpPhone: text("sbp_phone").notNull(),
  sbpBank: text("sbp_bank").notNull(),
  sbpRecipientName: text("sbp_recipient_name").notNull(),
  instructions: text("instructions"),
  yookassaEnabled: boolean("yookassa_enabled").notNull().default(false),
  extraDeviceSlotPriceRub: integer("extra_device_slot_price_rub").notNull().default(0),
  // When extraDeviceSlotPriceRub is 0/unset, the "add device" button is
  // disabled by default rather than silently offering a free slot. An admin
  // must explicitly opt in here to allow issuing extra slots for free.
  allowFreeExtraDeviceSlot: boolean("allow_free_extra_device_slot").notNull().default(false),
  // Self-service traffic top-up: price (rubles) for one package of
  // extraTrafficPackageGb gigabytes, added to the active subscription's
  // extraTrafficGb for the rest of the current period. Mirrors the
  // extraDeviceSlot pricing pattern above.
  extraTrafficPriceRub: integer("extra_traffic_price_rub").notNull().default(0),
  extraTrafficPackageGb: integer("extra_traffic_package_gb").notNull().default(10),
  // Same free-grant escape hatch as allowFreeExtraDeviceSlot, for symmetry.
  allowFreeExtraTraffic: boolean("allow_free_extra_traffic").notNull().default(false),
  trialEnabled: boolean("trial_enabled").notNull().default(false),
  trialDays: integer("trial_days").notNull().default(5),
  // Minimum wallet balance (in rubles) a user must hold/top up before an
  // hourly plan can be activated. 0 = no minimum beyond the normal
  // one-tick balance check in subscriptions.ts.
  minHourlyTopupRub: integer("min_hourly_topup_rub").notNull().default(0),
  // Public-facing domain embedded in subscription/vless links when healthy
  // (e.g. "vpnexus.pro"). Empty string means "use the built-in default".
  // Admin-editable so it can be swapped instantly if the domain is blocked.
  primaryDomain: text("primary_domain").notNull().default(""),
  // % of a referred user's confirmed subscription payment (amountRub) credited
  // to the referrer's wallet balance — see admin/payments.ts confirm route.
  // Only applies to payment.type === "subscription"; 0 disables payouts.
  referralCommissionPercent: integer("referral_commission_percent").notNull().default(0),
  // SBP payment settings: editable via admin panel without redeploy.
  // sbpPaymentUrl: link for the "Перейти к оплате по СБП" button; falls back
  //   to the hardcoded Ozon Bank URL when empty.
  // showManualSbpDetails: toggles the phone/bank/recipient CopyField block on
  //   checkout pages (hidden by default, admin enables when needed).
  // sbpQrCodeData/MimeType: base64 QR image served via /payment-settings/sbp-qr-image.
  sbpPaymentUrl: text("sbp_payment_url").notNull().default(""),
  showManualSbpDetails: boolean("show_manual_sbp_details").notNull().default(false),
  // Payment-method visibility toggles — controlled from the admin panel.
  // yookassaEnabled: show the "Карта / SberPay" tile on checkout pages.
  //   Defaults to true (backfilled via heal-schema M-12 for existing rows
  //   because the tile was always visible before this toggle existed).
  // sbpEnabled: show the "СБП" tile on checkout pages.
  //   Defaults to true so existing installs are unaffected on upgrade.
  sbpEnabled: boolean("sbp_enabled").notNull().default(true),
  sbpQrCodeData: text("sbp_qr_code_data"),
  sbpQrCodeMimeType: text("sbp_qr_code_mime_type"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPaymentSettingsSchema = createInsertSchema(paymentSettingsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertPaymentSettings = z.infer<typeof insertPaymentSettingsSchema>;
export type PaymentSettings = typeof paymentSettingsTable.$inferSelect;
