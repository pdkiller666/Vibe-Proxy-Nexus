/**
 * ЮMoney payment button — one button, opens YooMoney quickpay page where
 * the user picks the payment method themselves (card, SberPay, wallet).
 * Payment is confirmed automatically via the YooMoney HTTP notification webhook.
 */

interface YooMoneyPaymentButtonsProps {
  paymentId: number;
  amountRub: number;
}

export function YooMoneyPaymentButtons({ paymentId, amountRub }: YooMoneyPaymentButtonsProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="font-bold text-lg">Онлайн-оплата</div>
        <div className="text-2xl font-bold">{amountRub} ₽</div>
      </div>
      <p className="text-sm text-muted-foreground">
        Мгновенное подтверждение — активируется автоматически сразу после оплаты.
      </p>
      <a
        href={`/api/payments/yoomoney/checkout/${paymentId}`}
        className="flex items-center justify-center gap-3 w-full border border-border bg-card hover:border-primary hover:bg-primary/5 transition-colors py-4 px-3"
      >
        <span className="text-2xl">💜</span>
        <div className="text-center">
          <div className="font-bold text-sm">Оплатить через ЮMoney</div>
          <div className="text-xs text-muted-foreground">Карта · SberPay · Кошелёк</div>
        </div>
      </a>
      <p className="text-xs text-muted-foreground">
        Оплата проходит через сервис ЮMoney (ООО НКО «ЮМани»).
      </p>
    </div>
  );
}
