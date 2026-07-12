import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import meRouter from "./me";
import plansRouter from "./plans";
import paymentSettingsRouter from "./paymentSettings";
import vpnNodesRouter from "./vpnNodes";
import subscriptionsRouter from "./subscriptions";
import paymentsRouter from "./payments";
import balanceTransactionsRouter from "./balanceTransactions";
import vpnKeysRouter from "./vpnKeys";
import subscriptionRouter from "./subscription";
import extraSlotOrderRouter from "./extraSlotOrder";
import balanceTopupOrderRouter from "./balanceTopupOrder";
import supportRouter from "./support";
import adminRouter from "./admin";
import freeKassaRouter from "./freekassa";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(meRouter);
router.use(plansRouter);
router.use(paymentSettingsRouter);
router.use(vpnNodesRouter);
router.use(subscriptionsRouter);
router.use(paymentsRouter);
router.use(balanceTransactionsRouter);
router.use(vpnKeysRouter);
router.use(subscriptionRouter);
router.use(extraSlotOrderRouter);
router.use(balanceTopupOrderRouter);
router.use(supportRouter);
router.use(adminRouter);
router.use(freeKassaRouter);

export default router;
