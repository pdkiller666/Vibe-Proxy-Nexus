import { Router, type IRouter } from "express";
import { requireAuth, requireAdmin } from "../../lib/auth";
import dashboardRouter from "./dashboard";
import plansRouter from "./plans";
import paymentSettingsRouter from "./paymentSettings";
import paymentsRouter from "./payments";
import vpnNodesRouter from "./vpnNodes";
import vpnKeysRouter from "./vpnKeys";
import usersRouter from "./users";
import passwordResetRouter from "./passwordReset";
import supportRouter from "./support";

const router: IRouter = Router();

// Defence-in-depth: requireAdmin at the router level means a forgotten
// middleware on a new sub-route cannot accidentally expose an admin endpoint.
// Individual routes keep their own requireAuth + requireAdmin guards too.
router.use(requireAuth, requireAdmin);

router.use(dashboardRouter);
router.use(plansRouter);
router.use(paymentSettingsRouter);
router.use(paymentsRouter);
router.use(vpnNodesRouter);
router.use(vpnKeysRouter);
router.use(usersRouter);
router.use(passwordResetRouter);
router.use(supportRouter);

export default router;
