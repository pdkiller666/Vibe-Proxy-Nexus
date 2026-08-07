/**
 * autoRenew.ts — opt-in automatic monthly renewal from wallet balance (ТЗ v2.1 §4.3).
 *
 * Runs every hour. For each active monthly subscription expiring within 24 h
 * where the user has autoRenewFromBalance=true and the feature flag is on:
 *   1. Guard: skip if the user already has a newer active subscription (already renewed).
 *   2. Call checkoutFromBalance → success: emit auto_renew_success system event.
 *      402 (not enough funds): emit auto_renew_failed (deduped per 24 h).
 *      Technical error (500): emit auto_renew_error admin event + retry next tick.
 *
 * The expiry job (subscriptionLifecycle.ts) is NOT modified — it handles normal
 * expiry as usual; autoRenew only fires BEFORE expiry.
 */

import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  subscriptionsTable,
  plansTable,
  usersTable,
  systemEventsTable,
  paymentSettingsTable,
} from "@workspace/db";
import { checkoutFromBalance } from "./balanceCheckout";
import { logger } from "./logger";

const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours before expiry
const AUTO_RENEW_INTERVAL_MS = 60 * 60 * 1000; // run every hour
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24 h dedup for user notifications

export async function runAutoRenew(): Promise<void> {
  // Check feature flag first — short-circuit the whole job if disabled
  const [settings] = await db.select({ balancePaymentsEnabled: paymentSettingsTable.balancePaymentsEnabled })
    .from(paymentSettingsTable).limit(1);
  if (!settings?.balancePaymentsEnabled) return;

  const now = new Date();
  const renewBefore = new Date(now.getTime() + RENEW_WINDOW_MS);

  // Find candidates: active monthly subscriptions expiring within 24 h,
  // where the user has opted in and is not banned.
  const candidates = await db
    .select({
      subscriptionId: subscriptionsTable.id,
      userId: subscriptionsTable.userId,
      endsAt: subscriptionsTable.endsAt,
      planId: subscriptionsTable.planId,
      planName: plansTable.name,
    })
    .from(subscriptionsTable)
    .innerJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
    .innerJoin(usersTable, eq(subscriptionsTable.userId, usersTable.id))
    .where(
      and(
        eq(subscriptionsTable.status, "active"),
        eq(plansTable.billingType, "monthly"),
        lt(subscriptionsTable.endsAt, renewBefore),
        gt(subscriptionsTable.endsAt, now),       // not yet expired
        eq(usersTable.autoRenewFromBalance, true),
        eq(usersTable.isBanned, false),
      ),
    );

  if (candidates.length === 0) return;

  logger.info({ count: candidates.length }, "autoRenew: processing candidates");

  for (const cand of candidates) {
    try {
      await processCandidate(cand, now);
    } catch (err) {
      logger.error({ err, userId: cand.userId, subscriptionId: cand.subscriptionId },
        "autoRenew: unexpected error processing candidate");
    }
  }
}

async function processCandidate(
  cand: { subscriptionId: number; userId: number; endsAt: Date | null; planId: number; planName: string },
  now: Date,
): Promise<void> {
  // Guard: skip if user already has another active subscription starting at/after endsAt
  // (means it was already renewed — manually or by a prior autoRenew tick)
  if (cand.endsAt) {
    const [alreadyRenewed] = await db
      .select({ id: subscriptionsTable.id })
      .from(subscriptionsTable)
      .where(
        and(
          eq(subscriptionsTable.userId, cand.userId),
          eq(subscriptionsTable.status, "active"),
          gt(subscriptionsTable.startsAt, now),
          // Exclude the current subscription itself
          // (startsAt > now is sufficient since current sub's startsAt ≤ now)
        ),
      )
      .limit(1);

    if (alreadyRenewed) {
      logger.info({ userId: cand.userId, subscriptionId: cand.subscriptionId },
        "autoRenew: already renewed — skipping");
      return;
    }
  }

  const result = await checkoutFromBalance(cand.userId, { kind: "subscription", planId: cand.planId });

  if (result.ok) {
    // Emit user-facing success notification
    await db.insert(systemEventsTable).values({
      userId: cand.userId,
      eventType: "auto_renew_success",
      metadata: {
        planName: cand.planName,
        amountRub: result.result.amountRub,
        newSubscriptionId: result.result.subscription?.id ?? null,
      },
    });
    logger.info({ userId: cand.userId, planId: cand.planId, amountRub: result.result.amountRub },
      "autoRenew: renewed successfully");
    return;
  }

  if (result.status === 402) {
    // Business failure (insufficient funds): notify user once per 24 h
    const alreadyNotified = await hasRecentEvent(cand.userId, "auto_renew_failed", DEDUP_WINDOW_MS);
    if (!alreadyNotified) {
      const [plan] = await db.select({ priceRub: plansTable.priceRub })
        .from(plansTable).where(eq(plansTable.id, cand.planId)).limit(1);
      await db.insert(systemEventsTable).values({
        userId: cand.userId,
        eventType: "auto_renew_failed",
        metadata: {
          planName: cand.planName,
          requiredRub: (plan?.priceRub ?? 0),
          balanceRub: Math.floor(result.balanceKopecks / 100),
        },
      });
    }
    logger.info({ userId: cand.userId, planId: cand.planId, balanceKopecks: result.balanceKopecks },
      "autoRenew: insufficient balance — expiry job will handle normally");
    return;
  }

  if (result.status === 409) {
    // Feature flag was disabled between the initial check and checkout — skip
    return;
  }

  // Technical error (500): emit admin event (deduped) + subscription stays for retry next tick
  const alreadyNotifiedAdmin = await hasRecentEvent(null, "auto_renew_error", DEDUP_WINDOW_MS, cand.userId);
  if (!alreadyNotifiedAdmin) {
    await db.insert(systemEventsTable).values({
      eventType: "auto_renew_error",
      metadata: { userId: cand.userId, planId: cand.planId, planName: cand.planName, error: result.error },
    });
  }
  logger.error({ userId: cand.userId, planId: cand.planId, error: result.error },
    "autoRenew: technical error — will retry next tick");
}

/** Check if a system_events row of the given type was inserted within windowMs for this userId. */
async function hasRecentEvent(
  userId: number | null,
  eventType: string,
  windowMs: number,
  metaUserId?: number,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMs);

  if (userId !== null) {
    // User-scoped events (auto_renew_failed)
    const [row] = await db
      .select({ id: systemEventsTable.id })
      .from(systemEventsTable)
      .where(
        and(
          eq(systemEventsTable.userId, userId),
          eq(systemEventsTable.eventType, eventType),
          gt(systemEventsTable.createdAt, since),
          isNull(systemEventsTable.acknowledgedAt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  // Admin-scoped events with userId stored in metadata (auto_renew_error).
  // Filter by metadata->>'userId' so each user gets their own dedup window,
  // not a shared one across all users.
  const [row] = await db
    .select({ id: systemEventsTable.id })
    .from(systemEventsTable)
    .where(
      and(
        eq(systemEventsTable.eventType, eventType),
        gt(systemEventsTable.createdAt, since),
        isNull(systemEventsTable.userId),
        isNull(systemEventsTable.acknowledgedAt),
        metaUserId !== undefined
          ? sql`(${systemEventsTable.metadata}->>'userId')::int = ${metaUserId}`
          : undefined,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export function startAutoRenewJob(): void {
  setInterval(() => {
    runAutoRenew().catch((err) =>
      logger.error({ err }, "autoRenew: unhandled error in job tick"),
    );
  }, AUTO_RENEW_INTERVAL_MS);

  // Also run shortly after startup to catch any subscriptions that expired
  // while the server was down
  setTimeout(() => {
    runAutoRenew().catch((err) =>
      logger.error({ err }, "autoRenew: startup run failed"),
    );
  }, 30_000);
}
