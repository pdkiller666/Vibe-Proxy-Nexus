import { sql } from "drizzle-orm";
import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { paymentsTable } from "./payments";

export const balanceTransactionTypeValues = [
  "topup",
  "debit",
  "refund",
  "referral",
  "referral_reversal",
] as const;

export const balanceTransactionsTable = pgTable(
  "balance_transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    amountKopecks: integer("amount_kopecks").notNull(),
    type: text("type", { enum: balanceTransactionTypeValues }).notNull(),
    paymentId: integer("payment_id").references(() => paymentsTable.id, { onDelete: "set null" }),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("balance_transactions_user_id_idx").on(table.userId),
    // Referral commission queries join on paymentId to check if a commission
    // was already issued for a given payment; without this index every
    // confirmPayment call does a sequential scan of the whole table.
    index("balance_transactions_payment_id_idx").on(table.paymentId),
    // A payment can produce at most one commission and one reversal. These
    // partial unique indexes are the database-level idempotency boundary;
    // application checks alone are not safe under concurrent confirmations.
    uniqueIndex("balance_transactions_referral_payment_unique_idx")
      .on(table.paymentId)
      .where(sql`type = 'referral' AND payment_id IS NOT NULL`),
    uniqueIndex("balance_transactions_referral_reversal_payment_unique_idx")
      .on(table.paymentId)
      .where(sql`type = 'referral_reversal' AND payment_id IS NOT NULL`),
  ],
);

export const insertBalanceTransactionSchema = createInsertSchema(balanceTransactionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBalanceTransaction = z.infer<typeof insertBalanceTransactionSchema>;
export type BalanceTransaction = typeof balanceTransactionsTable.$inferSelect;
