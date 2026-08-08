import { lt } from "drizzle-orm";
import { db, adminAuditLogTable } from "@workspace/db";
import { logger } from "./logger";

const RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 часа

async function cleanupOldAuditLogs(): Promise<void> {
  const cutoff = new Date(
    Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  try {
    const result = await db
      .delete(adminAuditLogTable)
      .where(lt(adminAuditLogTable.createdAt, cutoff))
      .returning({ id: adminAuditLogTable.id });
    if (result.length > 0) {
      logger.info(
        { count: result.length },
        "auditLogCleanup: deleted old entries",
      );
    }
  } catch (err) {
    logger.error({ err }, "auditLogCleanup: failed");
  }
}

export function startAuditLogCleanupJob(): void {
  cleanupOldAuditLogs().catch((err) =>
    logger.error({ err }, "auditLogCleanup: startup run failed"),
  );
  setInterval(() => {
    cleanupOldAuditLogs().catch((err) =>
      logger.error({ err }, "auditLogCleanup: periodic run failed"),
    );
  }, CLEANUP_INTERVAL_MS);
}
