import { Router, type IRouter } from "express";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { db, inviteLinksTable, usersTable, plansTable, subscriptionsTable, paymentSettingsTable } from "@workspace/db";
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
import { forgotPasswordRateLimit, registerRateLimit, registerPerCodeRateLimit } from "../lib/rateLimit";
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
import { issueKeyForUser } from "../lib/keyIssuance";
import { assignReferralCode } from "../lib/referralCode";

const router: IRouter = Router();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

router.post("/auth/register", registerRateLimit, registerPerCodeRateLimit, async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const email = normalizeEmail(parsed.data.email);
  const { password, name, ref } = parsed.data;

  // Invite-only lookup — two tiers, checked in priority order:
  //   1. Admin invite links (invite_links table) — carry per-link plan/trial
  //      overrides and a usage counter. Code length is 12 chars, deliberately
  //      longer than the 8-char user referral codes, so the two pools never
  //      collide. Rejected when isActive=false, expired, or maxUses reached.
  //   2. User referral codes (users.referral_code) — standard invite chain;
  //      no per-link overrides; commission attribution still applies.
  const trimmedRef = ref.trim();

  const [inviteLink] = await db
    .select()
    .from(inviteLinksTable)
    .where(
      and(
        eq(inviteLinksTable.code, trimmedRef),
        eq(inviteLinksTable.isActive, true),
        or(isNull(inviteLinksTable.expiresAt), gt(inviteLinksTable.expiresAt, new Date())),
        or(isNull(inviteLinksTable.maxUses), lt(inviteLinksTable.usedCount, inviteLinksTable.maxUses)),
      ),
    );

  let referrerId: number;
  let resolvedInviteLinkId: number | null = null;

  if (inviteLink) {
    // Admin-created invite link — use the link creator as referrer so any
    // configured commission flows to the admin who issued the link.
    referrerId = inviteLink.createdByUserId;
    resolvedInviteLinkId = inviteLink.id;
  } else {
    // Fall back to standard user referral code.
    const [referrer] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.referralCode, trimmedRef));
    if (!referrer) {
      res.status(400).json({ error: "Недействительная реферальная ссылка. Регистрация возможна только по приглашению." });
      return;
    }
    referrerId = referrer.id;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));

  if (existing) {
    res.status(409).json({ error: "Пользователь с таким email уже зарегистрирован" });
    return;
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db
    .insert(usersTable)
    .values({ email, passwordHash, name: name ?? null, referredByUserId: referrerId, inviteLinkId: resolvedInviteLinkId })
    .onConflictDoNothing({ target: usersTable.email })
    .returning();

  if (!user) {
    res.status(409).json({ error: "Пользователь с таким email уже зарегистрирован" });
    return;
  }

  await assignReferralCode(user.id);

  // Atomically increment usage counter so the admin can track registrations
  // per invite link. Done after successful user creation (not inside the
  // onConflictDoNothing block) so a duplicate-email race never inflates the count.
  if (resolvedInviteLinkId !== null) {
    await db
      .update(inviteLinksTable)
      .set({ usedCount: sql`${inviteLinksTable.usedCount} + 1` })
      .where(eq(inviteLinksTable.id, resolvedInviteLinkId));
  }

  // Trial subscription: if enabled in settings, create an active subscription
  // immediately so the user can try the service without paying first.
  // We pick the cheapest active plan (by priceRub, then id) for devicesIncluded.
  // If no plans exist yet the trial is silently skipped.
  try {
    const [settings] = await db.select().from(paymentSettingsTable).limit(1);

    // An invite link with explicit planId or trialDays overrides is treated as
    // a per-link trial grant and bypasses the global trialEnabled switch.
    // Rationale: if an admin explicitly configured trial settings on a link
    // (e.g. a VIP campaign), those settings must fire even when the global
    // trial toggle is off. A link with both fields null has no override intent
    // and falls through to the global flag like any regular registration.
    const hasInviteLinkTrialOverride =
      inviteLink != null && (inviteLink.planId != null || inviteLink.trialDays != null);

    if (settings?.trialEnabled || hasInviteLinkTrialOverride) {
      // Resolve the trial plan: admin-selected first, auto-select as fallback.
      // Auto-select only considers monthly plans — hourly plans have priceRub=0
      // and would always win the sort, but an hourly trial is meaningless since
      // balance=0 means the first billing tick immediately stops VPN access.
      let trialPlan: typeof plansTable.$inferSelect | undefined;

      // Plan resolution priority (highest → lowest):
      //   1. invite link planId override (per-link, set at link creation time)
      //   2. global trialPlanId from payment_settings (admin-selected)
      //   3. cheapest active monthly plan (auto-select fallback)
      const overridePlanId = inviteLink?.planId ?? settings.trialPlanId ?? null;

      if (overridePlanId) {
        // Verify the plan is still active — if deleted/deactivated, fall through
        // to auto-select so the trial fires rather than silently skipping.
        const [explicit] = await db
          .select()
          .from(plansTable)
          .where(and(eq(plansTable.id, overridePlanId), eq(plansTable.isActive, true)))
          .limit(1);
        trialPlan = explicit;
        if (!trialPlan) {
          logger.warn(
            { userId: user.id, overridePlanId },
            "Override trial plan is inactive/missing — falling back to cheapest monthly plan",
          );
        }
      }

      if (!trialPlan) {
        const [cheapest] = await db
          .select()
          .from(plansTable)
          .where(and(eq(plansTable.isActive, true), eq(plansTable.billingType, "monthly")))
          .orderBy(asc(plansTable.priceRub), asc(plansTable.id))
          .limit(1);
        trialPlan = cheapest;
      }

      if (trialPlan) {
        // trialDays priority: invite-link override → global setting → 5-day default.
        const trialDays = inviteLink?.trialDays ?? settings.trialDays ?? 5;
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

        // Auto-issue first VPN key so the user can connect immediately after
        // registration without any extra steps.
        try {
          const totalSlots = trialPlan.devicesIncluded + 0; // new user has no extra slots yet
          const keyResult = await issueKeyForUser(user.id, totalSlots);
          if (keyResult.ok) {
            logger.info({ userId: user.id, keyId: keyResult.key.id }, "Auto VPN key issued on registration");
          } else {
            logger.warn({ userId: user.id, err: keyResult.error }, "Auto VPN key skipped on registration");
          }
        } catch (err) {
          logger.error({ err, userId: user.id }, "Failed to auto-issue VPN key on registration");
        }
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

  // Re-fetch: assignReferralCode() updated the row after `user` was read.
  const [freshUser] = await db.select().from(usersTable).where(eq(usersTable.id, user.id));
  res.json(RegisterResponse.parse(await buildMeData(freshUser ?? user, req.get("host") ?? "")));
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

  res.json(LoginResponse.parse(await buildMeData(user, req.get("host") ?? "")));
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
