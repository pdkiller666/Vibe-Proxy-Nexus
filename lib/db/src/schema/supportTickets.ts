import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
// Note: attachmentData / attachmentMimeType are stored as parallel text[] arrays (up to 4 items each).
import { usersTable } from "./users";

export const ticketStatusValues = ["open", "answered", "closed"] as const;

export const supportTicketsTable = pgTable(
  "support_tickets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    subject: text("subject").notNull(),
    status: text("status", { enum: ticketStatusValues }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_tickets_user_id_idx").on(table.userId),
    index("support_tickets_status_idx").on(table.status),
  ],
);

export const supportMessagesTable = pgTable(
  "support_messages",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => supportTicketsTable.id),
    authorId: integer("author_id")
      .notNull()
      .references(() => usersTable.id),
    body: text("body").notNull(),
    // Image attachments stored as parallel base64 text[] arrays (up to 4 items).
    // Nullable — most messages have no attachments.
    attachmentData: text("attachment_data").array(),
    attachmentMimeType: text("attachment_mime_type").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_messages_ticket_id_idx").on(table.ticketId),
    // Admin support panel resolves user details per message; without this
    // index a ticket with many messages causes a seq-scan on the whole table.
    // Index pre-created via heal-schema.mjs.
    index("support_messages_author_id_idx").on(table.authorId),
  ],
);

export type SupportTicket = typeof supportTicketsTable.$inferSelect;
export type SupportMessage = typeof supportMessagesTable.$inferSelect;
