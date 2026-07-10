import { and, count, desc, eq, gt, isNull, or, sum } from "drizzle-orm";
import { db, balanceTransactionsTable, paymentSettingsTable, plansTable, subscriptionsTable, usersTable, vpnKeysTable, type User } from "@workspace/db";

export async function buildMeData(user: User) {
  // Defense in depth: the background job in subscriptionLifecycle.ts flips
  // "active" subscriptions to "expired" on a periodic sweep, so there's a
  // window (up to its interval) where a row can still say "active" despite
  // endsAt already being in the past. Re-check endsAt here so access reads
  // are never stale even if the sweep hasn't run yet.
  // Order by startsAt/id (always set), not endsAt: an indefinite hourly plan
  // has endsAt = null, and Postgres sorts NULLs FIRST in a DESC order by
  // default — so ordering by desc(endsAt) would surface a stale hourly
  // subscription ahead of a newer, dated plan the user just switched to.
  // There should only ever be one "active" row per user (the admin confirm
  // route retires the previous one), but this ordering is also the correct
  // tiebreaker defensively if that invariant is ever violated.
  const [activeSubscription] = await db
    .select({
      endsAt: subscriptionsTable.endsAt,
      planName: plansTable.name,
      devicesIncluded: plansTable.devicesIncluded,
      billingType: plansTable.billingType,
      hourlyRateKopecks: plansTable.hourlyRateKopecks,
      lastBilledAt: subscriptionsTable.lastBilledAt,
      extraDeviceSlots: subscriptionsTable.extraDeviceSlots,
      trafficLimitGb: plansTable.trafficLimitGb,
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
    .orderBy(desc(subscriptionsTable.startsAt), desc(subscriptionsTable.id))
    .limit(1);

  const [keyCountResult] = await db
    .select({
      cnt: count(),
      periodUp: sum(vpnKeysTable.periodUpBytes),
      periodDown: sum(vpnKeysTable.periodDownBytes),
    })
    .from(vpnKeysTable)
    .where(and(eq(vpnKeysTable.userId, user.id), isNull(vpnKeysTable.revokedAt)));

  const activeKeyCount = keyCountResult?.cnt ?? 0;
  const periodUsageBytes = Number(keyCountResult?.periodUp ?? 0) + Number(keyCountResult?.periodDown ?? 0);
  // Extra device slots live on the active subscription row, not the user —
  // without an active subscription there is no slot to report at all (slots
  // bought under a since-expired/switched subscription do not carry over).
  const deviceSlots = activeSubscription ? activeSubscription.devicesIncluded + activeSubscription.extraDeviceSlots : 0;

  const [settings] = await db.select({ referralCommissionPercent: paymentSettingsTable.referralCommissionPercent }).from(paymentSettingsTable).limit(1);

  const [earningsResult] = await db
    .select({ total: sum(balanceTransactionsTable.amountKopecks) })
    .from(balanceTransactionsTable)
    .where(and(eq(balanceTransactionsTable.userId, user.id), eq(balanceTransactionsTable.type, "referral")));

  const [{ count: referredUserCount }] = await db
    .select({ count: count() })
    .from(usersTable)
    .where(eq(usersTable.referredByUserId, user.id));

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    hasActiveSubscription: Boolean(activeSubscription),
    currentPlanName: activeSubscription?.planName ?? null,
    subscriptionEndsAt: activeSubscription?.endsAt ?? null,
    currentPlanBillingType: activeSubscription?.billingType ?? null,
    hourlyRateKopecks: activeSubscription?.hourlyRateKopecks ?? null,
    lastBilledAt: activeSubscription?.lastBilledAt ?? null,
    deviceSlots,
    activeKeyCount,
    balanceKopecks: user.balanceKopecks,
    trafficLimitGb: activeSubscription?.trafficLimitGb ?? null,
    periodUsageBytes,
    referralCode: user.referralCode,
    referralCommissionPercent: settings?.referralCommissionPercent ?? 0,
    referralEarningsKopecks: Number(earningsResult?.total ?? 0),
    referredUserCount,
  };
}
