import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useListMyVpnKeys,
  useCreateExtraTrafficOrder,
  useGetPaymentSettings,
  useListMyNotifications,
  useAcknowledgeNotification,
  useListPlans,
  useListMyPayments,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { queryClient } from "@/lib/query-client";
import { getGetMeQueryKey, getListMyNotificationsQueryKey } from "@workspace/api-client-react";
import {
  Shield,
  CreditCard,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Sparkles,
  Zap,
  Gauge,
  ChevronDown,
  Users,
  Copy,
  Check,
  Server,
  X,
  Gift,
  RefreshCw,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { OnboardingTip } from "@/components/onboarding-tip";
import { useToast } from "@/hooks/use-toast";
import { ReferralOfferCard } from "@/components/referral-offer";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function formatDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function getDaysLeft(endsAt?: string | null): number | null {
  if (!endsAt) return null;
  const diff = new Date(endsAt).getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function pluralDays(n: number) {
  if (n === 1) return "день";
  if (n >= 2 && n <= 4) return "дня";
  return "дней";
}

function formatKopecks(kopecks: number): string {
  const rubles = Math.floor(kopecks / 100);
  const cents = kopecks % 100;
  if (cents === 0) return `${rubles} ₽`;
  return `${rubles},${String(cents).padStart(2, "0")} ₽`;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 МБ";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TrafficSection() {
  const { data: me } = useGetMe();
  const { data: keys, isLoading } = useListMyVpnKeys();
  const { data: paymentSettings } = useGetPaymentSettings();
  const { mutate: createTrafficOrder, isPending: orderingTraffic } = useCreateExtraTrafficOrder();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const activeKeys = (keys ?? []).filter((k) => !k.revokedAt);
  const allKeys = keys ?? [];

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  // Previously this bailed out entirely once every key was revoked (e.g. by
  // the traffic-limit sweep), which hid the exact information — and the
  // top-up CTA — a user needs to understand why their VPN stopped working.
  // Only skip the section if there's truly nothing to show (no keys ever).
  if (allKeys.length === 0) return null;

  const limitBytes = me?.trafficLimitGb ? me.trafficLimitGb * 1024 * 1024 * 1024 : null;
  const usedBytes = me?.periodUsageBytes ?? 0;
  const usagePct = limitBytes ? Math.min(100, (usedBytes / limitBytes) * 100) : null;
  const exceeded = me?.trafficLimitExceeded ?? false;
  const nearLimit = !exceeded && usagePct !== null && usagePct >= 80;

  const trafficPrice = paymentSettings?.extraTrafficPriceRub ?? 0;
  const trafficPackageGb = paymentSettings?.extraTrafficPackageGb ?? 0;
  const allowFreeTraffic = paymentSettings?.allowFreeExtraTraffic ?? false;
  const topupDisabled = trafficPrice <= 0 && !allowFreeTraffic;

  function handleBuyTraffic() {
    createTrafficOrder(undefined, {
      onSuccess: (data) => {
        if (data.freeGranted) {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          toast({ title: `Начислено ${data.extraTrafficGb} ГБ бесплатно` });
          return;
        }
        setLocation(`/checkout/traffic/${data.paymentId}`);
      },
      onError: (err: unknown) => {
        const body = err as { paymentId?: number; message?: string };
        if (body?.paymentId) {
          setLocation(`/checkout/traffic/${body.paymentId}`);
          return;
        }
        toast({
          title: err instanceof Error ? err.message : "Не удалось создать заявку",
          variant: "destructive",
        });
      },
    });
  }

  const buyTrafficButton = limitBytes !== null && (
    <button
      onClick={handleBuyTraffic}
      disabled={orderingTraffic || topupDisabled}
      title={topupDisabled ? "Покупка дополнительного трафика временно недоступна" : undefined}
      className="shrink-0 bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
    >
      {orderingTraffic
        ? "Создаём заявку..."
        : trafficPrice > 0
          ? `+${trafficPackageGb} ГБ — ${trafficPrice} ₽`
          : `+${trafficPackageGb} ГБ`}
    </button>
  );

  return (
    <div className="bg-card border border-border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Gauge className="w-4 h-4 text-primary" />
        <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
          Трафик за текущий период
        </p>
      </div>

      {exceeded && (
        <div className="flex items-start gap-3 bg-destructive/10 border border-destructive/30 p-4 text-sm text-destructive">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-2">
            <span>
              Лимит трафика на текущий период исчерпан — ваши ключи VPN отозваны. Докупите трафик, чтобы сразу
              восстановить доступ, либо дождитесь начала следующего периода.
            </span>
            {limitBytes !== null && <div>{buyTrafficButton}</div>}
          </div>
        </div>
      )}

      {nearLimit && (
        <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 p-4 text-sm text-orange-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 space-y-2">
            <span>
              Использовано {usagePct!.toFixed(0)}% лимита трафика на этот период. Докупите трафик заранее, чтобы
              избежать отключения ключей.
            </span>
            {limitBytes !== null && <div>{buyTrafficButton}</div>}
          </div>
        </div>
      )}

      {limitBytes !== null && (
        <div>
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <span>
              {formatBytes(usedBytes)} из {formatBytes(limitBytes)}
              {(me?.extraTrafficGb ?? 0) > 0 && ` (включая +${me!.extraTrafficGb} ГБ докупленных)`}
            </span>
            <span>{usagePct!.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                exceeded ? "bg-destructive" : usagePct! >= 80 ? "bg-orange-500" : "bg-primary"
              }`}
              style={{ width: `${Math.max(2, usagePct!)}%` }}
            />
          </div>
        </div>
      )}
      {limitBytes === null && (
        <p className="text-sm text-muted-foreground">
          Использовано: <strong className="text-foreground">{formatBytes(usedBytes)}</strong> (без лимита)
        </p>
      )}

      {!exceeded && !nearLimit && limitBytes !== null && (
        <div className="flex justify-end">{buyTrafficButton}</div>
      )}

      {activeKeys.length > 0 && (
        <div className="space-y-2">
          {activeKeys.map((key) => (
            <div key={key.id} className="flex items-center justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{key.label}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  Активность: {key.lastTrafficAt ? formatDateTime(key.lastTrafficAt) : "нет данных"}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold">{formatBytes(key.periodUpBytes + key.periodDownBytes)}</p>
                <p className="text-xs text-muted-foreground">за период</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ReferralSection() {
  const { data: me } = useGetMe();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  // Collapsed by default on mobile (same pattern as CollapsibleOnMobile)
  const [location] = useLocation();
  const [open, setOpen] = useState(
    () =>
      (typeof window !== "undefined" && window.innerWidth >= 768) ||
      location.includes("referrals=1"),
  );

  if (!me?.referralCode || me.referralCommissionPercent <= 0) return null;

  const referralLink = `https://${me.referralLinkHost}${basePath}/sign-up?ref=${me.referralCode}`;
  const commission  = me.referralCommissionPercent;
  const invited     = me.referredUserCount;
  const earned      = me.referralEarningsKopecks;

  const refsNeeded  = commission > 0 ? Math.ceil(100 / commission) : null;
  const progressPct = refsNeeded ? Math.min(100, Math.round((invited / refsNeeded) * 100)) : 0;
  const isFree      = refsNeeded !== null && invited >= refsNeeded;

  function copyLink() {
    navigator.clipboard.writeText(referralLink).then(() => {
      setCopied(true);
      toast({ title: "Реферальная ссылка скопирована" });
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function copyCode() {
    if (!me) return;
    navigator.clipboard.writeText(me.referralCode).then(() => {
      setCopiedCode(true);
      toast({ title: "Инвайт-код скопирован" });
      setTimeout(() => setCopiedCode(false), 2000);
    });
  }

  return (
    <div className="bg-card border border-border overflow-hidden">

      {/* ── Заголовок — стиль nav-кнопки (как Тарифы / Ключи VPN) ────────── */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-4 p-5 border-b border-border text-left hover:bg-muted/30 transition-colors"
      >
        <div>
          <div className="font-bold flex items-center gap-2">
            <Gift className="w-4 h-4 text-primary shrink-0" />
            Реферальная программа
            {isFree && (
              <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 bg-green-100 text-green-700 rounded-full">
                <CheckCircle2 className="w-3 h-3" />
                Окупается
              </span>
            )}
            {!isFree && invited > 0 && (
              <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-bold bg-primary/10 text-primary rounded-full">
                {invited}
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground mt-0.5">
            {commission > 0
              ? `${commission}% с каждой оплаты реферала`
              : "Приглашайте друзей"}
          </div>
        </div>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>

      {/* ── Тело: заголовок + цифры, прогресс, ссылка — сворачивается ── */}
      <div className={open ? "block" : "hidden"}>

        {/* Описание — внутри тела, видно только при раскрытии */}
        <div className="px-5 pt-4 pb-2">
          <p className="text-base font-black tracking-tight leading-snug">
            {isFree
              ? "Ваша подписка окупается рефералами"
              : "Пользуйтесь бесплатно — приглашайте друзей"}
          </p>
          {commission > 0 && !isFree && refsNeeded && (
            <p className="text-sm text-muted-foreground mt-1">
              {refsNeeded === 1
                ? "Достаточно одного оплатившего реферала — и подписка окупается"
                : `Пригласите ${refsNeeded} человек — их оплаты перекроют стоимость вашей подписки`}
            </p>
          )}
          {isFree && (
            <p className="text-sm text-green-600 font-medium mt-1">
              Комиссия с рефералов уже покрывает стоимость подписки
            </p>
          )}
        </div>

        {/* Статистика */}
        <div className={`grid divide-x divide-border border-b border-border ${commission > 0 ? "grid-cols-2" : "grid-cols-1"}`}>
          <div className="px-5 py-4">
            <div className="text-3xl font-black">{invited}</div>
            <div className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">
              {invited === 1 ? "приглашённый" : "приглашено"}
            </div>
          </div>
          {commission > 0 && (
            <div className="px-5 py-4">
              <div className={`text-3xl font-black ${earned > 0 ? "text-green-600" : ""}`}>
                {formatKopecks(earned)}
              </div>
              <div className="text-xs text-muted-foreground mt-1 uppercase tracking-wide">начислено на баланс</div>
            </div>
          )}
        </div>

        {/* Прогресс к бесплатной подписке */}
        {commission > 0 && refsNeeded && (
          <div className="px-5 py-3 border-b border-border space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>До бесплатной подписки</span>
              <span className={isFree ? "text-green-600 font-semibold" : ""}>
                {invited} / {refsNeeded}
              </span>
            </div>
            <div className="h-1.5 bg-muted overflow-hidden">
              <div
                className={`h-full transition-all ${isFree ? "bg-green-500" : "bg-primary"}`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
            {!isFree && invited === 0 && (
              <p className="text-xs text-muted-foreground">
                Поделитесь ссылкой — каждый оплативший друг приближает вас к бесплатной подписке
              </p>
            )}
          </div>
        )}

        {/* Ссылка и код */}
        <div className="p-5 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex-1 min-w-0 font-mono text-sm bg-muted px-3 py-2 truncate select-all">
              {referralLink}
            </div>
            <button
              onClick={copyLink}
              className="shrink-0 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? "Скопировано" : "Скопировать ссылку"}
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-muted-foreground whitespace-nowrap">Инвайт-код:</span>
              <div className="font-mono text-sm bg-muted px-3 py-2 select-all tracking-widest">
                {me.referralCode}
              </div>
            </div>
            <button
              onClick={copyCode}
              className="shrink-0 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5"
            >
              {copiedCode ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copiedCode ? "Скопировано" : "Скопировать код"}
            </button>
          </div>

          {/* Механика */}
          <div className="border-t border-border pt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>✓ Зачисляется сразу после оплаты реферала</span>
            <span>✓ Идёт в счёт вашей подписки</span>
            <span>✓ Без вывода, замкнутый баланс</span>
          </div>
        </div>

      </div>
    </div>
  );
}

/**
 * A successful background renewal gets one server-claimed referral prompt.
 * Claiming the event before rendering prevents a refresh or second device from
 * repeating the offer; the regular auto-renew banner still handles failures
 * and the success message when referrals are disabled.
 */
function AutoRenewReferralOffer() {
  const { data: me } = useGetMe();
  const { data: notifications } = useListMyNotifications();
  const { mutate: acknowledge } = useAcknowledgeNotification({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMyNotificationsQueryKey() });
      },
    },
  });
  const [claimedEventId, setClaimedEventId] = useState<number | null>(null);
  const claimAttempted = useRef<number | null>(null);
  const event = (notifications ?? []).find((notification) => notification.eventType === "auto_renew_success");
  const referralEnabled = Boolean(me?.referralCode && (me.referralCommissionPercent ?? 0) > 0);

  useEffect(() => {
    if (!referralEnabled || !event || claimAttempted.current === event.id) return;
    claimAttempted.current = event.id;
    acknowledge(
      { id: event.id },
      {
        onSuccess: () => setClaimedEventId(event.id),
      },
    );
  }, [acknowledge, event, referralEnabled]);

  if (!referralEnabled || !claimedEventId) return null;

  return (
    <div className="flex items-start gap-3 p-4 text-sm border bg-green-50 border-green-200 text-green-800">
      <RefreshCw className="w-4 h-4 shrink-0 mt-0.5 text-green-600" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold">Подписка автоматически продлена.</span>{" "}
        Поделитесь своей ссылкой, чтобы будущие оплаты друзей помогали покрывать её стоимость.
        <ReferralOfferCard compact />
      </div>
    </div>
  );
}

/**
 * Shows dismissible banners for auto_renew_success and auto_renew_failed events.
 */
function AutoRenewBanners() {
  const { data: me } = useGetMe();
  const { data: notifications } = useListMyNotifications();
  const { mutate: acknowledge } = useAcknowledgeNotification({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMyNotificationsQueryKey() });
      },
    },
  });

  const referralEnabled = Boolean(me?.referralCode && (me.referralCommissionPercent ?? 0) > 0);
  const renewEvents = (notifications ?? []).filter(
    (n) =>
      n.eventType === "auto_renew_failed" ||
      (n.eventType === "auto_renew_success" && !referralEnabled),
  );

  if (renewEvents.length === 0) return null;

  return (
    <div className="space-y-2">
      {renewEvents.map((n) => {
        const meta = n.metadata as {
          planName?: string;
          amountRub?: number;
          requiredRub?: number;
          balanceRub?: number;
        };
        const isSuccess = n.eventType === "auto_renew_success";
        return (
          <div
            key={n.id}
            className={`flex items-start gap-3 p-4 text-sm border ${
              isSuccess
                ? "bg-green-50 border-green-200 text-green-800"
                : "bg-amber-50 border-amber-300 text-amber-800"
            }`}
          >
            <RefreshCw className={`w-4 h-4 shrink-0 mt-0.5 ${isSuccess ? "text-green-600" : "text-amber-600"}`} />
            <div className="flex-1 min-w-0">
              {isSuccess ? (
                <>
                  <span className="font-semibold">Подписка автоматически продлена.</span>{" "}
                  С баланса списано <strong>{meta.amountRub} ₽</strong>
                  {meta.planName ? ` за тариф «${meta.planName}»` : ""}.
                </>
              ) : (
                <>
                  <span className="font-semibold">Не удалось автопродлить подписку.</span>{" "}
                  Нужно <strong>{meta.requiredRub} ₽</strong>, на балансе{" "}
                  <strong>{meta.balanceRub} ₽</strong>. Пополните баланс, чтобы не потерять доступ.
                </>
              )}
            </div>
            <button
              type="button"
              aria-label="Закрыть уведомление"
              onClick={() => acknowledge({ id: n.id })}
              className={`shrink-0 transition-colors ${isSuccess ? "text-green-500 hover:text-green-800" : "text-amber-500 hover:text-amber-800"}`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Shows an expiry event only for the subscription that is currently expired.
 * A user may renew before seeing a notification; matching the subscription ID
 * keeps that historical event from contradicting the fresh active state.
 * Hourly billing remains owned by BalanceBanners.
 */
function SubscriptionExpiryBanners() {
  const { data: me } = useGetMe();
  const { data: notifications } = useListMyNotifications();
  const { mutate: acknowledge } = useAcknowledgeNotification({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMyNotificationsQueryKey() });
      },
    },
  });

  const expiredSubscription =
    me?.subscriptionState === "expired" &&
    me.expiredSubscription?.billingType !== "hourly"
      ? me.expiredSubscription
      : null;
  const expiryEvents = (notifications ?? []).filter((notification) => {
    if (notification.eventType !== "subscription_expired" || !expiredSubscription) {
      return false;
    }
    const metadata = notification.metadata as { subscriptionId?: number };
    return metadata.subscriptionId === expiredSubscription.id;
  });

  if (expiryEvents.length === 0 || !expiredSubscription) return null;

  return (
    <div className="space-y-2">
      {expiryEvents.map((notification) => {
        const metadata = notification.metadata as {
          planName?: string;
          endedAt?: string | null;
          isTrial?: boolean;
        };
        const isTrial = Boolean(metadata.isTrial ?? expiredSubscription.isTrial);
        return (
          <div
            key={notification.id}
            className="flex items-start gap-3 bg-red-50 border border-red-300 p-4 text-sm text-red-800"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
            <div className="flex-1 min-w-0">
              <span className="font-semibold">
                {isTrial ? "Пробный период закончился." : "Подписка закончилась."}
              </span>{" "}
              {metadata.planName || expiredSubscription.planName
                ? `Тариф «${metadata.planName || expiredSubscription.planName}» `
                : ""}
              {metadata.endedAt || expiredSubscription.endsAt
                ? `завершился ${formatDate(metadata.endedAt || expiredSubscription.endsAt)}. `
                : ""}
              <Link href="/plans" className="underline font-semibold hover:opacity-80">
                Выберите тариф
              </Link>{" "}
              для восстановления доступа.
            </div>
            <button
              type="button"
              aria-label="Закрыть уведомление"
              onClick={() => acknowledge({ id: notification.id })}
              className="shrink-0 text-red-500 hover:text-red-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Shows dismissible banners for balance_low and balance_exhausted events.
 * balance_low  — emitted by the hourly billing tick when < 3 hours of balance remain.
 * balance_exhausted — emitted when the balance ran out and VPN keys were revoked.
 */
function BalanceBanners() {
  const { data: notifications } = useListMyNotifications();
  const { mutate: acknowledge } = useAcknowledgeNotification({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMyNotificationsQueryKey() });
      },
    },
  });

  const balanceEvents = (notifications ?? []).filter(
    (n) => n.eventType === "balance_low" || n.eventType === "balance_exhausted",
  );

  if (balanceEvents.length === 0) return null;

  return (
    <div className="space-y-2">
      {balanceEvents.map((n) => {
        const isExhausted = n.eventType === "balance_exhausted";
        return (
          <div
            key={n.id}
            className={`flex items-start gap-3 p-4 text-sm border ${
              isExhausted
                ? "bg-red-50 border-red-300 text-red-700"
                : "bg-orange-50 border-orange-200 text-orange-700"
            }`}
          >
            <AlertTriangle
              className={`w-4 h-4 shrink-0 mt-0.5 ${isExhausted ? "text-red-500" : "text-orange-500"}`}
            />
            <div className="flex-1 min-w-0">
              {isExhausted ? (
                <>
                  <span className="font-semibold">VPN был отключён — баланс закончился.</span>{" "}
                  <Link href="/payments" className="underline font-semibold hover:opacity-80">
                    Пополните баланс
                  </Link>{" "}
                  и выберите тариф заново, чтобы восстановить доступ.
                </>
              ) : (
                <>
                  <span className="font-semibold">Баланс заканчивается</span> — осталось менее 3 часов работы VPN.{" "}
                  <Link href="/payments" className="underline font-semibold hover:opacity-80">
                    Пополнить прямо сейчас
                  </Link>
                </>
              )}
            </div>
            <button
              type="button"
              aria-label="Закрыть уведомление"
              onClick={() => acknowledge({ id: n.id })}
              className={`shrink-0 transition-colors ${
                isExhausted ? "text-red-400 hover:text-red-700" : "text-orange-400 hover:text-orange-700"
              }`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// Collapsed by default on mobile (to avoid a long scroll before reaching
// Тарифы/Ключи/Платежи) but expanded by default on desktop, where there's
// plenty of room. Purely a display toggle — content stays mounted either way.
function CollapsibleOnMobile({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(() => (typeof window !== "undefined" ? window.innerWidth >= 768 : true));

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between py-2 md:hidden"
      >
        <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">{title}</span>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div className={open ? "block" : "hidden md:block"}>{children}</div>
    </div>
  );
}

export default function Dashboard() {
  const { data: me, isLoading: meLoading } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const { data: keys, isLoading: keysLoading } = useListMyVpnKeys();
  const { data: plans, isLoading: plansLoading } = useListPlans();
  const { data: payments } = useListMyPayments();
  const { toast } = useToast();
  // Usage details toggle — collapsed on mobile by default, open on desktop
  const [usageOpen, setUsageOpen] = useState(() => (typeof window !== "undefined" ? window.innerWidth >= 768 : true));

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];
  const daysLeft = getDaysLeft(me?.subscriptionEndsAt as string | null | undefined);
  const isExpiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 5;
  const expiredSubscription =
    me?.subscriptionState === "expired" &&
    me.expiredSubscription?.billingType !== "hourly"
      ? me.expiredSubscription
      : null;
  const isExpired = Boolean(expiredSubscription);

  // Low-balance warnings for hourly billing
  const isHourly = me?.currentPlanBillingType === "hourly";
  const hoursLeft =
    isHourly && me?.hourlyRateKopecks && me.hourlyRateKopecks > 0
      ? (me.balanceKopecks ?? 0) / me.hourlyRateKopecks
      : null;
  const isBalanceCritical = hoursLeft !== null && hoursLeft < 3;
  const isBalanceLow     = hoursLeft !== null && hoursLeft >= 3 && hoursLeft < 24;

  // Trial detection — API returns isTrialSubscription = true when the active
  // subscription has no completed payment (i.e. was granted for free on sign-up).
  const isTrial = Boolean(me?.isTrialSubscription);
  // Suppress the generic "expiring soon" orange warning when user is on trial —
  // the dedicated teal trial banner below already handles the expiry message.
  const showExpiringSoon = isExpiringSoon && !isExpired && !isTrial;

  // Promo plan — backend prepends it first when user's invite link has one.
  // Only show the promo CTA when the user has no active subscription yet.
  const promoPlan = !me?.hasActiveSubscription && plans?.[0]?.isPromo ? plans[0] : null;
  const hasUnusedPromo = promoPlan != null && (promoPlan.userUsedCount ?? 0) === 0;

  const pendingPayments = (payments ?? []).filter((p) => p.status === "pending");

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Панель управления</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Статус вашего доступа к сервису.
        </p>
      </div>

      {/* Pending payments banner — shown when user navigated away from an unfinished payment */}
      {pendingPayments.length > 0 && (
        <Link
          href="/payments"
          className="flex items-center justify-between gap-3 border border-primary/50 bg-primary/5 p-4 hover:bg-primary/10 transition-colors"
        >
          <div className="flex items-center gap-3 min-w-0">
            <Clock className="w-4 h-4 text-primary shrink-0" />
            <span className="text-sm font-bold text-primary">
              {pendingPayments.length === 1
                ? "Есть незавершённый платёж — ожидает подтверждения"
                : `Незавершённых платежей: ${pendingPayments.length} — ожидают подтверждения`}
            </span>
          </div>
          <ArrowRight className="w-4 h-4 text-primary shrink-0" />
        </Link>
      )}

      {/* Onboarding tip — adapts text to the user's current state */}
      <OnboardingTip
        id="dashboard-welcome"
        icon={<Sparkles className="w-4 h-4" />}
        title="Добро пожаловать в VPNexus!"
      >
        <p>Здесь — статус вашей подписки и быстрый доступ ко всем разделам.</p>
        {isTrial ? (
          <p>
            У вас активен <strong>бесплатный пробный период</strong>. Первый VPN-ключ уже выпущен —
            откройте раздел{" "}
            <Link href="/keys" className="underline font-semibold">Подключение</Link>{" "}
            и подключитесь прямо сейчас. Чтобы продолжить пользоваться после пробного периода,
            выберите{" "}
            <Link href="/plans" className="underline font-semibold">подходящий тариф</Link>.
          </p>
        ) : me?.hasActiveSubscription ? (
          <p>
            <strong>Следующий шаг:</strong> откройте раздел{" "}
            <Link href="/keys" className="underline font-semibold">Подключение</Link>{" "}
            — первый ключ уже готов, подключитесь к интернету за минуту.
          </p>
        ) : expiredSubscription ? (
          <p>
            <strong>{expiredSubscription.isTrial ? "Пробный период закончился:" : "Подписка закончилась:"}</strong>{" "}
            перейдите в раздел{" "}
            <Link href="/plans" className="underline font-semibold">Тарифы</Link>{" "}
            и выберите новый план для восстановления доступа.
          </p>
        ) : (
          <p>
            <strong>Следующий шаг:</strong> перейдите в раздел{" "}
            <Link href="/plans" className="underline font-semibold">Тарифы</Link>{" "}
            — выберите подходящий план и получите доступ к VPN.
          </p>
        )}
      </OnboardingTip>

      {/* Auto-renew notifications */}
      <AutoRenewReferralOffer />
      <AutoRenewBanners />

        {/* Monthly/trial expiry event — deliberately separate from hourly balance events */}
        <SubscriptionExpiryBanners />

      {/* Hourly balance warnings (balance_low / balance_exhausted) */}
      <BalanceBanners />

      {/* ── Trial period banner ── shown prominently so the user knows they're on
          a free trial and what happens after it ends. Shown regardless of
          days-left count (even on day 1) and suppresses the generic orange
          "expiring soon" warning to avoid double-messaging. */}
      {isTrial && me?.hasActiveSubscription && (
        <div className="bg-card border border-emerald-300 dark:border-emerald-700 overflow-hidden">
          <div className="h-1 w-full bg-gradient-to-r from-emerald-400 to-teal-500" />
          <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="w-12 h-12 bg-emerald-50 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
              <Gift className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                  Пробный период
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 rounded-full">
                  Бесплатно
                </span>
              </div>
              <p className="text-sm font-semibold">
                {daysLeft !== null && daysLeft >= 0
                  ? daysLeft === 0
                    ? "Пробный период заканчивается сегодня"
                    : `Осталось ${daysLeft} ${pluralDays(daysLeft)} пробного доступа`
                  : "Пробный период активен"}
                {me.subscriptionEndsAt && (
                  <span className="text-muted-foreground font-normal">
                    {" "}· до {formatDate(me.subscriptionEndsAt as string | null | undefined)}
                  </span>
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                После окончания пробного периода VPN-доступ будет приостановлен.
                Купите подписку сейчас — она активируется немедленно.
              </p>
            </div>
            <Link
              href="/plans"
              className="shrink-0 bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-5 py-2.5 text-sm transition-colors whitespace-nowrap"
            >
              Выбрать тариф
            </Link>
          </div>
        </div>
      )}

      {showExpiringSoon && (
        <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 p-4 text-sm text-orange-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Подписка истекает через{" "}
            <strong>{daysLeft === 0 ? "менее суток" : `${daysLeft} ${pluralDays(daysLeft)}`}</strong>.{" "}
            <Link href="/plans" className="underline font-semibold hover:text-orange-900">
              Продлить сейчас
            </Link>
          </span>
        </div>
      )}

      {isBalanceCritical && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-300 p-4 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            <strong>Баланс почти исчерпан</strong> — осталось менее 3 часов работы VPN.{" "}
            <Link href="/payments" className="underline font-semibold hover:text-red-900">
              Пополнить прямо сейчас
            </Link>
          </span>
        </div>
      )}

      {isBalanceLow && (
        <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 p-4 text-sm text-orange-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Баланс заканчивается — осталось примерно{" "}
            <strong>{Math.floor(hoursLeft!)} ч</strong> работы VPN.{" "}
            <Link href="/payments" className="underline font-semibold hover:text-orange-900">
              Пополнить баланс
            </Link>
          </span>
        </div>
      )}

      {/* ── Subscription hero block ───────────────────────────────── */}
      {meLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : me?.hasActiveSubscription && me.currentPlanBillingType === "hourly" ? (
        <div className="bg-card border border-border overflow-hidden">
          <div className="h-1 w-full bg-primary" />
          <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                  Подписка
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                  <CheckCircle2 className="w-3 h-3" />
                  Активна
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-primary shrink-0" />
                <div className="text-2xl font-black tracking-tight">{me.currentPlanName}</div>
              </div>
              <p className="text-sm text-muted-foreground mt-1.5">
                {formatKopecks(me.hourlyRateKopecks ?? 0)}/час — списывается с баланса автоматически.
              </p>
            </div>
            <Link
              href="/plans"
              className="shrink-0 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
            >
              Сменить тариф
            </Link>
          </div>
          {/* ── Подробности использования — встроенный тогглер ── */}
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setUsageOpen((o) => !o)}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors"
            >
              <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Подробности использования
              </span>
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${usageOpen ? "rotate-180" : ""}`} />
            </button>
            {usageOpen && (
              <div className="px-5 pb-5 space-y-6">
                <TrafficSection />
              </div>
            )}
          </div>
        </div>
      ) : me?.hasActiveSubscription ? (
        <div className={`bg-card overflow-hidden ${isTrial ? "border border-emerald-200 dark:border-emerald-800" : "border border-border"}`}>
          {/* colour bar */}
          <div className={`h-1 w-full ${isTrial ? "bg-gradient-to-r from-emerald-400 to-teal-500" : showExpiringSoon ? "bg-orange-400" : "bg-primary"}`} />
          <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            {/* info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                  Подписка
                </span>
                {isTrial ? (
                  <>
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300">
                      <Gift className="w-3 h-3" />
                      Пробный период
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                      <CheckCircle2 className="w-3 h-3" />
                      Активна
                    </span>
                  </>
                ) : (
                  <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full
                    ${showExpiringSoon
                      ? "bg-orange-100 text-orange-700"
                      : "bg-green-100 text-green-700"}`}>
                    <CheckCircle2 className="w-3 h-3" />
                    Активна
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isTrial
                  ? <Gift className={`w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400`} />
                  : <Shield className={`w-5 h-5 shrink-0 ${showExpiringSoon ? "text-orange-500" : "text-primary"}`} />}
                <div className="text-2xl font-black tracking-tight">{me.currentPlanName}</div>
              </div>
              {daysLeft !== null && daysLeft >= 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {daysLeft === 0
                        ? "Истекает сегодня"
                        : `Осталось ${daysLeft} ${pluralDays(daysLeft)}`}
                    </span>
                    <span>до {formatDate(me.subscriptionEndsAt as string | null | undefined)}</span>
                  </div>
                  <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${isTrial ? "bg-emerald-500" : showExpiringSoon ? "bg-orange-400" : "bg-primary"}`}
                      style={{ width: `${Math.max(4, Math.min(100, (daysLeft / 30) * 100))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
            {/* action */}
            <Link
              href="/plans"
              className={`shrink-0 px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap
                ${isTrial
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "border border-border hover:border-primary hover:text-primary"}`}
            >
              {isTrial ? "Купить подписку" : "Продлить / сменить"}
            </Link>
          </div>
          {/* ── Подробности использования — встроенный тогглер ── */}
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setUsageOpen((o) => !o)}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/30 transition-colors"
            >
              <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                Подробности использования
              </span>
              <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${usageOpen ? "rotate-180" : ""}`} />
            </button>
            {usageOpen && (
              <div className="px-5 pb-5 space-y-6">
                <TrafficSection />
              </div>
            )}
          </div>
        </div>
      ) : expiredSubscription ? (
        <div className="bg-red-50 border border-red-300 overflow-hidden">
          <div className="h-1 w-full bg-red-500" />
          <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-red-700">
                  {expiredSubscription.isTrial ? "Пробный период" : "Подписка"}
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                  <AlertTriangle className="w-3 h-3" />
                  Завершена
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-red-600 shrink-0" />
                <div className="text-2xl font-black tracking-tight">
                  {expiredSubscription.isTrial ? "Пробный период закончился" : "Подписка закончилась"}
                </div>
              </div>
              <p className="text-sm text-red-800 mt-1.5">
                {expiredSubscription.planName && <>Тариф «{expiredSubscription.planName}» завершён</>}
                {expiredSubscription.endsAt
                  ? `${expiredSubscription.planName ? " " : ""}${formatDate(expiredSubscription.endsAt)}. `
                  : ". "}
                Выберите тариф, чтобы восстановить доступ к VPN.
              </p>
            </div>
            <Link
              href="/plans"
              className="shrink-0 bg-red-600 hover:bg-red-700 text-white px-5 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap"
            >
              Выбрать тариф
            </Link>
          </div>
        </div>
      ) : hasUnusedPromo && promoPlan ? (
        /* ── Promo offer hero — shown instead of plain "no subscription" ── */
        <div className="overflow-hidden border border-violet-300 bg-gradient-to-br from-violet-700 to-indigo-800 shadow-lg shadow-violet-300/20">
          {/* top accent bar */}
          <div className="h-1 w-full bg-gradient-to-r from-violet-400 to-indigo-400 opacity-60" />
          <div className="p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center gap-6">
            {/* icon */}
            <div className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center shrink-0 border border-white/20">
              <Sparkles className="w-8 h-8 text-violet-200" />
            </div>
            {/* text */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-violet-200">
                  Специальное предложение
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 bg-white/15 text-white rounded-full border border-white/20">
                  ✨ Промо
                </span>
              </div>
              <div className="text-2xl font-black tracking-tight text-white">
                {promoPlan.name}
              </div>
              <p className="text-sm text-violet-200 mt-1">
                Доступно по приглашению — всего{" "}
                <strong className="text-white">{promoPlan.priceRub} ₽</strong>
                {promoPlan.durationDays > 0
                  ? ` на ${promoPlan.durationDays} дн.`
                  : ""}
                {promoPlan.maxUses === 1
                  ? " — одноразовое предложение"
                  : promoPlan.maxUses != null
                  ? `, лимит ${promoPlan.maxUses} пользователей`
                  : ""}
                . Оформите сейчас — предложение ограничено.
              </p>
            </div>
            {/* CTA */}
            <Link
              href="/plans"
              className="shrink-0 inline-flex items-center gap-2 bg-white text-violet-700 px-6 py-3 font-bold hover:bg-violet-50 transition-colors whitespace-nowrap"
            >
              Получить доступ <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      ) : (
        <div className="bg-card border-2 border-dashed border-border p-8 flex flex-col sm:flex-row sm:items-center gap-6">
          <div className="w-14 h-14 bg-muted flex items-center justify-center shrink-0">
            <Shield className="w-7 h-7 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground mb-1">Подписка</p>
            <div className="text-xl font-bold text-foreground">Нет активной подписки</div>
            <p className="text-sm text-muted-foreground mt-1">Выберите тариф и получите доступ к сервису.</p>
          </div>
          <Link
            href="/plans"
            className="shrink-0 inline-flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 font-bold hover:opacity-90 transition-opacity"
          >
            Выбрать тариф <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {/* ── Referral ──────────────────────────────────────────────────── */}
      <ReferralSection />

      {/* ── Quick nav ─────────────────────────────────────────────────── */}
      <div className="grid md:grid-cols-3 gap-4">
        <Link
          href="/plans"
          className="group bg-card border border-border p-5 flex items-center justify-between hover:border-primary transition-colors"
        >
          <div>
            <div className="font-bold flex items-center gap-2">
              Тарифы
              {!plansLoading && plans && (
                <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-bold bg-primary/10 text-primary rounded-full">
                  {plans.filter((p) => p.isActive).length}
                </span>
              )}
            </div>
            <div className="text-sm text-muted-foreground">Продлить или сменить план</div>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
        </Link>
        <Link
          href="/keys"
          className="group bg-card border border-border p-5 flex items-center justify-between hover:border-primary transition-colors"
        >
          <div>
            <div className="font-bold flex items-center gap-2">
              Подключение
              {!keysLoading && (
                <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-bold bg-primary/10 text-primary rounded-full">
                  {activeKeys.length}
                </span>
              )}
            </div>
            <div className="text-sm text-muted-foreground">Подключить VPN и управлять устройствами</div>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
        </Link>
        <Link
          href="/payments"
          className="group bg-card border border-border p-5 flex items-center justify-between hover:border-primary transition-colors"
        >
          <div>
            <div className="font-bold flex items-center gap-2">
              Платежи
              {!meLoading && me && (
                <span className="inline-flex items-center justify-center h-5 px-2 text-xs font-bold bg-primary/10 text-primary rounded-full">
                  {formatKopecks(me.balanceKopecks ?? 0)}
                </span>
              )}
            </div>
            <div className="text-sm text-muted-foreground">История и статус оплат</div>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
        </Link>
      </div>

    </div>
  );
}
