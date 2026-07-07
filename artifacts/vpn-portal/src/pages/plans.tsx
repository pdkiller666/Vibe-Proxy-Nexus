import { useState } from "react";
import { useLocation } from "wouter";
import { useListPlans, useCreateSubscription } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Check, CreditCard } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";

export default function Plans() {
  const { data: plans, isLoading } = useListPlans();
  const { mutate: createSubscription, isPending } = useCreateSubscription();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [loadingPlanId, setLoadingPlanId] = useState<number | null>(null);

  function handleSelect(planId: number) {
    setLoadingPlanId(planId);
    createSubscription(
      { data: { planId, provider: "manual_sbp" } },
      {
        onSuccess: (result) => {
          toast({ title: "Подписка создана", description: "Переходим к оплате." });
          setLocation(`/checkout/${result.subscription.id}`);
        },
        onError: () => {
          toast({
            title: "Не удалось оформить подписку",
            description: "Попробуйте ещё раз чуть позже.",
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
                <h3 className="font-bold text-xl mb-1">{plan.name}</h3>
                <div className="text-3xl font-bold mb-1">
                  {plan.priceRub} ₽
                </div>
                <div className="text-sm text-muted-foreground font-mono mb-6">
                  на {plan.durationDays} дней
                </div>
                {plan.description && (
                  <p className="text-sm text-muted-foreground mb-6 flex-1">{plan.description}</p>
                )}
                <button
                  onClick={() => handleSelect(plan.id)}
                  disabled={isPending}
                  className="w-full bg-primary text-primary-foreground font-bold py-3 hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loadingPlanId === plan.id ? (
                    "Оформляем..."
                  ) : (
                    <>
                      <Check className="w-4 h-4" /> Оформить
                    </>
                  )}
                </button>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
