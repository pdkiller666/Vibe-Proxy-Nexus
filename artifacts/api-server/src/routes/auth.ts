import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import { db, usersTable, plansTable, subscriptionsTable, paymentSettingsTable } from "@workspace/db";
import {
  RegisterBody,
  RegisterResponse,
  LoginBody,
  LoginResponse,
  ForgotPasswordBody,
  ForgotPasswordResponse,
  ResetPasswordBody,
  ResetPasswordResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { hashPassword, verifyPassword } from "../lib/password";
import { buildMeData } from "../lib/meResponse";
import { isRateLimited, recordFailedAttempt, resetAttempts } from "../lib/loginRateLimit";
import { forgotPasswordRateLimit, registerRateLimit } from "../lib/rateLimit";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionTokenFromRequest,
  invalidateUserSessions,
  setSessionCookie,
} from "../lib/session";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
} from "../lib/passwordReset";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

router.post("/auth/register", registerRateLimit, async (req, res): Promise<void> => {
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

  // Trial subscription: if enabled in settings, create an active subscription
  // immediately so the user can try the service without paying first.
  // We pick the cheapest active plan (by priceRub, then id) for devicesIncluded.
  // If no plans exist yet the trial is silently skipped.
  try {
    const [settings] = await db.select().from(paymentSettingsTable).limit(1);
    if (settings?.trialEnabled) {
      const [trialPlan] = await db
        .select()
        .from(plansTable)
        .where(eq(plansTable.isActive, true))
        .orderBy(asc(plansTable.priceRub), asc(plansTable.id))
        .limit(1);

      if (trialPlan) {
        const trialDays = settings.trialDays ?? 5;
        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + trialDays * 24 * 60 * 60 * 1000);
        await db.insert(subscriptionsTable).values({
          userId: user.id,
          planId: trialPlan.id,
          status: "active",
          startsAt,
          endsAt,
        });
        logger.info({ userId: user.id, trialDays, planId: trialPlan.id }, "Trial subscription created");
      } else {
        logger.warn({ userId: user.id }, "Trial enabled but no active plans found — skipping trial");
      }
    }
  } catch (err) {
    // Trial creation failure must not break registration — user still gets their account.
    logger.error({ err, userId: user.id }, "Failed to create trial subscription");
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

router.post("/auth/forgot-password", forgotPasswordRateLimit, async (req, res): Promise<void> => {
  const parsed = ForgotPasswordBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const email = normalizeEmail(parsed.data.email);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));

  // The response is intentionally generic and identical whether or not the
  // account exists, to avoid leaking account existence to an unauthenticated
  // caller. No outbound email sending is configured yet, so the reset token
  // is only recorded server-side (never returned in this response or logged
  // in full) — see the admin-assisted "/admin/users/:userId/password-reset"
  // endpoint for how a support admin can generate a usable link today. Once
  // an email provider is wired up, this endpoint should email the link to
  // the user's address instead.
  const genericMessage = "Если аккаунт с таким email существует, вы получите ссылку для сброса пароля.";

  if (user) {
    await createPasswordResetToken(user.id);
    logger.info({ userId: user.id }, "Password reset requested");
  }

  res.json(ForgotPasswordResponse.parse({ message: genericMessage }));
});

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const parsed = ResetPasswordBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { token, password } = parsed.data;
  const userId = await consumePasswordResetToken(token);

  if (!userId) {
    res.status(400).json({ error: "Ссылка для сброса пароля недействительна или устарела" });
    return;
  }

  const passwordHash = await hashPassword(password);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, userId));
  await invalidateUserSessions(userId);

  res.json(ResetPasswordResponse.parse({ message: "Пароль обновлён. Теперь вы можете войти." }));
});

export default router;
