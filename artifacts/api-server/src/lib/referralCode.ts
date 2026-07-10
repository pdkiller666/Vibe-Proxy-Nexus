import crypto from "node:crypto";
import { eq, isNull, or } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";

const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CODE_LENGTH = 8;

function generateCandidateCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Assigns a fresh, unique referral code to `userId`. Retries a handful of
 * times on the (extremely unlikely) chance of a collision with an existing
 * code before giving up.
 */
export async function assignReferralCode(userId: number): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCandidateCode();
    try {
      await db.update(usersTable).set({ referralCode: code }).where(eq(usersTable.id, userId));
      return code;
    } catch (err) {
      const pgCode = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (pgCode !== "23505") throw err;
      // Collision on the unique index — try another random code.
    }
  }
  throw new Error("Failed to generate a unique referral code after multiple attempts");
}

/**
 * Backfills referral codes for any pre-existing users created before this
 * feature shipped (referralCode defaults to "" at the DB level, which is not
 * a usable/shareable code). Runs once per boot; idempotent and safe to call
 * repeatedly since it only touches rows still missing a real code.
 */
export async function backfillReferralCodes(): Promise<void> {
  try {
    const missing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(or(eq(usersTable.referralCode, ""), isNull(usersTable.referralCode)));

    for (const user of missing) {
      await assignReferralCode(user.id);
    }

    if (missing.length > 0) {
      logger.info({ count: missing.length }, "Backfilled referral codes for existing users");
    }
  } catch (err) {
    logger.error({ err }, "Failed to backfill referral codes");
  }
}
