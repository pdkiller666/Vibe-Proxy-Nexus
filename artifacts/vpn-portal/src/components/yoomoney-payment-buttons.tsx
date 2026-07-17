/**
 * Payment method tiles shown on all checkout pages.
 *
 * Tile 1 — Карта / SberPay (auto-confirm via YooMoney webhook)
 * Tile 2 — СБП через Озон Банк (manual confirm: user transfers the exact
 *           amount, then uploads a screenshot in the section below)
 */

import { useState } from "react";

const OZON_SBP_URL = "https://finance.ozon.ru/apps/sbp/ozonbankpay/0199bf34-b74d-7723-9d12-04de3561863f";

interface YooMoneyPaymentButtonsProps {
  paymentId: number;
  amountRub: number;
  /** Payment reference — shown as a copy field so the user can put it in the
   *  transfer comment for easier admin matching. */
  reference?: string;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="text-xs border border-border px-2 py-0.5 hover:bg-muted transition-colors shrink-0"
    >
      {copied ? "✓ скопировано" : "скопировать"}
    </button>
  );
}

export function YooMoneyPaymentButtons({ paymentId, amountRub, reference }: YooMoneyPaymentButtonsProps) {
  const [sbpOpen, setSbpOpen] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="font-bold text-lg">Онлайн-оплата</div>
        <div className="text-2xl font-bold">{amountRub} ₽</div>
      </div>
      <p className="text-sm text-muted-foreground">
        Мгновенное подтверждение — активируется автоматически сразу после оплаты.
      </p>

      {/* ── Tiles ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        {/* Карта / SberPay — auto-confirm */}
        <a
          href={`/api/payments/yoomoney/checkout/${paymentId}?method=card`}
          className="flex flex-col items-center gap-1 border border-border bg-card hover:border-primary hover:bg-primary/5 transition-colors py-4 px-3 text-center"
        >
          <span className="text-2xl">💳</span>
          <span className="font-bold text-sm">Карта / SberPay</span>
          <span className="text-xs text-muted-foreground">Visa · MC · МИР · SberPay</span>
        </a>

        {/* СБП — manual, expands instructions */}
        <button
          type="button"
          onClick={() => setSbpOpen((v) => !v)}
          className={[
            "flex flex-col items-center gap-1 border bg-card hover:border-primary hover:bg-primary/5 transition-colors py-4 px-3 text-center",
            sbpOpen ? "border-primary bg-primary/5" : "border-border",
          ].join(" ")}
        >
          <span className="text-2xl">⚡</span>
          <span className="font-bold text-sm">СБП</span>
          <span className="text-xs text-muted-foreground">Озон Банк · ручное подтверждение</span>
        </button>
      </div>

      {/* ── СБП instructions (expands when tile is clicked) ───────────── */}
      {sbpOpen && (
        <div className="border border-primary/40 bg-primary/5 p-4 space-y-4">
          {/* Step 1 — amount */}
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Шаг 1 — переведите ровно</p>
            <div className="flex items-center gap-3">
              <span className="text-3xl font-bold">{amountRub} ₽</span>
              <CopyButton value={String(amountRub)} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Введите эту сумму в поле перевода — копейки менять не нужно.
            </p>
          </div>

          {reference && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">В комментарии к переводу укажите</p>
              <div className="flex items-center gap-2 font-mono text-sm break-all">
                <span>{reference}</span>
                <CopyButton value={reference} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Это поможет администратору быстрее найти ваш платёж.
              </p>
            </div>
          )}

          {/* Step 2 — open Ozon Bank */}
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Шаг 2 — откройте форму перевода</p>
            <a
              href={OZON_SBP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-bold px-5 py-3 hover:opacity-90 transition-opacity text-sm"
            >
              ⚡ Перейти к оплате по СБП
            </a>
          </div>

          {/* Step 3 — screenshot */}
          <div className="border-t border-border pt-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Шаг 3 — подтвердите оплату</p>
            <p className="text-sm">
              После перевода загрузите скриншот и нажмите «Я оплатил(а)» в форме ниже ↓
            </p>
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Карта и SberPay — автоматическое подтверждение через ЮMoney (ООО НКО «ЮМани»).
        СБП — ручное подтверждение администратором.
      </p>
    </div>
  );
}
