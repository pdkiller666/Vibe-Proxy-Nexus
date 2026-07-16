import { randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, sessionsTable, usersTable } from "@workspace/db";
import {
  deleteExpiredSessions,
  destroySession,
  getUserBySessionToken,
  invalidateUserSessions,
} from "./session";

function makeToken(): string {
  return randomBytes(16).toString("hex");
}

// Mirror of hashToken() in session.ts — tokens are stored hashed in the DB.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("getUserBySessionToken", () => {
  let userId: number;
  const createdTokens: string[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `session-token-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;
  });

  afterEach(async () => {
    for (const token of createdTokens.splice(0)) {
      // Tokens are stored as SHA-256 hashes — delete by hash, not the raw value.
      await db.delete(sessionsTable).where(eq(sessionsTable.token, hashToken(token)));
    }
  });

  afterAll(async () => {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  async function seedSession(expiresAt: Date): Promise<string> {
    const token = makeToken();
    // Store hash in DB (mirrors createSession() in session.ts).
    await db.insert(sessionsTable).values({ token: hashToken(token), userId, expiresAt });
    createdTokens.push(token);
    return token;
  }

  it("returns null for a session that has already expired, even if cleanup hasn't run", async () => {
    const expiredToken = await seedSession(new Date(Date.now() - 60 * 60 * 1000));

    const user = await getUserBySessionToken(expiredToken);

    expect(user).toBeNull();
  });

  it("resolves to the user for a session with a future expiry", async () => {
    const validToken = await seedSession(new Date(Date.now() + 60 * 60 * 1000));

    const user = await getUserBySessionToken(validToken);

    expect(user).not.toBeNull();
    expect(user?.id).toBe(userId);
  });

  it("returns null for a token that does not exist", async () => {
    const user = await getUserBySessionToken(makeToken());

    expect(user).toBeNull();
  });
});

describe("deleteExpiredSessions", () => {
  let userId: number;
  const createdTokens: string[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `session-cleanup-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;
  });

  afterEach(async () => {
    for (const token of createdTokens.splice(0)) {
      await db.delete(sessionsTable).where(eq(sessionsTable.token, hashToken(token)));
    }
  });

  afterAll(async () => {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  async function seedSession(expiresAt: Date): Promise<string> {
    const token = makeToken();
    await db.insert(sessionsTable).values({ token: hashToken(token), userId, expiresAt });
    createdTokens.push(token);
    return token;
  }

  async function sessionExists(token: string): Promise<boolean> {
    const rows = await db.select().from(sessionsTable).where(eq(sessionsTable.token, hashToken(token)));
    return rows.length > 0;
  }

  it("deletes sessions with an expiresAt in the past and keeps future ones", async () => {
    const pastToken = await seedSession(new Date(Date.now() - 60 * 60 * 1000));
    const futureToken = await seedSession(new Date(Date.now() + 60 * 60 * 1000));

    const deletedCount = await deleteExpiredSessions();

    expect(deletedCount).toBeGreaterThanOrEqual(1);
    await expect(sessionExists(pastToken)).resolves.toBe(false);
    await expect(sessionExists(futureToken)).resolves.toBe(true);
  });

  it("deletes a session whose expiresAt equals the seed-time 'now' (boundary case)", async () => {
    // By the time deleteExpiredSessions() runs its query, real time has moved
    // past this timestamp, so a session expiring exactly "now" at seed time
    // is already expired and must be removed.
    const now = new Date();
    const boundaryToken = await seedSession(now);

    await deleteExpiredSessions();

    await expect(sessionExists(boundaryToken)).resolves.toBe(false);
  });

  it("deletes a session the moment it becomes expired relative to now", async () => {
    const justExpiredToken = await seedSession(new Date(Date.now() - 1));

    await deleteExpiredSessions();

    await expect(sessionExists(justExpiredToken)).resolves.toBe(false);
  });

  it("does not delete a session that has not expired yet", async () => {
    const futureToken = await seedSession(new Date(Date.now() + 60 * 60 * 1000));

    await deleteExpiredSessions();

    await expect(sessionExists(futureToken)).resolves.toBe(true);
  });
});

describe("destroySession", () => {
  let userId: number;
  const createdTokens: string[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `session-destroy-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;
  });

  afterEach(async () => {
    for (const token of createdTokens.splice(0)) {
      await db.delete(sessionsTable).where(eq(sessionsTable.token, hashToken(token)));
    }
  });

  afterAll(async () => {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  });

  async function seedSession(expiresAt: Date): Promise<string> {
    const token = randomBytes(16).toString("hex");
    await db.insert(sessionsTable).values({ token: hashToken(token), userId, expiresAt });
    createdTokens.push(token);
    return token;
  }

  async function sessionExists(token: string): Promise<boolean> {
    const rows = await db.select().from(sessionsTable).where(eq(sessionsTable.token, hashToken(token)));
    return rows.length > 0;
  }

  it("removes exactly the targeted session and leaves other sessions untouched", async () => {
    const targetToken = await seedSession(new Date(Date.now() + 60 * 60 * 1000));
    const otherToken = await seedSession(new Date(Date.now() + 60 * 60 * 1000));

    await destroySession(targetToken);

    await expect(sessionExists(targetToken)).resolves.toBe(false);
    await expect(sessionExists(otherToken)).resolves.toBe(true);
  });

  it("is a no-op when the token does not exist", async () => {
    const otherToken = await seedSession(new Date(Date.now() + 60 * 60 * 1000));

    await expect(destroySession(randomBytes(16).toString("hex"))).resolves.not.toThrow();

    await expect(sessionExists(otherToken)).resolves.toBe(true);
  });
});

describe("invalidateUserSessions", () => {
  let userId: number;
  let otherUserId: number;
  const createdTokens: string[] = [];

  beforeAll(async () => {
    const [user] = await db
      .insert(usersTable)
      .values({
        email: `session-invalidate-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    userId = user.id;

    const [otherUser] = await db
      .insert(usersTable)
      .values({
        email: `session-invalidate-other-test-${randomBytes(6).toString("hex")}@example.com`,
        passwordHash: "not-a-real-hash",
        referralCode: randomBytes(8).toString("hex"),
      })
      .returning({ id: usersTable.id });
    otherUserId = otherUser.id;
  });

  afterEach(async () => {
    for (const token of createdTokens.splice(0)) {
      await db.delete(sessionsTable).where(eq(sessionsTable.token, hashToken(token)));
    }
  });

  afterAll(async () => {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
    await db.delete(usersTable).where(eq(usersTable.id, otherUserId));
  });

  async function seedSessionFor(ownerId: number, expiresAt: Date): Promise<string> {
    const token = randomBytes(16).toString("hex");
    await db.insert(sessionsTable).values({ token: hashToken(token), userId: ownerId, expiresAt });
    createdTokens.push(token);
    return token;
  }

  async function sessionExists(token: string): Promise<boolean> {
    const rows = await db.select().from(sessionsTable).where(eq(sessionsTable.token, hashToken(token)));
    return rows.length > 0;
  }

  it("removes all sessions for the given user and leaves other users' sessions untouched", async () => {
    const sessionOneToken = await seedSessionFor(userId, new Date(Date.now() + 60 * 60 * 1000));
    const sessionTwoToken = await seedSessionFor(userId, new Date(Date.now() + 2 * 60 * 60 * 1000));
    const otherUserToken = await seedSessionFor(otherUserId, new Date(Date.now() + 60 * 60 * 1000));

    await invalidateUserSessions(userId);

    await expect(sessionExists(sessionOneToken)).resolves.toBe(false);
    await expect(sessionExists(sessionTwoToken)).resolves.toBe(false);
    await expect(sessionExists(otherUserToken)).resolves.toBe(true);
  });

  it("is a no-op when the user has no sessions", async () => {
    const otherUserToken = await seedSessionFor(otherUserId, new Date(Date.now() + 60 * 60 * 1000));

    await expect(invalidateUserSessions(userId)).resolves.not.toThrow();

    await expect(sessionExists(otherUserToken)).resolves.toBe(true);
  });
});
