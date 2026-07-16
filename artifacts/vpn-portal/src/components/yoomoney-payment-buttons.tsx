/**
 * ЮMoney (YooMoney) payment method buttons.
 *
 * Each button links to /api/payments/yoomoney/checkout/{paymentId}?method=<key>;
 * the server redirects to the YooMoney quickpay page with the right paymentType:
 *   card   → AC (банковская карта Visa / MasterCard / МИР)
 *   wallet → PC (кошелёк ЮMoney; СБП доступна на странице оплаты ЮMoney)
 *
 * Payment is confirmed automatically via the YooMoney HTTP notification webhook.
 */

interface YooMoneyPaymentButtonsProps {
  paymentId: number;
  amountRub: number;
}

const methods = [
  {
    key: "card",
    label: "Карта",
    sub: "Visa · Mastercard · МИР",
    emoji: "💳",
  },
  {
    key: "wallet",
    label: "ЮMoney",
    sub: "Кошелёк / СБП",
    emoji: "💜",
  },
] as const;

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
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {methods.map(({ key, label, sub, emoji }) => (
          <a
            key={key}
            href={`/api/payments/yoomoney/checkout/${paymentId}?method=${key}`}
            className="flex flex-col items-center gap-1 border border-border bg-card hover:border-primary hover:bg-primary/5 transition-colors py-4 px-3 text-center"
          >
            <span className="text-2xl">{emoji}</span>
            <span className="font-bold text-sm">{label}</span>
            <span className="text-xs text-muted-foreground">{sub}</span>
          </a>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Оплата проходит через сервис ЮMoney (ООО НКО «ЮМани»).
      </p>
    </div>
  );
}
