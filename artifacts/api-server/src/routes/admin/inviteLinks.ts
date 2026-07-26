import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, inviteLinksTable, plansTable, usersTable } from "@workspace/db";
import {
  CreateAdminInviteLinkBody,
  CreateAdminInviteLinkResponse,
  UpdateAdminInviteLinkBody,
  UpdateAdminInviteLinkParams,
  UpdateAdminInviteLinkResponse,
  DeleteAdminInviteLinkParams,
  GetAdminInviteLinkUsersParams,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

// 12-character code — deliberately longer than the 8-char user referral codes
// so there is zero namespace collision between the two pools. auth.ts always
// checks invite_links BEFORE users.referral_code, so longer codes only ever
// resolve as admin invite links.
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const INVITE_CODE_LENGTH = 12;

function generateInviteCode(): string {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

type LinkRow = {
  id: number;
  code: string;
  note: string | null;
  createdByUserId: number;
  planId: number | null;
  planName: string | null;
  trialDays: number | null;
  maxUses: number | null;
  usedCount: number;
  isActive: boolean;
  expiresAt: Date | null;
  createdAt: Date;
};

/** Shape the DB row into the AdminInviteLink API response object. */
function formatLink(row: LinkRow) {
  return {
    id: row.id,
    code: row.code,
    note: row.note ?? null,
    createdByUserId: row.createdByUserId,
    planId: row.planId ?? null,
    planName: row.planName ?? null,
    trialDays: row.trialDays ?? null,
    maxUses: row.maxUses ?? null,
    usedCount: row.usedCount,
    isActive: row.isActive,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** SELECT with plan JOIN — shared by GET (list) and the post-write re-fetch. */
const selectWithPlan = () =>
  db
    .select({
      id: inviteLinksTable.id,
      code: inviteLinksTable.code,
      note: inviteLinksTable.note,
      createdByUserId: inviteLinksTable.createdByUserId,
      planId: inviteLinksTable.planId,
      planName: plansTable.name,
      trialDays: inviteLinksTable.trialDays,
      maxUses: inviteLinksTable.maxUses,
      usedCount: inviteLinksTable.usedCount,
      isActive: inviteLinksTable.isActive,
      expiresAt: inviteLinksTable.expiresAt,
      createdAt: inviteLinksTable.createdAt,
    })
    .from(inviteLinksTable)
    .leftJoin(plansTable, eq(inviteLinksTable.planId, plansTable.id));

// ── GET /admin/invite-links ───────────────────────────────────────────────────
router.get("/admin/invite-links", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const rows = await selectWithPlan().orderBy(desc(inviteLinksTable.createdAt));
  res.json(rows.map(formatLink));
});

// ── POST /admin/invite-links ──────────────────────────────────────────────────
router.post("/admin/invite-links", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateAdminInviteLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { note, planId, trialDays, maxUses, expiresAt } = parsed.data;

  // Verify planId points to an active monthly plan when provided.
  // Monthly-only: hourly plans have priceRub=0 so their first billing tick
  // immediately kills VPN access when the new user's balance is zero.
  if (planId != null) {
    const [plan] = await db
      .select({ id: plansTable.id, billingType: plansTable.billingType })
      .from(plansTable)
      .where(and(eq(plansTable.id, planId), eq(plansTable.isActive, true)))
      .limit(1);
    if (!plan) {
      res.status(400).json({ error: "Указанный тариф не найден или неактивен" });
      return;
    }
    if (plan.billingType !== "monthly") {
      res.status(400).json({ error: "Для инвайт-ссылки можно выбрать только месячный тариф" });
      return;
    }
  }

  // Generate a unique 12-char code with retry on collision (astronomically rare).
  let code: string | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateInviteCode();
    const [existing] = await db
      .select({ id: inviteLinksTable.id })
      .from(inviteLinksTable)
      .where(eq(inviteLinksTable.code, candidate))
      .limit(1);
    if (!existing) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    logger.error("Failed to generate unique invite link code after 10 attempts");
    res.status(500).json({ error: "Не удалось сгенерировать уникальный код" });
    return;
  }

  const [inserted] = await db
    .insert(inviteLinksTable)
    .values({
      code,
      note: note ?? null,
      createdByUserId: req.appUser!.id,
      planId: planId ?? null,
      trialDays: trialDays ?? null,
      maxUses: maxUses ?? null,
      expiresAt: expiresAt ?? null,
      isActive: true,
    })
    .returning({ id: inviteLinksTable.id });

  if (!inserted) {
    res.status(500).json({ error: "Не удалось создать ссылку" });
    return;
  }

  const [row] = await selectWithPlan().where(eq(inviteLinksTable.id, inserted.id));
  res.status(201).json(CreateAdminInviteLinkResponse.parse(formatLink(row!)));
});

// ── PATCH /admin/invite-links/:linkId ────────────────────────────────────────
router.patch("/admin/invite-links/:linkId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateAdminInviteLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateAdminInviteLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { linkId } = params.data;
  const { note, isActive, planId, trialDays, maxUses, expiresAt } = parsed.data;

  // Validate planId when being set to a non-null value — must be active and monthly.
  if (planId != null) {
    const [plan] = await db
      .select({ id: plansTable.id, billingType: plansTable.billingType })
      .from(plansTable)
      .where(and(eq(plansTable.id, planId), eq(plansTable.isActive, true)))
      .limit(1);
    if (!plan) {
      res.status(400).json({ error: "Указанный тариф не найден или неактивен" });
      return;
    }
    if (plan.billingType !== "monthly") {
      res.status(400).json({ error: "Для инвайт-ссылки можно выбрать только месячный тариф" });
      return;
    }
  }

  // Build partial update — only include keys the caller sent.
  type UpdateSet = Partial<{
    note: string | null;
    isActive: boolean;
    planId: number | null;
    trialDays: number | null;
    maxUses: number | null;
    expiresAt: Date | null;
  }>;
  const updateSet: UpdateSet = {};
  if (note !== undefined) updateSet.note = note;
  if (isActive !== undefined) updateSet.isActive = isActive;
  if (planId !== undefined) updateSet.planId = planId;
  if (trialDays !== undefined) updateSet.trialDays = trialDays;
  if (maxUses !== undefined) updateSet.maxUses = maxUses;
  if (expiresAt !== undefined) updateSet.expiresAt = expiresAt as Date | null | undefined;

  if (Object.keys(updateSet).length === 0) {
    res.status(400).json({ error: "Нет полей для обновления" });
    return;
  }

  const [updated] = await db
    .update(inviteLinksTable)
    .set(updateSet)
    .where(eq(inviteLinksTable.id, linkId))
    .returning({ id: inviteLinksTable.id });

  if (!updated) {
    res.status(404).json({ error: "Ссылка не найдена" });
    return;
  }

  const [row] = await selectWithPlan().where(eq(inviteLinksTable.id, updated.id));
  res.json(UpdateAdminInviteLinkResponse.parse(formatLink(row!)));
});

// ── GET /admin/invite-links/:linkId/users ────────────────────────────────────
router.get("/admin/invite-links/:linkId/users", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = GetAdminInviteLinkUsersParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { linkId } = params.data;

  // Verify the link exists before returning its audience so we get a proper
  // 404 instead of an empty array for non-existent link IDs.
  const [link] = await db
    .select({ id: inviteLinksTable.id })
    .from(inviteLinksTable)
    .where(eq(inviteLinksTable.id, linkId))
    .limit(1);

  if (!link) {
    res.status(404).json({ error: "Ссылка не найдена" });
    return;
  }

  const users = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.inviteLinkId, linkId))
    .orderBy(asc(usersTable.createdAt));

  res.json(users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    createdAt: u.createdAt.toISOString(),
  })));
});

// ── DELETE /admin/invite-links/:linkId ───────────────────────────────────────
router.delete("/admin/invite-links/:linkId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteAdminInviteLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(inviteLinksTable)
    .where(eq(inviteLinksTable.id, params.data.linkId))
    .returning({ id: inviteLinksTable.id });

  if (!deleted) {
    res.status(404).json({ error: "Ссылка не найдена" });
    return;
  }

  res.sendStatus(204);
});

export default router;
