import { Router, type IRouter } from "express";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, usersTable, type User } from "@workspace/db";
import {
  GetMeResponse,
  UpdateMeBody,
  UpdateMeResponse,
  ChangeMyEmailBody,
  ChangeMyEmailResponse,
  ChangeMyPasswordBody,
  ChangeMyPasswordResponse,
  PatchMeAutoRenewBody,
} from "@workspace/api-zod";
import { requireAuth, requireAuthAllowBanned } from "../lib/auth";
import { buildMeData } from "../lib/meResponse";
import { hashPassword, verifyPassword } from "../lib/password";
import { invalidateUserSessions } from "../lib/session";

const router: IRouter = Router();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

router.get("/me", requireAuthAllowBanned, async (req, res): Promise<void> => {
  const user = req.appUser!;
  res.json(GetMeResponse.parse(await buildMeData(user, req.get("host") ?? "")));
});

router.patch("/me", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateMeBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ name: parsed.data.name ?? null })
    .where(eq(usersTable.id, req.appUser!.id))
    .returning();

  res.json(UpdateMeResponse.parse(await buildMeData(user!, req.get("host") ?? "")));
});

router.patch("/me/email", requireAuth, async (req, res): Promise<void> => {
  const parsed = ChangeMyEmailBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const passwordValid = await verifyPassword(parsed.data.currentPassword, req.appUser!.passwordHash);
  if (!passwordValid) {
    res.status(401).json({ error: "Неверный текущий пароль" });
    return;
  }

  const newEmail = normalizeEmail(parsed.data.newEmail);

  let user: User | undefined;
  try {
    [user] = await db
      .update(usersTable)
      .set({ email: newEmail })
      .where(eq(usersTable.id, req.appUser!.id))
      .returning();
  } catch (err) {
    const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Этот email уже используется" });
      return;
    }
    throw err;
  }

  res.json(ChangeMyEmailResponse.parse(await buildMeData(user!, req.get("host") ?? "")));
});

router.patch("/me/password", requireAuth, async (req, res): Promise<void> => {
  const parsed = ChangeMyPasswordBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const passwordValid = await verifyPassword(parsed.data.currentPassword, req.appUser!.passwordHash);
  if (!passwordValid) {
    res.status(401).json({ error: "Неверный текущий пароль" });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, req.appUser!.id));

  // Invalidate every other session so a stolen/lost device is logged out —
  // the current session's cookie still works (it isn't re-issued), matching
  // the UX of most "change password" flows (you stay logged in here).
  await invalidateUserSessions(req.appUser!.id);

  res.json(ChangeMyPasswordResponse.parse({ message: "Пароль изменён" }));
});

router.patch("/me/auto-renew", requireAuth, async (req, res): Promise<void> => {
  const parsed = PatchMeAutoRenewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.enabled) {
    const result = await db.transaction(async (tx) => {
      // The balance checkout path locks this same row before it debits. Holding
      // the lock here makes the balance check and preference update one atomic
      // decision instead of trusting the user object loaded by auth middleware.
      const [lockedUser] = await tx
        .select({ id: usersTable.id, balanceKopecks: usersTable.balanceKopecks })
        .from(usersTable)
        .where(eq(usersTable.id, req.appUser!.id))
        .for("update");

      if (!lockedUser) return { kind: "missing_user" as const };

      // Match buildMeData exactly: select the most recent active subscription
      // of any billing type, then require that current subscription to be
      // monthly. An older monthly row must not authorize a current hourly plan.
      const [currentSubscription] = await tx
        .select({
          priceRub: plansTable.priceRub,
          billingType: plansTable.billingType,
        })
        .from(subscriptionsTable)
        .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
        .where(
          and(
            eq(subscriptionsTable.userId, lockedUser.id),
            eq(subscriptionsTable.status, "active"),
            or(isNull(subscriptionsTable.endsAt), gt(subscriptionsTable.endsAt, new Date())),
          ),
        )
        .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
        .limit(1);

      if (
        !currentSubscription ||
        currentSubscription.billingType !== "monthly" ||
        currentSubscription.priceRub <= 0
      ) {
        return { kind: "not_monthly" as const };
      }

      const requiredKopecks = currentSubscription.priceRub * 100;
      if (lockedUser.balanceKopecks < requiredKopecks) {
        return {
          kind: "insufficient_balance" as const,
          balanceKopecks: lockedUser.balanceKopecks,
          requiredKopecks,
        };
      }

      const [user] = await tx
        .update(usersTable)
        .set({ autoRenewFromBalance: true })
        .where(eq(usersTable.id, lockedUser.id))
        .returning();
      return { kind: "updated" as const, user: user! };
    });

    if (result.kind === "missing_user" || result.kind === "not_monthly") {
      res.status(400).json({ error: "Автопродление доступно только для активного месячного тарифа." });
      return;
    }

    if (result.kind === "insufficient_balance") {
      res.status(402).json({
        error: "Недостаточно средств на балансе для включения автопродления. Пополните баланс и попробуйте снова.",
        balanceKopecks: result.balanceKopecks,
        requiredKopecks: result.requiredKopecks,
      });
      return;
    }

    res.json(GetMeResponse.parse(await buildMeData(result.user, req.get("host") ?? "")));
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ autoRenewFromBalance: false })
    .where(eq(usersTable.id, req.appUser!.id))
    .returning();

  res.json(GetMeResponse.parse(await buildMeData(user!, req.get("host") ?? "")));
});

export default router;
