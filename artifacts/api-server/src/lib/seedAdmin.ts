import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { hashPassword } from "./password";
import { logger } from "./logger";
import { assignReferralCode } from "./referralCode";

/**
 * Seeds a default admin account from ADMIN_EMAIL / ADMIN_PASSWORD env vars.
 *
 * Runs once per boot and is intentionally conservative: if ANY admin already
 * exists, it does nothing. This means once someone changes the admin's email
 * or password through the web interface (or a second admin is promoted), the
 * env vars stop having any effect — they only provide the *initial* default
 * credentials, never override customized ones.
 */
export async function seedDefaultAdmin(): Promise<void> {
  const email = process.env["ADMIN_EMAIL"];
  const password = process.env["ADMIN_PASSWORD"];

  if (!email || !password) {
    return;
  }

  try {
    const [existingAdmin] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.role, "admin"))
      .limit(1);

    if (existingAdmin) {
      return;
    }

    const [existingByEmail] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    if (existingByEmail) {
      await db.update(usersTable).set({ role: "admin" }).where(eq(usersTable.id, existingByEmail.id));
      logger.info({ email }, "Promoted existing user to admin using ADMIN_EMAIL from environment");
      return;
    }

    const passwordHash = await hashPassword(password);
    const [admin] = await db.insert(usersTable).values({ email, passwordHash, role: "admin" }).returning();
    if (admin) {
      // The seeded admin has no referrer — it's the root of the invite chain
      // that every other registration (see auth.ts /register) must trace
      // back to via a referral code.
      await assignReferralCode(admin.id);
    }
    logger.info({ email }, "Seeded default admin user from ADMIN_EMAIL/ADMIN_PASSWORD environment variables");
  } catch (err) {
    logger.error({ err }, "Failed to seed default admin user");
  }
}
