// M-44 is a data correction as well as an index migration. Keep every part of
// it in one transaction so an interrupted startup cannot debit a referrer
// while leaving the duplicate ledger rows to be processed again.
export const M44_ADVISORY_LOCK_KEY = 440044;

export async function runM44ReferralLedgerRepair(client, { beforeCommit } = {}) {
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    // Multiple containers can start while a previous container is still
    // shutting down. Serialize M-44 itself, without sharing M-41's lock:
    // M-41 uses CREATE INDEX CONCURRENTLY and must remain outside a transaction.
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [M44_ADVISORY_LOCK_KEY]);

    await client.query(`
      ALTER TABLE payments
        ADD COLUMN IF NOT EXISTS refund_kind text,
        ADD COLUMN IF NOT EXISTS refund_reason text,
        ADD COLUMN IF NOT EXISTS refunded_at timestamptz
    `);
    await client.query(`
      CREATE TEMP TABLE referral_duplicate_rows ON COMMIT DROP AS
      SELECT id, user_id, amount_kopecks
        FROM (
          SELECT id, user_id, amount_kopecks,
                 row_number() OVER (PARTITION BY payment_id ORDER BY id) AS row_num
            FROM balance_transactions
           WHERE type = 'referral' AND payment_id IS NOT NULL
        ) ranked
       WHERE row_num > 1
    `);
    const duplicateSummary = await client.query(`
      SELECT
        COUNT(*)::integer AS duplicate_count,
        COALESCE(SUM(amount_kopecks), 0)::bigint AS duplicate_amount_kopecks
        FROM referral_duplicate_rows
    `);
    const summary = duplicateSummary.rows[0];
    console.log(
      `heal-schema: M-44 will remove ${summary.duplicate_count} duplicate referral rows ` +
        `and debit ${summary.duplicate_amount_kopecks} kopecks from referrer balances`,
    );
    await client.query(`
      UPDATE users AS u
         SET balance_kopecks = u.balance_kopecks - duplicates.amount_kopecks
        FROM (
          SELECT user_id, SUM(amount_kopecks) AS amount_kopecks
            FROM referral_duplicate_rows
           GROUP BY user_id
        ) duplicates
       WHERE u.id = duplicates.user_id
    `);
    await client.query(`
      DELETE FROM balance_transactions bt
       USING referral_duplicate_rows duplicates
       WHERE bt.id = duplicates.id
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS balance_transactions_referral_payment_unique_idx
        ON balance_transactions(payment_id)
        WHERE type = 'referral' AND payment_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS balance_transactions_referral_reversal_payment_unique_idx
        ON balance_transactions(payment_id)
        WHERE type = 'referral_reversal' AND payment_id IS NOT NULL
    `);

    // A malformed self-reference must never be able to qualify for a
    // commission, even if an administrator/import writes users directly.
    await client.query(`
      UPDATE users
         SET referred_by_user_id = NULL
       WHERE referred_by_user_id = id
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'users_no_self_referral_check'
             AND conrelid = 'users'::regclass
        ) THEN
          ALTER TABLE users
            ADD CONSTRAINT users_no_self_referral_check
            CHECK (referred_by_user_id IS NULL OR referred_by_user_id <> id);
        END IF;
      END $$;
    `);

    // Used only by the migration test to model a process/database failure
    // after all writes and before commit. Production never supplies it.
    await beforeCommit?.();
    await client.query("COMMIT");
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("heal-schema: M-44 rollback failed", rollbackError);
      }
    }
    throw error;
  }
}