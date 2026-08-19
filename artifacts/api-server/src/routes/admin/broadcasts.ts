import { Router, type IRouter } from "express";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
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
  page:     z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const DetailParams = z.object({
  broadcastId: z.string().uuid(),
});

const DetailQuery = z.object({
  recipientPage:     z.coerce.number().int().min(1).default(1),
  recipientPageSize: z.coerce.number().int().min(1).max(100).default(50),
  search:            z.string().trim().max(100).default(""),
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
  let skippedBannedCount = 0;

  if (targetType === "specific") {
    if (!inputUserIds || inputUserIds.length === 0) {
      res.status(400).json({ error: "userIds обязательны для targetType=specific" });
      return;
    }
    const users = await db
      .select({ id: usersTable.id, isBanned: usersTable.isBanned })
      .from(usersTable)
      .where(inArray(usersTable.id, inputUserIds));
    // Track how many requested IDs were silently dropped due to ban
    skippedBannedCount = users.filter((u) => u.isBanned).length;
    targetUserIds = users.filter((u) => !u.isBanned).map((u) => u.id);

  } else {
    // "all" or "filtered": start with non-banned users, then narrow
    const conditions: SQL[] = [eq(usersTable.isBanned, false)];

    if (targetType === "filtered" && filters) {
      // planId without hasActiveSubscription=true is meaningless — reject early
      if (filters.planId && filters.hasActiveSubscription !== true) {
        res.status(400).json({ error: "planId требует hasActiveSubscription=true" });
        return;
      }

      if (filters.hasActiveSubscription === true) {
        // Users who have at least one active subscription (optionally for a specific plan)
        const subConditions: SQL[] = [eq(subscriptionsTable.status, "active")];
        if (filters.planId) {
          subConditions.push(eq(subscriptionsTable.planId, filters.planId));
        }
        const activeSubs = await db
          .selectDistinct({ userId: subscriptionsTable.userId })
          .from(subscriptionsTable)
          .where(and(...subConditions));
        const activeIds = activeSubs.map((r) => r.userId);
        if (activeIds.length === 0) {
          res.json({ sentCount: 0, skippedBannedCount: 0 });
          return;
        }
        conditions.push(inArray(usersTable.id, activeIds));

      } else if (filters.hasActiveSubscription === false) {
        // Users who have NO active subscription
        const activeSubs = await db
          .selectDistinct({ userId: subscriptionsTable.userId })
          .from(subscriptionsTable)
          .where(eq(subscriptionsTable.status, "active"));
        const activeIds = activeSubs.map((r) => r.userId);
        if (activeIds.length > 0) {
          conditions.push(notInArray(usersTable.id, activeIds));
        }
      }
    }

    const users = await db.select({ id: usersTable.id }).from(usersTable).where(and(...conditions));
    targetUserIds = users.map((u) => u.id);
  }

  if (targetUserIds.length === 0) {
    res.json({ sentCount: 0, skippedBannedCount });
    return;
  }

  const broadcastId = randomUUID();
  const sentAt      = new Date().toISOString();

  // ── Bulk insert (one row per target user) ────────────────────────────────
  await db.insert(systemEventsTable).values(
    targetUserIds.map((userId) => ({
      eventType: "admin_message",
      metadata:  {
        title,
        message,
        broadcastId,
        sentAt,
        targetType,
        ...(targetType === "filtered" && filters ? { filters } : {}),
      } as Record<string, unknown>,
      userId,
    })),
  );

  res.json({ sentCount: targetUserIds.length, skippedBannedCount });
});

/**
 * GET /admin/broadcasts/:broadcastId
 * Returns the full broadcast content and a paginated list of existing users
 * who received it. Deleted users are intentionally absent because their
 * user-scoped system event rows are removed by the existing FK cascade.
 */
router.get("/admin/broadcasts/:broadcastId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = DetailParams.safeParse(req.params);
  const query = DetailQuery.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: "Некорректные параметры рассылки" });
    return;
  }

  const { broadcastId } = params.data;
  const { recipientPage, recipientPageSize, search } = query.data;
  const offset = (recipientPage - 1) * recipientPageSize;
  const searchPattern = `%${search}%`;

  const detailsResult = await db.execute<{
    title: string | null;
    message: string | null;
    sentAt: Date | string | null;
    targetType: string | null;
    filters: Record<string, unknown> | null;
    recipientTotal: number;
    recipientFilteredTotal: number;
    recipients: Array<{
      userId: number;
      email: string;
      name: string | null;
      acknowledgedAt: string | null;
    }>;
  }>(sql`
    WITH broadcast_events AS MATERIALIZED (
      SELECT
        se.id,
        se.user_id AS "userId",
        se.acknowledged_at AS "acknowledgedAt",
        se.created_at AS "createdAt",
        se.metadata->>'title' AS title,
        se.metadata->>'message' AS message,
        se.metadata->>'targetType' AS "targetType",
        se.metadata->'filters' AS filters,
        u.email,
        u.name
      FROM system_events se
      INNER JOIN users u ON u.id = se.user_id
      WHERE se.event_type = 'admin_message'
        AND se.user_id IS NOT NULL
        AND se.metadata->>'broadcastId' = ${broadcastId}
    ),
    summary AS (
      SELECT
        title,
        message,
        "createdAt" AS "sentAt",
        "targetType",
        filters
      FROM broadcast_events
      ORDER BY "createdAt", id
      LIMIT 1
    ),
    recipient_counts AS (
      SELECT
        COUNT(*)::int AS "recipientTotal",
        COUNT(*) FILTER (
          WHERE
            ${search} = ''
            OR email ILIKE ${searchPattern}
            OR CAST("userId" AS TEXT) ILIKE ${searchPattern}
            OR COALESCE(name, '') ILIKE ${searchPattern}
        )::int AS "recipientFilteredTotal"
      FROM broadcast_events
    ),
    filtered_page AS (
      SELECT
        "userId",
        email,
        name,
        "acknowledgedAt"
      FROM broadcast_events
      WHERE
        ${search} = ''
        OR email ILIKE ${searchPattern}
        OR CAST("userId" AS TEXT) ILIKE ${searchPattern}
        OR COALESCE(name, '') ILIKE ${searchPattern}
      ORDER BY LOWER(email), "userId"
      LIMIT ${recipientPageSize} OFFSET ${offset}
    )
    SELECT
      summary.title,
      summary.message,
      summary."sentAt",
      summary."targetType",
      summary.filters,
      recipient_counts."recipientTotal",
      recipient_counts."recipientFilteredTotal",
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'userId', "userId",
              'email', email,
              'name', name,
              'acknowledgedAt', "acknowledgedAt"
            )
            ORDER BY LOWER(email), "userId"
          )
          FROM filtered_page
        ),
        '[]'::json
      ) AS recipients
    FROM summary
    CROSS JOIN recipient_counts
  `);

  const details = detailsResult.rows[0];
  if (!details?.title || !details.message || !details.sentAt) {
    res.status(404).json({ error: "Рассылка не найдена" });
    return;
  }

  res.json({
    broadcastId,
    title: details.title,
    message: details.message,
    sentAt: new Date(details.sentAt).toISOString(),
    recipientCount: details.recipientTotal,
    targetType: details.targetType,
    filters: details.filters,
    recipients: details.recipients.map((recipient) => ({
      ...recipient,
      acknowledgedAt: recipient.acknowledgedAt
        ? new Date(recipient.acknowledgedAt).toISOString()
        : null,
    })),
    recipientTotal: details.recipientTotal,
    recipientFilteredTotal: details.recipientFilteredTotal,
    recipientPage,
    recipientPageSize,
  });
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
        metadata->>'broadcastId'        AS "broadcastId",
        MIN(metadata->>'title')         AS title,
        MIN(metadata->>'message')       AS message,
        MIN(created_at)                 AS "sentAt",
        COUNT(*)::int                   AS "recipientCount"
      FROM system_events
      WHERE event_type = 'admin_message'
        AND user_id IS NOT NULL
        AND metadata->>'broadcastId' IS NOT NULL
      GROUP BY metadata->>'broadcastId'
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
