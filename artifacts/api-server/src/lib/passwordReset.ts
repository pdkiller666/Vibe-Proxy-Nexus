import { randomBytes } from "node:crypto";
import { eq, gt, and, lt } from "drizzle-orm";
import { db, passwordResetTokensTable } from "@workspace/db";

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function createPasswordResetToken(
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  await db.insert(passwordResetTokensTable).values({ token, userId, expiresAt });

  return { token, expiresAt };
}

export async function consumePasswordResetToken(token: string): Promise<number | null> {
  const [row] = await db
    .delete(passwordResetTokensTable)
    .where(and(eq(passwordResetTokensTable.token, token), gt(passwordResetTokensTable.expiresAt, new Date())))
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
