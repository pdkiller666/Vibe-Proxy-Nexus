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
