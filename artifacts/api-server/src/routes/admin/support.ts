import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { db, supportTicketsTable, supportMessagesTable, usersTable } from "@workspace/db";
import {
  AddTicketMessageBody,
  AddTicketMessageParams,
  GetTicketParams,
  ListAdminTicketsResponse,
  GetTicketResponse,
  AddTicketMessageResponse,
  UpdateTicketStatusBody,
  UpdateTicketStatusParams,
  UpdateTicketStatusResponse,
  ListAdminTicketsQueryParams,
} from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../../lib/auth";

const router: IRouter = Router();

// List all tickets (with optional status filter)
router.get("/admin/support-tickets", requireAuth, requireAdmin, async (req, res): Promise<void> => {
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
});

// Get ticket with messages
router.get("/admin/support-tickets/:ticketId", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = GetTicketParams.safeParse(req.params);
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
    GetTicketResponse.parse({
      ...ticket.ticket,
      userEmail: ticket.userEmail,
      messageCount: messages.length,
      messages: messages.map(({ msg, authorEmail, authorRole }) => ({
        ...msg,
        authorEmail,
        isAdmin: authorRole === "admin",
      })),
    }),
  );
});

// Admin reply
router.post("/admin/support-tickets/:ticketId/messages", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const admin = req.appUser!;
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
      .values({ ticketId: ticket.id, authorId: admin.id, body: parsed.data.body })
      .returning();

    await tx
      .update(supportTicketsTable)
      .set({ status: "answered", updatedAt: new Date() })
      .where(eq(supportTicketsTable.id, ticket.id));

    return [newMsg];
  });

  const [withAuthor] = await db
    .select({ msg: supportMessagesTable, authorEmail: usersTable.email, authorRole: usersTable.role })
    .from(supportMessagesTable)
    .innerJoin(usersTable, eq(supportMessagesTable.authorId, usersTable.id))
    .where(eq(supportMessagesTable.id, msg.id));

  res.status(201).json(
    AddTicketMessageResponse.parse({
      ...withAuthor.msg,
      authorEmail: withAuthor.authorEmail,
      isAdmin: withAuthor.authorRole === "admin",
    }),
  );
});

// Update ticket status
router.patch("/admin/support-tickets/:ticketId/status", requireAuth, requireAdmin, async (req, res): Promise<void> => {
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
});

export default router;
