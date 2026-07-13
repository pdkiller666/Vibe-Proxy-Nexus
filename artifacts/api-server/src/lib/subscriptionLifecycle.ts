/**
 * Background job that closes the biggest gap in the manual-payment billing
 * model: nothing else in the codebase ever transitions a subscription from
 * "active" to "expired" once its `endsAt` passes, and nothing revokes the
 * VPN keys issued under it. Without this job, a single confirmed payment
 * grants permanent access regardless of the plan's duration.
 *
 * Runs periodically (and once at startup) rather than exactly at each
 * subscription's expiry instant — a `pending_payment`/`active` VPN service
 * doesn't need second-precision cutoff, and periodic sweeps are simpler and
 * more resilient to restarts than per-subscription timers.
 */
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
} from "drizzle-orm";
import {
  db,
  paymentsTable,
  subscriptionsTable,
  vpnKeysTable,
} from "@workspace/db";
import { logger } from "./logger";
import { isLocalXrayEnabled, removeXrayClient } from "./xray";

const SUBSCRIPTION_EXPIRY_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Pending subscriptions older than this are auto-cancelled. */
const PENDING_PAYMENT_EXPIRY_HOURS = 48;

/**
 * How long a user keeps VPN access after their last subscription's `endsAt`
 * passes, before their keys are actually revoked. Manual SBP payments aren't
 * confirmed instantly — an admin has to see the transfer and click confirm —
 * so revoking access the moment a subscription lapses turned a normal
 * renewal into a race: if the admin hadn't confirmed yet when this sweep
 * ran, the user's key was cut, and confirming the payment afterwards never
 * restored it (see ensureActiveKeyForUser in keyIssuance.ts, which now
 * covers that gap too). This grace period exists to make that race rare in
 * the first place, not just recoverable after the fact.
 */
const KEY_REVOKE_GRACE_PERIOD_HOURS = 24;

/**
 * Flips overdue "active" subscriptions to "expired". Safe to call
 * concurrently/repeatedly — scoped by status so re-running it (e.g. two
 * overlapping intervals) is a no-op on already-settled rows.
 *
 * Deliberately does NOT touch VPN keys — see revokeKeysPastGracePeriod for
 * that, which runs as a separate, later-triggering sweep.
 */
export async function expireOverdueSubscriptions(): Promise<number> {
  const now = new Date();

  const expired = await db
    .update(subscriptionsTable)
    .set({ status: "expired" })
    .where(
      and(
        eq(subscriptionsTable.status, "active"),
        isNotNull(subscriptionsTable.endsAt),
        lt(subscriptionsTable.endsAt, now),
      ),
    )
    .returning({ userId: subscriptionsTable.userId });

  return expired.length;
}

/**
 * Revokes VPN keys for users who have had no active subscription for longer
 * than KEY_REVOKE_GRACE_PERIOD_HOURS. Runs independently of
 * expireOverdueSubscriptions so it also catches users who lapsed on an
 * earlier run and are only now past the grace period — not just ones that
 * expired in this exact tick.
 *
 * Safe to call concurrently/repeatedly: every write is scoped by
 * `revokedAt is null`, so re-running it is a no-op on already-revoked keys.
 */
export async function revokeKeysPastGracePeriod(): Promise<number> {
  const now = new Date();
  const cutoff = new Date(
    now.getTime() - KEY_REVOKE_GRACE_PERIOD_HOURS * 60 * 60 * 1000,
  );

  const candidateUsers = await db
    .selectDistinct({ userId: vpnKeysTable.userId })
    .from(vpnKeysTable)
    .where(isNull(vpnKeysTable.revokedAt));

  let revokedCount = 0;

  for (const { userId } of candidateUsers) {
    // A user can have more than one subscription row (e.g. an early renewal
    // purchased before the previous period ended, or a payment the admin
    // just confirmed). Skip anyone who currently has an active row — their
    // access is still valid regardless of grace-period math below.
    const [stillActive] = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.userId, userId),
          eq(subscriptionsTable.status, "active"),
        ),
      )
      .limit(1);

    if (stillActive) continue;

    // Grace period is measured from the most recent subscription that ever
    // had a known end date. If the user has none (e.g. keys exist but they
    // never had a dated subscription — shouldn't normally happen), we have
    // no basis to start a clock, so leave their key alone rather than guess.
    const [latest] = await db
      .select({ endsAt: subscriptionsTable.endsAt })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.userId, userId),
          isNotNull(subscriptionsTable.endsAt),
        ),
      )
      .orderBy(desc(subscriptionsTable.endsAt))
      .limit(1);

    if (!latest?.endsAt || latest.endsAt >= cutoff) continue;

    const keysToRevoke = await db
      .select()
      .from(vpnKeysTable)
      .where(
        and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)),
      );

    if (keysToRevoke.length === 0) continue;

    for (const key of keysToRevoke) {
      if (isLocalXrayEnabled()) {
        try {
          await removeXrayClient(key.uuid);
        } catch (err) {
          logger.error(
            { err, uuid: key.uuid, userId },
            "Failed to remove client from local Xray during grace-period key revocation",
          );
        }
      }
    }

    await db
      .update(vpnKeysTable)
      .set({ revokedAt: now })
      .where(
        and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)),
      );

    revokedCount += keysToRevoke.length;
  }

  return revokedCount;
}

/**
 * Cancels pending_payment subscriptions and their associated payments that
 * have been waiting longer than PENDING_PAYMENT_EXPIRY_HOURS. This prevents
 * stale rows accumulating in the admin queue indefinitely.
 *
 * Safe to call concurrently — the WHERE clause on `status = 'pending_payment'`
 * means already-cancelled rows are untouched.
 */
export async function cancelStalePendingSubscriptions(): Promise<number> {
  const cutoff = new Date(
    Date.now() - PENDING_PAYMENT_EXPIRY_HOURS * 60 * 60 * 1000,
  );

  const stale = await db
    .select({ id: subscriptionsTable.id })
    .from(subscriptionsTable)
    .where(
      and(
        eq(subscriptionsTable.status, "pending_payment"),
        lt(subscriptionsTable.createdAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;

  const staleIds = stale.map((s) => s.id);

  await db.transaction(async (tx) => {
    await tx
      .update(subscriptionsTable)
      .set({ status: "cancelled" })
      .where(
        and(
          inArray(subscriptionsTable.id, staleIds),
          eq(subscriptionsTable.status, "pending_payment"),
        ),
      );

    await tx
      .update(paymentsTable)
      .set({
        status: "rejected",
        rejectionReason:
          "Автоматическая отмена: оплата не поступила в течение 48 часов",
      })
      .where(
        and(
          inArray(paymentsTable.subscriptionId, staleIds),
          eq(paymentsTable.status, "pending"),
        ),
      );
  });

  return staleIds.length;
}

/**
 * Cancels extra_device_slot payments that have been pending longer than
 * PENDING_PAYMENT_EXPIRY_HOURS. These payments have subscriptionId = null
 * so they are not covered by cancelStalePendingSubscriptions.
 *
 * Without this, a user with a forgotten/abandoned slot order is permanently
 * blocked by the "one pending slot order at a time" guard (409) and can
 * never buy a new slot.
 */
export async function cancelStaleExtraSlotPayments(): Promise<number> {
  const cutoff = new Date(
    Date.now() - PENDING_PAYMENT_EXPIRY_HOURS * 60 * 60 * 1000,
  );

  const result = await db
    .update(paymentsTable)
    .set({
      status: "rejected",
      rejectionReason:
        "Автоматическая отмена: оплата не поступила в течение 48 часов",
    })
    .where(
      and(
        eq(paymentsTable.type, "extra_device_slot"),
        eq(paymentsTable.status, "pending"),
        lt(paymentsTable.createdAt, cutoff),
      ),
    )
    .returning({ id: paymentsTable.id });

  return result.length;
}

/**
 * Reconciliation pass: for any VPN key revoked within the last 24 hours,
 * attempt to remove the client from Xray again. This handles the edge case
 * where Xray was temporarily unavailable during the expiry run — the DB row
 * was marked revoked but the Xray process still had the client active.
 *
 * `removeXrayClient` is called idempotently: if the client is already gone,
 * the error is silently ignored (expected behaviour).
 */
export async function reconcileRevokedXrayClients(): Promise<void> {
  if (!isLocalXrayEnabled()) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentlyRevoked = await db
    .select({ uuid: vpnKeysTable.uuid, userId: vpnKeysTable.userId })
    .from(vpnKeysTable)
    .where(
      and(
        isNotNull(vpnKeysTable.revokedAt),
        gte(vpnKeysTable.revokedAt, since),
      ),
    );

  for (const key of recentlyRevoked) {
    try {
      await removeXrayClient(key.uuid);
    } catch {
      // Expected when the client is already absent — silently ignored.
    }
  }
}

export function startSubscriptionExpiryJob(): NodeJS.Timeout {
  const run = () => {
    expireOverdueSubscriptions()
      .then((count) => {
        if (count > 0) {
          logger.info({ count }, "Expired overdue subscriptions");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Failed to expire overdue subscriptions");
      });

    revokeKeysPastGracePeriod()
      .then((count) => {
        if (count > 0) {
          logger.info(
            { count, graceHours: KEY_REVOKE_GRACE_PERIOD_HOURS },
            "Revoked VPN keys past grace period",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "Failed to revoke keys past grace period");
      });

    cancelStalePendingSubscriptions()
      .then((count) => {
        if (count > 0) {
          logger.info(
            { count },
            "Auto-cancelled stale pending subscriptions (48h timeout)",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "Failed to cancel stale pending subscriptions");
      });

    cancelStaleExtraSlotPayments()
      .then((count) => {
        if (count > 0) {
          logger.info(
            { count },
            "Auto-cancelled stale extra device slot payments (48h timeout)",
          );
        }
      })
      .catch((err) => {
        logger.error(
          { err },
          "Failed to cancel stale extra device slot payments",
        );
      });

    reconcileRevokedXrayClients().catch((err) => {
      logger.error({ err }, "Failed to reconcile revoked Xray clients");
    });
  };

  run();

  return setInterval(run, SUBSCRIPTION_EXPIRY_CHECK_INTERVAL_MS);
}
