import { Router, type IRouter } from "express";
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
