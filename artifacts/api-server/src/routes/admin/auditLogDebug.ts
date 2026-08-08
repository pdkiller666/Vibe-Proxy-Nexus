/**
 * TEMPORARY diagnostic endpoint — verifies audit log health from inside the
 * production container. Remove after the issue is confirmed resolved.
 *
 * GET /admin/debug/audit-log-check
 *   → requires admin auth
 *   → checks table existence, row count, test insert/delete, and middleware probe
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db, adminAuditLogTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../../lib/auth";
import { logger } from "../../lib/logger";

const router = Router();

router.get(
  "/admin/debug/audit-log-check",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const result: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      adminId: req.appUser?.id,
      adminEmail: req.appUser?.email,
      adminRole: req.appUser?.role,
    };

    // 1. Does the table exist?
    try {
      const [{ tbl }] = await db.execute<{ tbl: string | null }>(
        sql`SELECT to_regclass('public.admin_audit_log') AS tbl`,
      );
      result.tableExists = tbl !== null;
      result.tableName = tbl;
    } catch (e) {
      result.tableExistsError = String(e);
    }

    // 2. Current row count
    try {
      const [{ count }] = await db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM admin_audit_log`,
      );
      result.rowCount = Number(count);
    } catch (e) {
      result.rowCountError = String(e);
    }

    // 3. Test INSERT → SELECT → DELETE
    try {
      const [inserted] = await db
        .insert(adminAuditLogTable)
        .values({
          adminId: req.appUser!.id,
          adminEmail: req.appUser!.email,
          action: "unknown_action",
          method: "GET",
          path: "/admin/debug/audit-log-check",
          details: { note: "diagnostic test row — will be deleted immediately" },
          responseStatus: 200,
          durationMs: 0,
        })
        .returning({ id: adminAuditLogTable.id });

      result.testInsertId = inserted?.id;
      result.testInsertOk = inserted != null;

      // Clean up the test row right away
      if (inserted?.id) {
        await db.execute(
          sql`DELETE FROM admin_audit_log WHERE id = ${inserted.id}`,
        );
        result.testDeleteOk = true;
      }
    } catch (e) {
      result.testInsertError = String(e);
      logger.error({ err: e }, "audit-log-debug: test insert failed");
    }

    // 4. Middleware self-check — verify req.appUser is available (critical for
    //    the finish-event callback which reads req.appUser after response ends)
    result.appUserAvailable = req.appUser != null;
    result.appUserRole = req.appUser?.role;

    // 5. Count entries from last 24 h
    try {
      const [{ recent }] = await db.execute<{ recent: string }>(
        sql`SELECT count(*)::text AS recent FROM admin_audit_log
            WHERE created_at > now() - interval '24 hours'`,
      );
      result.rowsLast24h = Number(recent);
    } catch (e) {
      result.rowsLast24hError = String(e);
    }

    res.json(result);
  },
);

/**
 * POST /admin/debug/audit-log-probe
 * Делает POST-запрос (мутативный метод) с 200-ответом.
 * Если middleware работает — в таблице должна появиться запись с action=unknown_action
 * и path=/admin/debug/audit-log-probe в течение секунды после этого вызова.
 * Проверить: сразу после вызова этого endpoint — вызовите GET /admin/debug/audit-log-check
 * и убедитесь что rowsLast24h > 0.
 */
router.post(
  "/admin/debug/audit-log-probe",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const [{ cnt }] = await db.execute<{ cnt: string }>(
      sql`SELECT count(*)::text AS cnt FROM admin_audit_log`,
    ).catch(() => [{ cnt: "error" }] as { cnt: string }[]);

    res.json({
      ok: true,
      message: "POST probe — this action should be logged by auditLogMiddleware. " +
        "Call GET /admin/debug/audit-log-check after 1s and verify rowsLast24h > 0.",
      rowsBefore: cnt,
      timestamp: new Date().toISOString(),
    });
  },
);

export default router;
