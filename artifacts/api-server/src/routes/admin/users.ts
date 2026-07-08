import { Router, type IRouter } from "express";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, usersTable, vpnKeysTable, type User } from "@workspace/db";
import {
  ListAdminUsersResponse,
  UpdateUserExtraSlotsBody,
  UpdateUserExtraSlotsParams,
  UpdateUserExtraSlotsResponse,
  UpdateUserRoleBody,
  UpdateUserRoleParams,
  UpdateUserRoleResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

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
  }));
  const trafficByUser = new Map(trafficRows.map((r) => [r.userId, r]));

  // A user should only have one currently-active subscription, but pick the
  // most recently started one defensively (DISTINCT ON) so a data anomaly
  // can't fan this join out into multiple limit rows per user.
  const limitRows = await db
    .selectDistinctOn([subscriptionsTable.userId], {
      userId: subscriptionsTable.userId,
      trafficLimitGb: plansTable.trafficLimitGb,
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
  const limitByUser = new Map(limitRows.map((r) => [r.userId, r.trafficLimitGb]));

  return users.map((user) => {
    const traffic = trafficByUser.get(user.id);
    const trafficLimitGb = limitByUser.get(user.id) ?? null;
    const periodBytes = (traffic?.periodUpBytes ?? 0) + (traffic?.periodDownBytes ?? 0);
    return {
      ...user,
      trafficUpBytes: traffic?.trafficUpBytes ?? 0,
      trafficDownBytes: traffic?.trafficDownBytes ?? 0,
      periodUpBytes: traffic?.periodUpBytes ?? 0,
      periodDownBytes: traffic?.periodDownBytes ?? 0,
      trafficLimitGb,
      trafficLimitExceeded: trafficLimitGb != null && periodBytes >= trafficLimitGb * 1024 * 1024 * 1024,
    };
  });
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

  const [user] = await db
    .update(usersTable)
    .set({ extraDeviceSlots: parsed.data.extraDeviceSlots })
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [enriched] = await enrichUsersWithTraffic([user]);
  res.json(UpdateUserExtraSlotsResponse.parse(enriched));
});

export default router;
