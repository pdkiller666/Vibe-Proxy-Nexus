/**
 * FreeKassa payment method buttons.
 *
 * Active FK methods for this merchant (confirmed 2026-07-16):
 *   36 — Card RUB API (Visa / MasterCard / МИР) — API badge
 *   44 — СБП (НСПК) API — API badge
 *   QIWI (35) — not available (QIWI Bank licence revoked 2024)
 *
 * Each button links to /api/payments/freekassa/checkout/{paymentId}?method=<key>
 * so the server can pass the `i` field in the FK API call.
 */

interface FkPaymentButtonsProps {
  paymentId: number;
  amountRub: number;
}

const methods = [
  {
    key: "card",
    label: "Карта / МИР",
    sub: "Visa · Mastercard · МИР",
    emoji: "💳",
  },
  {
    key: "sbp",
    label: "СБП",
    sub: "Система быстрых платежей",
    emoji: "⚡",
  },
] as const;

export function FkPaymentButtons({ paymentId, amountRub }: FkPaymentButtonsProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="font-bold text-lg">Онлайн-оплата</div>
        <div className="text-2xl font-bold">{amountRub} ₽</div>
      </div>
      <p className="text-sm text-muted-foreground">
        Мгновенное подтверждение — активируется автоматически сразу после оплаты.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {methods.map(({ key, label, sub, emoji }) => (
          <a
            key={key}
            href={`/api/payments/freekassa/checkout/${paymentId}?method=${key}`}
            className="flex flex-col items-center gap-1 border border-border bg-card hover:border-primary hover:bg-primary/5 transition-colors py-4 px-3 text-center"
          >
            <span className="text-2xl">{emoji}</span>
            <span className="font-bold text-sm">{label}</span>
            <span className="text-xs text-muted-foreground">{sub}</span>
          </a>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Приём платежей через KASSA.
      </p>
    </div>
  );
}
