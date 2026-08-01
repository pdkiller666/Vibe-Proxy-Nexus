import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, inviteLinksTable, plansTable, subscriptionsTable } from "@workspace/db";
import { ListPlansResponse } from "@workspace/api-zod";
import { getSessionTokenFromRequest, getUserBySessionToken } from "../lib/session";

const router: IRouter = Router();

router.get("/plans", async (req, res): Promise<void> => {
  // Non-promo plans are always public — fetch them unconditionally.
  const publicPlans = await db
    .select()
    .from(plansTable)
    .where(eq(plansTable.isPromo, false))
    .orderBy(asc(plansTable.priceRub));

  // Attempt optional authentication to check whether the user has a promo-plan
  // entitlement via their invite link. No auth cookie = only public plans.
  let promoEntry: (typeof plansTable.$inferSelect & { userUsedCount: number }) | null = null;

  const token = getSessionTokenFromRequest(req);
  if (token) {
    const user = await getUserBySessionToken(token);
    if (user && !user.isBanned && user.inviteLinkId) {
      // Resolve the promo plan attached to the user's invite link.
      const [inviteLink] = await db
        .select({ planId: inviteLinksTable.planId })
        .from(inviteLinksTable)
        .where(eq(inviteLinksTable.id, user.inviteLinkId))
        .limit(1);

      if (inviteLink?.planId) {
        const [promoPlan] = await db
          .select()
          .from(plansTable)
          .where(
            and(
              eq(plansTable.id, inviteLink.planId),
              eq(plansTable.isPromo, true),
              eq(plansTable.isActive, true),
            ),
          )
          .limit(1);

        if (promoPlan) {
          // A "use" = a subscription the user actually paid for and activated.
          // Only "active" (currently running) and "expired" (completed period) count.
          // "cancelled" and "rejected" mean the payment attempt failed or was
          // abandoned — the promo plan must remain visible so the user can retry.
          // "pending_payment" (checkout in progress) is also excluded intentionally.
          const [{ usedCount }] = await db
            .select({ usedCount: sql<number>`count(*)::int` })
            .from(subscriptionsTable)
            .where(
              and(
                eq(subscriptionsTable.userId, user.id),
                eq(subscriptionsTable.planId, promoPlan.id),
                inArray(subscriptionsTable.status, ["active", "expired"]),
              ),
            );

          const maxUses = promoPlan.maxUses;
          const eligible = maxUses === null || usedCount < maxUses;
          if (eligible) {
            promoEntry = { ...promoPlan, userUsedCount: usedCount };
          }
        }
      }
    }
  }

  // Promo plan (if any) goes FIRST so the user sees it immediately at the start
  // of the carousel — not buried at the end after all public plans.
  const allPlans = [
    ...(promoEntry ? [promoEntry] : []),
    ...publicPlans.map((p) => ({ ...p, userUsedCount: null })),
  ];

  res.json(ListPlansResponse.parse(allPlans));
});

export default router;
