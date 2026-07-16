import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  paymentsTable,
  plansTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import {
  ConfirmPaymentParams,
  ConfirmPaymentResponse,
  ListAdminPaymentsQueryParams,
  ListAdminPaymentsResponse,
  RejectPaymentBody,
  RejectPaymentParams,
  RejectPaymentResponse,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { confirmPaymentById } from "../../lib/confirmPayment";

const router: IRouter = Router();

function withHasScreenshot<
  T extends {
    screenshotData: string | null;
    screenshotMimeType: string | null;
  },
>(payment: T) {
  const {
    screenshotData,
    screenshotMimeType: _screenshotMimeType,
    ...rest
  } = payment;
  return { ...rest, hasScreenshot: Boolean(screenshotData) };
}

router.get(
  "/admin/payments",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const query = ListAdminPaymentsQueryParams.safeParse(req.query);

    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }

    const rows = await db
      .select({
        id: paymentsTable.id,
        subscriptionId: paymentsTable.subscriptionId,
        userId: paymentsTable.userId,
        type: paymentsTable.type,
        provider: paymentsTable.provider,
        amountRub: paymentsTable.amountRub,
        status: paymentsTable.status,
        reference: paymentsTable.reference,
        userNote: paymentsTable.userNote,
        rejectionReason: paymentsTable.rejectionReason,
        createdAt: paymentsTable.createdAt,
        confirmedAt: paymentsTable.confirmedAt,
        hasScreenshot: sql<boolean>`(${paymentsTable.screenshotData} IS NOT NULL)`,
        userEmail: usersTable.email,
        planName: plansTable.name,
      })
      .from(paymentsTable)
      .innerJoin(usersTable, eq(paymentsTable.userId, usersTable.id))
      .leftJoin(
        subscriptionsTable,
        eq(paymentsTable.subscriptionId, subscriptionsTable.id),
      )
      .leftJoin(plansTable, eq(subscriptionsTable.planId, plansTable.id))
      .where(
        query.data.status
          ? eq(paymentsTable.status, query.data.status)
          : undefined,
      )
      .orderBy(desc(paymentsTable.createdAt));

    res.json(
      ListAdminPaymentsResponse.parse(
        rows.map(({ planName, ...rest }) => ({
          ...rest,
          planName: planName ?? null,
        })),
      ),
    );
  },
);

router.post(
  "/admin/payments/:paymentId/confirm",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = ConfirmPaymentParams.safeParse(req.params);

    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    // Delegate to the shared confirmation library — single source of truth for
    // all payment types (subscription activation, extra slot/traffic, balance
    // top-up) and their referral commissions, period counter resets, and key
    // issuance guarantees. No logic is duplicated here.
    const result = await confirmPaymentById(params.data.paymentId);

    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    res.json(ConfirmPaymentResponse.parse(withHasScreenshot(result.payment)));
  },
);

router.post(
  "/admin/payments/:paymentId/reject",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = RejectPaymentParams.safeParse(req.params);

    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = RejectPaymentBody.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [payment] = await db
      .select()
      .from(paymentsTable)
      .where(eq(paymentsTable.id, params.data.paymentId));

    if (!payment) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }

    if (payment.status !== "pending") {
      res.status(409).json({ error: "Payment is not pending" });
      return;
    }

    let updatedPayment;
    try {
      updatedPayment = await db.transaction(async (tx) => {
        // Only update subscription status if this is a subscription payment
        if (payment.type === "subscription" && payment.subscriptionId) {
          await tx
            .update(subscriptionsTable)
            .set({ status: "rejected" })
            .where(
              and(
                eq(subscriptionsTable.id, payment.subscriptionId),
                eq(subscriptionsTable.status, "pending_payment"),
              ),
            );
        }

        const [updatedPay] = await tx
          .update(paymentsTable)
          .set({ status: "rejected", rejectionReason: parsed.data.reason })
          .where(
            and(
              eq(paymentsTable.id, payment.id),
              eq(paymentsTable.status, "pending"),
            ),
          )
          .returning();

        if (!updatedPay) {
          throw new Error("Payment state changed concurrently");
        }

        return updatedPay;
      });
    } catch {
      res
        .status(409)
        .json({
          error:
            "Payment or subscription state changed concurrently, please retry",
        });
      return;
    }

    res.json(RejectPaymentResponse.parse(withHasScreenshot(updatedPayment)));
  },
);

export default router;
