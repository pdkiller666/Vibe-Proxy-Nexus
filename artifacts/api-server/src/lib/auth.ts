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

export async function requireAuth(
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
