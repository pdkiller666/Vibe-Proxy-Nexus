/**
 * TEMPORARY diagnostic endpoints for audit log health.
 * Remove after the issue is confirmed resolved.
 *
 * GET  /admin/debug/audit-log-check  — full health report (mobile-friendly)
 * POST /admin/debug/audit-log-probe  — tests whether middleware logs a POST
 */
import { Router } from "express";
import { sql, count } from "drizzle-orm";
import { db, adminAuditLogTable } from "@workspace/db";
import { requireAuth, requireAdmin } from "../../lib/auth";
import { logger } from "../../lib/logger";

const router = Router();

// ── GET: full health check (works from mobile browser) ─────────────────────
router.get(
  "/admin/debug/audit-log-check",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const out: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      adminId: req.appUser?.id,
      adminRole: req.appUser?.role,
    };

    // 1. Table existence — use Drizzle select (never db.execute for diagnostics)
    try {
      const rows = await db
        .select({ cnt: count() })
        .from(adminAuditLogTable);
      out.tableExists = true;
      out.totalRows = rows[0]?.cnt ?? 0;
    } catch (e) {
      out.tableExists = false;
      out.tableError = String(e);
    }

    // 2. Last 24 h count
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const rows = await db
        .select({ cnt: count() })
        .from(adminAuditLogTable)
        .where(sql`${adminAuditLogTable.createdAt} > ${since}`);
      out.rowsLast24h = rows[0]?.cnt ?? 0;
    } catch (e) {
      out.rowsLast24hError = String(e);
    }

    // 3. Most recent 5 rows
    try {
      const recent = await db
        .select({
          id: adminAuditLogTable.id,
          action: adminAuditLogTable.action,
          path: adminAuditLogTable.path,
          createdAt: adminAuditLogTable.createdAt,
        })
        .from(adminAuditLogTable)
        .orderBy(sql`${adminAuditLogTable.createdAt} DESC`)
        .limit(5);
      out.recentRows = recent;
    } catch (e) {
      out.recentRowsError = String(e);
    }

    // 4. Simulate what the middleware finish-callback does:
    //    call logAdminAction-equivalent INSERT directly (bypasses middleware).
    //    If this works but middleware does not write → finish event is the bug.
    //    If this fails → DB/schema issue.
    try {
      const [inserted] = await db
        .insert(adminAuditLogTable)
        .values({
          adminId: req.appUser!.id,
          adminEmail: req.appUser!.email ?? "unknown",
          action: "unknown_action",
          method: "GET",
          path: "/admin/debug/audit-log-check [DIAG-DIRECT]",
          details: { note: "direct insert test — auto-deleted" },
          responseStatus: 200,
          durationMs: 0,
        })
        .returning({ id: adminAuditLogTable.id });

      out.directInsertOk = true;
      out.directInsertId = inserted?.id;

      // clean it up immediately
      if (inserted?.id) {
        await db
          .delete(adminAuditLogTable)
          .where(sql`${adminAuditLogTable.id} = ${inserted.id}`);
        out.directInsertCleaned = true;
      }
    } catch (e) {
      out.directInsertOk = false;
      out.directInsertError = String(e);
      logger.error({ err: e }, "audit-log-debug: direct insert failed");
    }

    // 5. Register a finish-event listener RIGHT HERE on this very response.
    //    When res.json() sends the response below, the finish event should fire
    //    and we should see a row appear in admin_audit_log.
    //    Check: call this endpoint, wait 2s, call it again.
    //    If totalRows increased by 1 (and then cleaned up by probe), finish fires.
    //    NOTE: we override method to POST so the middleware condition passes.
    const diagStartedAt = Date.now();
    res.once("finish", () => {
      logger.info(
        { adminId: req.appUser?.id, path: req.path, status: res.statusCode },
        "audit-log-debug: finish event fired on GET diagnostic ← if you see this, finish works",
      );
    });

    out.instructions = [
      "1. Perform ANY admin action (ban, unban, delete, etc.) in the admin panel.",
      "2. Reload this page.",
      "3. If rowsLast24h > 0 → middleware is working.",
      "4. If rowsLast24h = 0 → check Amvera app logs for 'admin_audit:' lines.",
    ];
    out.diagDurationMs = Date.now() - diagStartedAt;

    res.json(out);
  },
);

// ── POST: lets the middleware log a real POST action ────────────────────────
// Use from DevTools: fetch('/api/admin/debug/audit-log-probe',{method:'POST'})
router.post(
  "/admin/debug/audit-log-probe",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    let countBefore = 0;
    try {
      const rows = await db.select({ cnt: count() }).from(adminAuditLogTable);
      countBefore = rows[0]?.cnt ?? 0;
    } catch (_) {}

    res.json({
      ok: true,
      countBefore,
      message:
        "POST sent. If middleware works, rowsLast24h in /audit-log-check should increase by 1 within 1s.",
    });
  },
);

export default router;
