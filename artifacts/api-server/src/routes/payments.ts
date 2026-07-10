import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";
import {
  ListMyPaymentsResponse,
  UpdatePaymentNoteBody,
  UpdatePaymentNoteParams,
  UpdatePaymentNoteResponse,
  UpdatePaymentScreenshotBody,
  UpdatePaymentScreenshotParams,
  UpdatePaymentScreenshotResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

function withHasScreenshot<T extends { screenshotData: string | null }>(payment: T) {
  const { screenshotData: _screenshotData, ...rest } = payment;
  return { ...rest, hasScreenshot: Boolean(payment.screenshotData) };
}

router.get("/payments/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const payments = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.userId, user.id))
    .orderBy(desc(paymentsTable.createdAt));

  res.json(ListMyPaymentsResponse.parse(payments.map(withHasScreenshot)));
});

router.patch("/payments/:paymentId/note", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const params = UpdatePaymentNoteParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePaymentNoteBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [payment] = await db
    .update(paymentsTable)
    .set({ userNote: parsed.data.userNote })
    .where(and(eq(paymentsTable.id, params.data.paymentId), eq(paymentsTable.userId, user.id)))
    .returning();

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  res.json(UpdatePaymentNoteResponse.parse(withHasScreenshot(payment)));
});

router.patch("/payments/:paymentId/screenshot", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const params = UpdatePaymentScreenshotParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdatePaymentScreenshotBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [payment] = await db
    .update(paymentsTable)
    .set({ screenshotData: parsed.data.data, screenshotMimeType: parsed.data.mimeType })
    .where(and(eq(paymentsTable.id, params.data.paymentId), eq(paymentsTable.userId, user.id)))
    .returning();

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  res.json(UpdatePaymentScreenshotResponse.parse(withHasScreenshot(payment)));
});

router.get("/payments/:paymentId/screenshot/image", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const paymentId = Number(req.params.paymentId);

  if (!Number.isInteger(paymentId)) {
    res.status(400).json({ error: "Invalid payment id" });
    return;
  }

  const [payment] = await db
    .select({
      userId: paymentsTable.userId,
      screenshotData: paymentsTable.screenshotData,
      screenshotMimeType: paymentsTable.screenshotMimeType,
    })
    .from(paymentsTable)
    .where(
      user.role === "admin"
        ? eq(paymentsTable.id, paymentId)
        : and(eq(paymentsTable.id, paymentId), eq(paymentsTable.userId, user.id)),
    )
    .limit(1);

  if (!payment || !payment.screenshotData) {
    res.status(404).json({ error: "Screenshot not found" });
    return;
  }

  res.setHeader("Content-Type", payment.screenshotMimeType ?? "application/octet-stream");
  res.send(Buffer.from(payment.screenshotData, "base64"));
});

export default router;
