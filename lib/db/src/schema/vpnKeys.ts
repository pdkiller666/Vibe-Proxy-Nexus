import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
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
  },
  (table) => [index("vpn_keys_user_id_idx").on(table.userId)],
);

export const insertVpnKeySchema = createInsertSchema(vpnKeysTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVpnKey = z.infer<typeof insertVpnKeySchema>;
export type VpnKey = typeof vpnKeysTable.$inferSelect;
