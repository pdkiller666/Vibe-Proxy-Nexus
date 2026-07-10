import { Router, type IRouter } from "express";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  passwordResetTokensTable,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  sessionsTable,
  supportMessagesTable,
  supportTicketsTable,
  usersTable,
  vpnKeysTable,
  type User,
} from "@workspace/db";
import {
  DeleteUserParams,
  ListAdminUsersResponse,
  UpdateUserExtraSlotsBody,
  UpdateUserExtraSlotsParams,
  UpdateUserExtraSlotsResponse,
  UpdateUserProfileBody,
  UpdateUserProfileParams,
  UpdateUserProfileResponse,
  UpdateUserRoleBody,
  UpdateUserRoleParams,
  UpdateUserRoleResponse,
  UpdateUserSubscriptionBody,
  UpdateUserSubscriptionParams,
  UpdateUserSubscriptionResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { isLocalXrayEnabled, removeXrayClient } from "../../lib/xray";
import { logger } from "../../lib/logger";
import { ONLINE_THRESHOLD_MS } from "../../lib/session";

const router: IRouter = Router();

/**
 * Enriches raw user rows with aggregated traffic (lifetime + current period,
 * summed across the user's own VPN keys) and the trafficLimitGb/exceeded
 * flag from their current subscription's plan.
 *
 * `userIds` optionally scopes the traffic/limit lookups to a subset of
 * users (e.g. a single user after a PATCH), avoiding a full-table scan.
 */
async function enrichUsersWithTraffic(users: User[]) {
  if (users.length === 0) return [];
  const userIds = users.map((u) => u.id);

  // Lifetime + current-period traffic, summed across a user's own VPN keys
  // (revoked keys still count toward lifetime totals, but not toward the
  // active plan's limit — enforceTrafficLimits() in trafficPolling.ts only
  // sums non-revoked keys, so mirror that here for the "exceeded" flag).
  // Postgres's sum(bigint) returns `numeric`, which node-postgres (and thus
  // drizzle's `sql<number>` — a type-only annotation, not a runtime coercion)
  // hands back as a *string*. Coalescing missing rows to a JS `0` above
  // masked this in earlier ad-hoc testing (users with no vpn_keys never hit
  // the SQL path), but any user with actual traffic breaks Zod validation
  // with "Expected number, received string". Coerce explicitly with Number().
  const rawTrafficRows = await db
    .select({
      userId: vpnKeysTable.userId,
      trafficUpBytes: sql<string>`coalesce(sum(${vpnKeysTable.trafficUpBytes}), 0)`,
      trafficDownBytes: sql<string>`coalesce(sum(${vpnKeysTable.trafficDownBytes}), 0)`,
      periodUpBytes: sql<string>`coalesce(sum(${vpnKeysTable.periodUpBytes}) filter (where ${vpnKeysTable.revokedAt} is null), 0)`,
      periodDownBytes: sql<string>`coalesce(sum(${vpnKeysTable.periodDownBytes}) filter (where ${vpnKeysTable.revokedAt} is null), 0)`,
      // All active keys are reset together, so max() gives the effective period
      // start. Null if the user has no active (non-revoked) keys at all.
      periodStartedAt: sql<Date | null>`max(${vpnKeysTable.periodStartedAt}) filter (where ${vpnKeysTable.revokedAt} is null)`,
    })
    .from(vpnKeysTable)
    .where(inArray(vpnKeysTable.userId, userIds))
    .groupBy(vpnKeysTable.userId);
  const trafficRows = rawTrafficRows.map((r) => ({
    userId: r.userId,
    trafficUpBytes: Number(r.trafficUpBytes),
    trafficDownBytes: Number(r.trafficDownBytes),
    periodUpBytes: Number(r.periodUpBytes),
    periodDownBytes: Number(r.periodDownBytes),
    periodStartedAt: r.periodStartedAt,
  }));
  const trafficByUser = new Map(trafficRows.map((r) => [r.userId, r]));

  // A user should only have one currently-active subscription, but pick the
  // most recently started one defensively (DISTINCT ON) so a data anomaly
  // can't fan this join out into multiple limit rows per user.
  const activeRows = await db
    .selectDistinctOn([subscriptionsTable.userId], {
      userId: subscriptionsTable.userId,
      subscriptionId: subscriptionsTable.id,
      trafficLimitGb: plansTable.trafficLimitGb,
      planName: plansTable.name,
      extraDeviceSlots: subscriptionsTable.extraDeviceSlots,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(plansTable.id, subscriptionsTable.planId))
    .where(
      and(
        eq(subscriptionsTable.status, "active"),
        or(isNull(subscriptionsTable.endsAt), gt(subscriptionsTable.endsAt, new Date())),
        inArray(subscriptionsTable.userId, userIds),
      ),
    )
    .orderBy(subscriptionsTable.userId, desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id));
  const limitByUser = new Map(activeRows.map((r) => [r.userId, r.trafficLimitGb]));
  // The genuinely active plan (status=active, not expired) — separate from
  // `currentByUser` below, which can point at a cancelled/pending/rejected
  // request instead. Any "what plan is this user on right now" display must
  // use this one, not currentByUser, or a cancelled downgrade request looks
  // like it actually took effect.
  const activePlanNameByUser = new Map(activeRows.map((r) => [r.userId, r.planName]));
  // Extra device slots live on the active subscription row (see schema
  // comment), so a user with no active subscription has 0 usable slots —
  // any slots purchased under a since-expired/switched subscription do not
  // carry over.
  const activeSubscriptionIdByUser = new Map(activeRows.map((r) => [r.userId, r.subscriptionId]));
  const extraDeviceSlotsByUser = new Map(activeRows.map((r) => [r.userId, r.extraDeviceSlots]));

  // Referral info: who referred each user in (by email, for display), and
  // how many accounts each user has referred in themselves.
  const referrerIds = [...new Set(users.map((u) => u.referredByUserId).filter((id): id is number => id != null))];
  const referrerRows = referrerIds.length > 0
    ? await db.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, referrerIds))
    : [];
  const referrerEmailById = new Map(referrerRows.map((r) => [r.id, r.email]));

  const referredCountRows = await db
    .select({ referredByUserId: usersTable.referredByUserId, count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(inArray(usersTable.referredByUserId, userIds))
    .groupBy(usersTable.referredByUserId);
  const referredCountByUser = new Map(referredCountRows.map((r) => [r.referredByUserId, r.count]));

  // Separately, the user's most recent subscription of *any* status (so the
  // admin panel can show an expired/cancelled/pending plan too, not just an
  // active one) — this is display-only and unrelated to the traffic-limit
  // lookup above, which intentionally only considers active subscriptions.
  const currentRows = await db
    .selectDistinctOn([subscriptionsTable.userId], {
      userId: subscriptionsTable.userId,
      planId: subscriptionsTable.planId,
      planName: plansTable.name,
      status: subscriptionsTable.status,
      endsAt: subscriptionsTable.endsAt,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(plansTable.id, subscriptionsTable.planId))
    .where(inArray(subscriptionsTable.userId, userIds))
    .orderBy(subscriptionsTable.userId, desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id));
  const currentByUser = new Map(currentRows.map((r) => [r.userId, r]));

  const now = Date.now();

  return users.map((user) => {
    const traffic = trafficByUser.get(user.id);
    const trafficLimitGb = limitByUser.get(user.id) ?? null;
    const current = currentByUser.get(user.id);
    const periodBytes = (traffic?.periodUpBytes ?? 0) + (traffic?.periodDownBytes ?? 0);
    return {
      ...user,
      isOnline: Boolean(user.lastActiveAt) && now - user.lastActiveAt!.getTime() <= ONLINE_THRESHOLD_MS,
      trafficUpBytes: traffic?.trafficUpBytes ?? 0,
      trafficDownBytes: traffic?.trafficDownBytes ?? 0,
      periodUpBytes: traffic?.periodUpBytes ?? 0,
      periodDownBytes: traffic?.periodDownBytes ?? 0,
      periodStartedAt: traffic?.periodStartedAt ?? null,
      trafficLimitGb,
      trafficLimitExceeded: trafficLimitGb != null && periodBytes >= trafficLimitGb * 1024 * 1024 * 1024,
      activePlanName: activePlanNameByUser.get(user.id) ?? null,
      extraDeviceSlots: extraDeviceSlotsByUser.get(user.id) ?? 0,
      activeSubscriptionId: activeSubscriptionIdByUser.get(user.id) ?? null,
      referredByEmail: user.referredByUserId != null ? (referrerEmailById.get(user.referredByUserId) ?? null) : null,
      referredUserCount: referredCountByUser.get(user.id) ?? 0,
      planId: current?.planId ?? null,
      planName: current?.planName ?? null,
      subscriptionStatus: current?.status ?? null,
      subscriptionEndsAt: current?.endsAt ?? null,
    };
  });
}

/**
 * True if `userId` is currently an admin and removing/demoting them would
 * leave zero admins in the system — used to block both role-demotion and
 * account-deletion of the last remaining admin.
 */
async function isLastRemainingAdmin(userId: number): Promise<boolean> {
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!target || target.role !== "admin") return false;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));
  return count <= 1;
}

router.get("/admin/users", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(desc(usersTable.createdAt));
  const enriched = await enrichUsersWithTraffic(users);
  res.json(ListAdminUsersResponse.parse(enriched));
});

router.patch("/admin/users/:userId/role", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserRoleParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserRoleBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.role === "user") {
    const wouldRemoveLastAdmin = await isLastRemainingAdmin(params.data.userId);
    if (wouldRemoveLastAdmin) {
      res.status(400).json({ error: "Cannot demote the last remaining admin" });
      return;
    }
  }

  const [user] = await db
    .update(usersTable)
    .set({ role: parsed.data.role })
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [enriched] = await enrichUsersWithTraffic([user]);
  res.json(UpdateUserRoleResponse.parse(enriched));
});

router.patch("/admin/users/:userId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserProfileParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserProfileBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.name === undefined && parsed.data.email === undefined) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  let user: User | undefined;
  try {
    [user] = await db
      .update(usersTable)
      .set(parsed.data)
      .where(eq(usersTable.id, params.data.userId))
      .returning();
  } catch (err) {
    // Postgres unique_violation on users.email. Drizzle wraps the raw pg
    // error, which carries the code either directly or on `.cause` depending
    // on the driver path taken, so check both.
    const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Email is already in use" });
      return;
    }
    throw err;
  }

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [enriched] = await enrichUsersWithTraffic([user]);
  res.json(UpdateUserProfileResponse.parse(enriched));
});

router.delete("/admin/users/:userId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteUserParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const { userId } = params.data;

  if (req.appUser?.id === userId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (await isLastRemainingAdmin(userId)) {
    res.status(400).json({ error: "Cannot delete the last remaining admin" });
    return;
  }

  // Remove any still-live keys from the VPN node(s) before dropping the DB
  // rows. Unlike a plain revoke, this must be reliable: once the user row is
  // gone there is no natural retry path from the UI, and stale Xray clients
  // would leave a "deleted" account with live network access. So a failure
  // here aborts the whole deletion (no DB rows are touched yet) instead of
  // silently proceeding — the admin can retry once the node is reachable.
  const keys = await db
    .select()
    .from(vpnKeysTable)
    .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)));
  if (isLocalXrayEnabled()) {
    for (const key of keys) {
      try {
        await removeXrayClient(key.uuid);
      } catch (err) {
        logger.error({ err, uuid: key.uuid, userId }, "Failed to remove client from Xray while deleting user");
        res.status(502).json({ error: "Failed to deprovision an active VPN key; user was not deleted. Try again." });
        return;
      }
    }
  }

  // Delete in FK-dependency order. sessions and password_reset_tokens cascade
  // at the DB level; everything else here references users without
  // ON DELETE CASCADE, so it must be cleaned up explicitly first. Support
  // messages are also deleted by authorId (not just by ticket ownership) —
  // an admin who replied to another user's ticket would otherwise leave a
  // dangling FK when *that admin* is the one being deleted.
  await db.transaction(async (tx) => {
    const tickets = await tx.select({ id: supportTicketsTable.id }).from(supportTicketsTable).where(eq(supportTicketsTable.userId, userId));
    const ticketIds = tickets.map((t) => t.id);

    await tx
      .delete(supportMessagesTable)
      .where(
        ticketIds.length > 0
          ? or(inArray(supportMessagesTable.ticketId, ticketIds), eq(supportMessagesTable.authorId, userId))
          : eq(supportMessagesTable.authorId, userId),
      );
    await tx.delete(supportTicketsTable).where(eq(supportTicketsTable.userId, userId));
    await tx.delete(paymentsTable).where(eq(paymentsTable.userId, userId));
    await tx.delete(subscriptionsTable).where(eq(subscriptionsTable.userId, userId));
    await tx.delete(vpnKeysTable).where(eq(vpnKeysTable.userId, userId));
    await tx.delete(usersTable).where(eq(usersTable.id, userId));
  });

  res.sendStatus(204);
});

router.patch("/admin/users/:userId/subscription", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserSubscriptionParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserSubscriptionBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { userId } = params.data;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [plan] = await db.select().from(plansTable).where(eq(plansTable.id, parsed.data.planId));
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const now = new Date();
  const [currentActive] = await db
    .select()
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  // Extend from the current active period's end if it hasn't lapsed yet
  // (matches the renewal-via-payment logic in payments.ts); otherwise start
  // fresh from now.
  const startsAt = currentActive?.endsAt && currentActive.endsAt > now ? currentActive.endsAt : now;
  const durationDays = parsed.data.durationDays ?? plan.durationDays;
  const endsAt = new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    // A user should only ever have one active subscription; defensively
    // expire any others before activating the new one.
    await tx
      .update(subscriptionsTable)
      .set({ status: "expired" })
      .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")));

    await tx.insert(subscriptionsTable).values({ userId, planId: plan.id, status: "active", startsAt, endsAt });

    // Manual grant/renewal starts a fresh traffic-tracking period, same as a
    // confirmed payment does.
    await tx
      .update(vpnKeysTable)
      .set({ periodUpBytes: 0, periodDownBytes: 0, periodStartedAt: now })
      .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)));
  });

  const [updatedUser] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const [enriched] = await enrichUsersWithTraffic([updatedUser!]);
  res.json(UpdateUserSubscriptionResponse.parse(enriched));
});

router.patch("/admin/users/:userId/extra-slots", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserExtraSlotsParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserExtraSlotsBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Extra slots live on the active subscription row (see schema comment on
  // subscriptions.extraDeviceSlots) — without one there is nothing to attach
  // slots to, and per policy slots can't be granted/used without an active
  // subscription anyway.
  const [activeSub] = await db
    .select({ id: subscriptionsTable.id })
    .from(subscriptionsTable)
    .where(and(eq(subscriptionsTable.userId, user.id), eq(subscriptionsTable.status, "active")))
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  if (!activeSub) {
    res.status(409).json({ error: "У пользователя нет активной подписки — сначала назначьте тариф." });
    return;
  }

  await db
    .update(subscriptionsTable)
    .set({ extraDeviceSlots: parsed.data.extraDeviceSlots })
    .where(eq(subscriptionsTable.id, activeSub.id));

  const [enriched] = await enrichUsersWithTraffic([user]);
  res.json(UpdateUserExtraSlotsResponse.parse(enriched));
});

export default router;
