import { boolean, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vpnNodesTable = pgTable("vpn_nodes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  host: text("host"),
  // Port VPN clients connect to. Defaults to 443, but Amvera-hosted nodes
  // without a Dedicated IPv4 must use the platform's raw-TCP SNI ports
  // (5432/27017/6379) instead, since 443 is always TLS-terminated by Amvera's
  // own edge (see .agents/memory/amvera-raw-tcp-port.md).
  port: integer("port").notNull().default(443),
  panelUrl: text("panel_url"),
  panelLogin: text("panel_login"),
  panelPassword: text("panel_password"),
  publicKey: text("public_key"),
  shortId: text("short_id"),
  sni: text("sni").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVpnNodeSchema = createInsertSchema(vpnNodesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVpnNode = z.infer<typeof insertVpnNodeSchema>;
export type VpnNode = typeof vpnNodesTable.$inferSelect;
