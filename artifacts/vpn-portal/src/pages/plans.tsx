import { useState } from "react";
import { useLocation } from "wouter";
import { useListPlans, useCreateSubscription, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Check, CreditCard, Zap } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";

function formatKopecks(kopecks: number): string {
  const rubles = Math.floor(kopecks / 100);
  const cents = kopecks % 100;
  if (cents === 0) return `${rubles} ₽`;
  return `${rubles},${String(cents).padStart(2, "0")} ₽`;
}

export default function Plans() {
  const { data: plans, isLoading } = useListPlans();
  const { data: me } = useGetMe();
  const { mutate: createSubscription, isPending } = useCreateSubscription();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [loadingPlanId, setLoadingPlanId] = useState<number | null>(null);

  function handleSelect(planId: number, billingType?: string) {
    setLoadingPlanId(planId);
    createSubscription(
      { data: { planId, provider: "manual_sbp" } },
      {
        onSuccess: (result) => {
          if (billingType === "hourly") {
            queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
            toast({ title: "Почасовой тариф подключён", description: "Оплата будет автоматически списываться с баланса." });
            setLocation("/dashboard");
            return;
          }
          toast({ title: "Подписка создана", description: "Переходим к оплате." });
          setLocation(`/checkout/${result.subscription.id}`);
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : undefined;
          toast({
            title: msg ?? "Не удалось оформить подписку",
            description: msg ? undefined : "Попробуйте ещё раз чуть позже.",
            variant: "destructive",
          });
          setLoadingPlanId(null);
        },
      },
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Тарифные планы</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Оплата — вручную через СБП. Активация после подтверждения перевода.
        </p>
      </div>

      <OnboardingTip
        id="plans-how-to-pay"
        icon={<CreditCard className="w-4 h-4" />}
        title="Как оплатить тариф"
      >
        <p>
          <strong>1.</strong> Выберите нужный план и нажмите «Выбрать».
        </p>
        <p>
          <strong>2.</strong> Вы увидите реквизиты для перевода по СБП — переведите точную сумму.
        </p>
        <p>
          <strong>3.</strong> Администратор подтверждает оплату в течение нескольких часов, после чего подписка активируется автоматически.
        </p>
      </OnboardingTip>

      <div className="grid md:grid-cols-3 gap-6">
        {isLoading ? (
          <>
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
            <Skeleton className="h-72 w-full" />
          </>
        ) : (
          plans
            ?.filter((p) => p.isActive)
            .map((plan, i) => (
              <div
                key={plan.id}
                style={{ animationDelay: `${i * 80}ms` }}
                className="bg-card border border-border p-6 flex flex-col animate-in fade-in slide-in-from-bottom-2 duration-500"
              >
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-bold text-xl">{plan.name}</h3>
                  {plan.billingType === "hourly" && (
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                      <Zap className="w-3 h-3" /> Почасовой
                    </span>
                  )}
                </div>
                {plan.billingType === "hourly" ? (
                  <>
                    <div className="text-3xl font-bold mb-1">
                      {formatKopecks(plan.hourlyRateKopecks ?? 0)}
                    </div>
                    <div className="text-sm text-muted-foreground font-mono mb-6">
                      за час, списывается с баланса
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-3xl font-bold mb-1">
                      {plan.priceRub} ₽
                    </div>
                    <div className="text-sm text-muted-foreground font-mono mb-6">
                      на {plan.durationDays} дней
                    </div>
                  </>
                )}
                {plan.description && (
                  <p className="text-sm text-muted-foreground mb-6 flex-1">{plan.description}</p>
                )}
                <button
                  onClick={() => handleSelect(plan.id, plan.billingType)}
                  disabled={isPending || (plan.billingType === "hourly" && !me?.balanceKopecks)}
                  className="w-full bg-primary text-primary-foreground font-bold py-3 hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loadingPlanId === plan.id ? (
                    "Оформляем..."
                  ) : (
                    <>
                      <Check className="w-4 h-4" /> {plan.billingType === "hourly" ? "Подключить" : "Оформить"}
                    </>
                  )}
                </button>
                {plan.billingType === "hourly" && !me?.balanceKopecks && (
                  <p className="text-xs text-orange-600 mt-2">Пополните баланс, чтобы подключить тариф.</p>
                )}
              </div>
            ))
        )}
      </div>
    </div>
  );
}
