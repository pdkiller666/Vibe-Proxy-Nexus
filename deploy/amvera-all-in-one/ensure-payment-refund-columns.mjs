import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("ensure-payment-refund-columns: DATABASE_URL is required");
  process.exit(1);
}

// Keep this bootstrap check compatible with the production database TLS setup.
// It is intentionally limited to the additive columns read by the new payment
// routes; the full repair and drizzle push still run in the background.
const parsedUrl = new URL(databaseUrl);
const sslMode = parsedUrl.searchParams.get("sslmode");
const useSSL = sslMode !== "disable";
parsedUrl.searchParams.delete("sslmode");

const client = new Client({
  connectionString: parsedUrl.toString(),
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '10s'");
  await client.query(`
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS refund_kind text,
      ADD COLUMN IF NOT EXISTS refund_reason text,
      ADD COLUMN IF NOT EXISTS refunded_at timestamptz
  `);
  console.log("ensure-payment-refund-columns: ready");
} finally {
  await client.end();
}