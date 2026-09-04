import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import { db, inviteLinksTable, usersTable } from "@workspace/db";
import app from "../app";

const request = supertest(app);
const password = "correct-horse-battery-staple";
const uid = () => randomBytes(8).toString("hex");

describe("invite link registration limits", () => {
  const createdUserIds: number[] = [];
  const createdInviteLinkIds: number[] = [];

  afterEach(async () => {
    if (createdInviteLinkIds.length > 0) {
      await db
        .delete(inviteLinksTable)
        .where(inArray(inviteLinksTable.id, createdInviteLinkIds.splice(0)));
    }
    if (createdUserIds.length > 0) {
      await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds.splice(0)));
    }
  });

  it("does not exceed maxUses when registrations race for the last slot", async () => {
    const suffix = uid();
    const referrerEmail = `invite-limit-referrer-${suffix}@example.com`;
    const inviteCode = `invite${suffix}`;
    const [referrer] = await db
      .insert(usersTable)
      .values({
        email: referrerEmail,
        passwordHash: "not-a-real-hash",
        referralCode: uid(),
      })
      .returning({ id: usersTable.id });
    createdUserIds.push(referrer!.id);

    const [inviteLink] = await db
      .insert(inviteLinksTable)
      .values({
        code: inviteCode,
        createdByUserId: referrer!.id,
        maxUses: 1,
      })
      .returning();
    createdInviteLinkIds.push(inviteLink!.id);

    const emails = [`invite-limit-first-${suffix}@example.com`, `invite-limit-second-${suffix}@example.com`];
    const responses = await Promise.all(
      emails.map((email) =>
        request.post("/api/auth/register").send({
          email,
          password,
          ref: inviteCode,
        }),
      ),
    );

    const registeredUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(inArray(usersTable.email, emails), eq(usersTable.inviteLinkId, inviteLink!.id)));
    createdUserIds.push(...registeredUsers.map((user) => user.id));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);

    const [updatedInviteLink] = await db
      .select({ usedCount: inviteLinksTable.usedCount })
      .from(inviteLinksTable)
      .where(eq(inviteLinksTable.id, inviteLink!.id));
    expect(updatedInviteLink?.usedCount).toBe(1);

    expect(registeredUsers).toHaveLength(1);
  });

  it("allows each available invite slot to be used by a different concurrent user", async () => {
    const suffix = uid();
    const referrerEmail = `invite-burst-referrer-${suffix}@example.com`;
    const inviteCode = `invite${suffix}`;
    const maxUses = 3;
    const emails = Array.from(
      { length: maxUses + 2 },
      (_, index) => `invite-burst-${index}-${suffix}@example.com`,
    );
    const [referrer] = await db
      .insert(usersTable)
      .values({
        email: referrerEmail,
        passwordHash: "not-a-real-hash",
        referralCode: uid(),
      })
      .returning({ id: usersTable.id });
    createdUserIds.push(referrer!.id);

    const [inviteLink] = await db
      .insert(inviteLinksTable)
      .values({
        code: inviteCode,
        createdByUserId: referrer!.id,
        maxUses,
      })
      .returning();
    createdInviteLinkIds.push(inviteLink!.id);

    const responses = await Promise.all(
      emails.map((email) =>
        request.post("/api/auth/register").send({
          email,
          password,
          ref: inviteCode,
        }),
      ),
    );

    const registeredUsers = await db
      .select({ id: usersTable.id, referralCode: usersTable.referralCode })
      .from(usersTable)
      .where(and(inArray(usersTable.email, emails), eq(usersTable.inviteLinkId, inviteLink!.id)));
    createdUserIds.push(...registeredUsers.map((user) => user.id));

    const successfulResponses = responses.filter((response) => response.status === 200);
    const rejectedResponses = responses.filter((response) => response.status === 400);
    expect(successfulResponses).toHaveLength(maxUses);
    expect(rejectedResponses).toHaveLength(emails.length - maxUses);
    expect(rejectedResponses.every((response) =>
      response.body.error === "Недействительная реферальная ссылка. Регистрация возможна только по приглашению.",
    )).toBe(true);

    const [updatedInviteLink] = await db
      .select({ usedCount: inviteLinksTable.usedCount })
      .from(inviteLinksTable)
      .where(eq(inviteLinksTable.id, inviteLink!.id));
    expect(updatedInviteLink?.usedCount).toBe(maxUses);

    const referralCodes = registeredUsers.map((user) => user.referralCode);
    expect(referralCodes.every((code) => code.length > 0)).toBe(true);
    expect(new Set(referralCodes).size).toBe(maxUses);
    expect(registeredUsers).toHaveLength(maxUses);
  });

  it("does not consume an extra invite slot when the same email registers concurrently", async () => {
    const suffix = uid();
    const referrerEmail = `invite-duplicate-referrer-${suffix}@example.com`;
    const inviteCode = `invite${suffix}`;
    const email = `invite-duplicate-${suffix}@example.com`;
    const [referrer] = await db
      .insert(usersTable)
      .values({
        email: referrerEmail,
        passwordHash: "not-a-real-hash",
        referralCode: uid(),
      })
      .returning({ id: usersTable.id });
    createdUserIds.push(referrer!.id);

    const [inviteLink] = await db
      .insert(inviteLinksTable)
      .values({
        code: inviteCode,
        createdByUserId: referrer!.id,
        maxUses: 2,
      })
      .returning();
    createdInviteLinkIds.push(inviteLink!.id);

    const responses = await Promise.all(
      [1, 2].map(() =>
        request.post("/api/auth/register").send({
          email,
          password,
          ref: inviteCode,
        }),
      ),
    );

    const registeredUsers = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.email, email), eq(usersTable.inviteLinkId, inviteLink!.id)));
    createdUserIds.push(...registeredUsers.map((user) => user.id));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const [updatedInviteLink] = await db
      .select({ usedCount: inviteLinksTable.usedCount })
      .from(inviteLinksTable)
      .where(eq(inviteLinksTable.id, inviteLink!.id));
    expect(updatedInviteLink?.usedCount).toBe(1);

    expect(registeredUsers).toHaveLength(1);
  });
});