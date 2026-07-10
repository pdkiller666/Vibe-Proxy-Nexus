import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, balanceTransactionsTable } from "@workspace/db";
import { ListMyBalanceTransactionsResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.get("/balance-transactions/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const rows = await db
    .select()
    .from(balanceTransactionsTable)
    .where(eq(balanceTransactionsTable.userId, user.id))
    .orderBy(desc(balanceTransactionsTable.createdAt))
    .limit(200);

  res.json(ListMyBalanceTransactionsResponse.parse(rows));
});

export default router;
