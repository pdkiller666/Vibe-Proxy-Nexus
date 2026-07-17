import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vpnNodesTable = pgTable(
  "vpn_nodes",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    region: text("region").notNull(),
    // heal-schema.mjs runs `UPDATE vpn_nodes SET host = sni WHERE host IS NULL`
    // before drizzle-kit push, so this NOT NULL is safe on existing data.
    host: text("host").notNull(),
    // Port VPN clients connect to. Defaults to 443, but Amvera-hosted nodes
    // without a Dedicated IPv4 must use the platform's raw-TCP SNI ports
    // (5432/27017/6379) instead, since 443 is always TLS-terminated by Amvera's
    // own edge (see .agents/memory/amvera-raw-tcp-port.md).
    port: integer("port").notNull().default(443),
    // Remote Management API fields (null → this is the local Amvera node).
    // When managementApiUrl is set, keyIssuance routes add/revoke requests to
    // the remote node's Management REST API instead of writing to the local
    // Xray config on disk. trafficPolling polls GET {managementApiUrl}/stats
    // for per-UUID traffic counters from remote nodes.
    managementApiUrl: text("management_api_url"),
    managementApiSecret: text("management_api_secret"),
    publicKey: text("public_key"),
    shortId: text("short_id"),
    sni: text("sni").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    // Optional cap on concurrently-active VPN keys this node will serve. Null
    // means unlimited. Enforced at key-issuance time in vpnKeys.ts.
    maxUsers: integer("max_users"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // keyIssuance.ts filters to active nodes with capacity on every key issuance.
  (table) => [
    index("vpn_nodes_is_active_idx").on(table.isActive),
    // Prevents duplicate node configs; index pre-created via heal-schema.mjs.
    uniqueIndex("vpn_nodes_name_unique").on(table.name),
  ],
);

export const insertVpnNodeSchema = createInsertSchema(vpnNodesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVpnNode = z.infer<typeof insertVpnNodeSchema>;
export type VpnNode = typeof vpnNodesTable.$inferSelect;
