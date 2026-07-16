import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";

// ── Screenshot validation ─────────────────────────────────────────────────────
// Reject uploads that don't look like real images before they ever reach the
// DB. Three independent checks are layered so that bypassing one still hits
// the others:
//   1. MIME allowlist  — client-declared type must be one we actually serve
//   2. Size limit      — base64 string capped at ~8 MB → ~6 MB decoded
//   3. Magic bytes     — first bytes of the decoded payload must match the
//                        declared type; client-controlled mimeType field cannot
//                        be used to disguise a non-image as an image
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BASE64_BYTES = 8 * 1024 * 1024; // 8 MB base64 ≈ 6 MB decoded

const MAGIC: Record<string, (buf: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) =>
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  "image/webp": (b) =>
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,  // WEBP
};

function validateScreenshot(mimeType: string, data: string): string | null {
  if (!ALLOWED_MIME_TYPES.has(mimeType))
    return `Недопустимый тип файла. Разрешены: ${[...ALLOWED_MIME_TYPES].join(", ")}`;
  if (data.length > MAX_BASE64_BYTES)
    return "Скриншот слишком большой (максимум 6 МБ)";
  let buf: Buffer;
  try {
    buf = Buffer.from(data, "base64");
  } catch {
    return "Некорректный base64";
  }
  const check = MAGIC[mimeType];
  if (check && !check(buf))
    return "Содержимое файла не соответствует указанному типу";
  return null; // valid
}
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
    })
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

  const validationError = validateScreenshot(parsed.data.mimeType, parsed.data.data);
  if (validationError) {
    res.status(400).json({ error: validationError });
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
