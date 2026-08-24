import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import { db, plansTable, subscriptionsTable, usersTable } from "@workspace/db";
import app from "../app";
import { hashPassword } from "../lib/password";

const request = supertest(app);
const createdUserIds: number[] = [];
let monthlyPlanId: number;
let hourlyPlanId: number;
const monthlyPlanPriceRub = 500;

async function createUser(balanceKopecks: number): Promise<{ id: number; cookie: string }> {
  const email = `auto-renew-route-${randomBytes(6).toString("hex")}@example.com`;
  const password = "correct-horse-battery-staple";
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: await hashPassword(password),
      referralCode: randomBytes(8).toString("hex"),
      balanceKopecks,
    })
    .returning({ id: usersTable.id });
  createdUserIds.push(user!.id);

  const login = await request.post("/api/auth/login").send({ email, password });
  expect(login.status).toBe(200);
  const cookies = Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"] : [login.headers["set-cookie"]];
  const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");

  return { id: user!.id, cookie: sessionCookie.split(";")[0] };
}

async function createActiveMonthlySubscription(userId: number) {
  await db.insert(subscriptionsTable).values({
    userId,
    planId: monthlyPlanId,
    status: "active",
    startsAt: new Date(),
    endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
}

beforeAll(async () => {
  const [plan] = await db
    .insert(plansTable)
    .values({
      name: `auto-renew-route-${randomBytes(4).toString("hex")}`,
      priceRub: monthlyPlanPriceRub,
      durationDays: 30,
    })
    .returning({ id: plansTable.id });
  monthlyPlanId = plan!.id;

  const [hourlyPlan] = await db
    .insert(plansTable)
    .values({
      name: `auto-renew-hourly-${randomBytes(4).toString("hex")}`,
      priceRub: 0,
      durationDays: 0,
      billingType: "hourly",
      hourlyRateKopecks: 100,
    })
    .returning({ id: plansTable.id });
  hourlyPlanId = hourlyPlan!.id;
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.userId, createdUserIds));
    await db.delete(usersTable).where(inArray(usersTable.id, createdUserIds));
  }
  await db.delete(plansTable).where(eq(plansTable.id, monthlyPlanId));
  await db.delete(plansTable).where(eq(plansTable.id, hourlyPlanId));
});

describe("PATCH /me/auto-renew", () => {
  it("rejects enabling auto-renew when the balance is below the current monthly plan price", async () => {
    const { id, cookie } = await createUser(monthlyPlanPriceRub * 100 - 1);
    await createActiveMonthlySubscription(id);

    const response = await request
      .patch("/api/me/auto-renew")
      .set("Cookie", cookie)
      .send({ enabled: true });

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({
      balanceKopecks: monthlyPlanPriceRub * 100 - 1,
      requiredKopecks: monthlyPlanPriceRub * 100,
    });

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    expect(user!.autoRenewFromBalance).toBe(false);
  });

  it("enables auto-renew when the balance covers the current monthly plan price", async () => {
    const { id, cookie } = await createUser(monthlyPlanPriceRub * 100);
    await createActiveMonthlySubscription(id);

    const response = await request
      .patch("/api/me/auto-renew")
      .set("Cookie", cookie)
      .send({ enabled: true });

    expect(response.status).toBe(200);
    expect(response.body.autoRenewFromBalance).toBe(true);
  });

  it("allows disabling auto-renew even after the balance falls below the price", async () => {
    const { id, cookie } = await createUser(0);
    await createActiveMonthlySubscription(id);
    await db.update(usersTable).set({ autoRenewFromBalance: true }).where(eq(usersTable.id, id));

    const response = await request
      .patch("/api/me/auto-renew")
      .set("Cookie", cookie)
      .send({ enabled: false });

    expect(response.status).toBe(200);
    expect(response.body.autoRenewFromBalance).toBe(false);
  });

  it("does not use an older monthly subscription when the current subscription is hourly", async () => {
    const { id, cookie } = await createUser(monthlyPlanPriceRub * 100);
    await db.insert(subscriptionsTable).values([
      {
        userId: id,
        planId: monthlyPlanId,
        status: "active",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
      {
        userId: id,
        planId: hourlyPlanId,
        status: "active",
        startsAt: new Date(),
        endsAt: null,
      },
    ]);

    const response = await request
      .patch("/api/me/auto-renew")
      .set("Cookie", cookie)
      .send({ enabled: true });

    expect(response.status).toBe(400);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    expect(user!.autoRenewFromBalance).toBe(false);
  });
});