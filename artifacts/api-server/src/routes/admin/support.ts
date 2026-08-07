import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db, supportTicketsTable, supportMessagesTable, usersTable } from "@workspace/db";
import {
  AdminAddTicketMessageBody,
  AdminAddTicketMessageParams,
  GetAdminTicketParams,
  ListAdminTicketsResponse,
  GetAdminTicketResponse,
  AdminAddTicketMessageResponse,
  UpdateTicketStatusBody,
  UpdateTicketStatusParams,
  UpdateTicketStatusResponse,
  ListAdminTicketsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../../lib/auth";
import { validateImage } from "../../lib/imageValidation";

const router: IRouter = Router();

/** Strip raw base64, expose hasAttachment flag. */
function withHasAttachment<T extends { attachmentData?: string | null }>(
  msg: T,
): Omit<T, "attachmentData"> & { hasAttachment: boolean } {
  const { attachmentData: _d, ...rest } = msg;
  return { ...rest, hasAttachment: Boolean(msg.attachmentData) };
}

// List all tickets (with optional status filter)
router.get(
  "/admin/support-tickets",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const query = ListAdminTicketsQueryParams.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: query.error.message });
      return;
    }

    const rows = await db
      .select({
        ticket: supportTicketsTable,
        userEmail: usersTable.email,
        messageCount: count(supportMessagesTable.id),
      })
      .from(supportTicketsTable)
      .leftJoin(supportMessagesTable, eq(supportMessagesTable.ticketId, supportTicketsTable.id))
      .innerJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
      .where(query.data.status ? eq(supportTicketsTable.status, query.data.status) : undefined)
      .groupBy(supportTicketsTable.id, usersTable.email)
      .orderBy(desc(supportTicketsTable.updatedAt));

    res.json(
      ListAdminTicketsResponse.parse(
        rows.map(({ ticket, userEmail, messageCount }) => ({
          ...ticket,
          userEmail,
          messageCount,
        })),
      ),
    );
  },
);

// Get ticket with messages
router.get(
  "/admin/support-tickets/:ticketId",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = GetAdminTicketParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [ticket] = await db
      .select({ ticket: supportTicketsTable, userEmail: usersTable.email })
      .from(supportTicketsTable)
      .innerJoin(usersTable, eq(supportTicketsTable.userId, usersTable.id))
      .where(eq(supportTicketsTable.id, params.data.ticketId));

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
      GetAdminTicketResponse.parse({
        ...ticket.ticket,
        userEmail: ticket.userEmail,
        messageCount: messages.length,
        messages: messages.map(({ msg, authorEmail, authorRole }) =>
          withHasAttachment({
            ...msg,
            authorEmail,
            isAdmin: authorRole === "admin",
          }),
        ),
      }),
    );
  },
);

// Admin reply
router.post(
  "/admin/support-tickets/:ticketId/messages",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const admin = req.appUser!;
    const params = AdminAddTicketMessageParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = AdminAddTicketMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // Validate optional attachment
    const { attachmentData, attachmentMimeType } = parsed.data;
    const hasAttachmentInput = attachmentData != null && attachmentMimeType != null;
    if (hasAttachmentInput) {
      const err = validateImage(attachmentMimeType!, attachmentData!);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
    }

    const [ticket] = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, params.data.ticketId));

    if (!ticket) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    const [msg] = await db.transaction(async (tx) => {
      const [newMsg] = await tx
        .insert(supportMessagesTable)
        .values({
          ticketId: ticket.id,
          authorId: admin.id,
          body: parsed.data.body,
          ...(hasAttachmentInput ? { attachmentData, attachmentMimeType } : {}),
        })
        .returning();

      await tx
        .update(supportTicketsTable)
        .set({ status: "answered", updatedAt: new Date() })
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
      AdminAddTicketMessageResponse.parse(
        withHasAttachment({
          ...withAuthor.msg,
          authorEmail: withAuthor.authorEmail,
          isAdmin: withAuthor.authorRole === "admin",
        }),
      ),
    );
  },
);

// Serve attachment image for a support message (admin)
router.get(
  "/admin/support-tickets/:ticketId/messages/:messageId/attachment",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const ticketId = Number(req.params.ticketId);
    const messageId = Number(req.params.messageId);

    if (!Number.isInteger(ticketId) || !Number.isInteger(messageId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [ticket] = await db
      .select({ id: supportTicketsTable.id })
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, ticketId))
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

    if (!msg || !msg.attachmentData) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    res.setHeader("Content-Type", msg.attachmentMimeType ?? "application/octet-stream");
    res.send(Buffer.from(msg.attachmentData, "base64"));
  },
);

// Update ticket status
router.patch(
  "/admin/support-tickets/:ticketId/status",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = UpdateTicketStatusParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const parsed = UpdateTicketStatusBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [updated] = await db
      .update(supportTicketsTable)
      .set({ status: parsed.data.status, updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, params.data.ticketId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Ticket not found" });
      return;
    }

    res.json(UpdateTicketStatusResponse.parse(updated));
  },
);

export default router;
