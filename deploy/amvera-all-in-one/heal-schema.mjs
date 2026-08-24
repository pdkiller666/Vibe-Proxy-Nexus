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
  `ALTER TABLE vpn_keys ADD COLUMN IF NOT EXISTS replaces_key_id integer`,
  `ALTER TABLE vpn_keys ADD COLUMN IF NOT EXISTS xray_cleanup_pending_at timestamptz`,
  `ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS min_hourly_topup_rub integer NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id integer REFERENCES users(id)`,
  `ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS referral_commission_percent integer NOT NULL DEFAULT 0`,
  // FK / lookup indexes added 2026-07-16
  `CREATE INDEX IF NOT EXISTS payments_subscription_id_idx ON payments(subscription_id)`,
  `CREATE INDEX IF NOT EXISTS vpn_keys_node_id_idx ON vpn_keys(node_id)`,
  `CREATE INDEX IF NOT EXISTS vpn_keys_replaces_key_id_idx ON vpn_keys(replaces_key_id)`,
  `CREATE INDEX IF NOT EXISTS subscriptions_plan_id_idx ON subscriptions(plan_id)`,
  `CREATE INDEX IF NOT EXISTS users_referred_by_user_id_idx ON users(referred_by_user_id)`,
  // ── M-39: free traffic grant rate-limiting settings ─────────────────────────
  // Two new columns on payment_settings that control how often a user can
  // receive a free extra-traffic grant when allowFreeExtraTraffic is true.
  // Defaults match the server-side fallbacks in extraTrafficOrder.ts.
  `ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS free_traffic_grant_cooldown_hours integer NOT NULL DEFAULT 24`,
  `ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS free_traffic_grants_per_cooldown integer NOT NULL DEFAULT 1`,
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

const M41_INDEX_NAME = "subscriptions_active_user_starts_at_id_idx";
const M41_ADVISORY_LOCK_KEY = 410041;
const M41_CREATE_INDEX_SQL = `
  CREATE INDEX CONCURRENTLY IF NOT EXISTS subscriptions_active_user_starts_at_id_idx
    ON subscriptions(user_id, starts_at DESC NULLS FIRST, id DESC)
    WHERE status = 'active'
`;

function normalizePredicate(predicate) {
  return String(predicate ?? "")
    .toLowerCase()
    .replace(/[\s()]/g, "");
}

function isHealthyM41Index(index) {
  return Boolean(
    index?.indisvalid &&
      index.indisready &&
      index.indislive &&
      index.index_method === "btree" &&
      Array.isArray(index.key_columns) &&
      index.key_columns.join(",") === "user_id,starts_at,id" &&
      Array.isArray(index.descending) &&
      index.descending.join(",") === "false,true,true" &&
      Array.isArray(index.nulls_first) &&
      index.nulls_first.join(",") === "false,true,false" &&
      normalizePredicate(index.predicate) === "status='active'::text",
  );
}

async function readM41Index() {
  const { rows } = await client.query(
    `
      SELECT
        i.indisvalid,
        i.indisready,
        i.indislive,
        am.amname AS index_method,
        array_agg(a.attname ORDER BY key_part.ordinality)
          FILTER (WHERE key_part.ordinality <= i.indnkeyatts) AS key_columns,
        array_agg((i.indoption[key_part.ordinality - 1] & 1) = 1 ORDER BY key_part.ordinality)
          FILTER (WHERE key_part.ordinality <= i.indnkeyatts) AS descending,
        array_agg((i.indoption[key_part.ordinality - 1] & 2) = 2 ORDER BY key_part.ordinality)
          FILTER (WHERE key_part.ordinality <= i.indnkeyatts) AS nulls_first,
        pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_class index_class
      JOIN pg_index i ON i.indexrelid = index_class.oid
      JOIN pg_class table_class ON table_class.oid = i.indrelid
      JOIN pg_am am ON am.oid = index_class.relam
      LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_part(attnum, ordinality) ON true
      LEFT JOIN pg_attribute a
        ON a.attrelid = table_class.oid AND a.attnum = key_part.attnum
      WHERE index_class.relname = $1
        AND table_class.oid = 'subscriptions'::regclass
      GROUP BY i.indexrelid, i.indisvalid, i.indisready, i.indislive,
        i.indnkeyatts, i.indoption, am.amname, i.indpred, i.indrelid
    `,
    [M41_INDEX_NAME],
  );
  return rows[0] ?? null;
}

async function ensureM41SubscriptionExpiryIndex() {
  let lockHeld = false;
  await client.query("SELECT pg_advisory_lock($1::bigint)", [M41_ADVISORY_LOCK_KEY]);
  lockHeld = true;

  try {
    const existing = await readM41Index();
    if (!isHealthyM41Index(existing)) {
      if (existing) {
        console.warn(`heal-schema: M-41 rebuilding unhealthy ${M41_INDEX_NAME}`);
        // This must remain a standalone query: PostgreSQL rejects concurrent
        // index operations inside an explicit transaction or DO block.
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${M41_INDEX_NAME}`);
      } else {
        console.log(`heal-schema: M-41 creating ${M41_INDEX_NAME}`);
      }

      // Concurrent creation keeps subscription/payment writes available while
      // production builds the new partial index.
      await client.query(M41_CREATE_INDEX_SQL);
    } else {
      console.log(`heal-schema: M-41 ${M41_INDEX_NAME} already healthy`);
    }

    const verified = await readM41Index();
    if (!isHealthyM41Index(verified)) {
      throw new Error(`M-41 ${M41_INDEX_NAME} is missing or does not match the required definition`);
    }
    console.log(`heal-schema: M-41 ${M41_INDEX_NAME} ready (partial, concurrent)`);
  } finally {
    if (lockHeld) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [M41_ADVISORY_LOCK_KEY]);
    }
  }
}

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
    DO $$
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
    END $$;
  `);
  console.log("heal-schema: dropped vpn_nodes legacy panel_* columns");

  // M-11: FK onDelete rules (2026-07-18)
  //
  // drizzle-kit push cannot ALTER existing FK constraints non-interactively
  // (it always prompts when dropping/recreating), so we do it here with plain
  // SQL inside a single DB transaction.
  //
  // Pattern for each FK column:
  //   1. Drop ALL existing FK constraints on that specific column using a
  //      cursor loop — avoids the "query returned more than one row" error
  //      that SELECT INTO raises when multiple constraints exist, and safely
  //      handles the zero-constraint case without an IS NOT NULL guard.
  //   2. Filter by column attnum, not just the table pair, so FKs on other
  //      columns to the same parent table are not accidentally dropped.
  //   3. Add the canonical constraint only when the desired ON DELETE action
  //      is not already present (idempotent re-runs are safe).
  //
  // The whole block runs inside a single transaction so a mid-run failure
  // rolls back completely rather than leaving the schema half-migrated.
  await client.query("BEGIN");
  try {
    await client.query(`
      DO $$
      DECLARE
        r    RECORD;
        col  int2[];
      BEGIN
        -- ── vpn_keys.user_id → CASCADE ─────────────────────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'vpn_keys'::regclass
                        AND attname  = 'user_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid   = 'vpn_keys'::regclass
            AND confrelid  = 'users'::regclass
            AND contype    = 'f'
            AND conkey     = col
        LOOP
          EXECUTE 'ALTER TABLE vpn_keys DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'vpn_keys'::regclass
            AND confrelid = 'users'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'c'
        ) THEN
          ALTER TABLE vpn_keys ADD CONSTRAINT vpn_keys_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;

        -- ── vpn_keys.node_id → RESTRICT ────────────────────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'vpn_keys'::regclass
                        AND attname  = 'node_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid   = 'vpn_keys'::regclass
            AND confrelid  = 'vpn_nodes'::regclass
            AND contype    = 'f'
            AND conkey     = col
        LOOP
          EXECUTE 'ALTER TABLE vpn_keys DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'vpn_keys'::regclass
            AND confrelid = 'vpn_nodes'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'r'
        ) THEN
          ALTER TABLE vpn_keys ADD CONSTRAINT vpn_keys_node_id_fkey
            FOREIGN KEY (node_id) REFERENCES vpn_nodes(id) ON DELETE RESTRICT;
        END IF;

        -- ── subscriptions.user_id → CASCADE ────────────────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'subscriptions'::regclass
                        AND attname  = 'user_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid   = 'subscriptions'::regclass
            AND confrelid  = 'users'::regclass
            AND contype    = 'f'
            AND conkey     = col
        LOOP
          EXECUTE 'ALTER TABLE subscriptions DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'subscriptions'::regclass
            AND confrelid = 'users'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'c'
        ) THEN
          ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;

        -- ── subscriptions.plan_id → RESTRICT ───────────────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'subscriptions'::regclass
                        AND attname  = 'plan_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid   = 'subscriptions'::regclass
            AND confrelid  = 'plans'::regclass
            AND contype    = 'f'
            AND conkey     = col
        LOOP
          EXECUTE 'ALTER TABLE subscriptions DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'subscriptions'::regclass
            AND confrelid = 'plans'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'r'
        ) THEN
          ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_id_fkey
            FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT;
        END IF;

        -- ── payments.user_id → CASCADE ─────────────────────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'payments'::regclass
                        AND attname  = 'user_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid   = 'payments'::regclass
            AND confrelid  = 'users'::regclass
            AND contype    = 'f'
            AND conkey     = col
        LOOP
          EXECUTE 'ALTER TABLE payments DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'payments'::regclass
            AND confrelid = 'users'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'c'
        ) THEN
          ALTER TABLE payments ADD CONSTRAINT payments_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;

        -- ── payments.subscription_id → SET NULL ────────────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'payments'::regclass
                        AND attname  = 'subscription_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid   = 'payments'::regclass
            AND confrelid  = 'subscriptions'::regclass
            AND contype    = 'f'
            AND conkey     = col
        LOOP
          EXECUTE 'ALTER TABLE payments DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'payments'::regclass
            AND confrelid = 'subscriptions'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'n'
        ) THEN
          ALTER TABLE payments ADD CONSTRAINT payments_subscription_id_fkey
            FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL;
        END IF;

        -- ── balance_transactions.payment_id → SET NULL ─────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'balance_transactions'::regclass
                        AND attname  = 'payment_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid   = 'balance_transactions'::regclass
            AND confrelid  = 'payments'::regclass
            AND contype    = 'f'
            AND conkey     = col
        LOOP
          EXECUTE 'ALTER TABLE balance_transactions DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'balance_transactions'::regclass
            AND confrelid = 'payments'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'n'
        ) THEN
          ALTER TABLE balance_transactions ADD CONSTRAINT balance_transactions_payment_id_fkey
            FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  console.log("heal-schema: applied FK onDelete rules (M-11)");

  // ── M-12: payment method visibility toggles ──────────────────────────────
  // sbp_enabled: new column — controls whether the SBP tile appears on
  //   checkout pages. DEFAULT true keeps existing behaviour intact.
  // yookassa_enabled: column already exists but defaulted to false since it
  //   was never wired to the UI. The card tile was always visible before this
  //   change, so flip existing false rows to true to preserve that behaviour.
  await client.query(`
    ALTER TABLE payment_settings
      ADD COLUMN IF NOT EXISTS sbp_enabled boolean NOT NULL DEFAULT true;
  `);
  await client.query(`
    UPDATE payment_settings SET yookassa_enabled = true WHERE yookassa_enabled = false;
  `);
  console.log("heal-schema: M-12 payment method toggles (sbp_enabled + yookassa_enabled backfill)");

  // ── M-13: admin_note column on users ──────────────────────────────────────
  // Private memo field visible only in the admin panel; never exposed to users.
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_note text;
  `);
  console.log("heal-schema: M-13 admin_note column added to users");

  // ── M-14: trial_plan_id column on payment_settings ───────────────────────
  // Nullable FK → plans(id) ON DELETE SET NULL. When non-null, the referenced
  // plan is used as the trial plan instead of auto-selecting the cheapest one.
  // ON DELETE SET NULL means deleting a plan never leaves a dangling reference.
  await client.query(`
    ALTER TABLE payment_settings
      ADD COLUMN IF NOT EXISTS trial_plan_id int REFERENCES plans(id) ON DELETE SET NULL;
  `);
  console.log("heal-schema: M-14 trial_plan_id column added to payment_settings");

  // ── M-15: support_tickets ON DELETE CASCADE + status index ───────────────
  // Without CASCADE, deleting a user who has support tickets raises a FK
  // constraint violation. Drop-then-recreate the FK regardless of its current
  // name so the migration is idempotent.
  await client.query(`
    DO $$
    DECLARE
      _con text;
    BEGIN
      SELECT tc.constraint_name INTO _con
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema   = kcu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name      = 'support_tickets'
        AND kcu.column_name    = 'user_id';
      IF _con IS NOT NULL THEN
        EXECUTE format('ALTER TABLE support_tickets DROP CONSTRAINT %I', _con);
      END IF;
      ALTER TABLE support_tickets
        ADD CONSTRAINT support_tickets_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- already recreated with CASCADE
    END $$;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS support_tickets_status_idx
      ON support_tickets (status);
  `);
  console.log("heal-schema: M-15 support_tickets ON DELETE CASCADE + status index");

  // ── M-16: is_banned column on users ──────────────────────────────────────
  // Allows administrators to block a user account without deleting it.
  // When true, requireAuth returns 403 AccountBanned (except GET /me, which
  // stays open so the frontend can show a "banned" screen instead of sign-in).
  // DEFAULT false preserves existing behaviour for all current users.
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false;
  `);
  console.log("heal-schema: M-16 is_banned column added to users");

  // ── M-17: users.referred_by_user_id FK → ON DELETE SET NULL ──────────────
  // The self-referencing FK was originally created without an ON DELETE action
  // (defaults to NO ACTION / RESTRICT). Any delete path that bypasses the
  // app-level null-out in admin/users.ts (raw SQL, migrations, direct DB
  // access) would raise a FK violation. Recreating it with ON DELETE SET NULL
  // makes the database itself the safety net.
  //
  // Uses the cursor-loop pattern from M-11: drop ALL existing FKs on this
  // specific column (by attnum) then re-add the canonical one with SET NULL,
  // skipping the re-add if it already exists (idempotent).
  await client.query("BEGIN");
  try {
    await client.query(`
      DO $$
      DECLARE
        r   RECORD;
        col int2[];
      BEGIN
        -- ── users.referred_by_user_id → SET NULL ───────────────────────────
        col := ARRAY[(SELECT attnum FROM pg_attribute
                      WHERE attrelid = 'users'::regclass
                        AND attname  = 'referred_by_user_id')]::int2[];
        FOR r IN
          SELECT conname FROM pg_constraint
          WHERE conrelid  = 'users'::regclass
            AND confrelid = 'users'::regclass
            AND contype   = 'f'
            AND conkey    = col
        LOOP
          EXECUTE 'ALTER TABLE users DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid  = 'users'::regclass
            AND confrelid = 'users'::regclass
            AND contype   = 'f'
            AND conkey    = col
            AND confdeltype = 'n'
        ) THEN
          ALTER TABLE users ADD CONSTRAINT users_referred_by_user_id_fkey
            FOREIGN KEY (referred_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  console.log("heal-schema: M-17 users.referred_by_user_id FK → ON DELETE SET NULL");

  // ── M-18: invite_links table ──────────────────────────────────────────────
  // Admin-created invite links with per-link plan/trial overrides.
  // Code is 12 chars (vs 8 for user referral codes) — distinct length means
  // zero namespace collision; auth.ts checks this table first.
  // created_by_user_id CASCADE: deleting an admin removes their invite links.
  // plan_id SET NULL: deleting a plan never leaves a dangling FK.
  await client.query(`
    CREATE TABLE IF NOT EXISTS invite_links (
      id                   serial        PRIMARY KEY,
      code                 text          NOT NULL,
      note                 text,
      created_by_user_id   integer       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_id              integer       REFERENCES plans(id) ON DELETE SET NULL,
      trial_days           integer,
      max_uses             integer,
      used_count           integer       NOT NULL DEFAULT 0,
      is_active            boolean       NOT NULL DEFAULT true,
      expires_at           timestamptz,
      created_at           timestamptz   NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'invite_links_code_unique') THEN
        CREATE UNIQUE INDEX invite_links_code_unique ON invite_links(code);
      END IF;
    END $$;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS invite_links_created_by_user_id_idx
      ON invite_links(created_by_user_id)
  `);
  console.log("heal-schema: M-18 invite_links table + indexes");

  // ── M-19: users.invite_link_id FK → invite_links ─────────────────────────
  // Records which admin invite link each user registered through. This enables
  // "show me who came from this campaign link" queries in the admin panel.
  // Nullable so users registered before this feature (or via plain referral
  // code) are unaffected. ON DELETE SET NULL: deleting an invite link never
  // removes the user rows — it just clears the attribution reference.
  await client.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_link_id integer;
  `);
  // Add FK constraint idempotently (may already exist on repeated runs).
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_invite_link_id_fkey'
          AND conrelid = 'users'::regclass
      ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_invite_link_id_fkey
          FOREIGN KEY (invite_link_id) REFERENCES invite_links(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS users_invite_link_id_idx ON users(invite_link_id);
  `);
  console.log("heal-schema: M-19 users.invite_link_id FK → invite_links");

  // ── M-20: payments.ym_operation_id — YooMoney webhook deduplication ─────────
  // YooMoney retries webhook delivery (10 min, 1 h) on non-200 responses.
  // Storing the operation_id lets the handler return 200 immediately on a
  // retry without re-running confirmPaymentById. The partial unique index
  // (WHERE ym_operation_id IS NOT NULL) ensures a given transfer can never
  // credit two different payment rows even under a misconfigured label.
  await client.query(`
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS ym_operation_id text;
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'payments_ym_operation_id_unique_idx'
      ) THEN
        CREATE UNIQUE INDEX payments_ym_operation_id_unique_idx
          ON payments(ym_operation_id)
          WHERE ym_operation_id IS NOT NULL;
      END IF;
    END $$;
  `);
  console.log("heal-schema: M-20 payments.ym_operation_id + unique index");

  // ── M-21: payments.webhook_event_id — generic provider-agnostic dedup key ──
  // Generalises the YooMoney ym_operation_id pattern so any future webhook
  // provider (SBP via Tinkoff, YooKassa SBP, etc.) can record its event id in
  // one place. The YooMoney handler now writes here instead of ym_operation_id.
  //
  // Migration steps:
  //   1. Add the column (idempotent).
  //   2. Backfill from ym_operation_id so existing confirmed YooMoney payments
  //      already carry the correct dedup key in the new column.
  //   3. Add the partial unique index (WHERE NOT NULL) — same semantics as the
  //      legacy ym_operation_id index: no two payments can be credited by the
  //      same provider event even under a misconfigured label.
  //
  // ym_operation_id is intentionally left in place (column + index kept) so
  // Drizzle does not need to drop it non-interactively. It will remain NULL on
  // all new payments going forward.
  await client.query(`
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS webhook_event_id text;
  `);
  await client.query(`
    UPDATE payments
       SET webhook_event_id = ym_operation_id
     WHERE ym_operation_id IS NOT NULL
       AND webhook_event_id IS NULL;
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'payments_webhook_event_id_unique_idx'
      ) THEN
        CREATE UNIQUE INDEX payments_webhook_event_id_unique_idx
          ON payments(webhook_event_id)
          WHERE webhook_event_id IS NOT NULL;
      END IF;
    END $$;
  `);
  console.log("heal-schema: M-21 payments.webhook_event_id + backfill from ym_operation_id + unique index");

  // ── M-22: system_events table ─────────────────────────────────────────────
  // Persistent in-app events written by background processes (e.g. Xray ENOENT
  // recovery). Admins dismiss them from the dashboard; acknowledged events are
  // filtered out by GET /admin/system-events.
  await client.query(`
    CREATE TABLE IF NOT EXISTS system_events (
      id               serial        PRIMARY KEY,
      event_type       text          NOT NULL,
      metadata         jsonb,
      acknowledged_at  timestamptz,
      created_at       timestamptz   NOT NULL DEFAULT now()
    )
  `);
  console.log("heal-schema: M-22 system_events table");

  // ── M-23: drop retired payments.ym_operation_id column + its index ──────────
  // M-21 backfilled all values into webhook_event_id and no code path writes
  // ym_operation_id any more. The unique index must be dropped first (it
  // depends on the column); then the column itself can be dropped. Both steps
  // are guarded so repeated runs are no-ops.
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'payments_ym_operation_id_unique_idx'
      ) THEN
        DROP INDEX payments_ym_operation_id_unique_idx;
      END IF;
    END $$;
  `);
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name = 'ym_operation_id'
      ) THEN
        ALTER TABLE payments DROP COLUMN ym_operation_id;
      END IF;
    END $$;
  `);
  console.log("heal-schema: M-23 dropped payments.ym_operation_id index + column");

  // ── M-24: vpn_nodes.cert_sha256 — TLS cert fingerprint for bare-IP nodes ──
  // Modern Xray cores (26+) removed `allowInsecure`; bare-IP VPS nodes must now
  // supply `pinnedPeerCertSha256` (SHA256 of the DER cert, base64) in VLESS links.
  await client.query(`
    ALTER TABLE vpn_nodes
      ADD COLUMN IF NOT EXISTS cert_sha256 text
  `);
  console.log("heal-schema: M-24 vpn_nodes.cert_sha256");

  // ── M-25: vpn_nodes.consecutive_failures — auto-deactivation counter ─────────
  // Tracks how many back-to-back health-check failures a node has accumulated.
  // When the background monitor reaches the threshold (3) it sets isActive=false
  // and migrates active keys to other nodes. Reset to 0 on any successful poll.
  // Nodes with consecutiveFailures > 0 and isActive=false were auto-deactivated
  // (not manually disabled), so the monitor continues probing them for recovery.
  await client.query(`
    ALTER TABLE vpn_nodes
      ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0
  `);
  console.log("heal-schema: M-25 vpn_nodes.consecutive_failures");

  // ── M-26: system_events.user_id — user-scoped notification events ───────────
  // Allows background jobs (node monitoring, admin node deletion) to emit
  // user-facing notifications (e.g. "key_migrated"). NULL = admin-only event.
  // FK to users(id) ON DELETE CASCADE so orphan rows are auto-cleaned.
  await client.query(`
    ALTER TABLE system_events
      ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE
  `);
  console.log("heal-schema: M-26 system_events.user_id");

  // ── M-27: plans.is_promo — promo plans hidden from public listing ────────────
  // Promo plans are only assignable via admin invite links (referral campaigns,
  // limited-time offers). is_promo=false is the default; public GET /plans
  // filters these out so they never appear on the user-facing plan page.
  await client.query(`
    ALTER TABLE plans
      ADD COLUMN IF NOT EXISTS is_promo boolean NOT NULL DEFAULT false
  `);
  console.log("heal-schema: M-27 plans.is_promo");

  // ── M-28: plans.max_uses — per-user purchase limit ────────────────────────
  // Nullable integer. null = unlimited purchases. Primary use-case: promo plans
  // that should only be purchasable once per user (e.g. intro-price offers).
  await client.query(`
    ALTER TABLE plans
      ADD COLUMN IF NOT EXISTS max_uses integer
  `);
  console.log("heal-schema: M-28 plans.max_uses");

  // ── M-29: node_metric_snapshots — historical CPU/RAM/Disk chart data ─────
  // Rolling store of node system-metric snapshots. Written by the API server
  // each time it fetches system/status for a node (debounced: at most once per
  // 5 minutes per node). Rows older than 90 days are pruned by the cleanup job.
  await client.query(`
    CREATE TABLE IF NOT EXISTS node_metric_snapshots (
      id           serial      PRIMARY KEY,
      node_id      integer     NOT NULL REFERENCES vpn_nodes(id) ON DELETE CASCADE,
      recorded_at  timestamptz NOT NULL DEFAULT now(),
      cpu_percent  smallint    NOT NULL,
      ram_percent  smallint    NOT NULL,
      disk_percent smallint    NOT NULL
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS node_metric_snapshots_node_recorded_idx
      ON node_metric_snapshots(node_id, recorded_at)
  `);
  console.log("heal-schema: M-29 node_metric_snapshots table + index");

  // ── M-31: payment_settings.app_download_links ───────────────────────────
  // Admin-configurable download links for recommended client apps (JSONB).
  // NULL = use built-in defaults from appDownloadLinks.ts.
  await client.query(`
    ALTER TABLE payment_settings
      ADD COLUMN IF NOT EXISTS app_download_links jsonb
  `);
  console.log("heal-schema: M-31 payment_settings.app_download_links");

  // ── M-30: payment_settings.happ_ios_routing_profile — Happ iOS routing ────
  // Admin-editable Happ iOS routing profile stored as JSONB. Contains the
  // editable subset {name, directsites, directip}. NULL = use built-in
  // defaults (resolveHappIosRoutingProfile in happIosRouting.ts).
  await client.query(`
    ALTER TABLE payment_settings
      ADD COLUMN IF NOT EXISTS happ_ios_routing_profile jsonb
  `);
  console.log("heal-schema: M-30 payment_settings.happ_ios_routing_profile");

  // ── M-32: subscriptions.is_trial — explicit trial flag ───────────────────
  // Replaces the old payment-heuristic in meResponse.ts (check for a confirmed
  // payment linked to the subscription). Admin-assigned subscriptions are
  // created without a payment row, just like trials — the heuristic can't
  // distinguish them. The new flag is set to true only in auth.ts at trial
  // creation; admin routes leave it at the DEFAULT false. Existing rows all
  // default to false, which is safe: under-detection (a real trial row shows no
  // banner) is less harmful than over-detection (an admin grant wrongly shows
  // "Пробный период" and "Купить тариф" to a legitimately granted user).
  await client.query(`
    ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_trial boolean NOT NULL DEFAULT false
  `);
  console.log("heal-schema: M-32 subscriptions.is_trial");

  // ── M-33: users.auto_renew_from_balance — opt-in automatic renewal ────────
  // When true, autoRenewJob debits the monthly plan price from the user's
  // wallet ~24 h before subscription expiry. Defaults to false (opt-in).
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auto_renew_from_balance boolean NOT NULL DEFAULT false
  `);
  console.log("heal-schema: M-33 users.auto_renew_from_balance");

  // ── M-34: payment_settings.balance_payments_enabled — feature flag ────────
  // Kill-switch for the "pay from balance" feature: when false, POST
  // /api/balance-checkout returns 409 and the UI hides the button.
  // Defaults to false so the feature is off until admin explicitly enables it.
  await client.query(`
    ALTER TABLE payment_settings
      ADD COLUMN IF NOT EXISTS balance_payments_enabled boolean NOT NULL DEFAULT false
  `);
  console.log("heal-schema: M-34 payment_settings.balance_payments_enabled");

  // ── M-35: payments.provider — ensure 'balance' is a known value ──────────
  // provider is plain TEXT (not a Postgres ENUM), so no ALTER TYPE needed.
  // The TS-level paymentProviderValues array already includes 'balance'.
  // This comment-only migration documents that fact for ops runbooks.
  console.log("heal-schema: M-35 payments.provider 'balance' — no DB change needed (plain TEXT column)");

  // ── M-36: admin_audit_log — admin action journal ──────────────────────────
  // Immutable append-only log of all successful mutative admin actions.
  // adminId → SET NULL (not CASCADE): deleting an admin must not erase history.
  // adminEmail is denormalized so the identity is preserved after user deletion.
  // drizzle-kit push creates this table automatically, but it runs in the
  // background and may not finish before the first request. CREATE TABLE IF
  // NOT EXISTS here guarantees the table exists before the app starts serving.
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id                  serial        PRIMARY KEY,
      admin_id            integer       REFERENCES users(id) ON DELETE SET NULL,
      admin_email         varchar(255)  NOT NULL,
      action              varchar(64)   NOT NULL,
      method              varchar(10)   NOT NULL,
      path                varchar(512)  NOT NULL,
      target_type         varchar(64),
      target_id           integer,
      target_description  varchar(512),
      details             jsonb,
      response_status     smallint,
      duration_ms         integer,
      ip_address          varchar(64),
      user_agent          varchar(512),
      created_at          timestamptz   NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_audit_log_admin_id_idx
      ON admin_audit_log(admin_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_audit_log_action_idx
      ON admin_audit_log(action)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_audit_log_target_idx
      ON admin_audit_log(target_type, target_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_audit_log_created_at_idx
      ON admin_audit_log(created_at)
  `);
  console.log("heal-schema: M-36 admin_audit_log table + indexes");

  // ── M-37: support_messages.attachment_data/attachment_mime_type → text[] ──
  // drizzle-kit schema defines these as text[] (arrays) but they were originally
  // added as plain text columns (single value). Postgres cannot auto-cast text→text[],
  // so drizzle-kit push fails each restart. Fix: drop+re-add as text[] (nullable).
  // Existing text data in those columns is in the wrong format and cannot be used
  // as-is anyway; NULL is the correct sentinel for messages without attachments.
  await client.query(`
    DO $$
    DECLARE col_type text;
    BEGIN
      -- attachment_data
      SELECT data_type INTO col_type
        FROM information_schema.columns
       WHERE table_name = 'support_messages' AND column_name = 'attachment_data';
      IF col_type IS NOT NULL AND col_type <> 'ARRAY' THEN
        ALTER TABLE support_messages DROP COLUMN attachment_data;
        ALTER TABLE support_messages ADD COLUMN attachment_data text[];
      END IF;

      -- attachment_mime_type
      SELECT data_type INTO col_type
        FROM information_schema.columns
       WHERE table_name = 'support_messages' AND column_name = 'attachment_mime_type';
      IF col_type IS NOT NULL AND col_type <> 'ARRAY' THEN
        ALTER TABLE support_messages DROP COLUMN attachment_mime_type;
        ALTER TABLE support_messages ADD COLUMN attachment_mime_type text[];
      END IF;
    END $$
  `);
  console.log("heal-schema: M-37 support_messages attachment columns → text[]");

  // ── M-38: subscriptions — partial unique index (one pending_payment per user) ─
  // Closes a race condition in POST /subscriptions (monthly branch): two
  // concurrent requests (e.g. Amvera proxy retry) both passed the app-level
  // pre-check and then raced into db.transaction(), creating two
  // pending_payment rows.  The existing 23505-fallback in subscriptions.ts
  // was already written to handle this error — it just had no constraint to
  // actually trigger it.  This index makes that fallback functional.
  //
  // A partial index (WHERE status = 'pending_payment') is used so that users
  // can have many historical (expired/cancelled/active) subscription rows;
  // only the "waiting for payment" state is constrained to one per user.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_pending_per_user_idx
      ON subscriptions(user_id)
      WHERE status = 'pending_payment'
  `);
  console.log("heal-schema: M-38 subscriptions_one_pending_per_user_idx (partial unique)");

  // ── M-39: vpn_keys.idempotency_key — dedupe Amvera proxy retries ─────────
  // Amvera retries slow POSTs; POST /vpn-keys could run twice for one click
  // and issue two keys for users with >= 2 free slots. The client now sends
  // a UUID-per-click; this unique index (NULLs ignored) blocks the duplicate
  // insert and issueKeyForUser returns the first-created key instead.
  await client.query(`
    ALTER TABLE vpn_keys ADD COLUMN IF NOT EXISTS idempotency_key text
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS vpn_keys_idempotency_key_unique
      ON vpn_keys(idempotency_key)
  `);
  // provisioned_at marks when the key became fully usable (Xray client added).
  // Idempotent replays only return provisioned keys; NULL + not revoked means
  // "provisioning in flight". Backfill existing non-revoked keys as
  // provisioned — they were all issued under the old code path where the 201
  // implied provisioning succeeded.
  await client.query(`
    ALTER TABLE vpn_keys ADD COLUMN IF NOT EXISTS provisioned_at timestamptz
  `);
  await client.query(`
    UPDATE vpn_keys SET provisioned_at = created_at
     WHERE provisioned_at IS NULL AND revoked_at IS NULL
  `);
  console.log("heal-schema: M-39 vpn_keys.idempotency_key + unique index + provisioned_at");

  // ── M-40: purge inaccurate node metric snapshots captured before cgroup fix ──
  //
  // Before 2026-08-17 the local Amvera node's system status was read from
  // /proc/stat and /proc/meminfo — host-level metrics that reflect the
  // 64 GB bare-metal hypervisor, not the 2 GB container. This produced
  // systematically wrong values (RAM ~2%, CPU ~0%) that make the historical
  // charts misleading and prevent overload alerts from ever firing.
  //
  // The fix (lib/sysStatus.ts, deployed 2026-08-17) switched to cgroup v2
  // (memory.current / memory.max, cpu.stat) which gives accurate container
  // metrics. All snapshots recorded before the fix cutoff for local nodes
  // (management_api_url IS NULL) are garbage and should be deleted.
  //
  // Remote VPS nodes used psutil on a dedicated host — those values were
  // always correct and are intentionally left untouched.
  //
  // The cutoff '2026-08-17T04:00:00Z' is safely after the Amvera rebuild
  // (push → build + deploy ≈ 10–15 min; we give 4 h of headroom).
  //
  // Idempotent: DELETE on an already-empty set is a no-op.
  const { rowCount: deletedMetrics } = await client.query(`
    DELETE FROM node_metric_snapshots
    WHERE node_id IN (
      SELECT id FROM vpn_nodes WHERE management_api_url IS NULL
    )
    AND recorded_at < '2026-08-17T04:00:00Z'::timestamptz
  `);
  console.log(`heal-schema: M-40 purged ${deletedMetrics} stale local-node metric snapshots (pre-cgroup-fix)`);

  // ── M-41: subscriptions — latest active row per user ─────────────────────
  // The dashboard uses DISTINCT ON (user_id) ordered by starts_at DESC, id
  // DESC. Build or repair this partial index concurrently so this optimization
  // never blocks subscription creation, payments, or billing updates.
  await ensureM41SubscriptionExpiryIndex();

  console.log("heal-schema: done");
} catch (err) {
  console.error("heal-schema: FAILED", err);
  process.exitCode = 1;
} finally {
  await client.end();
}
