/**
 * PayFromBalanceButton — instant payment from wallet balance.
 *
 * Rules (ТЗ v2.1 §3.1):
 *  - Hidden when priceRub === 0 (trial / promo plans, free grants)
 *  - Hidden when feature flag balancePaymentsEnabled === false
 *  - Shows balance inline; greys out if insufficient (still clickable to show error)
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Wallet, CheckCircle2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getGetMeQueryKey, getListMyPaymentsQueryKey, getListMySubscriptionsQueryKey } from "@workspace/api-client-react";

type Target = "subscription" | "extra_device_slot" | "extra_traffic";

interface Props {
  /** Payment target */
  target: Target;
  /** planId — required for target=subscription, ignored otherwise */
  planId?: number;
  /** Price of the item being purchased (rubles). Button is hidden when 0 or undefined. */
  priceRub: number;
  /** User's current balance in kopecks. */
  balanceKopecks: number;
  /** Whether the feature flag is on. Button is hidden when false. */
  enabled: boolean;
  /** Called on successful payment with the new paymentId. */
  onSuccess?: (paymentId: number) => void;
  /** Optional class for the outer wrapper */
  className?: string;
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

async function postBalanceCheckout(target: Target, planId?: number): Promise<{
  paymentId: number; type: string; amountRub: number;
}> {
  const res = await fetch(`${basePath}/api/balance-checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ target, planId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 402) {
      const rubles = Math.floor((body.requiredKopecks ?? 0) / 100);
      throw new Error(`Недостаточно средств. Нужно ${rubles} ₽ — пополните баланс и попробуйте снова.`);
    }
    if (res.status === 409) {
      throw new Error("Оплата с баланса временно отключена.");
    }
    throw new Error(body.error ?? "Ошибка при оплате с баланса");
  }
  return body;
}

export function PayFromBalanceButton({
  target,
  planId,
  priceRub,
  balanceKopecks,
  enabled,
  onSuccess,
  className,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [done, setDone] = useState(false);

  const sufficient = balanceKopecks >= priceRub * 100;

  const { mutate, isPending } = useMutation({
    mutationFn: () => postBalanceCheckout(target, planId),
    onSuccess: (data) => {
      // Invalidate everything that could have changed
      queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListMyPaymentsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListMySubscriptionsQueryKey() });
      setDone(true);
      toast({ title: "Оплачено с баланса!", description: `Списано ${data.amountRub} ₽` });
      onSuccess?.(data.paymentId);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Ошибка при оплате с баланса";
      toast({ title: msg, variant: "destructive" });
    },
  });

  // Guard: hide when feature is off or item is free
  if (!enabled || priceRub <= 0) return null;

  const balanceRub = Math.floor(balanceKopecks / 100);

  if (done) {
    return (
      <div className={`flex items-center gap-2 text-green-600 font-semibold text-sm py-3 ${className ?? ""}`}>
        <CheckCircle2 className="w-4 h-4" />
        Оплачено с баланса
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => mutate()}
        disabled={isPending}
        className={`w-full flex items-center justify-between gap-3 px-5 py-3 border font-bold text-sm transition-colors ${
          sufficient
            ? "border-primary text-primary hover:bg-primary hover:text-primary-foreground"
            : "border-amber-400 text-amber-700 bg-amber-50 hover:bg-amber-100"
        } disabled:opacity-50`}
      >
        <span className="flex items-center gap-2">
          {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
          {isPending ? "Оплачиваем..." : "Оплатить с баланса"}
        </span>
        <span className="font-mono text-xs">
          {sufficient ? (
            <>
              Баланс: {balanceRub} ₽ &nbsp;→&nbsp; -{priceRub} ₽
            </>
          ) : (
            <>
              Нужно {priceRub} ₽, баланс: {balanceRub} ₽
            </>
          )}
        </span>
      </button>
      {!sufficient && (
        <p className="text-xs text-amber-700 mt-1 pl-1">
          Недостаточно средств — пополните баланс на{" "}
          <strong>{priceRub - balanceRub} ₽</strong> и попробуйте снова.
        </p>
      )}
    </div>
  );
}
