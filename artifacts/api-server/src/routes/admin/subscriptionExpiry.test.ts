import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import {
  db,
  plansTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import app from "../../app";
import { hashPassword } from "../../lib/password";
import {
  hasSubscriptionNotEnded,
  isActiveMonthlySubscriptionExpiringWithin,
} from "../../lib/subscriptionExpiryCriteria";

const request = supertest(app);
const DAY_MS = 24 * 60 * 60 * 1000;
const password = "correct-horse-battery-staple";

type FixtureUser = { id: number; email: string };

async function createUser(role: "user" | "admin"): Promise<FixtureUser> {
  const email = `admin-expiry-${role}-${randomBytes(6).toString("hex")}@example.com`;
  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash: await hashPassword(password),
      role,
      referralCode: randomBytes(8).toString("hex"),
    })
    .returning({ id: usersTable.id, email: usersTable.email });
  return user!;
}

async function loginAsAdmin(admin: FixtureUser): Promise<string> {
  const response = await request.post("/api/auth/login").send({
    email: admin.email,
    password,
  });
  expect(response.status).toBe(200);

  const cookies = Array.isArray(response.headers["set-cookie"])
    ? response.headers["set-cookie"]
    : [response.headers["set-cookie"]];
  const sessionCookie = cookies.find((cookie: string) => cookie.startsWith("vpn_session="));
  if (!sessionCookie) throw new Error("Login did not set a session cookie");
  return sessionCookie.split(";")[0]!;
}

function isExpiringFromAdminUser(
  user: {
    activeSubscriptionId?: number | null;
    activeSubscriptionBillingType?: string | null;
    activeSubscriptionEndsAt?: string | Date | null;
  },
  days: number,
  now: number,
): boolean {
  if (
    user.activeSubscriptionId == null ||
    user.activeSubscriptionBillingType !== "monthly" ||
    !user.activeSubscriptionEndsAt
  ) {
    return false;
  }
  const endsAt = new Date(user.activeSubscriptionEndsAt).getTime();
  return endsAt > now && endsAt <= now + days * DAY_MS;
}

describe("subscription expiry boundary semantics", () => {
  const now = new Date("2026-08-22T00:00:00.000Z");
  const monthlyActive = { status: "active", billingType: "monthly", endsAt: now };

  it("excludes subscriptions ending at or before now and includes the upper boundary", () => {
    expect(hasSubscriptionNotEnded(new Date(now.getTime() - 1), now)).toBe(false);
    expect(hasSubscriptionNotEnded(now, now)).toBe(false);
    expect(hasSubscriptionNotEnded(new Date(now.getTime() + 1), now)).toBe(true);
    expect(
      isActiveMonthlySubscriptionExpiringWithin(
        { ...monthlyActive, endsAt: now },
        3,
        now,
      ),
    ).toBe(false);
    expect(
      isActiveMonthlySubscriptionExpiringWithin(
        { ...monthlyActive, endsAt: new Date(now.getTime() + 3 * DAY_MS) },
        3,
        now,
      ),
    ).toBe(true);
    expect(
      isActiveMonthlySubscriptionExpiringWithin(
        { ...monthlyActive, endsAt: new Date(now.getTime() + 3 * DAY_MS + 1) },
        3,
        now,
      ),
    ).toBe(false);
  });
});

describe("admin expiring-subscription consistency", () => {
  let admin: FixtureUser;
  let adminCookie: string;
  let monthlyPlanId: number;
  let hourlyPlanId: number;
  const userIds: number[] = [];
  const subscriptionIds: number[] = [];

  beforeAll(async () => {
    admin = await createUser("admin");
    adminCookie = await loginAsAdmin(admin);

    const [monthly, hourly] = await db
      .insert(plansTable)
      .values([
        {
          name: `Admin expiry monthly ${randomBytes(4).toString("hex")}`,
          priceRub: 500,
          durationDays: 30,
          billingType: "monthly",
        },
        {
          name: `Admin expiry hourly ${randomBytes(4).toString("hex")}`,
          priceRub: 0,
          durationDays: 0,
          billingType: "hourly",
          hourlyRateKopecks: 100,
        },
      ])
      .returning({ id: plansTable.id });
    monthlyPlanId = monthly!.id;
    hourlyPlanId = hourly!.id;
  });

  afterAll(async () => {
    await db.delete(subscriptionsTable).where(inArray(subscriptionsTable.id, subscriptionIds));
    await db.delete(usersTable).where(inArray(usersTable.id, [...userIds, admin.id]));
    await db.delete(plansTable).where(inArray(plansTable.id, [monthlyPlanId, hourlyPlanId]));
  });

  async function seedUserWithSubscription(
    status: "active" | "cancelled" | "pending_payment",
    planId: number,
    endsAt: Date | null,
  ): Promise<FixtureUser> {
    const user = await createUser("user");
    userIds.push(user.id);
    const [subscription] = await db
      .insert(subscriptionsTable)
      .values({
        userId: user.id,
        planId,
        status,
        startsAt: status === "pending_payment" ? null : new Date(),
        endsAt,
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(subscription!.id);
    return user;
  }

  it("uses active monthly users for every expiry window and ignores other states", async () => {
    const now = new Date();
    const within3 = await seedUserWithSubscription(
      "active",
      monthlyPlanId,
      new Date(now.getTime() + 2 * DAY_MS),
    );
    const at3DayBoundary = await seedUserWithSubscription(
      "active",
      monthlyPlanId,
      new Date(now.getTime() + 3 * DAY_MS),
    );
    const within7 = await seedUserWithSubscription(
      "active",
      monthlyPlanId,
      new Date(now.getTime() + 5 * DAY_MS),
    );
    const within30 = await seedUserWithSubscription(
      "active",
      monthlyPlanId,
      new Date(now.getTime() + 20 * DAY_MS),
    );
    const hourly = await seedUserWithSubscription("active", hourlyPlanId, null);
    const cancelled = await seedUserWithSubscription(
      "cancelled",
      monthlyPlanId,
      new Date(now.getTime() + DAY_MS),
    );
    const pending = await seedUserWithSubscription(
      "pending_payment",
      monthlyPlanId,
      new Date(now.getTime() + DAY_MS),
    );
    const endedAtBoundary = await seedUserWithSubscription("active", monthlyPlanId, now);
    const alreadyExpired = await seedUserWithSubscription(
      "active",
      monthlyPlanId,
      new Date(now.getTime() - 1_000),
    );

    // The pending request is newer but inactive. The active subscription's
    // date must remain the source of truth for the admin user row.
    const withNewerPending = await seedUserWithSubscription(
      "active",
      monthlyPlanId,
      new Date(now.getTime() + 2 * DAY_MS),
    );
    const [pendingRequest] = await db
      .insert(subscriptionsTable)
      .values({
        userId: withNewerPending.id,
        planId: monthlyPlanId,
        status: "pending_payment",
        startsAt: null,
        endsAt: null,
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(pendingRequest!.id);

    // The latest active row is already expired, so the older row must not
    // make this user appear in the summary. This guards the DISTINCT ON
    // ordering separately from the inactive pending request above.
    const withNewerExpiredActive = await createUser("user");
    userIds.push(withNewerExpiredActive.id);
    const [olderExpiringActive] = await db
      .insert(subscriptionsTable)
      .values({
        userId: withNewerExpiredActive.id,
        planId: monthlyPlanId,
        status: "active",
        startsAt: new Date(now.getTime() - 2 * DAY_MS),
        endsAt: new Date(now.getTime() + 2 * DAY_MS),
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(olderExpiringActive!.id);
    const [newerExpiredActive] = await db
      .insert(subscriptionsTable)
      .values({
        userId: withNewerExpiredActive.id,
        planId: monthlyPlanId,
        status: "active",
        startsAt: new Date(now.getTime() - DAY_MS),
        endsAt: new Date(now.getTime() - 1_000),
      })
      .returning({ id: subscriptionsTable.id });
    subscriptionIds.push(newerExpiredActive!.id);

    const [afterUsersResponse, afterSummaryResponse] = await Promise.all([
      request.get("/api/admin/users").set("Cookie", adminCookie),
      request.get("/api/admin/dashboard/summary").set("Cookie", adminCookie),
    ]);
    expect(afterUsersResponse.status).toBe(200);
    expect(afterSummaryResponse.status).toBe(200);

    const afterUsers = afterUsersResponse.body as Array<{
      id: number;
      activeSubscriptionId?: number | null;
      activeSubscriptionBillingType?: string | null;
      activeSubscriptionEndsAt?: string | null;
      subscriptionStatus?: string | null;
      subscriptionEndsAt?: string | null;
    }>;
    const fixtureIds = new Set(userIds);
    const expiring3DayIds = afterUsers
      .filter(
        (user) =>
          isExpiringFromAdminUser(user, 3, now.getTime()),
      )
      .map((user) => user.id)
      .sort((a, b) => a - b);

    expect(expiring3DayIds.filter((id) => fixtureIds.has(id))).toEqual(
      [within3.id, at3DayBoundary.id, withNewerPending.id].sort((a, b) => a - b),
    );
    expect(
      afterUsers
        .filter((user) => fixtureIds.has(user.id) && isExpiringFromAdminUser(user, 7, now.getTime()))
        .map((user) => user.id)
        .sort((a, b) => a - b),
    ).toEqual([within3.id, at3DayBoundary.id, within7.id, withNewerPending.id].sort((a, b) => a - b));
    expect(
      afterUsers
        .filter((user) => fixtureIds.has(user.id) && isExpiringFromAdminUser(user, 30, now.getTime()))
        .map((user) => user.id)
        .sort((a, b) => a - b),
    ).toEqual([within3.id, at3DayBoundary.id, within7.id, within30.id, withNewerPending.id].sort((a, b) => a - b));

    const hourlyRow = afterUsers.find((user) => user.id === hourly.id);
    const cancelledRow = afterUsers.find((user) => user.id === cancelled.id);
    const pendingRow = afterUsers.find((user) => user.id === pending.id);
    expect(hourlyRow?.activeSubscriptionBillingType).toBe("hourly");
    expect(cancelledRow?.activeSubscriptionId).toBeNull();
    expect(pendingRow?.activeSubscriptionId).toBeNull();
    expect(afterUsers.find((user) => user.id === endedAtBoundary.id)?.activeSubscriptionId).toBeNull();
    expect(afterUsers.find((user) => user.id === alreadyExpired.id)?.activeSubscriptionId).toBeNull();
    expect(afterUsers.find((user) => user.id === withNewerExpiredActive.id)?.activeSubscriptionId).toBeNull();

    const pendingMaskedRow = afterUsers.find((user) => user.id === withNewerPending.id);
    expect(pendingMaskedRow?.activeSubscriptionBillingType).toBe("monthly");
    expect(pendingMaskedRow?.activeSubscriptionEndsAt).toBeTruthy();
    expect(pendingMaskedRow?.subscriptionStatus).toBe("pending_payment");
    expect(pendingMaskedRow?.subscriptionEndsAt).toBeNull();

    // Use an absolute count from the complete admin user list instead of a
    // before/after delta. Other integration files share the development DB and
    // may create or remove expiring subscriptions while this test runs.
    expect(afterSummaryResponse.body.expiringIn3Days).toBe(expiring3DayIds.length);
  });
});