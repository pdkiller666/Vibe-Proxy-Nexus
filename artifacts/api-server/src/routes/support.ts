import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db, supportTicketsTable, supportMessagesTable, usersTable } from "@workspace/db";
import {
  CreateSupportTicketBody,
  AddTicketMessageBody,
  AddTicketMessageParams,
  GetTicketParams,
  CreateSupportTicketResponse,
  ListMyTicketsResponse,
  GetTicketResponse,
  AddTicketMessageResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { createTicketRateLimit, addMessageRateLimit } from "../lib/rateLimit";
import { validateImage } from "../lib/imageValidation";

const router: IRouter = Router();

const MAX_ATTACHMENTS = 4;

/** Strip raw base64 array and expose the count — same pattern as payments.screenshotData. */
function withAttachmentCount<T extends { attachmentData?: string[] | null }>(
  msg: T,
): Omit<T, "attachmentData"> & { attachmentCount: number } {
  const { attachmentData: _d, ...rest } = msg;
  return { ...rest, attachmentCount: msg.attachmentData?.length ?? 0 };
}

/** Validate an array of attachments. Returns an error string or null. */
function validateAttachments(data: string[] | null | undefined, mimeTypes: string[] | null | undefined): string | null {
  if (!data || data.length === 0) return null;
  if (!mimeTypes || mimeTypes.length !== data.length) {
    return "attachmentData and attachmentMimeType must have the same length";
  }
  if (data.length > MAX_ATTACHMENTS) {
    return `Maximum ${MAX_ATTACHMENTS} attachments allowed`;
  }
  for (let i = 0; i < data.length; i++) {
    const err = validateImage(mimeTypes[i], data[i]);
    if (err) return `Attachment ${i + 1}: ${err}`;
  }
  return null;
}

// List my tickets
router.get("/support-tickets", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;

  const rows = await db
    .select({
      ticket: supportTicketsTable,
      userEmail: usersTable.email,
      messageCount: count(supportMessagesTable.id),
    })
    .from(supportTicketsTable)
    .leftJoin(supportMessagesTable, eq(supportMessagesTable.ticketId, supportTicketsTable.id))
    .innerJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
    .where(eq(supportTicketsTable.userId, user.id))
    .groupBy(supportTicketsTable.id, usersTable.email)
    .orderBy(desc(supportTicketsTable.updatedAt));

  res.json(
    ListMyTicketsResponse.parse(
      rows.map(({ ticket, userEmail, messageCount }) => ({
        ...ticket,
        userEmail,
        messageCount,
      })),
    ),
  );
});

// Create ticket (with first message)
router.post(
  "/support-tickets",
  requireAuth,
  createTicketRateLimit,
  async (req, res): Promise<void> => {
    const user = req.appUser!;
    const parsed = CreateSupportTicketBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { attachmentData, attachmentMimeType } = parsed.data;
    const err = validateAttachments(attachmentData, attachmentMimeType);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }

    const hasAttachments = attachmentData && attachmentData.length > 0;

    const ticket = await db.transaction(async (tx) => {
      const [newTicket] = await tx
        .insert(supportTicketsTable)
        .values({ userId: user.id, subject: parsed.data.subject })
        .returning();

      await tx.insert(supportMessagesTable).values({
        ticketId: newTicket.id,
        authorId: user.id,
        body: parsed.data.body,
        ...(hasAttachments ? { attachmentData, attachmentMimeType } : {}),
      });

      return newTicket;
    });

    res.status(201).json(CreateSupportTicketResponse.parse(ticket));
  },
);

// Get ticket with messages
router.get("/support-tickets/:ticketId", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const params = GetTicketParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [ticket] = await db
    .select({ ticket: supportTicketsTable, userEmail: usersTable.email })
    .from(supportTicketsTable)
    .innerJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
    .where(
      and(
        eq(supportTicketsTable.id, params.data.ticketId),
        eq(supportTicketsTable.userId, user.id),
      ),
    );

  if (!ticket) {
    res.status(404).json({ error: "Ticket not found" });
    return;
  }

  const messages = await db
    .select({
      msg: supportMessagesTable,
      authorEmail: usersTable.email,
      authorRole: usersTable.role,
    })
    .from(supportMessagesTable)
    .innerJoin(usersTable, eq(supportMessagesTable.authorId, usersTable.id))
    .where(eq(supportMessagesTable.ticketId, ticket.ticket.id))
    .orderBy(asc(supportMessagesTable.createdAt));

  res.json(
    GetTicketResponse.parse({
      ...ticket.ticket,
      userEmail: ticket.userEmail,
      messageCount: messages.length,
      messages: messages.map(({ msg, authorEmail, authorRole }) =>
        withAttachmentCount({
          ...msg,
          authorEmail,
          isAdmin: authorRole === "admin",
        }),
      ),
    }),
  );
});

// Add message to ticket
router.post(
  "/support-tickets/:ticketId/messages",
  requireAuth,
  addMessageRateLimit,
  async (req, res): Promise<void> => {
    const user = req.appUser!;
    const params = AddTicketMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = AddTicketMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const { attachmentData, attachmentMimeType } = parsed.data;
    const err = validateAttachments(attachmentData, attachmentMimeType);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }

    const hasAttachments = attachmentData && attachmentData.length > 0;

    const [ticket] = await db
      .select()
      .from(supportTicketsTable)
      .where(
        and(
          eq(supportTicketsTable.id, params.data.ticketId),
          eq(supportTicketsTable.userId, user.id),
        ),
      );

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    if (ticket.status === "closed") {
      res.status(409).json({ error: "Ticket is closed" });
      return;
    }

    const [msg] = await db.transaction(async (tx) => {
      const [newMsg] = await tx
        .insert(supportMessagesTable)
        .values({
          ticketId: ticket.id,
          authorId: user.id,
          body: parsed.data.body,
          ...(hasAttachments ? { attachmentData, attachmentMimeType } : {}),
        })
        .returning();

      await tx
        .update(supportTicketsTable)
        .set({ status: "open", updatedAt: new Date() })
        .where(eq(supportTicketsTable.id, ticket.id));

      return [newMsg];
    });

    const [withAuthor] = await db
      .select({
        msg: supportMessagesTable,
        authorEmail: usersTable.email,
        authorRole: usersTable.role,
      })
      .from(supportMessagesTable)
      .innerJoin(usersTable, eq(supportMessagesTable.authorId, usersTable.id))
      .where(eq(supportMessagesTable.id, msg.id));

    res.status(201).json(
      AddTicketMessageResponse.parse(
        withAttachmentCount({
          ...withAuthor.msg,
          authorEmail: withAuthor.authorEmail,
          isAdmin: withAuthor.authorRole === "admin",
        }),
      ),
    );
  },
);

// Serve one attachment by index for a support message
router.get(
  "/support-tickets/:ticketId/messages/:messageId/attachments/:index",
  requireAuth,
  async (req, res): Promise<void> => {
    const user = req.appUser!;
    const ticketId = Number(req.params.ticketId);
    const messageId = Number(req.params.messageId);
    const index = Number(req.params.index);

    if (!Number.isInteger(ticketId) || !Number.isInteger(messageId) || !Number.isInteger(index) || index < 0) {
      res.status(400).json({ error: "Invalid id or index" });
      return;
    }

    // Check ticket ownership
    const [ticket] = await db
      .select({ userId: supportTicketsTable.userId })
      .from(supportTicketsTable)
      .where(
        user.role === "admin"
          ? eq(supportTicketsTable.id, ticketId)
          : and(eq(supportTicketsTable.id, ticketId), eq(supportTicketsTable.userId, user.id)),
      )
      .limit(1);

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    const [msg] = await db
      .select({
        attachmentData: supportMessagesTable.attachmentData,
        attachmentMimeType: supportMessagesTable.attachmentMimeType,
      })
      .from(supportMessagesTable)
      .where(
        and(
          eq(supportMessagesTable.id, messageId),
          eq(supportMessagesTable.ticketId, ticketId),
        ),
      )
      .limit(1);

    if (!msg || !msg.attachmentData || index >= msg.attachmentData.length) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    res.setHeader("Content-Type", msg.attachmentMimeType?.[index] ?? "application/octet-stream");
    res.send(Buffer.from(msg.attachmentData[index], "base64"));
  },
);

export default router;
