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
          // Count confirmed subscriptions (active/expired/cancelled) for this
          // plan+user pair. pending_payment and rejected rows don't count as a use.
          const [{ usedCount }] = await db
            .select({ usedCount: sql<number>`count(*)::int` })
            .from(subscriptionsTable)
            .where(
              and(
                eq(subscriptionsTable.userId, user.id),
                eq(subscriptionsTable.planId, promoPlan.id),
                inArray(subscriptionsTable.status, ["active", "expired", "cancelled"]),
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

  // Merge: public plans get userUsedCount=null, promo plan (if any) appended last.
  const allPlans = [
    ...publicPlans.map((p) => ({ ...p, userUsedCount: null })),
    ...(promoEntry ? [promoEntry] : []),
  ];

  res.json(ListPlansResponse.parse(allPlans));
});

export default router;
