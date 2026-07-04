import { Router, type IRouter } from "express";
import { db, paymentSettingsTable } from "@workspace/db";
import { GetPaymentSettingsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/payment-settings", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(paymentSettingsTable).limit(1);

  if (!settings) {
    res.json(
      GetPaymentSettingsResponse.parse({
        sbpPhone: "",
        sbpBank: "",
        sbpRecipientName: "",
        instructions: "Платёжные реквизиты ещё не настроены администратором.",
        yookassaEnabled: false,
      }),
    );
    return;
  }

  res.json(GetPaymentSettingsResponse.parse(settings));
});

export default router;
