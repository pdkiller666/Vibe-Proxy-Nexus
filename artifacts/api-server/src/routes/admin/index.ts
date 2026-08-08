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

const router: IRouter = Router();

// Defence-in-depth: requireAdmin at the router level means a forgotten
// middleware on a new sub-route cannot accidentally expose an admin endpoint.
// Individual routes keep their own requireAuth + requireAdmin guards too.
//
// IMPORTANT: the admin router is mounted without a path prefix (router.use(adminRouter))
// so that all routes can keep their /admin/ prefix in their own path strings.
//
// Auth guards keep their regex path so they don't block non-admin traffic
// (e.g. YooMoney webhooks) that also flows through this router.
router.use(/^\/admin(\/|$)/, requireAuth, requireAdmin);

// Audit middleware is registered WITHOUT a path — Express 4 creates one Layer
// per callback in router.use(path, fn1, fn2, fn3), and the third Layer was
// silently skipped (middlewareCalls=0 confirmed by diagnostic). No-path means
// this Layer always matches; logAdminAction filters internally by role/method.
router.use(auditLogMiddleware());

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

export default router;
