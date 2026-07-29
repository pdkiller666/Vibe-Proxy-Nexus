import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Persistent in-app system events written by background processes.
 *
 * Current event types:
 *  - "xray_config_remount": written by readConfig() when the ENOENT recovery
 *    path fires (PVC was re-attached empty, config rebuilt from template + DB).
 *
 * The acknowledgedAt column is set to NOW() when an admin dismisses the banner;
 * the GET endpoint only returns rows with acknowledgedAt IS NULL so the banner
 * disappears automatically after dismissal.
 */
export const systemEventsTable = pgTable("system_events", {
  id: serial("id").primaryKey(),
  /** Stable string key identifying the event category. */
  eventType: text("event_type").notNull(),
  /** Arbitrary JSON payload — shape is specific to each eventType. */
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  /** Set to NOW() when an admin dismisses/acknowledges the event. */
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SystemEvent = typeof systemEventsTable.$inferSelect;
