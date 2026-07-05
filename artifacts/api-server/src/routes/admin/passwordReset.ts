import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { AdminResetUserPasswordParams, AdminResetUserPasswordResponse } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";
import { createPasswordResetToken } from "../../lib/passwordReset";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

// Admin-assisted password reset: since no outbound email sending is
// configured yet, an admin generates a one-time reset link here and shares
// it with the user through a trusted channel (support chat, phone, etc).
// This intentionally requires admin auth so an anonymous caller can never
// obtain a usable reset token for an arbitrary account.
router.post(
  "/admin/users/:userId/password-reset",
  requireAuth,
  requireAdmin,
  async (req, res): Promise<void> => {
    const params = AdminResetUserPasswordParams.safeParse(req.params);

    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.userId));

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { token } = await createPasswordResetToken(user.id);
    const resetUrl = `/reset-password?token=${token}`;

    logger.info(
      { userId: user.id, adminId: req.appUser?.id },
      "Admin generated a password reset link",
    );

    res.json(AdminResetUserPasswordResponse.parse({ resetUrl }));
  },
);

export default router;
