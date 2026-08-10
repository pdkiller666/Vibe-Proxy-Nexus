import { Router, type IRouter } from "express";
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, systemEventsTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import {
  ListAdminSystemEventsResponse,
  AcknowledgeAdminSystemEventResponse,
  AcknowledgeAllAdminSystemEventsResponse,
  GetAdminSystemEventsHistoryResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * GET /admin/system-events
 * Returns all unacknowledged admin-scoped system events, ordered newest-first.
 * Filters to userId IS NULL so user-facing events (balance_low, key_migrated, etc.)
 * do not pollute the admin notification bell.
 */
router.get("/admin/system-events", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(systemEventsTable)
    .where(and(isNull(systemEventsTable.acknowledgedAt), isNull(systemEventsTable.userId)))
    .orderBy(desc(systemEventsTable.createdAt));

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
 * POST /admin/system-events/acknowledge-all
 * Marks all unacknowledged admin-scoped system events as acknowledged in one shot.
 * Returns the count of rows updated.
 *
 * IMPORTANT: must be registered BEFORE /:id/acknowledge so Express does not
 * treat "acknowledge-all" as an :id param.
 */
router.post("/admin/system-events/acknowledge-all", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const updated = await db
    .update(systemEventsTable)
    .set({ acknowledgedAt: new Date() })
    .where(and(isNull(systemEventsTable.acknowledgedAt), isNull(systemEventsTable.userId)))
    .returning({ id: systemEventsTable.id });

  res.json(AcknowledgeAllAdminSystemEventsResponse.parse({ acknowledged: updated.length }));
});

// Custom query schema — mirrors auditLog.ts pattern: zod.coerce for numeric/date
// query params because query strings are always plain text.
const HistoryQuery = z.object({
  page:      z.coerce.number().min(1).default(1),
  pageSize:  z.coerce.number().min(1).max(100).default(50),
  eventType: z.string().optional(),
  since:     z.coerce.date().optional(),
  until:     z.coerce.date().optional(),
});

/**
 * GET /admin/system-events/history
 * Paginated history of all admin-scoped system events (acknowledged + unacknowledged).
 * Supports filtering by eventType, since, until.
 *
 * IMPORTANT: must be registered BEFORE /:id/acknowledge for the same routing reason.
 */
router.get("/admin/system-events/history", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = HistoryQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: String(parsed.error) });
    return;
  }

  const { page, pageSize, eventType, since, until } = parsed.data;

  const conditions = [isNull(systemEventsTable.userId)]; // admin-scoped only
  if (eventType) conditions.push(eq(systemEventsTable.eventType, eventType));
  if (since)     conditions.push(gte(systemEventsTable.createdAt, since));
  if (until)     conditions.push(lte(systemEventsTable.createdAt, until));

  const whereClause = and(...conditions);
  const offset = (page - 1) * pageSize;

  const [entries, countRow] = await Promise.all([
    db
      .select()
      .from(systemEventsTable)
      .where(whereClause)
      .orderBy(desc(systemEventsTable.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<string>`count(*)` })
      .from(systemEventsTable)
      .where(whereClause)
      .then((r) => r[0]),
  ]);

  res.json(
    GetAdminSystemEventsHistoryResponse.parse({
      entries: entries.map((r) => ({
        id:             r.id,
        eventType:      r.eventType,
        metadata:       r.metadata ?? {},
        createdAt:      r.createdAt,
        acknowledgedAt: r.acknowledgedAt ?? null,
      })),
      total:    parseInt(countRow?.count ?? "0", 10),
      page,
      pageSize,
    }),
  );
});

/**
 * POST /admin/system-events/:id/acknowledge
 * Marks a single system event as acknowledged (dismissed) by setting acknowledgedAt = NOW().
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
