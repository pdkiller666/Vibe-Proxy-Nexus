import { boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
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
  // admin account, which has no referrer). Self-referencing FK with ON DELETE
  // SET NULL — deleting a referrer nulls this column on their referrals rather
  // than blocking the delete or cascading it. The app-level null-out in
  // admin/users.ts is kept as defence-in-depth.
  referredByUserId: integer("referred_by_user_id").references((): AnyPgColumn => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Updated (throttled, at most once/minute) on any authenticated request —
  // see requireAuth/getUserBySessionToken in the api-server. Used by the
  // admin panel to show who is "online" (active within the last 5 minutes).
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  // Private admin-only memo field — never exposed in user-facing API responses.
  adminNote: text("admin_note"),
  // Administratively blocked. When true, requireAuth returns 403 AccountBanned
  // for all routes except GET /me (so the frontend can show a "banned" screen
  // rather than silently redirecting to sign-in). VPN keys are revoked and
  // sessions are cleared on ban; ensureActiveKeyForUser is called on unban.
  isBanned: boolean("is_banned").notNull().default(false),
  // Which admin invite link this user registered through, if any. Nullable FK
  // to invite_links(id) with ON DELETE SET NULL — enforced at DB level via
  // heal-schema M-19. No TypeScript-level .references() here to avoid a
  // circular import (inviteLinks.ts already imports usersTable from this file).
  inviteLinkId: integer("invite_link_id"),
},
(table) => [
  // Referral-tree traversal and commission attribution walk this FK on every
  // subscription payment confirmation.
  index("users_referred_by_user_id_idx").on(table.referredByUserId),
  // Admin invite-link audience lookup: "who registered via link X?"
  index("users_invite_link_id_idx").on(table.inviteLinkId),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
