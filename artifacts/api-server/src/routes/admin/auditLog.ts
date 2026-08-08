import { Router } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db, adminAuditLogTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import {
  GetAdminAuditLogQueryParams,
  GetAdminAuditLogResponse,
} from "@workspace/api-zod";

const router = Router();

router.get(
  "/admin/audit-log",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const query = GetAdminAuditLogQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }

    const {
      page = 1,
      pageSize = 50,
      adminId,
      action,
      targetType,
      targetId,
      since,
      until,
      format,
    } = query.data;

    const conditions = [];
    if (adminId != null) conditions.push(eq(adminAuditLogTable.adminId, adminId));
    if (action) conditions.push(eq(adminAuditLogTable.action, action));
    if (targetType) conditions.push(eq(adminAuditLogTable.targetType, targetType));
    if (targetId != null) conditions.push(eq(adminAuditLogTable.targetId, targetId));
    if (since) conditions.push(gte(adminAuditLogTable.createdAt, new Date(since)));
    if (until) conditions.push(lte(adminAuditLogTable.createdAt, new Date(until)));

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    // CSV export — без пагинации, с safety cap
    if (format === "csv") {
      const rows = await db
        .select()
        .from(adminAuditLogTable)
        .where(whereClause)
        .orderBy(desc(adminAuditLogTable.createdAt))
        .limit(10_000);

      const headers = [
        "id",
        "createdAt",
        "adminEmail",
        "adminId",
        "action",
        "method",
        "path",
        "targetType",
        "targetId",
        "targetDescription",
        "responseStatus",
        "durationMs",
        "ipAddress",
        "details",
      ];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=audit-log.csv",
      );
      res.write(headers.join(",") + "\n");
      for (const r of rows) {
        const line = headers.map((h) => {
          const v = (r as Record<string, unknown>)[h];
          if (v == null) return "";
          const s =
            typeof v === "object" ? JSON.stringify(v) : String(v);
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        });
        res.write(line.join(",") + "\n");
      }
      res.end();
      return;
    }

    // JSON — с пагинацией
    const offset = (page - 1) * pageSize;

    const entries = await db
      .select()
      .from(adminAuditLogTable)
      .where(whereClause)
      .orderBy(desc(adminAuditLogTable.createdAt))
      .limit(pageSize)
      .offset(offset);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(adminAuditLogTable)
      .where(whereClause);

    res.json(
      GetAdminAuditLogResponse.parse({
        entries,
        total: Number(count),
        page,
        pageSize,
      }),
    );
  },
);

export default router;
