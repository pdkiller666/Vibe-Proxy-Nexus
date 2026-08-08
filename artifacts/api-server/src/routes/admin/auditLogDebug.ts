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
import { _auditDebug } from "../../lib/auditLog";

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

    // 5. Module-level debug counters from auditLogMiddleware.
    //    middlewareCalls: how many times the middleware ran (resets on restart).
    //    endPatchCalls:   how many times our res.end override was invoked.
    //                     THIS increments for every request including this GET.
    //                     If this value equals middlewareCalls → patch fires correctly.
    //                     If this value is 0 → res.end is bypassing our patch.
    //    insertAttempts:  how many times logAdminAction reached db.insert.
    out._debugCounters = { ..._auditDebug };
    out._debugCounters_note =
      "endPatchCalls should be ≥ middlewareCalls (each middleware call patches one res.end). " +
      "If endPatchCalls < middlewareCalls → patch not firing. " +
      "If endPatchCalls > 0 but insertAttempts = 0 → condition check failing (check method/status). " +
      "If insertAttempts > 0 but totalRows = 0 → db.insert throws (check directInsertError).";

    out.instructions = [
      "KEY: endPatchCalls should increase by 1 each time you load THIS page.",
      "1. Load this page → note endPatchCalls (should be N).",
      "2. Do an admin action (ban/create plan/etc).",
      "3. Load this page again → endPatchCalls should be N+2 (this GET + the POST).",
      "4. If endPatchCalls only grew by 1 (just this GET) → res.end patch not firing for POST routes.",
    ];

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
