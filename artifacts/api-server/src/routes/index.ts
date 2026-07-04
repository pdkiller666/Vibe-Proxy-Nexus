import { Router, type IRouter } from "express";
import healthRouter from "./health";
import meRouter from "./me";
import plansRouter from "./plans";
import paymentSettingsRouter from "./paymentSettings";
import vpnNodesRouter from "./vpnNodes";
import subscriptionsRouter from "./subscriptions";
import paymentsRouter from "./payments";
import vpnKeysRouter from "./vpnKeys";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
router.use(plansRouter);
router.use(paymentSettingsRouter);
router.use(vpnNodesRouter);
router.use(subscriptionsRouter);
router.use(paymentsRouter);
router.use(vpnKeysRouter);
router.use(adminRouter);

export default router;
