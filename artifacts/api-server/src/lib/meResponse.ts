import { and, desc, eq } from "drizzle-orm";
import { db, plansTable, subscriptionsTable, type User } from "@workspace/db";

export async function buildMeData(user: User) {
  const [activeSubscription] = await db
    .select({
      endsAt: subscriptionsTable.endsAt,
      planName: plansTable.name,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .where(and(eq(subscriptionsTable.userId, user.id), eq(subscriptionsTable.status, "active")))
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
