import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { ListAdminUsersResponse, UpdateUserRoleBody, UpdateUserRoleParams, UpdateUserRoleResponse } from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../../lib/auth";

const router: IRouter = Router();

router.get("/admin/users", requireAuth, requireAdmin, async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(desc(usersTable.createdAt));
  res.json(ListAdminUsersResponse.parse(users));
});

router.patch("/admin/users/:userId/role", requireAuth, requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateUserRoleParams.safeParse(req.params);

  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateUserRoleBody.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ role: parsed.data.role })
    .where(eq(usersTable.id, params.data.userId))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json(UpdateUserRoleResponse.parse(user));
});

export default router;
