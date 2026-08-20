import { Router } from "express";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, adminAuditLogTable } from "@workspace/db";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { GetAdminAuditLogResponse } from "@workspace/api-zod";
import {
  AUDIT_CSV_MAX_ROWS,
  getAuditCsvExportMetadata,
  limitAuditCsvRows,
  serializeAuditCsvCell,
} from "../../lib/auditCsv";

// Кастомная схема валидации запроса.
// Используем zod.coerce.date() для since/until — query params всегда строки,
// а сгенерированный GetAdminAuditLogQueryParams использует zod.date() (без
// принуждения), что приводит к 400 на любой фильтр по дате.
const AuditLogQuery = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(50),
  adminId: z.coerce.number().optional(),
  action: z.string().optional(),
  targetType: z.string().optional(),
  targetId: z.coerce.number().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  format: z.enum(["json", "csv"]).optional(),
});

const router = Router();

router.get(
  "/admin/audit-log",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsed = AuditLogQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: String(parsed.error) });
      return;
    }

    const {
      page,
      pageSize,
      adminId,
      action,
      targetType,
      targetId,
      since,
      until,
      format,
    } = parsed.data;

    const conditions = [];
    if (adminId != null) conditions.push(eq(adminAuditLogTable.adminId, adminId));
    if (action) conditions.push(eq(adminAuditLogTable.action, action));
    if (targetType) conditions.push(eq(adminAuditLogTable.targetType, targetType));
    if (targetId != null) conditions.push(eq(adminAuditLogTable.targetId, targetId));
    if (since) conditions.push(gte(adminAuditLogTable.createdAt, since));
    if (until) conditions.push(lte(adminAuditLogTable.createdAt, until));

    const whereClause =
      conditions.length > 0 ? and(...conditions) : undefined;

    // CSV export — без пагинации, с safety cap. Запрашиваем одну лишнюю строку,
    // чтобы явно сообщить UI об усечении без отдельного count(*) запроса.
    if (format === "csv") {
      const fetchedRows = await db
        .select()
        .from(adminAuditLogTable)
        .where(whereClause)
        .orderBy(desc(adminAuditLogTable.createdAt))
        .limit(AUDIT_CSV_MAX_ROWS + 1);
      const { rows, truncated } = limitAuditCsvRows(fetchedRows);

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
        "userAgent",
        "details",
      ];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        "attachment; filename=audit-log.csv",
      );
      for (const [header, value] of Object.entries(
        getAuditCsvExportMetadata(truncated),
      )) {
        res.setHeader(header, value);
      }
      res.write(`\uFEFF${headers.join(",")}\n`);
      for (const r of rows) {
        const line = headers.map((h) =>
          serializeAuditCsvCell((r as Record<string, unknown>)[h]),
        );
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

    const [countRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(adminAuditLogTable)
      .where(whereClause);

    res.json(
      GetAdminAuditLogResponse.parse({
        entries,
        total: Number(countRow!.count),
        page,
        pageSize,
      }),
    );
  },
);

export default router;
