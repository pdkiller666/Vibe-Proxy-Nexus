import { bigint, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { vpnNodesTable } from "./vpnNodes";

export const vpnKeysTable = pgTable(
  "vpn_keys",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    nodeId: integer("node_id")
      .notNull()
      .references(() => vpnNodesTable.id),
    uuid: text("uuid").notNull(),
    label: text("label").notNull(),
    vlessLink: text("vless_link").notNull(),
    deepLink: text("deep_link").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Traffic counters, populated by the background poll of Xray's Stats API
    // (see src/lib/trafficPolling.ts). No-ops (stay 0) when Xray isn't running
    // locally (e.g. Replit dev). "Lifetime" accumulates forever; "period"
    // resets to 0 whenever the owning user's subscription renews, so the
    // admin panel can show consumption for the current billing period.
    trafficUpBytes: bigint("traffic_up_bytes", { mode: "number" }).notNull().default(0),
    trafficDownBytes: bigint("traffic_down_bytes", { mode: "number" }).notNull().default(0),
    periodUpBytes: bigint("period_up_bytes", { mode: "number" }).notNull().default(0),
    periodDownBytes: bigint("period_down_bytes", { mode: "number" }).notNull().default(0),
    periodStartedAt: timestamp("period_started_at", { withTimezone: true }).notNull().defaultNow(),
    // Last absolute counter values read from Xray's Stats API (QueryStats
    // with reset:false — see src/lib/xrayStats.ts). Xray is never told to
    // reset its own counters, so these let the poller derive this cycle's
    // delta itself (current - lastSeen) without a read-then-write race, and
    // without losing any traffic if Xray restarts mid-cycle: a restart
    // resets Xray's in-memory counters to 0, which shows up here as
    // current < lastSeen, and the poller treats the whole `current` value
    // as the delta since the restart instead of discarding it.
    lastSeenUpBytes: bigint("last_seen_up_bytes", { mode: "number" }).notNull().default(0),
    lastSeenDownBytes: bigint("last_seen_down_bytes", { mode: "number" }).notNull().default(0),
    // Set (in the same batched UPDATE as the counters above) whenever a
    // traffic poll observes a nonzero delta for this key. Used by
    // hourlyBilling.ts as the "is this device actually connected right now"
    // signal for automatic start/stop of hourly billing — a key is
    // considered idle once this falls outside the billing grace window.
    lastTrafficAt: timestamp("last_traffic_at", { withTimezone: true }),
  },
  (table) => [index("vpn_keys_user_id_idx").on(table.userId)],
);

export const insertVpnKeySchema = createInsertSchema(vpnKeysTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVpnKey = z.infer<typeof insertVpnKeySchema>;
export type VpnKey = typeof vpnKeysTable.$inferSelect;
