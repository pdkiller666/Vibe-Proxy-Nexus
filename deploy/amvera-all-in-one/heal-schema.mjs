// Idempotent, non-interactive raw-SQL schema patches.
//
// `drizzle-kit push` prompts interactively whenever it can't tell if a column
// change is a rename or a drop+add (e.g. dropping `screenshot_url` while
// adding `screenshot_data`/`screenshot_mime_type` in the same push). Even
// with `--force`, that rename-resolution prompt still blocks on stdin, which
// is closed in production — so the push silently fails and prod schema falls
// behind, while the app (built against the new schema) throws "column does
// not exist" at runtime.
//
// This script runs BEFORE drizzle-kit push and applies known-safe,
// non-destructive column additions directly via plain SQL. `ADD COLUMN IF
// NOT EXISTS` has no ambiguity to resolve, so it never prompts. Keep this
// list append-only — one idempotent statement per historical schema change
// that drizzle-kit push cannot apply unattended.
import pg from "pg";

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("heal-schema: DATABASE_URL is required");
  process.exit(1);
}

const useSSL = /sslmode=require/.test(DATABASE_URL) || process.env.PGSSLMODE === "require";

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

const statements = [
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS screenshot_data text`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS screenshot_mime_type text`,
];

try {
  await client.connect();
  for (const sql of statements) {
    await client.query(sql);
    console.log(`heal-schema: applied: ${sql}`);
  }
  console.log("heal-schema: done");
} catch (err) {
  console.error("heal-schema: FAILED", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
