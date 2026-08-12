import { Router, type IRouter } from "express";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { randomUUID } from "crypto";
import { db, systemEventsTable, usersTable, subscriptionsTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../../lib/auth";

const router: IRouter = Router();

const BroadcastInputSchema = z.object({
  title:      z.string().min(1).max(100),
  message:    z.string().min(1).max(2000),
  targetType: z.enum(["all", "filtered", "specific"]),
  userIds:    z.array(z.number().int().positive()).optional(),
  filters:    z.object({
    hasActiveSubscription: z.boolean().optional(),
    planId:                z.number().int().positive().optional(),
  }).optional(),
});

const HistoryQuery = z.object({
  page:     z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

/**
 * POST /admin/broadcasts
 * Sends an admin_message notification to the resolved set of users.
 * Each user gets an individual system_events row (userId = user.id) so they
 * can acknowledge it independently. All rows for a single send share a
 * broadcastId UUID stored in metadata, which the history endpoint groups on.
 */
router.post("/admin/broadcasts", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = BroadcastInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: String(parsed.error) });
    return;
  }

  const { title, message, targetType, userIds: inputUserIds, filters } = parsed.data;

  // ── Resolve target user IDs ──────────────────────────────────────────────
  let targetUserIds: number[] = [];

  if (targetType === "specific") {
    if (!inputUserIds || inputUserIds.length === 0) {
      res.status(400).json({ error: "userIds обязательны для targetType=specific" });
      return;
    }
    const users = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(inArray(usersTable.id, inputUserIds), eq(usersTable.isBanned, false)));
    targetUserIds = users.map((u) => u.id);

  } else {
    // "all" or "filtered": start with non-banned users, then narrow
    const conditions: ReturnType<typeof eq>[] = [eq(usersTable.isBanned, false)];

    if (targetType === "filtered" && filters) {
      if (filters.hasActiveSubscription === true) {
        // Users who have at least one active subscription (optionally for a specific plan)
        const subConditions = [eq(subscriptionsTable.status, "active")];
        if (filters.planId) {
          subConditions.push(eq(subscriptionsTable.planId, filters.planId));
        }
        const activeSubs = await db
          .selectDistinct({ userId: subscriptionsTable.userId })
          .from(subscriptionsTable)
          .where(and(...subConditions));
        const activeIds = activeSubs.map((r) => r.userId);
        if (activeIds.length === 0) {
          res.json({ sentCount: 0 });
          return;
        }
        conditions.push(inArray(usersTable.id, activeIds) as ReturnType<typeof eq>);

      } else if (filters.hasActiveSubscription === false) {
        // Users who have NO active subscription
        const activeSubs = await db
          .selectDistinct({ userId: subscriptionsTable.userId })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.status, "active"));
        const activeIds = activeSubs.map((r) => r.userId);
        if (activeIds.length > 0) {
          conditions.push(notInArray(usersTable.id, activeIds) as ReturnType<typeof eq>);
        }
      }
    }

    const users = await db.select({ id: usersTable.id }).from(usersTable).where(and(...conditions));
    targetUserIds = users.map((u) => u.id);
  }

  if (targetUserIds.length === 0) {
    res.json({ sentCount: 0 });
    return;
  }

  const broadcastId = randomUUID();
  const sentAt      = new Date().toISOString();

  // ── Bulk insert (one row per target user) ────────────────────────────────
  await db.insert(systemEventsTable).values(
    targetUserIds.map((userId) => ({
      eventType: "admin_message",
      metadata:  { title, message, broadcastId, sentAt } as Record<string, unknown>,
      userId,
    })),
  );

  res.json({ sentCount: targetUserIds.length });
});

/**
 * GET /admin/broadcasts
 * Returns a paginated list of past broadcasts grouped by broadcastId.
 * Each row represents one send: title, message, when it was sent, and how
 * many users received it.
 */
router.get("/admin/broadcasts", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = HistoryQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: String(parsed.error) });
    return;
  }

  const { page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

  const [entries, countResult] = await Promise.all([
    db.execute<{
      broadcastId:    string;
      title:          string;
      message:        string;
      sentAt:         string;
      recipientCount: number;
    }>(sql`
      SELECT
        metadata->>'broadcastId'   AS "broadcastId",
        metadata->>'title'         AS title,
        metadata->>'message'       AS message,
        MIN(created_at)            AS "sentAt",
        COUNT(*)::int              AS "recipientCount"
      FROM system_events
      WHERE event_type = 'admin_message'
        AND user_id IS NOT NULL
        AND metadata->>'broadcastId' IS NOT NULL
      GROUP BY
        metadata->>'broadcastId',
        metadata->>'title',
        metadata->>'message'
      ORDER BY MIN(created_at) DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db.execute<{ count: number }>(sql`
      SELECT COUNT(DISTINCT metadata->>'broadcastId')::int AS count
      FROM system_events
      WHERE event_type = 'admin_message'
        AND user_id IS NOT NULL
        AND metadata->>'broadcastId' IS NOT NULL
    `),
  ]);

  const total = countResult.rows[0]?.count ?? 0;

  res.json({
    entries: entries.rows.map((r) => ({
      broadcastId:    r.broadcastId,
      title:          r.title,
      message:        r.message,
      sentAt:         r.sentAt,
      recipientCount: r.recipientCount,
    })),
    total,
    page,
    pageSize,
  });
});

export default router;
