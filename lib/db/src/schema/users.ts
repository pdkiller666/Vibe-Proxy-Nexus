import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name"),
  role: text("role", { enum: ["user", "admin"] }).notNull().default("user"),
  balanceKopecks: integer("balance_kopecks").notNull().default(0),
  // Short, unique, shareable invite code. The project is invite-only: every
  // registration must carry a valid referrer's code (see auth.ts /register),
  // starting from the seeded admin's own code as the root of the chain. Every
  // user (old and new) gets one, so backfillReferralCodes.ts assigns codes to
  // any pre-existing rows on startup — never leave this null/empty.
  referralCode: text("referral_code").notNull().unique().default(""),
  // Who invited this user, if anyone (null only for the very first/seed
  // admin account, which has no referrer). Self-referencing FK — no
  // onDelete cascade, since deleting a referrer must not delete their
  // referrals (see admin/users.ts delete route, which doesn't touch this).
  referredByUserId: integer("referred_by_user_id").references((): AnyPgColumn => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Updated (throttled, at most once/minute) on any authenticated request —
  // see requireAuth/getUserBySessionToken in the api-server. Used by the
  // admin panel to show who is "online" (active within the last 5 minutes).
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  // Private admin-only memo field — never exposed in user-facing API responses.
  adminNote: text("admin_note"),
},
(table) => [
  // Referral-tree traversal and commission attribution walk this FK on every
  // subscription payment confirmation.
  index("users_referred_by_user_id_idx").on(table.referredByUserId),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
