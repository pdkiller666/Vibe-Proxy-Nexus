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

router.get("/payments/me", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const payments = await db
    .select()
    .from(paymentsTable)
    .where(eq(paymentsTable.userId, user.id))
    .orderBy(desc(paymentsTable.createdAt));

  res.json(ListMyPaymentsResponse.parse(payments));
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

  res.json(UpdatePaymentNoteResponse.parse(payment));
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
    .set({ screenshotUrl: parsed.data.screenshotUrl })
    .where(and(eq(paymentsTable.id, params.data.paymentId), eq(paymentsTable.userId, user.id)))
    .returning();

  if (!payment) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  res.json(UpdatePaymentScreenshotResponse.parse(payment));
});

export default router;
