import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListPlans,
  useCreateSubscription,
  useGetMe,
  useGetPaymentSettings,
  useCreateBalanceTopupOrder,
  usePatchMeAutoRenew,
  getGetMeQueryKey,
  getApiErrorPositiveIntegerField,
  ApiError,
} from "@workspace/api-client-react";
import { PayFromBalanceButton } from "@/components/pay-from-balance-button";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Check, CreditCard, Zap, Wallet, CheckCircle2, Sparkles, X, RefreshCw, ChevronDown } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";
import { cn } from "@/lib/utils";
import { ReferralPaymentOffer } from "@/components/referral-offer";

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
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { mutate: createSubscription, isPending } = useCreateSubscription();
  const { mutate: createTopup, isPending: isToppingUp } = useCreateBalanceTopupOrder();
  const [autoRenewOverride, setAutoRenewOverride] = useState<boolean | null>(null);
  const { mutate: updateAutoRenew, isPending: isAutoRenewPending } = usePatchMeAutoRenew({
    mutation: {
      onSuccess: (data) => {
        setAutoRenewOverride(data.autoRenewFromBalance);
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
        toast({ title: "Настройки автопродления сохранены" });
      },
      onError: (error: unknown) => {
        setAutoRenewOverride(null);
        if (error instanceof ApiError && error.status === 402) return;
        toast({ title: "Не удалось изменить настройки автопродления", variant: "destructive" });
      },
    },
  });
  const [loadingPlanId, setLoadingPlanId] = useState<number | null>(null);
  const [topupPlanId, setTopupPlanId] = useState<number | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [balanceCheckoutPaymentId, setBalanceCheckoutPaymentId] = useState<number | null>(null);
  const [renewalExpandedPlanId, setRenewalExpandedPlanId] = useState<number | null>(null);
  const [autoRenewInfoOpen, setAutoRenewInfoOpen] = useState(false);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePlans = (plans?.filter((p) => p.isActive) ?? []).sort((a, b) => {
    // Promo plan always first so it's the hero card in the carousel
    if (a.isPromo && !b.isPromo) return -1;
    if (!a.isPromo && b.isPromo) return 1;
    return 0;
  });

  // Promo plan entitlement: the server appends the user's promo plan (if any)
  // only when they have a qualifying invite link. It won't appear for regular users.
  const promoPlan = activePlans.find((p) => p.isPromo);
  const hasUnusedPromo = promoPlan != null && (promoPlan.userUsedCount ?? 0) === 0;
  const [promoBannerDismissed, setPromoBannerDismissed] = useState(false);

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

  function showAutoRenewTopup(planId: number, priceRub: number) {
    setAutoRenewOverride(false);
    setRenewalExpandedPlanId(planId);
    toast({
      title: "Недостаточно средств для автопродления",
      description: `Для включения автопродления нужно ${priceRub} ₽ на балансе. Пополните баланс и попробуйте снова.`,
      variant: "destructive",
    });
  }

  function handleQuickTopup(planId: number, requestedAmountRub?: number) {
    const amountRub = Math.max(requestedAmountRub ?? 0, minHourlyTopupRub, 1);
    setTopupPlanId(planId);
    createTopup(
      { data: { amountRub } },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          setLocation(`/balance-topup/${data.paymentId}`);
        },
        onError: (err: unknown) => {
          const paymentId = getApiErrorPositiveIntegerField(err, "paymentId", 409);
          if (paymentId !== null) {
            setLocation(`/balance-topup/${paymentId}`);
            return;
          }
          const msg = err instanceof Error ? err.message : undefined;
          toast({ title: msg ?? "Не удалось создать заявку на пополнение", variant: "destructive" });
          setTopupPlanId(null);
        },
      },
    );
  }

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
          // 409 = existing pending_payment subscription — redirect to it
          const body = err as { existingSubscriptionId?: number };
          if (body?.existingSubscriptionId) {
            setLocation(`/checkout/${body.existingSubscriptionId}`);
            return;
          }
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
          Оплата картой или через СБП. Активация сразу после оплаты.
        </p>
      </div>

      {balanceCheckoutPaymentId && <ReferralPaymentOffer paymentId={balanceCheckoutPaymentId} />}

      <OnboardingTip
        id="plans-how-to-pay"
        icon={<CreditCard className="w-4 h-4" />}
        title="Как оплатить тариф"
      >
        <p>
          <strong>1.</strong> Выберите нужный план и нажмите «Оформить».
        </p>
        <p>
          <strong>2.</strong> Нажмите «Оплатить картой» — вы перейдёте на страницу оплаты. Подписка активируется автоматически.
        </p>
        <p>
          <strong>3.</strong> Если карты нет — можно оплатить вручную переводом по СБП (раздел «Альтернатива» на странице оплаты).
        </p>
      </OnboardingTip>

      {/* Promo banner — shown only to users with an unclaimed promo plan */}
      {hasUnusedPromo && !promoBannerDismissed && promoPlan && (
        <div className="relative flex items-start gap-3 rounded-none border border-orange-400 bg-gradient-to-r from-orange-50 to-amber-50 dark:from-orange-950/40 dark:to-amber-950/40 p-4 pr-10 animate-in fade-in slide-in-from-top-2 duration-500">
          <Sparkles className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-bold text-orange-800 dark:text-orange-300 text-sm">
              Для вас доступно эксклюзивное предложение!
            </p>
            <p className="text-sm text-orange-700 dark:text-orange-400">
              Тариф <strong>«{promoPlan.name}»</strong> доступен вам по специальной цене{" "}
              <strong>{promoPlan.priceRub} ₽</strong>
              {promoPlan.durationDays > 0 ? ` на ${promoPlan.durationDays} дней` : ""}.
              {promoPlan.maxUses === 1
                ? " Предложение одноразовое — воспользуйтесь им сейчас."
                : promoPlan.maxUses != null
                  ? ` Доступно ещё ${promoPlan.maxUses - (promoPlan.userUsedCount ?? 0)} раз(а).`
                  : " Оформите его прямо сейчас."}
            </p>
          </div>
          <button
            onClick={() => setPromoBannerDismissed(true)}
            className="absolute right-3 top-3 text-orange-400 hover:text-orange-600 transition-colors"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

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
              const isCurrentPlan = !!me?.hasActiveSubscription && me.currentPlanName === plan.name;
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
                    "snap-center shrink-0 w-[78%] xs:w-[70%] sm:w-[300px] md:w-[320px] border flex flex-col cursor-pointer select-none overflow-hidden",
                    "transition-all duration-300 ease-out animate-in fade-in slide-in-from-bottom-2",
                    plan.isPromo
                      ? "bg-card border-green-300 shadow-lg shadow-green-200/60 scale-[1.03] ring-2 ring-green-300/50"
                      : isCurrentPlan
                        ? "bg-card border-green-500 ring-2 ring-green-500/30 shadow-lg"
                        : isSelected
                          ? "bg-card border-primary ring-2 ring-primary/40 shadow-lg"
                          : "bg-card border-border hover:border-primary/40",
                  )}
                >
                  {/* Promo top ribbon */}
                  {plan.isPromo && (
                    <div className="bg-green-100 text-green-700 text-xs font-black uppercase tracking-widest text-center py-1.5 px-3 flex items-center justify-center gap-1.5 border-b border-green-200">
                      <Sparkles className="w-3 h-3" /> Только для вас <Sparkles className="w-3 h-3" />
                    </div>
                  )}

                  <div className="flex flex-col flex-1 p-6">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-bold text-xl">{plan.name}</h3>
                    {isCurrentPlan && (
                      <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                        <CheckCircle2 className="w-3 h-3" /> Активный
                      </span>
                    )}
                    {plan.isPromo && (
                      <span className="inline-flex items-center gap-1 text-xs font-bold px-2.5 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-200">
                        ✨ Промо
                      </span>
                    )}
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
                      <div className="text-sm font-mono mb-6 text-muted-foreground">
                        за час, списывается с баланса
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-4xl font-black mb-1">
                        {plan.priceRub} ₽
                      </div>
                      <div className="text-sm font-mono mb-6 text-muted-foreground">
                        на {plan.durationDays} дней
                      </div>
                    </>
                  )}
                  {plan.description && (
                    <p className="text-sm mb-4 flex-1 text-muted-foreground">{plan.description}</p>
                  )}
                  <ul className="space-y-1.5 mb-6 text-sm">
                    {[
                      `${plan.devicesIncluded} ${
                        plan.devicesIncluded === 1 ? "устройство"
                        : plan.devicesIncluded < 5 ? "устройства"
                        : "устройств"
                      }`,
                      plan.trafficLimitGb != null
                        ? `${plan.trafficLimitGb} ГБ трафика`
                        : "Без ограничения трафика",
                    ].map((feat) => (
                      <li key={feat} className="flex items-center gap-2 text-muted-foreground">
                        <Check className="w-3.5 h-3.5 shrink-0 text-primary" />
                        {feat}
                      </li>
                    ))}
                  </ul>
                  {(() => {
                    if (isCurrentPlan) {
                      const canRenewFromBalance =
                        plan.billingType === "monthly" &&
                        plan.priceRub > 0 &&
                        paymentSettings?.balancePaymentsEnabled === true;
                      const renewalTopupAmountRub = Math.max(plan.priceRub - balanceRub, minHourlyTopupRub, 1);
                      const renewalExpanded = renewalExpandedPlanId === plan.id;

                      return (
                        <div className="space-y-2">
                          {canRenewFromBalance && renewalExpanded ? (
                            <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                              <PayFromBalanceButton
                                target="subscription"
                                planId={plan.id}
                                priceRub={plan.priceRub}
                                balanceKopecks={me?.balanceKopecks ?? 0}
                                enabled
                                actionLabel="Продлить с баланса"
                                insufficientActionLabel={`Пополнить на ${renewalTopupAmountRub} ₽`}
                                insufficientTopupAmountRub={renewalTopupAmountRub}
                                isActionPending={topupPlanId === plan.id && isToppingUp}
                                actionPendingLabel="Создаём заявку..."
                                onInsufficientBalance={() => handleQuickTopup(plan.id, renewalTopupAmountRub)}
                                onSuccess={(paymentId) => {
                                  setBalanceCheckoutPaymentId(paymentId);
                                  window.scrollTo({ top: 0, behavior: "smooth" });
                                }}
                              />
                              <button
                                type="button"
                                className="w-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors py-2 text-xs font-semibold flex items-center justify-center gap-2"
                                onClick={() => setRenewalExpandedPlanId(null)}
                              >
                                <X className="w-3.5 h-3.5" />
                                Отмена
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              disabled={!canRenewFromBalance}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (canRenewFromBalance) setRenewalExpandedPlanId(plan.id);
                              }}
                              className={`w-full bg-green-100 text-green-700 font-bold py-3 flex items-center justify-center gap-2 ${
                                canRenewFromBalance
                                  ? "hover:bg-green-200 transition-colors"
                                  : "cursor-default opacity-90"
                              }`}
                            >
                              <CheckCircle2 className="w-4 h-4" />
                              {canRenewFromBalance ? "Продлить тариф" : "Текущий тариф"}
                            </button>
                          )}

                          {canRenewFromBalance && (
                            <div className="border border-border p-3 overflow-hidden">
                              <div className="flex items-center justify-between gap-3">
                                <button
                                  type="button"
                                  className="min-w-0 flex-1 flex items-center gap-2 text-left overflow-hidden"
                                  aria-expanded={autoRenewInfoOpen}
                                  aria-label={autoRenewInfoOpen ? "Свернуть автопродление" : "Раскрыть автопродление"}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setAutoRenewInfoOpen((open) => !open);
                                  }}
                                >
                                  <RefreshCw className="w-4 h-4 shrink-0 text-primary" />
                                  <span className="min-w-0 flex-1 truncate text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                                    Автопродление
                                  </span>
                                  <ChevronDown
                                    className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${
                                      autoRenewInfoOpen ? "rotate-180" : ""
                                    }`}
                                  />
                                </button>
                                <label
                                  className="relative inline-flex items-center cursor-pointer shrink-0 w-10 h-6"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    className="sr-only peer"
                                    aria-label="Автоматически продлять подписку с баланса"
                                    checked={autoRenewOverride ?? me?.autoRenewFromBalance ?? false}
                                    disabled={isAutoRenewPending}
                                    onChange={(e) => {
                                      const enabled = e.target.checked;
                                      if (enabled && (me?.balanceKopecks ?? 0) < plan.priceRub * 100) {
                                        showAutoRenewTopup(plan.id, plan.priceRub);
                                        return;
                                      }

                                      setAutoRenewOverride(enabled);
                                      updateAutoRenew(
                                        { data: { enabled } },
                                        {
                                          onError: (error: unknown) => {
                                            if (enabled && error instanceof ApiError && error.status === 402) {
                                              showAutoRenewTopup(plan.id, plan.priceRub);
                                            }
                                          },
                                        },
                                      );
                                    }}
                                  />
                                  <div className="w-10 h-6 shrink-0 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4 peer-disabled:opacity-50" />
                                </label>
                              </div>
                              {autoRenewInfoOpen && (
                                <p className="text-xs text-muted-foreground mt-2 pl-6">
                                  За ~24 ч до окончания с баланса спишется {plan.priceRub} ₽ и добавится ещё{" "}
                                  {plan.durationDays} дней.
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    }

                    const insufficientBalance =
                      plan.billingType === "hourly" &&
                      (!me?.balanceKopecks || (minHourlyTopupRub > 0 && balanceRub < minHourlyTopupRub));

                    if (insufficientBalance) {
                      const topupAmount = minHourlyTopupRub > 0 ? minHourlyTopupRub : 100;
                      return (
                        <>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCardClick(plan.id);
                              handleQuickTopup(plan.id);
                            }}
                            disabled={isToppingUp}
                            className="w-full bg-primary text-primary-foreground font-bold py-3 hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                          >
                            {topupPlanId === plan.id && isToppingUp ? (
                              "Переходим к оплате..."
                            ) : (
                              <>
                                <Wallet className="w-4 h-4" /> Пополнить — {topupAmount} ₽
                              </>
                            )}
                          </button>
                          <p className="text-xs text-orange-600 mt-2">
                            {minHourlyTopupRub > 0
                              ? `Минимальный баланс для подключения — ${minHourlyTopupRub} ₽.`
                              : "Пополните баланс, чтобы подключить тариф."}
                          </p>
                        </>
                      );
                    }

                    return (
                      <div className="space-y-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCardClick(plan.id);
                            handleSelect(plan.id, plan.billingType);
                          }}
                          disabled={isPending}
                          className={cn(
                            "w-full font-bold py-3 hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2",
                            "bg-primary text-primary-foreground",
                          )}
                        >
                          {loadingPlanId === plan.id ? (
                            "Оформляем..."
                          ) : (
                            <>
                              <Check className="w-4 h-4" /> {plan.billingType === "hourly" ? "Подключить" : "Оформить"}
                            </>
                          )}
                        </button>
                        {/* Balance checkout — only for monthly paid plans */}
                        {plan.billingType === "monthly" && (
                          <PayFromBalanceButton
                            target="subscription"
                            planId={plan.id}
                            priceRub={plan.priceRub}
                            balanceKopecks={me?.balanceKopecks ?? 0}
                            enabled={paymentSettings?.balancePaymentsEnabled ?? false}
                            onSuccess={(paymentId) => {
                              setBalanceCheckoutPaymentId(paymentId);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                          />
                        )}
                      </div>
                    );
                  })()}
                  </div>{/* end inner promo wrapper */}
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
