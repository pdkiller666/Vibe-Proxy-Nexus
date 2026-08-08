import { Router, type IRouter } from "express";
import { requireAuth, requireAdmin } from "../../lib/auth";
import { auditLogMiddleware } from "../../lib/auditLog";
import dashboardRouter from "./dashboard";
import plansRouter from "./plans";
import paymentSettingsRouter from "./paymentSettings";
import paymentsRouter from "./payments";
import vpnNodesRouter from "./vpnNodes";
import vpnKeysRouter from "./vpnKeys";
import usersRouter from "./users";
import passwordResetRouter from "./passwordReset";
import supportRouter from "./support";
import referralsRouter from "./referrals";
import inviteLinksRouter from "./inviteLinks";
import notificationsRouter from "./notifications";
import systemEventsRouter from "./systemEvents";
import billingDebugRouter from "./billingDebug";
import vpnNodeProvisioningRouter from "./vpnNodeProvisioning";
import auditLogRouter from "./auditLog";
import auditLogDebugRouter from "./auditLogDebug";

const router: IRouter = Router();

// Defence-in-depth: requireAdmin at the router level means a forgotten
// middleware on a new sub-route cannot accidentally expose an admin endpoint.
// Individual routes keep their own requireAuth + requireAdmin guards too.
//
// IMPORTANT: the admin router is mounted without a path prefix (router.use(adminRouter))
// so that all routes can keep their /admin/ prefix in their own path strings.
// The regex below ensures this middleware ONLY fires for /admin/* paths —
// without it, any request not handled by an earlier router (e.g. the YooMoney
// checkout GET) would hit requireAdmin here and return 403 for regular users.
router.use(/^\/admin(\/|$)/, requireAuth, requireAdmin, auditLogMiddleware());

router.use(vpnNodeProvisioningRouter);
router.use(auditLogRouter);
router.use(dashboardRouter);
router.use(plansRouter);
router.use(paymentSettingsRouter);
router.use(paymentsRouter);
router.use(vpnNodesRouter);
router.use(vpnKeysRouter);
router.use(usersRouter);
router.use(passwordResetRouter);
router.use(supportRouter);
router.use(referralsRouter);
router.use(inviteLinksRouter);
router.use(notificationsRouter);
router.use(systemEventsRouter);
router.use(billingDebugRouter);
router.use(auditLogDebugRouter);

export default router;
