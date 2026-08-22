const DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionExpiryCandidate = {
  status: string;
  billingType: string;
  endsAt: Date | null;
};

/**
 * A subscription ending at the current instant has already expired. Keep this
 * strict boundary shared by user enrichment and dashboard expiry reporting.
 */
export function hasSubscriptionNotEnded(
  endsAt: Date | null,
  now = new Date(),
): boolean {
  return endsAt === null || endsAt.getTime() > now.getTime();
}

/**
 * The canonical definition used by admin expiry reporting:
 * an active monthly subscription with a fixed end date in the half-open
 * (now, now + days] window.
 *
 * Keep this as a small, side-effect-free predicate so the boundary behaviour
 * can be regression-tested without depending on a running HTTP server.
 */
export function isActiveMonthlySubscriptionExpiringWithin(
  subscription: SubscriptionExpiryCandidate,
  days: number,
  now = new Date(),
): boolean {
  if (
    subscription.status !== "active" ||
    subscription.billingType !== "monthly" ||
    subscription.endsAt === null ||
    !hasSubscriptionNotEnded(subscription.endsAt, now)
  ) {
    return false;
  }

  const endsAt = subscription.endsAt.getTime();
  const nowMs = now.getTime();
  return endsAt <= nowMs + days * DAY_MS;
}