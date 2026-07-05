import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { RegisterBody, RegisterResponse, LoginBody, LoginResponse } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { hashPassword, verifyPassword } from "../lib/password";
import { buildMeData } from "../lib/meResponse";
import { isRateLimited, recordFailedAttempt, resetAttempts } from "../lib/loginRateLimit";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionTokenFromRequest,
  setSessionCookie,
} from "../lib/session";

const router: IRouter = Router();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

router.post("/auth/register", async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const email = normalizeEmail(parsed.data.email);
  const { password, name } = parsed.data;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));

  if (existing) {
    res.status(409).json({ error: "Пользователь с таким email уже зарегистрирован" });
    return;
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash, name: name ?? null })
    .onConflictDoNothing({ target: usersTable.email })
    .returning();

  if (!user) {
    res.status(409).json({ error: "Пользователь с таким email уже зарегистрирован" });
    return;
  }

  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(res, token, expiresAt);

  res.json(RegisterResponse.parse(await buildMeData(user)));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const email = normalizeEmail(parsed.data.email);
  const rateLimitKey = `${req.ip ?? "unknown"}:${email}`;

  if (isRateLimited(rateLimitKey)) {
    res.status(429).json({ error: "Слишком много попыток входа. Попробуйте позже." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  const passwordValid = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;

  if (!user || !passwordValid) {
    recordFailedAttempt(rateLimitKey);
    res.status(401).json({ error: "Неверный email или пароль" });
    return;
  }

  resetAttempts(rateLimitKey);

  const { token, expiresAt } = await createSession(user.id);
  setSessionCookie(res, token, expiresAt);

  res.json(LoginResponse.parse(await buildMeData(user)));
});

router.post("/auth/logout", requireAuth, async (req, res): Promise<void> => {
  const token = getSessionTokenFromRequest(req);

  if (token) {
    await destroySession(token);
  }

  clearSessionCookie(res);
  res.status(204).end();
});

export default router;
