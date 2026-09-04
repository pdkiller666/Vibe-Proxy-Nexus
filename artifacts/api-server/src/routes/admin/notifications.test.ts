import { randomBytes } from "node:crypto";
import supertest from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, paymentsTable, usersTable } from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";
import { refundPaymentById } from "../../lib/confirmPayment";

const request = supertest(app);

describe("admin payment notifications", () => {
  let adminId: number;
  let userId: number;
  let paymentId: number;
  let adminCookie: string;

  beforeAll(async () => {
    const suffix = randomBytes(6).toString("hex");
    const adminEmail = `notifications-admin-${suffix}@example.com`;
    const password = "correct-horse-battery-staple";
    const passwordHash = await hashPassword(password);

    const [admin] = await db
      .insert(usersTable)
      .values({
        email: adminEmail,
        passwordHash,
        role: "admin",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    adminId = admin.id;

    const [user] = await db
      .insert(usersTable)
      .values({
        email: `notifications-user-${suffix}@example.com`,
        passwordHash,
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [payment] = await db
      .insert(paymentsTable)
      .values({
        userId,
        provider: "yoomoney",
        type: "subscription",
        amountRub: 700,
        status: "confirmed",
        confirmedAt: new Date(Date.now() - 60 * 60 * 1000),
        reference: `notification-${suffix}`,
      })
      .returning({ id: paymentsTable.id });
    paymentId = payment.id;

    const login = await request.post("/api/auth/login").send({ email: adminEmail, password });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
    if (!sessionCookie) throw new Error("Login did not set a session cookie");
    adminCookie = sessionCookie.split(";")[0];

    const refunded = await refundPaymentById(paymentId, "chargeback", "test notification");
    expect(refunded.ok).toBe(true);
  });

  afterAll(async () => {
    await db.delete(paymentsTable).where(eq(paymentsTable.id, paymentId));
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(usersTable).where(eq(usersTable.id, adminId));
  });

  it("returns a recent refund using refundedAt even when confirmedAt is old", async () => {
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const response = await request
      .get(`/api/admin/notifications?since=${encodeURIComponent(since)}`)
      .set("Cookie", adminCookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: paymentId,
          status: "refunded",
          provider: "yoomoney",
        }),
      ]),
    );
  });
});