import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { subscriptionsTable, vpnKeysTable } from "@workspace/db";
import { lockCurrentSubscription, type PgTx } from "./subscription";

/**
 * Banks current-period usage from still-active keys onto the user's current
 * subscription before those key rows are revoked.
 *
 * Call this inside the SAME transaction that stamps revokedAt, and acquire
 * locks in this order (subscription first, keys second). That matches traffic
 * enforcement/key issuance and makes retries idempotent: once another caller
 * revokes a key it no longer matches isNull(revokedAt), so its bytes cannot be
 * banked twice.
 *
 * Replacement flows that copy period counters directly to the replacement
 * key (currently admin node deletion) must NOT call this helper, or the same
 * bytes would be counted both on the replacement key and in carry-over.
 *
 * If there is no genuinely-current subscription, there is no current billing
 * period to preserve. Expiry/hourly-billing revocations therefore remain
 * period boundaries rather than leaking old usage into a later subscription.
 */
export async function bankActiveKeyUsageForRevocation(
  tx: PgTx,
  userId: number,
  keyIds?: number[],
): Promise<{ bankedBytes: number; keyIds: number[] }> {
  if (keyIds?.length === 0) return { bankedBytes: 0, keyIds: [] };

  const currentSubscription = await lockCurrentSubscription(tx, userId);

  const keys = await tx
    .select({
      id: vpnKeysTable.id,
      periodUpBytes: vpnKeysTable.periodUpBytes,
      periodDownBytes: vpnKeysTable.periodDownBytes,
    })
    .from(vpnKeysTable)
    .where(
      and(
        eq(vpnKeysTable.userId, userId),
        keyIds ? inArray(vpnKeysTable.id, keyIds) : undefined,
        isNull(vpnKeysTable.revokedAt),
      ),
    )
    .for("update");

  const bankedBytes = keys.reduce(
    (sum, key) => sum + key.periodUpBytes + key.periodDownBytes,
    0,
  );

  if (currentSubscription && bankedBytes > 0) {
    await tx
      .update(subscriptionsTable)
      .set({
        carriedOverPeriodBytes: sql`${subscriptionsTable.carriedOverPeriodBytes} + ${bankedBytes}`,
      })
      .where(eq(subscriptionsTable.id, currentSubscription.id));
  }

  return { bankedBytes, keyIds: keys.map((key) => key.id) };
}