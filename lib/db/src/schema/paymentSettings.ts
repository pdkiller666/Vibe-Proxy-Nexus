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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPaymentSettingsSchema = createInsertSchema(paymentSettingsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertPaymentSettings = z.infer<typeof insertPaymentSettingsSchema>;
export type PaymentSettings = typeof paymentSettingsTable.$inferSelect;
