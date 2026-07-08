import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { paymentsTable } from "./payments";

export const balanceTransactionTypeValues = ["topup", "debit", "refund"] as const;

export const balanceTransactionsTable = pgTable(
  "balance_transactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    amountKopecks: integer("amount_kopecks").notNull(),
    type: text("type", { enum: balanceTransactionTypeValues }).notNull(),
    paymentId: integer("payment_id").references(() => paymentsTable.id),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("balance_transactions_user_id_idx").on(table.userId)],
);

export const insertBalanceTransactionSchema = createInsertSchema(balanceTransactionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertBalanceTransaction = z.infer<typeof insertBalanceTransactionSchema>;
export type BalanceTransaction = typeof balanceTransactionsTable.$inferSelect;
