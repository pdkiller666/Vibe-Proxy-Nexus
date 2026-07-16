import { randomBytes, createHash } from "node:crypto";
import { eq, gt, and, lt } from "drizzle-orm";
import { db, passwordResetTokensTable } from "@workspace/db";

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Store a SHA-256 hash of the raw token in the DB, not the token itself.
// The raw token is returned to the user (in-app link) and never persisted.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createPasswordResetToken(
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  // Store hash, not the raw token — see hashToken() above.
  await db.insert(passwordResetTokensTable).values({ token: hashToken(token), userId, expiresAt });

  return { token, expiresAt };
}

export async function consumePasswordResetToken(token: string): Promise<number | null> {
  const [row] = await db
    .delete(passwordResetTokensTable)
    .where(and(eq(passwordResetTokensTable.token, hashToken(token)), gt(passwordResetTokensTable.expiresAt, new Date())))
    .returning({ userId: passwordResetTokensTable.userId });

  return row?.userId ?? null;
}

export async function deleteExpiredPasswordResetTokens(): Promise<number> {
  const deleted = await db
    .delete(passwordResetTokensTable)
    .where(lt(passwordResetTokensTable.expiresAt, new Date()))
    .returning({ token: passwordResetTokensTable.token });

  return deleted.length;
}
