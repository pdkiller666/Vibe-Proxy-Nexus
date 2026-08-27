import { bigint, boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
      .references(() => usersTable.id, { onDelete: "cascade" }),
    planId: integer("plan_id")
      .notNull()
      .references(() => plansTable.id, { onDelete: "restrict" }),
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
    // Period bytes "banked" from VPN keys that enforceTrafficLimits() revoked
    // for exceeding the traffic cap (revokedReason: 'traffic_limit') while
    // this subscription row was the active one. Every usage check that sums
    // vpn_keys.periodUpBytes/periodDownBytes only does so over non-revoked
    // keys (isNull(revokedAt)) — without this column, the instant a key is
    // revoked for hitting the cap, its accumulated usage becomes invisible.
    // Then a top-up that clears trafficLimitExceededAt and triggers
    // ensureActiveKeyForUser (keyIssuance.ts) would reissue a brand new key
    // starting at 0 period bytes, handing the user a full fresh quota instead
    // of just the newly purchased headroom on top of what they'd already
    // used. Every place that computes "how much of this period has the user
    // used" must add this to the sum over active keys.
    // Never touched by a renewal: a renewal always activates a brand-new
    // subscription row (see schema comment on extraTrafficGb above), which
    // starts this back at 0 — matching periodUpBytes/periodDownBytes being
    // reset to 0 on the (surviving) active keys in confirmPayment.ts.
    carriedOverPeriodBytes: bigint("carried_over_period_bytes", { mode: "number" }).notNull().default(0),
    // True only for subscriptions created as a free trial during registration.
    // Admin-assigned subscriptions (PATCH /admin/users/:userId/subscription) are
    // inserted with isTrial=false (the default), so those users never see the
    // "Пробный период" banner. Replaces the old payment-heuristic in meResponse.ts.
    isTrial: boolean("is_trial").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("subscriptions_user_id_idx").on(table.userId),
    // Enforcement/billing jobs (hourlyBilling.ts, subscriptionLifecycle.ts,
    // keyIssuance.ts) all filter "active" subscriptions on every tick.
    index("subscriptions_status_idx").on(table.status),
    // Dashboard expiry summary selects the newest active row per user with
    // DISTINCT ON. Keep this partial index limited to the rows that query can
    // consider, while matching its DISTINCT ON and ORDER BY columns.
    index("subscriptions_active_user_starts_at_id_idx")
      .on(table.userId, table.startsAt.desc().nullsFirst(), table.id.desc())
      .where(sql`status = 'active'`),
    // Plan-based filtering (reporting, plan deactivation cascade checks).
    index("subscriptions_plan_id_idx").on(table.planId),
    // Partial unique index: at most one pending_payment row per user.
    // This makes the 23505-fallback in subscriptions.ts actually fire on
    // concurrent Amvera retries instead of letting a second row slip through.
    // Only pending_payment rows are constrained — expired/cancelled/active rows
    // are unlimited, which is the intended behaviour (a user may have many
    // historical non-pending subscriptions).
    uniqueIndex("subscriptions_one_pending_per_user_idx")
      .on(table.userId)
      .where(sql`status = 'pending_payment'`),
  ],
);

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
