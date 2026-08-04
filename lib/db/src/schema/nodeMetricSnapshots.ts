import { index, integer, pgTable, serial, smallint, timestamp } from "drizzle-orm/pg-core";
import { vpnNodesTable } from "./vpnNodes";

/**
 * Rolling store of node system-metric snapshots, written by the API server
 * each time it successfully fetches system/status for a node — at most once
 * every 5 minutes per node (debounced in-memory).
 *
 * Used to power the historical metric charts in the admin panel (CPU, RAM, Disk).
 * Rows older than 90 days are pruned by the nightly cleanup job.
 *
 * Values are stored as smallint (0-100) to keep the table compact.
 * cpuPercent is rounded to the nearest integer (1% resolution is fine for charts).
 */
export const nodeMetricSnapshotsTable = pgTable(
  "node_metric_snapshots",
  {
    id: serial("id").primaryKey(),
    nodeId: integer("node_id")
      .notNull()
      .references(() => vpnNodesTable.id, { onDelete: "cascade" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    cpuPercent: smallint("cpu_percent").notNull(),
    ramPercent: smallint("ram_percent").notNull(),
    diskPercent: smallint("disk_percent").notNull(),
  },
  (table) => [
    // Primary access pattern: WHERE node_id = ? AND recorded_at BETWEEN ? AND ?
    index("node_metric_snapshots_node_recorded_idx").on(table.nodeId, table.recordedAt),
  ],
);

export type NodeMetricSnapshot = typeof nodeMetricSnapshotsTable.$inferSelect;
