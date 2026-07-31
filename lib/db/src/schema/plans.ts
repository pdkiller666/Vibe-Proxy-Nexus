import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const planBillingTypeValues = ["monthly", "hourly"] as const;

export const plansTable = pgTable(
  "plans",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    priceRub: integer("price_rub").notNull(),
    durationDays: integer("duration_days").notNull(),
    devicesIncluded: integer("devices_included").notNull().default(1),
    // Traffic cap for the current subscription period, in gigabytes. Null means
    // unlimited. Enforced by src/lib/trafficPolling.ts, which revokes a user's
    // VPN keys once their period traffic (summed across keys) exceeds this.
    trafficLimitGb: integer("traffic_limit_gb"),
    // "hourly" plans are billed from the user's balance based on actual VPN
    // usage (see hourlyBilling.ts) instead of a fixed-duration manual payment.
    // durationDays/priceRub are unused for hourly plans; hourlyRateKopecks is
    // the per-hour rate charged in 5-minute increments while traffic flows.
    billingType: text("billing_type", { enum: planBillingTypeValues })
      .notNull()
      .default("monthly"),
    hourlyRateKopecks: integer("hourly_rate_kopecks"),
    isActive: boolean("is_active").notNull().default(true),
    // Promo plans are hidden from the public plan listing and can only be
    // assigned via admin invite links. Use them for referral campaigns,
    // influencer codes, or limited-time offers without polluting the main
    // plan-selection page that all users see.
    isPromo: boolean("is_promo").notNull().default(false),
    // Maximum number of times a single user may purchase this plan.
    // null = unlimited. Primary use-case: promo plans that are one-time-use
    // (e.g. a 150₽/month intro offer valid for 1 purchase per user).
    maxUses: integer("max_uses"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The plan-selection page filters to active plans on every load.
  (table) => [
    index("plans_is_active_idx").on(table.isActive),
    // Plan names are user-visible labels; duplicates cause confusion in both
    // the admin panel and user-facing plan selection. Pre-created via
    // heal-schema.mjs (DO $ IF NOT EXISTS $) to avoid drizzle-kit's
    // non-TTY prompt for tables with existing data.
    uniqueIndex("plans_name_unique").on(table.name),
  ],
);

export const insertPlanSchema = createInsertSchema(plansTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type Plan = typeof plansTable.$inferSelect;
