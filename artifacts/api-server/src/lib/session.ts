import { randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Request, Response } from "express";
import { db, sessionsTable, usersTable, type User } from "@workspace/db";
import { logger } from "./logger";

export const SESSION_COOKIE_NAME = "vpn_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET must be set. Generate one with e.g. `openssl rand -hex 32`.",
    );
  }
  return secret;
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessionsTable).values({ token, userId, expiresAt });

  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.token, token));
}

export async function getUserBySessionToken(token: string): Promise<User | null> {
  const [row] = await db
    .select({ user: usersTable })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(and(eq(sessionsTable.token, token), gt(sessionsTable.expiresAt, new Date())));

  return row?.user ?? null;
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    signed: true,
    expires: expiresAt,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export function getSessionTokenFromRequest(req: Request): string | null {
  const value = req.signedCookies?.[SESSION_COOKIE_NAME];
  return typeof value === "string" ? value : null;
}

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function deleteExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessionsTable)
    .where(lt(sessionsTable.expiresAt, new Date()))
    .returning({ token: sessionsTable.token });

  return deleted.length;
}

export function startSessionCleanupJob(): NodeJS.Timeout {
  const runCleanup = () => {
    deleteExpiredSessions()
      .then((count) => {
        if (count > 0) {
          logger.info({ count }, "Deleted expired sessions");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Failed to delete expired sessions");
      });
  };

  runCleanup();

  return setInterval(runCleanup, SESSION_CLEANUP_INTERVAL_MS);
}
