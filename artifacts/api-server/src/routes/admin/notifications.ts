import { Router, type IRouter } from "express";
import { and, eq, gte, inArray, or } from "drizzle-orm";
import { db, paymentsTable, usersTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

/**
 * GET /admin/notifications?since=<ISO>
 * Returns recent payment events (new pending + confirmed + rejected) since the given timestamp.
 * Designed for polling-based admin notifications — lightweight, no persistent state server-side.
 */
router.get("/admin/notifications", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const sinceRaw = req.query["since"] as string | undefined;
  // Default to last 10 minutes if no `since` provided (first-load case).
  const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 10 * 60 * 1000);

  if (isNaN(since.getTime())) {
    res.status(400).json({ error: "Invalid `since` parameter" });
    return;
  }

  const rows = await db
    .select({
      id: paymentsTable.id,
      status: paymentsTable.status,
      provider: paymentsTable.provider,
      amountRub: paymentsTable.amountRub,
      type: paymentsTable.type,
      createdAt: paymentsTable.createdAt,
      confirmedAt: paymentsTable.confirmedAt,
      userEmail: usersTable.email,
      extraTrafficGb: paymentsTable.extraTrafficGb,
    })
    .from(paymentsTable)
    .innerJoin(usersTable, eq(paymentsTable.userId, usersTable.id))
    .where(
      or(
        // New pending payments
        and(eq(paymentsTable.status, "pending"), gte(paymentsTable.createdAt, since)),
        // Payments confirmed or rejected since last check
        and(
          inArray(paymentsTable.status, ["confirmed", "rejected"]),
          gte(paymentsTable.confirmedAt, since),
        ),
      ),
    )
    .orderBy(paymentsTable.createdAt)
    .limit(100);

  res.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      provider: r.provider,
      amountRub: r.amountRub,
      type: r.type,
      createdAt: r.createdAt,
      userEmail: r.userEmail,
      extraTrafficGb: r.extraTrafficGb,
    })),
  );
});

export default router;
