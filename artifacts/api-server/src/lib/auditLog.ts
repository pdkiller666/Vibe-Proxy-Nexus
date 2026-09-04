import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, adminAuditLogTable, usersTable } from "@workspace/db";
import { logger } from "./logger";

// ── Sensitive fields (никогда не попадают в журнал) ───────────────────────────
const SENSITIVE_FIELDS = new Set<string>([
  "password",
  "passwordHash",
  "token",
  "secret",
  "managementApiSecret",
  "screenshotData",
  "sbpQrCodeData",
  // НЕ добавлять "data" — слишком широкое, встречается в обычных JSON
]);

// ── Known mutative actions ────────────────────────────────────────────────────
// Ключи используют нормализованные параметры (:xxx → :id).
// ACTION_MAP нечувствителен к именам параметров благодаря normalizeRoutePath.
const ACTION_MAP: Record<string, string> = {
  // Users
  "PATCH /admin/users/:id/role": "update_user_role",
  "PATCH /admin/users/:id": "update_user_profile",
  "DELETE /admin/users/:id": "delete_user",
  "PATCH /admin/users/:id/subscription": "update_user_subscription",
  "PATCH /admin/users/:id/extra-slots": "update_user_extra_slots",
  "PATCH /admin/users/:id/balance": "set_user_balance",
  // Реальный путь в users.ts — /set-password (не /password)
  "PATCH /admin/users/:id/set-password": "reset_user_password",
  "PATCH /admin/users/:id/note": "update_user_note",
  "POST /admin/users/:id/ban": "ban_user",
  "POST /admin/users/:id/unban": "unban_user",
  "POST /admin/users/:id/force-logout": "force_logout",

  // Plans
  "POST /admin/plans": "create_plan",
  "PATCH /admin/plans/:id": "update_plan",
  "DELETE /admin/plans/:id": "delete_plan",

  // VPN nodes — restart-xray находится в vpnNodes.ts (не vpnNodeProvisioning.ts)
  "POST /admin/vpn-nodes": "create_vpn_node",
  "PATCH /admin/vpn-nodes/:id": "update_vpn_node",
  "DELETE /admin/vpn-nodes/:id": "delete_vpn_node",
  "POST /admin/vpn-nodes/:id/system/restart-xray": "restart_xray",
  "POST /admin/vpn-nodes/provision": "provision_vpn_node",

  // VPN keys
  "POST /admin/vpn-keys/issue": "issue_vpn_key",
  "DELETE /admin/vpn-keys/:id": "revoke_vpn_key",

  // Invite links
  "POST /admin/invite-links": "create_invite_link",
  "PATCH /admin/invite-links/:id": "update_invite_link",
  "DELETE /admin/invite-links/:id": "delete_invite_link",

  // Payment settings
  "PATCH /admin/payment-settings": "update_payment_settings",
  "PUT /admin/payment-settings/sbp-qr": "upload_sbp_qr",
  "DELETE /admin/payment-settings/sbp-qr": "delete_sbp_qr",

  // Payments
  "POST /admin/payments/:id/confirm": "confirm_payment",
  "POST /admin/payments/:id/reject": "reject_payment",
  "POST /admin/payments/:id/refund": "refund_payment",
  "PATCH /admin/payments/:id/note": "update_payment_note",

  // Support
  "POST /admin/support-tickets/:id/messages": "reply_to_ticket",
  "PATCH /admin/support-tickets/:id/status": "update_ticket_status",

  // Password reset link generation (admin generates link to share with user)
  "POST /admin/users/:id/password-reset": "generate_password_reset_link",

  // System events
  "POST /admin/system-events/:id/acknowledge": "acknowledge_system_event",
  "POST /admin/system-events/acknowledge-all": "acknowledge_all_system_events",

  // Broadcasts
  "POST /admin/broadcasts": "send_broadcast",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Приводит :userId, :nodeId, :linkId и т.п. к каноническому :id.
 * Без req.baseUrl — он добавляет лишний префикс "/api", ломая мэтч.
 */
function normalizeRoutePath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      // Параметры маршрута (:userId, :nodeId и т.п.) → :id
      if (seg.startsWith(":")) return ":id";
      // Числовые сегменты в req.path (реальные ID) → :id
      // Нужно когда req.route недоступен и используется req.path напрямую
      if (/^\d+$/.test(seg)) return ":id";
      return seg;
    })
    .join("/");
}

/** Возвращает первый числовой параметр из params — работает с любым именем. */
function extractTargetId(
  params: Record<string, string | string[]>,
): number | null {
  for (const raw of Object.values(params)) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && /^\d+$/.test(value)) return parseInt(value, 10);
  }
  return null;
}

function inferTargetType(path: string): string | null {
  if (path.includes("/users/")) return "user";
  if (path.includes("/payments/")) return "payment";
  if (path.includes("/plans/")) return "plan";
  if (path.includes("/vpn-nodes/")) return "vpn_node";
  if (path.includes("/vpn-keys/")) return "vpn_key";
  if (path.includes("/invite-links/")) return "invite_link";
  if (path.includes("/support-tickets/")) return "support_ticket";
  if (path.includes("/payment-settings")) return "payment_settings";
  if (path.includes("/system-events/")) return "system_event";
  return null;
}

export function sanitizeAuditBody(
  body: unknown,
): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;

  return sanitizeAuditValue(body, new WeakSet<object>()) as Record<
    string,
    unknown
  >;
}

function sanitizeAuditValue(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    out[key] = SENSITIVE_FIELDS.has(key)
      ? "[REDACTED]"
      : sanitizeAuditValue(nestedValue, seen);
  }
  return out;
}

export function getAuditActionForRoute(method: string, path: string): string {
  return (
    ACTION_MAP[`${method} ${normalizeRoutePath(path)}`] ?? "unknown_action"
  );
}

async function buildTargetDescription(
  targetType: string | null,
  targetId: number | null,
): Promise<string | null> {
  if (!targetType || targetId == null) return null;

  // Enrich user — один SELECT email для human-readable описания
  if (targetType === "user") {
    const [u] = await db
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, targetId))
      .limit(1);
    if (u) return u.email;
  }

  return `${targetType} #${targetId}`;
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Логирует все успешные мутирующие запросы (POST/PATCH/PUT/DELETE) в
 * admin_audit_log. Слушает событие `finish` на response — срабатывает
 * для любого типа ответа: res.json(), res.send(), res.status(204).end() и т.д.
 * Не влияет на бизнес-логику. Не дублирует requireAuth/requireAdmin.
 */
export function auditLogMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();

    // pino-http (registered at app level) proves res.on("finish") works in
    // Amvera. We use it here instead of patching res.end — cleaner and
    // idiomatic. The middleware must be registered without a path in
    // router.use() — Express 4 silently skips the 3rd+ Layer when multiple
    // callbacks share a regex path (confirmed 2026-08-08).
    res.on("finish", () => {
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        ["POST", "PATCH", "PUT", "DELETE"].includes(req.method)
      ) {
        const durationMs = Date.now() - startedAt;
        void logAdminAction(req, res, durationMs).catch((err) => {
          logger.error(
            { err, path: req.path },
            "auditLog: failed to log action",
          );
        });
      }
    });

    next();
  };
}

async function logAdminAction(
  req: Request,
  res: Response,
  durationMs: number,
): Promise<void> {
  const adminUser = req.appUser;
  if (!adminUser || adminUser.role !== "admin") return;

  // req.route.path contains the full pattern like "/admin/users/:userId/ban".
  // Do NOT use req.baseUrl — it adds an extra "/api" prefix.
  const rawPath = req.route?.path ?? req.path;
  const routePattern = `${req.method} ${normalizeRoutePath(rawPath)}`;
  const action = getAuditActionForRoute(req.method, rawPath);
  if (action === "unknown_action") {
    logger.warn(
      { routePattern, rawPath, method: req.method, path: req.path },
      "admin_audit: no ACTION_MAP entry — logged as unknown_action",
    );
  }

  const targetType = inferTargetType(req.path);
  const targetId = extractTargetId(req.params);

  // Wrap separately so a DB lookup failure does NOT block the INSERT.
  let targetDescription: string | null = null;
  try {
    targetDescription = await buildTargetDescription(targetType, targetId);
  } catch (err) {
    logger.error(
      { err, targetType, targetId },
      "admin_audit: buildTargetDescription failed — continuing without description",
    );
  }

  const details: Record<string, unknown> = {};
  const sanitized = sanitizeAuditBody(req.body);
  if (sanitized) details.requestBody = sanitized;
  if (req.query && Object.keys(req.query).length > 0) {
    details.queryParams = req.query;
  }

  const ipAddress =
    (req.headers["x-forwarded-for"] as string | undefined)
      ?.split(",")[0]
      .trim() ??
    req.ip ??
    req.socket.remoteAddress ??
    null;
  const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;

  try {
    await db.insert(adminAuditLogTable).values({
      adminId: adminUser.id,
      adminEmail: adminUser.email,
      action,
      method: req.method,
      path: req.path,
      targetType,
      targetId,
      targetDescription,
      details,
      responseStatus: res.statusCode,
      durationMs,
      ipAddress,
      userAgent,
    });

    logger.info(
      { adminId: adminUser.id, action, method: req.method, path: req.path },
      "admin_audit: action logged",
    );
  } catch (err) {
    logger.error({ err, action, path: req.path }, "admin_audit: insert failed");
  }
}
