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
    // Extra traffic (GB) purchased on top of the plan's trafficLimitGb for
    // THIS subscription's period. Lives here rather than on the user for the
    // same reason as extraDeviceSlots: a renewal/plan switch creates a new
    // subscription row that starts back at 0, so top-ups don't silently
    // carry over into a period the user didn't buy them for.
    extraTrafficGb: integer("extra_traffic_gb").notNull().default(0),
    // Set by enforceTrafficLimits() (trafficPolling.ts) the moment this
    // subscription's period usage first exceeds its effective traffic cap
    // (plan.trafficLimitGb + extraTrafficGb). While set, new VPN key
    // issuance is blocked (see keyIssuance.ts) — this is what closes the
    // "revoke a key, immediately issue a fresh one to reset period bytes to
    // 0" loophole. Cleared only by a genuine traffic top-up payment
    // (confirmPayment.ts / admin payments confirm route); a renewal doesn't
    // need to clear it because renewals create a brand new subscription row
    // that starts with this null by default.
    trafficLimitExceededAt: timestamp("traffic_limit_exceeded_at", { withTimezone: true }),
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
