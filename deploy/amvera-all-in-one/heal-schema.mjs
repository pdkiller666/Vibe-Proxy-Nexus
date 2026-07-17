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

// Mirror lib/db/src/ssl.ts exactly: strip `sslmode` from the URL before
// passing it to pg, then set ssl:{rejectUnauthorized:false} separately.
// Recent versions of pg/pg-connection-string treat sslmode=require (and
// prefer/verify-ca) as aliases for verify-full, so passing the raw URL
// causes "self-signed certificate in certificate chain" even when
// rejectUnauthorized:false is set in the ssl object — the sslmode in the
// URL wins. Deleting it first ensures our ssl object is the sole SSL
// configuration source (see .agents/memory/amvera-internal-db-tls.md).
const parsedUrl = new URL(DATABASE_URL);
const sslMode = parsedUrl.searchParams.get("sslmode");
const useSSL = sslMode !== "disable";
parsedUrl.searchParams.delete("sslmode");

const client = new Client({
  connectionString: parsedUrl.toString(),
  ssl: useSSL ? { rejectUnauthorized: false } : undefined,
});

const statements = [
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS screenshot_data text`,
  `ALTER TABLE payments ADD COLUMN IF NOT EXISTS screenshot_mime_type text`,
  `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS extra_device_slots integer NOT NULL DEFAULT 0`,
  `ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS allow_free_extra_device_slot boolean NOT NULL DEFAULT false`,
  `ALTER TABLE vpn_keys ADD COLUMN IF NOT EXISTS description text`,
  `ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS min_hourly_topup_rub integer NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id integer REFERENCES users(id)`,
  `ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS referral_commission_percent integer NOT NULL DEFAULT 0`,
  // FK / lookup indexes added 2026-07-16
  `CREATE INDEX IF NOT EXISTS payments_subscription_id_idx ON payments(subscription_id)`,
  `CREATE INDEX IF NOT EXISTS vpn_keys_node_id_idx ON vpn_keys(node_id)`,
  `CREATE INDEX IF NOT EXISTS subscriptions_plan_id_idx ON subscriptions(plan_id)`,
  `CREATE INDEX IF NOT EXISTS users_referred_by_user_id_idx ON users(referred_by_user_id)`,
];

// Referral codes must be unique and non-empty before the `users_referral_code_unique`
// constraint (declared in the Drizzle schema) can be applied by `drizzle-kit push`.
// Existing rows all default to '' when the column is first added, so backfill each
// with a random 8-char code (retrying on collision) before drizzle-kit push runs.
const referralBackfillSql = `
DO $$
DECLARE
  r RECORD;
  candidate text;
BEGIN
  FOR r IN SELECT id FROM users WHERE referral_code = '' LOOP
    LOOP
      candidate := lower(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
      BEGIN
        UPDATE users SET referral_code = candidate WHERE id = r.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- collision on the (not-yet-created) unique index/constraint; retry
        NULL;
      END;
    END LOOP;
  END LOOP;
END $$;
`;

// Add the unique constraint only once codes are backfilled and only if it
// doesn't already exist (ADD CONSTRAINT has no IF NOT EXISTS in Postgres).
const referralUniqueConstraintSql = `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_referral_code_unique'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_referral_code_unique UNIQUE (referral_code);
  END IF;
END $$;
`;

// One-time backfill: extraDeviceSlots used to live on `users`. Move any
// existing value onto that user's currently active subscription (if any)
// before the column is dropped from `users` below. Guarded so it's a no-op
// once the users column is gone.
const backfillSql = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'extra_device_slots'
  ) THEN
    UPDATE subscriptions s
    SET extra_device_slots = u.extra_device_slots
    FROM users u
    WHERE s.user_id = u.id
      AND s.status = 'active'
      AND u.extra_device_slots > 0;

    ALTER TABLE users DROP COLUMN extra_device_slots;
  END IF;
END $$;
`;

try {
  await client.connect();
  for (const sql of statements) {
    await client.query(sql);
    console.log(`heal-schema: applied: ${sql}`);
  }
  await client.query(backfillSql);
  console.log("heal-schema: applied extra_device_slots backfill + users column drop");
  await client.query(referralBackfillSql);
  console.log("heal-schema: applied referral_code backfill");
  await client.query(referralUniqueConstraintSql);
  console.log("heal-schema: applied users_referral_code_unique constraint");

  // Unique constraint on vpn_keys.uuid — VLESS auth depends on UUID uniqueness.
  // Guards against app-level UUID collisions (astronomically rare but now DB-enforced).
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'vpn_keys_uuid_unique') THEN
        CREATE UNIQUE INDEX vpn_keys_uuid_unique ON vpn_keys(uuid);
      END IF;
    END $$;
  `);
  console.log("heal-schema: applied vpn_keys_uuid_unique");

  // Unique constraint on vpn_nodes.name — prevents duplicate node configs.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'vpn_nodes_name_unique') THEN
        CREATE UNIQUE INDEX vpn_nodes_name_unique ON vpn_nodes(name);
      END IF;
    END $$;
  `);
  console.log("heal-schema: applied vpn_nodes_name_unique");

  // Unique partial index: at most one pending payment per user per type.
  // Prevents duplicate-submission races that slip past the pre-check SELECT.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'payments_one_pending_per_user_type_idx') THEN
        CREATE UNIQUE INDEX payments_one_pending_per_user_type_idx
          ON payments(user_id, type)
          WHERE status = 'pending';
      END IF;
    END $$;
  `);
  console.log("heal-schema: applied payments_one_pending_per_user_type_idx");

  // M-5: vpn_nodes.host is declared NOT NULL in the schema. Fill any legacy
  // NULL rows with the sni value (they're always the same host in practice)
  // so drizzle-kit push can safely SET NOT NULL without failing on live data.
  await client.query(`
    UPDATE vpn_nodes SET host = sni WHERE host IS NULL AND sni IS NOT NULL
  `);
  console.log("heal-schema: applied vpn_nodes host NULL backfill");

  // M-3: Partial index — active VPN keys. All background jobs (hourlyBilling,
  // trafficPolling, subscriptionLifecycle, confirmPayment) filter active keys
  // with `WHERE revoked_at IS NULL`; a partial index is smaller and faster
  // than a full index on revoked_at because only a fraction of rows are active.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'vpn_keys_active_idx') THEN
        CREATE INDEX vpn_keys_active_idx ON vpn_keys(revoked_at) WHERE revoked_at IS NULL;
      END IF;
    END $$;
  `);
  console.log("heal-schema: applied vpn_keys_active_idx");

  // M-6: balance_transactions.payment_id — confirmPayment joins here to
  // issue referral commissions; without an index every confirmation scans
  // the full table.
  await client.query(`
    CREATE INDEX IF NOT EXISTS balance_transactions_payment_id_idx
      ON balance_transactions(payment_id)
  `);
  console.log("heal-schema: applied balance_transactions_payment_id_idx");

  // M-7: plans.name unique — plan names are user-visible; duplicates cause
  // confusion in admin and user-facing plan selection.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'plans_name_unique') THEN
        CREATE UNIQUE INDEX plans_name_unique ON plans(name);
      END IF;
    END $$;
  `);
  console.log("heal-schema: applied plans_name_unique");

  // M-8: support_messages.author_id — admin support panel joins on author_id
  // to resolve user details per message; without an index this is a seq-scan
  // on a potentially large table.
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_messages_author_id_idx
      ON support_messages(author_id)
  `);
  console.log("heal-schema: applied support_messages_author_id_idx");

  // M-9: payment_settings SBP extended fields (2026-07-17)
  await client.query(`ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sbp_payment_url text NOT NULL DEFAULT ''`);
  await client.query(`ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS show_manual_sbp_details boolean NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sbp_qr_code_data text`);
  await client.query(`ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sbp_qr_code_mime_type text`);
  console.log("heal-schema: applied payment_settings SBP extended fields");

  // M-10: vpn_nodes multi-node management API fields (2026-07-17)
  // Add the two new columns for remote-node routing. These are nullable: NULL
  // means the node is the local Amvera instance (existing behaviour). When set,
  // keyIssuance and trafficPolling route to the remote Management REST API.
  await client.query(`ALTER TABLE vpn_nodes ADD COLUMN IF NOT EXISTS management_api_url text`);
  await client.query(`ALTER TABLE vpn_nodes ADD COLUMN IF NOT EXISTS management_api_secret text`);
  console.log("heal-schema: applied vpn_nodes management_api_url/secret columns");

  // Drop the three legacy 3X-UI panel credential columns. They have been NULL
  // on every row in production since the 3X-UI architecture was abandoned.
  // Wrapped in DO $ … $ so the absence of the column is a no-op, not an error.
  await client.query(`
    DO $
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vpn_nodes' AND column_name = 'panel_url') THEN
        ALTER TABLE vpn_nodes DROP COLUMN panel_url;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vpn_nodes' AND column_name = 'panel_login') THEN
        ALTER TABLE vpn_nodes DROP COLUMN panel_login;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'vpn_nodes' AND column_name = 'panel_password') THEN
        ALTER TABLE vpn_nodes DROP COLUMN panel_password;
      END IF;
    END $;
  `);
  console.log("heal-schema: dropped vpn_nodes legacy panel_* columns");

  console.log("heal-schema: done");
} catch (err) {
  console.error("heal-schema: FAILED", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
// Appended lines are not valid here — need to insert before final lines
