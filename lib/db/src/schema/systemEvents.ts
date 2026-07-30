import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Persistent in-app system events written by background processes.
 *
 * Current event types:
 *  - "xray_config_remount": written by readConfig() when the ENOENT recovery
 *    path fires (PVC was re-attached empty, config rebuilt from template + DB).
 *  - "node_overloaded":   written by nodeMonitoring when CPU > 90% or RAM > 90%.
 *  - "node_unreachable":  written by nodeMonitoring after 3 consecutive probe failures;
 *                         the node is automatically set to isActive=false and all active
 *                         keys are migrated to other nodes in the same cycle.
 *  - "node_unavailable":  legacy alias emitted by older versions of nodeMonitoring
 *                         (before auto-deactivation was added). Still handled by the
 *                         admin UI for backward compat with existing unacknowledged rows.
 *  - "node_recovered":    written by nodeMonitoring when a previously auto-deactivated
 *                         node responds successfully; isActive is restored to true.
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
  /** Set to NOW() when an admin (or the user themselves) dismisses/acknowledges the event. */
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * When set, this event is a user-facing notification scoped to a specific user.
   * NULL = admin-only system event (no user association).
   *
   * Current user event types:
   *  - "key_migrated": emitted after a VPN key is automatically moved to another node
   *    (either via admin node-deletion or automated node-monitoring failover).
   *    metadata: { oldNodeName, oldNodeId, newNodeName, newNodeId, oldKeyId, newKeyId }
   */
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
});

export type SystemEvent = typeof systemEventsTable.$inferSelect;
