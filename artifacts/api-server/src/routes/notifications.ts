import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, systemEventsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { z } from "zod";

const router: IRouter = Router();

const AcknowledgeParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * GET /notifications
 * Returns all unacknowledged user-facing notifications for the current user.
 */
router.get("/notifications", requireAuth, async (req, res): Promise<void> => {
  const userId = req.appUser!.id;

  const rows = await db
    .select()
    .from(systemEventsTable)
    .where(
      and(
        eq(systemEventsTable.userId, userId),
        isNull(systemEventsTable.acknowledgedAt),
      ),
    )
    .orderBy(systemEventsTable.createdAt);

  res.json(
    rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      metadata: r.metadata ?? {},
      createdAt: r.createdAt,
    })),
  );
});

/**
 * POST /notifications/:id/acknowledge
 * Dismisses a user notification by setting acknowledgedAt = NOW().
 * Returns 404 if the notification does not belong to the current user.
 */
router.post("/notifications/:id/acknowledge", requireAuth, async (req, res): Promise<void> => {
  const params = AcknowledgeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid notification id" });
    return;
  }

  const userId = req.appUser!.id;

  const [row] = await db
    .update(systemEventsTable)
    .set({ acknowledgedAt: new Date() })
    .where(
      and(
        eq(systemEventsTable.id, params.data.id),
        eq(systemEventsTable.userId, userId),
        isNull(systemEventsTable.acknowledgedAt),
      ),
    )
    .returning({ id: systemEventsTable.id });

  if (!row) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  res.json({ id: row.id });
});

export default router;
