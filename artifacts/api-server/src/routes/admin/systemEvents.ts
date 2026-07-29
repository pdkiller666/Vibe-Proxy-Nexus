import { Router, type IRouter } from "express";
import { eq, isNull } from "drizzle-orm";
import { db, systemEventsTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { ListAdminSystemEventsResponse, AcknowledgeAdminSystemEventResponse } from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * GET /admin/system-events
 * Returns all unacknowledged system events, ordered newest-first.
 * Used by the admin dashboard to surface in-app alerts (e.g. Xray config remounts).
 */
router.get("/admin/system-events", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(systemEventsTable)
    .where(isNull(systemEventsTable.acknowledgedAt))
    .orderBy(systemEventsTable.createdAt);

  res.json(
    ListAdminSystemEventsResponse.parse(
      rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        metadata: r.metadata ?? {},
        createdAt: r.createdAt,
      })),
    ),
  );
});

/**
 * POST /admin/system-events/:id/acknowledge
 * Marks a system event as acknowledged (dismissed) by setting acknowledgedAt = NOW().
 * Idempotent: already-acknowledged events return 200 unchanged.
 */
router.post("/admin/system-events/:id/acknowledge", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const [row] = await db
    .update(systemEventsTable)
    .set({ acknowledgedAt: new Date() })
    .where(eq(systemEventsTable.id, id))
    .returning({ id: systemEventsTable.id });

  if (!row) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  res.json(AcknowledgeAdminSystemEventResponse.parse({ id: row.id }));
});

export default router;
