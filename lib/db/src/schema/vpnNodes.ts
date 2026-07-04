import { boolean, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const vpnNodesTable = pgTable("vpn_nodes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  host: text("host"),
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
