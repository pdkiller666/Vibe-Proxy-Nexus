import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";
import {
  GetMeResponse,
  UpdateMeBody,
  UpdateMeResponse,
  ChangeMyEmailBody,
  ChangeMyEmailResponse,
  ChangeMyPasswordBody,
  ChangeMyPasswordResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { buildMeData } from "../lib/meResponse";
import { hashPassword, verifyPassword } from "../lib/password";
import { invalidateUserSessions } from "../lib/session";

const router: IRouter = Router();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

router.get("/me", requireAuth, async (req, res): Promise<void> => {
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

export default router;
