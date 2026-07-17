/**
 * ЮMoney payment button — single button (card / SberPay).
 * Opens YooMoney quickpay with paymentType=AC (bank card); SberPay appears
 * on YooMoney's own page as an option.
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
        href={`/api/payments/yoomoney/checkout/${paymentId}?method=card`}
        className="flex flex-col items-center gap-1 border border-border bg-card hover:border-primary hover:bg-primary/5 transition-colors py-4 px-3 text-center w-full"
      >
        <span className="text-2xl">💳</span>
        <span className="font-bold text-sm">Карта / SberPay</span>
        <span className="text-xs text-muted-foreground">Visa · Mastercard · МИР · SberPay</span>
      </a>
      <p className="text-xs text-muted-foreground">
        Оплата проходит через сервис ЮMoney (ООО НКО «ЮМани»).
      </p>
    </div>
  );
}
