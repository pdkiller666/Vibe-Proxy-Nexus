import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

// TEMPORARY diagnostic route — added to investigate a prod-only "Failed
// query" error on the users table after the referral migration. Remove once
// the root cause is confirmed and fixed.
const router: IRouter = Router();

router.get("/debug/schema-check-tmp", async (_req, res): Promise<void> => {
  try {
    const columns = await db.execute(
      sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'users' order by ordinal_position`,
    );
    const constraints = await db.execute(
      sql`select conname, contype from pg_constraint where conrelid = 'users'::regclass`,
    );

    let selectError: unknown = null;
    try {
      await db.execute(sql`select id, email, referral_code, referred_by_user_id from users limit 1`);
    } catch (err) {
      selectError = {
        message: err instanceof Error ? err.message : String(err),
        cause: err instanceof Error && err.cause ? String(err.cause) : null,
        code: (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? null,
      };
    }

    res.json({ columns: columns.rows, constraints: constraints.rows, selectError });
  } catch (err) {
    res.status(500).json({
      message: err instanceof Error ? err.message : String(err),
      cause: err instanceof Error && err.cause ? String(err.cause) : null,
      code: (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? null,
    });
  }
});

export default router;
