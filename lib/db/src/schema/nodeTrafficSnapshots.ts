import { bigint, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { vpnNodesTable } from "./vpnNodes";

/**
 * Node-level traffic samples.
 *
 * Interface fields store cumulative OS counters. Xray fields store per-poll
 * deltas attributed through local VPN keys, or aggregate deltas for explicitly
 * monitor-only nodes that have no active local key rows. The sources use
 * separate columns because their semantics differ and must not be combined.
 */
export const nodeTrafficSnapshotsTable = pgTable(
  "node_traffic_snapshots",
  {
    id: serial("id").primaryKey(),
    nodeId: integer("node_id")
      .notNull()
      .references(() => vpnNodesTable.id, { onDelete: "cascade" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source", { enum: ["interface", "xray"] }).notNull(),
    interfaceName: text("interface_name"),
    interfaceRxBytes: bigint("interface_rx_bytes", { mode: "number" }),
    interfaceTxBytes: bigint("interface_tx_bytes", { mode: "number" }),
    xrayUpBytes: bigint("xray_up_bytes", { mode: "number" }),
    xrayDownBytes: bigint("xray_down_bytes", { mode: "number" }),
  },
  (table) => [
    index("node_traffic_snapshots_node_source_recorded_idx").on(
      table.nodeId,
      table.source,
      table.recordedAt,
    ),
  ],
);

export type NodeTrafficSnapshot = typeof nodeTrafficSnapshotsTable.$inferSelect;