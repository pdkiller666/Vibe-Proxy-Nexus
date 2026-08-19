import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import {
  db,
  plansTable,
  subscriptionsTable,
  systemEventsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { hashPassword } from "../lib/password";
import { buildSubscriptionToken } from "../lib/subscription";
import { expireOverdueSubscriptions } from "../lib/subscriptionLifecycle";

const request = supertest(app);
const password = "correct-horse-battery-staple";

type TestUser = {
  id: number;
  email: string;
  cookie: string;
};

async function createUser(prefix: string): Promise<TestUser> {
  const email = `${prefix}-${randomBytes(6).toString("hex")}@example.com`;
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
      referralCode: randomBytes(8).toString("hex"),
    })
    .returning({ id: usersTable.id });

  const login = await request.post("/api/auth/login").send({ email, password });
  expect(login.status).toBe(200);
  const cookies = Array.isArray(login.headers["set-cookie"])
    ? login.headers["set-cookie"]
    : [login.headers["set-cookie"]];
  const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");

  return { id: user.id, email, cookie: sessionCookie.split(";")[0] };
}

function decodeAnnounce(value: string | undefined): string {
  if (!value?.startsWith("base64:")) throw new Error("Missing Announce header");
  return Buffer.from(value.slice("base64:".length), "base64").toString("utf8");
}

describe("expired subscription API and Happ behavior", () => {
  let expiredUser: TestUser;
  let activeUser: TestUser;
  let neverSubscribedUser: TestUser;
  let otherUser: TestUser;
  let hourlyUser: TestUser;
  let planId: number;
  let hourlyPlanId: number;
  let expiredSubscriptionId: number;

  beforeAll(async () => {
    const [plan, hourlyPlan] = await db
      .insert(plansTable)
      .values([
        {
          name: `Expiry API plan ${randomBytes(4).toString("hex")}`,
          priceRub: 500,
          durationDays: 30,
        },
        {
          name: `Expiry hourly plan ${randomBytes(4).toString("hex")}`,
          priceRub: 0,
          durationDays: 0,
          billingType: "hourly",
          hourlyRateKopecks: 100,
        },
      ])
      .returning({ id: plansTable.id });
    planId = plan.id;
    hourlyPlanId = hourlyPlan.id;

    [expiredUser, activeUser, neverSubscribedUser, otherUser, hourlyUser] = await Promise.all([
      createUser("expiry-api-expired"),
      createUser("expiry-api-active"),
      createUser("expiry-api-none"),
      createUser("expiry-api-other"),
      createUser("expiry-api-hourly"),
    ]);

    const [expiredSubscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: expiredUser.id,
        planId,
        status: "active",
        isTrial: true,
        startsAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() - 60 * 60 * 1000),
      })
      .returning({ id: subscriptionsTable.id });
    expiredSubscriptionId = expiredSubscription.id;

    await db.insert(subscriptionsTable).values({
      userId: activeUser.id,
      planId,
      status: "active",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    await db.insert(subscriptionsTable).values({
      userId: hourlyUser.id,
      planId: hourlyPlanId,
      status: "active",
      startsAt: new Date(),
      endsAt: null,
    });
  });

  afterAll(async () => {
    const userIds = [expiredUser.id, activeUser.id, neverSubscribedUser.id, otherUser.id, hourlyUser.id];
    await db.delete(systemEventsTable).where(inArray(systemEventsTable.userId, userIds));
    await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.userId, userIds));
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
    await db.delete(plansTable).where(inArray(plansTable.id, [planId, hourlyPlanId]));
  });

  it("distinguishes expired, active, and never-subscribed users before the expiry sweep runs", async () => {
    const [expired, active, none] = await Promise.all([
      request.get("/api/me").set("Cookie", expiredUser.cookie),
      request.get("/api/me").set("Cookie", activeUser.cookie),
      request.get("/api/me").set("Cookie", neverSubscribedUser.cookie),
    ]);

    expect(expired.status).toBe(200);
    expect(expired.body).toMatchObject({
      hasActiveSubscription: false,
      subscriptionState: "expired",
      expiredSubscription: {
        id: expiredSubscriptionId,
        planName: expect.stringMatching(/^Expiry API plan /),
        billingType: "monthly",
        isTrial: true,
        endsAt: expect.any(String),
      },
    });

    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({
      hasActiveSubscription: true,
      subscriptionState: "active",
      expiredSubscription: null,
    });

    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({
      hasActiveSubscription: false,
      subscriptionState: "none",
      expiredSubscription: null,
    });
  });

  it("emits an owner-scoped event and announces expiry to Happ without serving keys", async () => {
    await expireOverdueSubscriptions();

    const ownerNotifications = await request
      .get("/api/notifications")
      .set("Cookie", expiredUser.cookie);
    expect(ownerNotifications.status).toBe(200);
    const expiryEvent = ownerNotifications.body.find(
      (event: { eventType: string }) => event.eventType === "subscription_expired",
    );
    expect(expiryEvent).toMatchObject({
      eventType: "subscription_expired",
      metadata: expect.objectContaining({ subscriptionId: expiredSubscriptionId }),
    });

    const otherNotifications = await request
      .get("/api/notifications")
      .set("Cookie", otherUser.cookie);
    expect(otherNotifications.status).toBe(200);
    expect(otherNotifications.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: expiryEvent.id })]),
    );

    const forbiddenAcknowledgement = await request
      .post(`/api/notifications/${expiryEvent.id}/acknowledge`)
      .set("Cookie", otherUser.cookie);
    expect(forbiddenAcknowledgement.status).toBe(404);

    const response = await request.get(`/api/sub/${buildSubscriptionToken(expiredUser.id)}`);
    expect(response.status).toBe(200);
    expect(response.text).toBe("");
    expect(decodeAnnounce(response.headers.announce)).toContain("Пробный период закончился");
    expect(response.headers["profile-web-page-url"]).toMatch(/\/dashboard$/);
    expect(response.headers["subscription-userinfo"]).toBeUndefined();
  });

  it("keeps active Happ subscriptions on their existing non-expiry path", async () => {
    const response = await request.get(`/api/sub/${buildSubscriptionToken(activeUser.id)}`);

    expect(response.status).toBe(200);
    expect(decodeAnnounce(response.headers.announce)).not.toContain("закончилась");
    expect(response.headers["subscription-userinfo"]).toContain("expire=");
  });

  it("keeps active hourly subscriptions on the existing balance-warning path", async () => {
    const [meResponse, subscriptionResponse] = await Promise.all([
      request.get("/api/me").set("Cookie", hourlyUser.cookie),
      request.get(`/api/sub/${buildSubscriptionToken(hourlyUser.id)}`),
    ]);

    expect(meResponse.status).toBe(200);
    expect(meResponse.body).toMatchObject({
      hasActiveSubscription: true,
      subscriptionState: "active",
      expiredSubscription: null,
    });
    expect(subscriptionResponse.status).toBe(200);
    expect(decodeAnnounce(subscriptionResponse.headers.announce)).toContain("Баланс почти исчерпан");
    expect(decodeAnnounce(subscriptionResponse.headers.announce)).not.toContain("закончилась");
    expect(subscriptionResponse.headers["subscription-userinfo"]).toContain("total=");
    expect(subscriptionResponse.headers["subscription-userinfo"]).not.toContain("expire=");
  });
});