import type { NextFunction, Request, Response } from "express";
import { clerkClient, getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";
import { logger } from "./logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      appUser?: User;
    }
  }
}

export async function getOrCreateUser(clerkUserId: string): Promise<User> {
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));

  if (existing) return existing;

  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const primaryEmail = clerkUser.emailAddresses.find(
    (address) => address.id === clerkUser.primaryEmailAddressId,
  );
  const email =
    primaryEmail?.emailAddress ?? clerkUser.emailAddresses[0]?.emailAddress ?? "";
  const name =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim() || null;

  const [user] = await db
    .insert(usersTable)
    .values({ clerkUserId, email, name })
    .onConflictDoNothing({ target: usersTable.clerkUserId })
    .returning();

  if (user) return user;

  const [raceWinner] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId));

  if (!raceWinner) {
    logger.error({ clerkUserId }, "Failed to provision local user record");
    throw new Error("Failed to provision user");
  }

  return raceWinner;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;

  if (!clerkUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.appUser = await getOrCreateUser(clerkUserId);
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.appUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (req.appUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  next();
}
