import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db, systemEventsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";

const request = supertest(app);
const broadcastId = randomUUID();
const inconsistentBroadcastId = randomUUID();
const password = "correct-horse-battery-staple";

type TestUser = {
  id: number;
  email: string;
  password: string;
};

async function createUser(role: "user" | "admin", name: string): Promise<TestUser> {
  const email = `broadcast-test-${role}-${randomBytes(6).toString("hex")}@example.com`;
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      name,
      passwordHash,
      role,
      referralCode: randomBytes(8).toString("hex"),
    })
    .returning({ id: usersTable.id, email: usersTable.email });

  return { ...user, password };
}

async function loginAndGetCookie(user: TestUser): Promise<string> {
  const response = await request.post("/api/auth/login").send({
    email: user.email,
    password: user.password,
  });
  expect(response.status).toBe(200);

  const cookies = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"]
    : [response.headers["set-cookie"]];
  const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  return sessionCookie.split(";")[0];
}

describe("admin broadcast history details", () => {
  let admin: TestUser;
  let regularUser: TestUser;
  let recipients: TestUser[];
  let adminCookie: string;
  let regularCookie: string;

  beforeAll(async () => {
    admin = await createUser("admin", "Broadcast Admin");
    regularUser = await createUser("user", "Regular User");
    recipients = await Promise.all([
      createUser("user", "Alice Recipient"),
      createUser("user", "Bob Recipient"),
      createUser("user", "Deleted Recipient"),
    ]);
    adminCookie = await loginAndGetCookie(admin);
    regularCookie = await loginAndGetCookie(regularUser);

    await db.insert(systemEventsTable).values(
      recipients.map((recipient) => ({
        eventType: "admin_message",
        userId: recipient.id,
        metadata: {
          broadcastId,
          title: "Длинный заголовок тестовой рассылки",
          message: "Первая строка\nВторая строка",
          targetType: "filtered",
          filters: { hasActiveSubscription: true },
        },
      })),
    );

    const canonicalSentAt = new Date("2026-08-19T10:00:00.000Z");
    await db.insert(systemEventsTable).values([
      {
        eventType: "admin_message",
        userId: recipients[0].id,
        createdAt: canonicalSentAt,
        metadata: {
          broadcastId: inconsistentBroadcastId,
          title: "Канонический заголовок",
          message: "Канонический текст",
          targetType: "all",
        },
      },
      {
        eventType: "admin_message",
        userId: recipients[1].id,
        createdAt: new Date("2026-08-19T10:01:00.000Z"),
        metadata: {
          broadcastId: inconsistentBroadcastId,
          title: "Несогласованный заголовок",
          message: "Несогласованный текст",
          targetType: "specific",
        },
      },
    ]);
  });

  afterAll(async () => {
    const existingUserIds = [admin.id, regularUser.id, ...recipients.map((recipient) => recipient.id)];
    await db.delete(systemEventsTable).where(inArray(systemEventsTable.userId, existingUserIds));
    await db.delete(usersTable).where(inArray(usersTable.id, existingUserIds));
  });

  it("rejects a regular user", async () => {
    const response = await request
      .get(`/api/admin/broadcasts/${broadcastId}`)
      .set("Cookie", regularCookie);

    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid IDs and fractional pagination values", async () => {
    const invalidId = await request
      .get("/api/admin/broadcasts/not-a-uuid")
      .set("Cookie", adminCookie);
    expect(invalidId.status).toBe(400);

    const detailFraction = await request
      .get(`/api/admin/broadcasts/${broadcastId}?recipientPage=1.5`)
      .set("Cookie", adminCookie);
    expect(detailFraction.status).toBe(400);

    const historyFraction = await request
      .get("/api/admin/broadcasts?pageSize=2.5")
      .set("Cookie", adminCookie);
    expect(historyFraction.status).toBe(400);
  });

  it("returns 404 for an unknown broadcast", async () => {
    const response = await request
      .get(`/api/admin/broadcasts/${randomUUID()}`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(404);
  });

  it("keeps recipient pages and filtered counts in agreement", async () => {
    const acknowledgedAt = new Date("2026-08-19T11:00:00.000Z");
    await db
      .update(systemEventsTable)
      .set({ acknowledgedAt })
      .where(eq(systemEventsTable.userId, recipients[0].id));

    const firstPage = await request
      .get(`/api/admin/broadcasts/${broadcastId}?recipientPage=1&recipientPageSize=1`)
      .set("Cookie", adminCookie);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body).toMatchObject({
      broadcastId,
      title: "Длинный заголовок тестовой рассылки",
      message: "Первая строка\nВторая строка",
      targetType: "filtered",
      recipientTotal: 3,
      recipientFilteredTotal: 3,
      recipientPage: 1,
      recipientPageSize: 1,
    });
    expect(firstPage.body.recipients).toHaveLength(1);

    const acknowledgedSearch = await request
      .get(`/api/admin/broadcasts/${broadcastId}?search=${encodeURIComponent(recipients[0].email)}`)
      .set("Cookie", adminCookie);
    expect(acknowledgedSearch.status).toBe(200);
    expect(acknowledgedSearch.body.recipients).toEqual([
      expect.objectContaining({
        userId: recipients[0].id,
        email: recipients[0].email,
        acknowledgedAt: acknowledgedAt.toISOString(),
      }),
    ]);

    const search = await request
      .get(`/api/admin/broadcasts/${broadcastId}?search=${encodeURIComponent(recipients[1].email)}`)
      .set("Cookie", adminCookie);

    expect(search.status).toBe(200);
    expect(search.body.recipientTotal).toBe(3);
    expect(search.body.recipientFilteredTotal).toBe(1);
    expect(search.body.recipients).toEqual([
      expect.objectContaining({
        userId: recipients[1].id,
        email: recipients[1].email,
        acknowledgedAt: null,
      }),
    ]);
  });

  it("uses one canonical earliest event for summary metadata", async () => {
    const response = await request
      .get(`/api/admin/broadcasts/${inconsistentBroadcastId}`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      broadcastId: inconsistentBroadcastId,
      title: "Канонический заголовок",
      message: "Канонический текст",
      targetType: "all",
      sentAt: "2026-08-19T10:00:00.000Z",
      recipientTotal: 2,
    });
  });

  it("excludes a deleted user from recipient history", async () => {
    const deletedRecipient = recipients[2];
    await db.delete(usersTable).where(eq(usersTable.id, deletedRecipient.id));

    const response = await request
      .get(`/api/admin/broadcasts/${broadcastId}`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(200);
    expect(response.body.recipientTotal).toBe(2);
    expect(response.body.recipients.map((recipient: { email: string }) => recipient.email))
      .not.toContain(deletedRecipient.email);
  });
});