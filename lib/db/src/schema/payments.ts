import { sql } from "drizzle-orm";
import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
// NOTE: unique indexes on nullable columns are declared in the table's index
// block below (not via .unique() on the column) to avoid drizzle-kit
// interactive prompts on schema push (see heal-schema.mjs).
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { subscriptionsTable } from "./subscriptions";

// "freekassa" is a LEGACY value: the integration was removed 2026-07-17, no
// code path creates it anymore, but historical rows still contain it and all
// read/serialization paths must keep accepting it.
// "free_grant" is used when an admin enables allowFreeExtraTraffic: payments
// with this provider are created-then-immediately-confirmed in a single
// request so free grants leave an auditable trail in the payments table.
export const paymentProviderValues = ["manual_sbp", "yookassa", "yoomoney", "freekassa", "balance", "free_grant"] as const;
export const paymentStatusValues = ["pending", "confirmed", "rejected"] as const;
export const paymentTypeValues = ["subscription", "extra_device_slot", "balance_topup", "extra_traffic"] as const;

export const paymentsTable = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    subscriptionId: integer("subscription_id")
      .references(() => subscriptionsTable.id, { onDelete: "set null" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    type: text("type", { enum: paymentTypeValues }).notNull().default("subscription"),
    provider: text("provider", { enum: paymentProviderValues }).notNull(),
    amountRub: integer("amount_rub").notNull(),
    // For type === "extra_traffic" only: how many GB this specific order
    // grants, captured at order-creation time from the then-current
    // paymentSettings.extraTrafficPackageGb. Locking it in per-payment means
    // a later admin price/package-size change never retroactively changes
    // what an already-placed (or already-confirmed) order is worth.
    extraTrafficGb: integer("extra_traffic_gb"),
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
    // Generic webhook dedup key — set by any payment-provider webhook handler
    // (currently YooMoney; ready for SBP/Tinkoff/YooKassa callbacks).
    // The provider stores its event/operation id here before confirming, so a
    // retry of the same event is a no-op and a second distinct event on an
    // already-settled payment surfaces as a double-charge warning.
    // Nullable (only set when the provider supplies an event id).  Unique
    // (partial, WHERE NOT NULL) so no two payments can be credited by the
    // same event even under a misconfigured label.
    webhookEventId: text("webhook_event_id"),
  },
  (table) => [
    // PostgreSQL cannot express this cross-table ownership rule as a CHECK
    // constraint. The production schema installs the
    // payments_subscription_owner_guard trigger, and all application writes
    // validate the same invariant before inserting or changing a payment.
    // subscription_id may remain NULL for balance top-ups.
    index("payments_user_id_idx").on(table.userId),
    // Admin dashboard's pending-payments queue and the FreeKassa webhook
    // both filter by status on every request/callback.
    index("payments_status_idx").on(table.status),
    // Subscription-specific payment lookups (e.g. joining payments to a subscription).
    index("payments_subscription_id_idx").on(table.subscriptionId),
    // Prevents duplicate pending orders for the same user+type via a race
    // condition (two concurrent requests both passing the pre-check SELECT).
    // Backed by the DB so it works even across multiple app instances.
    uniqueIndex("payments_one_pending_per_user_type_idx")
      .on(table.userId, table.type)
      .where(sql`status = 'pending'`),
    // Ensures no two payments can be credited by the same provider event id.
    uniqueIndex("payments_webhook_event_id_unique_idx")
      .on(table.webhookEventId)
      .where(sql`webhook_event_id IS NOT NULL`),
  ],
);

export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type Payment = typeof paymentsTable.$inferSelect;
