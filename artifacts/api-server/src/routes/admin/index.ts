import { Router, type IRouter } from "express";
import dashboardRouter from "./dashboard";
import plansRouter from "./plans";
import paymentSettingsRouter from "./paymentSettings";
import paymentsRouter from "./payments";
import vpnNodesRouter from "./vpnNodes";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(dashboardRouter);
router.use(plansRouter);
router.use(paymentSettingsRouter);
router.use(paymentsRouter);
router.use(vpnNodesRouter);
router.use(usersRouter);

export default router;
