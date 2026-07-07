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
  trialEnabled: boolean("trial_enabled").notNull().default(false),
  trialDays: integer("trial_days").notNull().default(5),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPaymentSettingsSchema = createInsertSchema(paymentSettingsTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertPaymentSettings = z.infer<typeof insertPaymentSettingsSchema>;
export type PaymentSettings = typeof paymentSettingsTable.$inferSelect;
