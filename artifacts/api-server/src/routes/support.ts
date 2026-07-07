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

const router: IRouter = Router();

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
router.post("/support-tickets", requireAuth, async (req, res): Promise<void> => {
  const user = req.appUser!;
  const parsed = CreateSupportTicketBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const ticket = await db.transaction(async (tx) => {
    const [newTicket] = await tx
      .insert(supportTicketsTable)
      .values({ userId: user.id, subject: parsed.data.subject })
      .returning();

    await tx.insert(supportMessagesTable).values({
      ticketId: newTicket.id,
      authorId: user.id,
      body: parsed.data.body,
    });

    return newTicket;
  });

  res.status(201).json(CreateSupportTicketResponse.parse(ticket));
});

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
      messages: messages.map(({ msg, authorEmail, authorRole }) => ({
        ...msg,
        authorEmail,
        isAdmin: authorRole === "admin",
      })),
    }),
  );
});

// Add message to ticket
router.post("/support-tickets/:ticketId/messages", requireAuth, async (req, res): Promise<void> => {
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
      .values({ ticketId: ticket.id, authorId: user.id, body: parsed.data.body })
      .returning();

    await tx
      .update(supportTicketsTable)
      .set({ status: "open", updatedAt: new Date() })
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

export default router;
