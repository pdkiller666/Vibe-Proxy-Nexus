import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { plansTable } from "./plans";

export const subscriptionStatusValues = [
  "pending_payment",
  "active",
  "expired",
  "cancelled",
  "rejected",
] as const;

export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    planId: integer("plan_id")
      .notNull()
      .references(() => plansTable.id),
    status: text("status", { enum: subscriptionStatusValues })
      .notNull()
      .default("pending_payment"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    // Hourly-plan subscriptions only: the point up to which usage has already
    // been charged from the user's balance. Advanced forward by
    // hourlyBilling.ts as it bills elapsed 5-minute active ticks. Null for
    // monthly subscriptions and for hourly subscriptions not yet billed once.
    lastBilledAt: timestamp("last_billed_at", { withTimezone: true }),
    // Extra device slots purchased while THIS subscription was the active
    // one. Lives on the subscription row (not the user) on purpose: when a
    // fixed-duration plan ends or the user switches plans, a brand new
    // subscription row is created and this starts back at 0 — extra slots
    // are tied to the subscription period they were bought under, not kept
    // forever. Hourly plans reuse the same subscription row for their whole
    // continuous billing lifetime (see hourlyBilling.ts), so slots bought
    // there naturally persist for as long as that hourly subscription stays
    // active, which is the correct behavior for usage-based billing.
    extraDeviceSlots: integer("extra_device_slots").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("subscriptions_user_id_idx").on(table.userId)],
);

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
