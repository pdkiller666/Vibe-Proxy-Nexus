---
name: Admin user delete/role safety
description: Safety invariants for admin-triggered user deletion and role changes in the VPN portal — deprovisioning reliability and last-admin protection.
---

When an admin deletes a user or changes a user's role, two invariants must hold:

1. **VPN key deprovisioning on delete must not be best-effort.** If any active
   VPN key fails to be removed from Xray during a user-delete cascade, the
   whole deletion must abort (no DB rows touched) and return an error asking
   the admin to retry — never silently delete the DB rows while a stale Xray
   client is still live.
   **Why:** once the user row is gone there's no natural retry path from the
   UI, and a "deleted" account with lingering network access is a real
   security hole, not just a stale-consistency nit (flagged by architect
   review as critical).
   **How to apply:** in the delete-user route, remove Xray clients first; on
   any failure, respond 502 and return before starting the DB transaction.

2. **Never allow the system to end up with zero admins.** Both deleting a
   user and demoting a user's role (admin → user) must check whether the
   target is the last remaining admin and block the action if so (self-delete
   was already blocked separately, but self-demotion and cross-admin
   delete/demote were not).
   **Why:** the admin panel is the only way to manage roles; losing the last
   admin locks everyone out of user/subscription/key management.
   **How to apply:** a shared `isLastRemainingAdmin(userId)` check
   (role === "admin" AND count(role='admin') <= 1) gates both the
   `DELETE /admin/users/:id` and `PATCH /admin/users/:id/role` (when demoting)
   routes.
