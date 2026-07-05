import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, type User } from "@workspace/db";

export async function buildMeData(user: User) {
  // Defense in depth: the background job in subscriptionLifecycle.ts flips
  // "active" subscriptions to "expired" on a periodic sweep, so there's a
  // window (up to its interval) where a row can still say "active" despite
  // endsAt already being in the past. Re-check endsAt here so access reads
  // are never stale even if the sweep hasn't run yet.
  const [activeSubscription] = await db
    .select({
      endsAt: subscriptionsTable.endsAt,
      planName: plansTable.name,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(
      and(
        eq(subscriptionsTable.userId, user.id),
        eq(subscriptionsTable.status, "active"),
        or(isNull(subscriptionsTable.endsAt), gt(subscriptionsTable.endsAt, new Date())),
      ),
    )
    .orderBy(desc(subscriptionsTable.endsAt))
    .limit(1);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    hasActiveSubscription: Boolean(activeSubscription),
    currentPlanName: activeSubscription?.planName ?? null,
    subscriptionEndsAt: activeSubscription?.endsAt ?? null,
  };
}
