import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useListPlans, useCreateSubscription, useGetMe, useGetPaymentSettings, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Check, CreditCard, Zap } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";
import { cn } from "@/lib/utils";

function formatKopecks(kopecks: number): string {
  const rubles = Math.floor(kopecks / 100);
  const cents = kopecks % 100;
  if (cents === 0) return `${rubles} ₽`;
  return `${rubles},${String(cents).padStart(2, "0")} ₽`;
}

export default function Plans() {
  const { data: plans, isLoading } = useListPlans();
  const { data: me } = useGetMe();
  const { data: paymentSettings } = useGetPaymentSettings();
  const { mutate: createSubscription, isPending } = useCreateSubscription();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [loadingPlanId, setLoadingPlanId] = useState<number | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePlans = plans?.filter((p) => p.isActive) ?? [];

  useEffect(() => {
    if (!selectedPlanId && activePlans.length > 0) {
      setSelectedPlanId(activePlans[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlans.length]);

  function scrollToCard(planId: number, behavior: ScrollBehavior = "smooth") {
    const el = cardRefs.current[planId];
    if (!el) return;

    programmaticScrollRef.current = true;
    if (programmaticScrollTimeoutRef.current) clearTimeout(programmaticScrollTimeoutRef.current);
    programmaticScrollTimeoutRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 600);

    // scrollIntoView with inline:'center' cooperates correctly with
    // snap-x snap-mandatory — the browser respects the snap points
    // instead of fighting a manually-clamped scrollTo offset.
    el.scrollIntoView({ behavior, inline: "center", block: "nearest" });
  }

  function handleCardClick(planId: number) {
    const index = activePlans.findIndex((p) => p.id === planId);
    if (index !== -1) setActiveIndex(index);
    setSelectedPlanId(planId);
    scrollToCard(planId);
  }

  const handleScroll = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      if (programmaticScrollRef.current) return;
      const trackCenter = track.scrollLeft + track.clientWidth / 2;
      let closestId: number | null = null;
      let closestIndex = 0;
      let closestDist = Infinity;
      activePlans.forEach((plan, i) => {
        const el = cardRefs.current[plan.id];
        if (!el) return;
        const cardCenter = el.offsetLeft + el.clientWidth / 2;
        const dist = Math.abs(cardCenter - trackCenter);
        if (dist < closestDist) {
          closestDist = dist;
          closestId = plan.id;
          closestIndex = i;
        }
      });
      if (closestId !== null) {
        setSelectedPlanId(closestId);
        setActiveIndex(closestIndex);
      }
    }, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlans]);

  const minHourlyTopupRub = paymentSettings?.minHourlyTopupRub ?? 0;
  const balanceRub = me ? Math.floor(me.balanceKopecks / 100) : 0;

  function handleSelect(planId: number, billingType?: string) {
    if (billingType === "hourly" && minHourlyTopupRub > 0 && balanceRub < minHourlyTopupRub) {
      toast({
        title: "Пополните баланс",
        description: `Для подключения почасового тарифа нужно минимум ${minHourlyTopupRub} ₽ на балансе.`,
        variant: "destructive",
      });
      setLocation("/dashboard");
      return;
    }

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

      {isLoading ? (
        <div className="grid md:grid-cols-3 gap-6">
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          <div
            ref={trackRef}
            onScroll={handleScroll}
            className="flex gap-4 overflow-x-auto snap-x snap-mandatory scroll-smooth pb-4 -mx-4 px-4 md:mx-0 md:px-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            {activePlans.map((plan, i) => {
              const isSelected = selectedPlanId === plan.id;
              return (
                <div
                  key={plan.id}
                  ref={(el) => {
                    cardRefs.current[plan.id] = el;
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleCardClick(plan.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") handleCardClick(plan.id);
                  }}
                  style={{ animationDelay: `${i * 80}ms` }}
                  className={cn(
                    "snap-center shrink-0 w-[78%] xs:w-[70%] sm:w-[300px] md:w-[320px] bg-card border p-6 flex flex-col cursor-pointer select-none",
                    "transition-all duration-300 ease-out animate-in fade-in slide-in-from-bottom-2",
                    isSelected
                      ? "border-primary ring-2 ring-primary/40 shadow-lg"
                      : "border-border hover:border-primary/40",
                  )}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCardClick(plan.id);
                      handleSelect(plan.id, plan.billingType);
                    }}
                    disabled={
                      isPending ||
                      (plan.billingType === "hourly" && !me?.balanceKopecks) ||
                      (plan.billingType === "hourly" && minHourlyTopupRub > 0 && balanceRub < minHourlyTopupRub)
                    }
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
                  {plan.billingType === "hourly" && minHourlyTopupRub > 0 && balanceRub < minHourlyTopupRub && (
                    <p className="text-xs text-orange-600 mt-2">
                      Минимальное пополнение для подключения — {minHourlyTopupRub} ₽.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {activePlans.length > 1 && (
            <div className="flex items-center justify-center gap-2">
              {activePlans.map((plan, i) => (
                <button
                  key={plan.id}
                  aria-label={`Перейти к тарифу ${plan.name}`}
                  onClick={() => handleCardClick(plan.id)}
                  className={cn(
                    "h-2 rounded-full transition-all duration-300",
                    activeIndex === i || selectedPlanId === plan.id
                      ? "w-6 bg-primary"
                      : "w-2 bg-border hover:bg-primary/40",
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
