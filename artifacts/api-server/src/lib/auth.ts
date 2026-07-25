import type { NextFunction, Request, Response } from "express";
import type { User } from "@workspace/db";
import { getSessionTokenFromRequest, getUserBySessionToken } from "./session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      appUser?: User;
    }
  }
}

/**
 * Validates the session token and attaches the user to `req.appUser`.
 * Does NOT check `isBanned` — use this only for endpoints that must remain
 * accessible while an account is administratively blocked (e.g. GET /me, so
 * the frontend can display a "banned" screen instead of redirecting to sign-in).
 */
export async function requireAuthAllowBanned(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = getSessionTokenFromRequest(req);

  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const user = await getUserBySessionToken(token);

  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.appUser = user;
  next();
}

/**
 * Validates the session token, attaches the user to `req.appUser`, and blocks
 * banned accounts with 403 AccountBanned. Use this for all regular routes.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireAuthAllowBanned(req, res, () => {
    if (req.appUser?.isBanned) {
      res.status(403).json({ error: "AccountBanned" });
      return;
    }
    next();
  });
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
