import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  smallint,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const adminAuditLogTable = pgTable(
  "admin_audit_log",
  {
    id: serial("id").primaryKey(),

    // Who performed the action. Nullable — admin может быть удалён,
    // но запись в журнале остаётся (adminEmail денормализован).
    adminId: integer("admin_id").references(() => usersTable.id, {
      onDelete: "set null", // НЕ cascade — иначе удаление админа стирает аудит
    }),
    adminEmail: varchar("admin_email", { length: 255 }).notNull(),

    // What action was performed
    action: varchar("action", { length: 64 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(), // POST | PATCH | PUT | DELETE
    path: varchar("path", { length: 512 }).notNull(),

    // Target entity (optional)
    targetType: varchar("target_type", { length: 64 }), // 'user' | 'payment' | 'plan' | 'vpn_node' | 'vpn_key' | 'invite_link' | 'support_ticket' | 'payment_settings'
    targetId: integer("target_id"),
    targetDescription: varchar("target_description", { length: 512 }),

    // Structured payload (sanitized — пароли/токены заменены на [REDACTED])
    details: jsonb("details").$type<Record<string, unknown>>(),

    // Response metadata
    responseStatus: smallint("response_status"),
    durationMs: integer("duration_ms"),

    // Request metadata
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 512 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_audit_log_admin_id_idx").on(table.adminId),
    index("admin_audit_log_action_idx").on(table.action),
    index("admin_audit_log_target_idx").on(table.targetType, table.targetId),
    index("admin_audit_log_created_at_idx").on(table.createdAt),
  ],
);

export const insertAdminAuditLogSchema = createInsertSchema(
  adminAuditLogTable,
).omit({
  id: true,
  createdAt: true,
});

export type InsertAdminAuditLog = z.infer<typeof insertAdminAuditLogSchema>;
export type AdminAuditLog = typeof adminAuditLogTable.$inferSelect;
