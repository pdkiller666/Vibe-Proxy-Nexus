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
import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db, paymentsTable, subscriptionsTable, vpnKeysTable } from "@workspace/db";
import { logger } from "./logger";
import { isLocalXrayEnabled, removeXrayClient } from "./xray";

const SUBSCRIPTION_EXPIRY_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Pending subscriptions older than this are auto-cancelled. */
const PENDING_PAYMENT_EXPIRY_HOURS = 48;

/**
 * Flips overdue "active" subscriptions to "expired" and revokes VPN keys for
 * any user left with no other currently-active subscription. Safe to call
 * concurrently/repeatedly — every step is scoped by status so re-running it
 * (e.g. two overlapping intervals) is a no-op on already-settled rows.
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

  if (expired.length === 0) return 0;

  const affectedUserIds = [...new Set(expired.map((row) => row.userId))];

  for (const userId of affectedUserIds) {
    // A user can have more than one subscription row (e.g. an early renewal
    // purchased before the previous period ended). Only revoke keys once
    // none of their subscriptions are still active — otherwise we'd cut off
    // access covered by a different, still-valid row.
    const [stillActive] = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(and(eq(subscriptionsTable.userId, userId), eq(subscriptionsTable.status, "active")))
      .limit(1);

    if (stillActive) continue;

    const keysToRevoke = await db
      .select()
      .from(vpnKeysTable)
      .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)));

    if (keysToRevoke.length === 0) continue;

    for (const key of keysToRevoke) {
      if (isLocalXrayEnabled()) {
        try {
          await removeXrayClient(key.uuid);
        } catch (err) {
          logger.error(
            { err, uuid: key.uuid, userId },
            "Failed to remove client from local Xray during subscription expiry",
          );
        }
      }
    }

    await db
      .update(vpnKeysTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(vpnKeysTable.userId, userId), isNull(vpnKeysTable.revokedAt)));
  }

  return expired.length;
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
  const cutoff = new Date(Date.now() - PENDING_PAYMENT_EXPIRY_HOURS * 60 * 60 * 1000);

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
      .where(and(inArray(subscriptionsTable.id, staleIds), eq(subscriptionsTable.status, "pending_payment")));

    await tx
      .update(paymentsTable)
      .set({
        status: "rejected",
        rejectionReason: "Автоматическая отмена: оплата не поступила в течение 48 часов",
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
    .where(and(isNotNull(vpnKeysTable.revokedAt), gte(vpnKeysTable.revokedAt, since)));

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
          logger.info({ count }, "Expired overdue subscriptions and revoked their VPN keys");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Failed to expire overdue subscriptions");
      });

    cancelStalePendingSubscriptions()
      .then((count) => {
        if (count > 0) {
          logger.info({ count }, "Auto-cancelled stale pending subscriptions (48h timeout)");
        }
      })
      .catch((err) => {
        logger.error({ err }, "Failed to cancel stale pending subscriptions");
      });

    reconcileRevokedXrayClients().catch((err) => {
      logger.error({ err }, "Failed to reconcile revoked Xray clients");
    });
  };

  run();

  return setInterval(run, SUBSCRIPTION_EXPIRY_CHECK_INTERVAL_MS);
}
