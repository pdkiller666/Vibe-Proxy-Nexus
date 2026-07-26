import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// Forward-reference imports to avoid circular deps in the Drizzle schema.
import { usersTable } from "./users";
import { plansTable } from "./plans";

export const inviteLinksTable = pgTable(
  "invite_links",
  {
    id: serial("id").primaryKey(),
    // 12-character alphanumeric code — deliberately longer than the 8-char
    // user referral codes so there is zero namespace collision between the two
    // pools. auth.ts checks this table FIRST (before users.referral_code), so
    // any code found here takes priority and carries the per-link overrides.
    code: text("code").notNull(),
    // Admin memo — e.g. "для Telegram-канала", "для Ивана с работы". Purely
    // informational; never shown to registering users.
    note: text("note"),
    // Who created this link. CASCADE: deleting the admin account removes their
    // invite links rather than leaving orphaned rows.
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references((): AnyPgColumn => usersTable.id, { onDelete: "cascade" }),
    // Plan override — null = fall back to global trial plan / auto-select.
    // ON DELETE SET NULL so deleting a plan never leaves a dangling FK.
    planId: integer("plan_id").references((): AnyPgColumn => plansTable.id, {
      onDelete: "set null",
    }),
    // Trial-duration override in days — null = use global trialDays setting.
    trialDays: integer("trial_days"),
    // Maximum registrations allowed via this link. Null = unlimited.
    maxUses: integer("max_uses"),
    // Atomically incremented in auth.ts on every successful registration.
    usedCount: integer("used_count").notNull().default(0),
    // Soft-disable without deletion. Deactivated links are refused at
    // registration time regardless of usedCount / expiresAt.
    isActive: boolean("is_active").notNull().default(true),
    // Hard expiry timestamp. Null = never expires.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique code index — pre-created in heal-schema.mjs (CREATE TABLE IF NOT
    // EXISTS) so drizzle-kit push never sees an ambiguous rename/add prompt.
    uniqueIndex("invite_links_code_unique").on(table.code),
    // auth.ts and the admin panel filter by creator for "my links" queries.
    index("invite_links_created_by_user_id_idx").on(table.createdByUserId),
  ],
);

export const insertInviteLinkSchema = createInsertSchema(inviteLinksTable).omit({
  id: true,
  usedCount: true,
  createdAt: true,
});
export type InsertInviteLink = z.infer<typeof insertInviteLinkSchema>;
export type InviteLink = typeof inviteLinksTable.$inferSelect;
