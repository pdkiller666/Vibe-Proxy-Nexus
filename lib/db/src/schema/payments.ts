import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { subscriptionsTable } from "./subscriptions";

export const paymentProviderValues = ["manual_sbp", "yookassa"] as const;
export const paymentStatusValues = ["pending", "confirmed", "rejected"] as const;
export const paymentTypeValues = ["subscription", "extra_device_slot", "balance_topup"] as const;

export const paymentsTable = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    subscriptionId: integer("subscription_id")
      .references(() => subscriptionsTable.id),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    type: text("type", { enum: paymentTypeValues }).notNull().default("subscription"),
    provider: text("provider", { enum: paymentProviderValues }).notNull(),
    amountRub: integer("amount_rub").notNull(),
    status: text("status", { enum: paymentStatusValues }).notNull().default("pending"),
    reference: text("reference").notNull(),
    userNote: text("user_note"),
    // Screenshot the user uploaded as proof of SBP transfer, stored directly
    // in Postgres as base64 (no external object storage dependency — this app
    // runs as a single Docker container outside Replit, so Replit's Object
    // Storage sidecar is not reachable in production). Null until attached.
    screenshotData: text("screenshot_data"),
    screenshotMimeType: text("screenshot_mime_type"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [index("payments_user_id_idx").on(table.userId)],
);

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof paymentsTable.$inferSelect;
