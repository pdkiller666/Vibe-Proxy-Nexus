import { useState } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useListMyVpnKeys,
  useCreateExtraTrafficOrder,
  useGetPaymentSettings,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { queryClient } from "@/lib/query-client";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import {
  Shield,
  Key,
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
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { OnboardingTip } from "@/components/onboarding-tip";
import { useToast } from "@/hooks/use-toast";

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

  if (!me?.referralCode) return null;

  const referralLink = `https://${me.referralLinkHost}/sign-up?ref=${me.referralCode}`;

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
    <div className="bg-card border border-border p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-primary" />
        <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
          Реферальная программа
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-0 font-mono text-sm bg-muted px-3 py-2 truncate select-all">
          {referralLink}
        </div>
        <button
          onClick={copyLink}
          className="shrink-0 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors flex items-center gap-1.5"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? "Скопировано" : "Копировать"}
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
          {copiedCode ? "Скопировано" : "Копировать"}
        </button>
      </div>
      <div className="flex items-center gap-6 flex-wrap text-sm border-t border-border pt-3">
        <div>
          <span className="text-muted-foreground">Приглашено:</span>{" "}
          <strong className="text-foreground">{me.referredUserCount}</strong>
        </div>
        {me.referralCommissionPercent > 0 && (
          <>
            <div>
              <span className="text-muted-foreground">Заработано:</span>{" "}
              <strong className="text-green-600">{formatKopecks(me.referralEarningsKopecks)}</strong>
            </div>
            <div className="text-xs text-muted-foreground font-mono">
              {me.referralCommissionPercent}% от оплат ваших рефералов
            </div>
          </>
        )}
      </div>
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
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: keys, isLoading: keysLoading } = useListMyVpnKeys();
  const { toast } = useToast();

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];
  const daysLeft = getDaysLeft(me?.subscriptionEndsAt as string | null | undefined);
  const isExpiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 5;
  const isExpired = daysLeft !== null && daysLeft < 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Панель управления</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Статус вашего доступа к сервису.
        </p>
      </div>

      <OnboardingTip
        id="dashboard-welcome"
        icon={<Sparkles className="w-4 h-4" />}
        title="Добро пожаловать в VPNexus!"
      >
        <p>Здесь — статус вашей подписки и быстрый доступ ко всем разделам.</p>
        <p>
          <strong>Следующий шаг:</strong> откройте раздел{" "}
          <Link href="/keys" className="underline font-semibold">Ключи VPN</Link>{" "}
          — первый ключ уже готов, подключитесь к интернету за минуту.
        </p>
      </OnboardingTip>

      {isExpiringSoon && !isExpired && (
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

      {/* ── Subscription hero block ───────────────────────────────── */}
      {meLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : me?.hasActiveSubscription && me.currentPlanBillingType === "hourly" ? (
        <div className="bg-card border border-border overflow-hidden">
          <div className="h-1 w-full bg-primary" />
          <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-6">
            <div className="w-14 h-14 bg-primary/10 flex items-center justify-center shrink-0">
              <Zap className="w-7 h-7 text-primary" />
            </div>
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
              <div className="text-2xl font-black tracking-tight">{me.currentPlanName}</div>
              <p className="text-sm text-muted-foreground mt-2">
                Почасовая оплата — {formatKopecks(me.hourlyRateKopecks ?? 0)}/час, списывается автоматически с баланса, пока есть трафик. Ничего останавливать не нужно.
              </p>
            </div>
            <Link
              href="/plans"
              className="shrink-0 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
            >
              Сменить тариф
            </Link>
          </div>
        </div>
      ) : me?.hasActiveSubscription ? (
        <div className="bg-card border border-border overflow-hidden">
          {/* colour bar */}
          <div className={`h-1 w-full ${isExpiringSoon ? "bg-orange-400" : "bg-primary"}`} />
          <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-6">
            {/* icon */}
            <div className={`w-14 h-14 flex items-center justify-center shrink-0
              ${isExpiringSoon ? "bg-orange-100" : "bg-primary/10"}`}>
              <Shield className={`w-7 h-7 ${isExpiringSoon ? "text-orange-600" : "text-primary"}`} />
            </div>
            {/* info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
                  Подписка
                </span>
                <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full
                  ${isExpiringSoon
                    ? "bg-orange-100 text-orange-700"
                    : "bg-green-100 text-green-700"}`}>
                  <CheckCircle2 className="w-3 h-3" />
                  Активна
                </span>
              </div>
              <div className="text-2xl font-black tracking-tight">{me.currentPlanName}</div>
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
                      className={`h-full rounded-full transition-all ${isExpiringSoon ? "bg-orange-400" : "bg-primary"}`}
                      style={{ width: `${Math.max(4, Math.min(100, (daysLeft / 30) * 100))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
            {/* action */}
            <Link
              href="/plans"
              className="shrink-0 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
            >
              Продлить / сменить
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

      {/* ── Usage detail: right after subscription so traffic/key info is
           immediately visible; collapsed on mobile to keep the hero clean ── */}
      <CollapsibleOnMobile title="Подробности использования">
        <div className="space-y-6 pt-1">
          <TrafficSection />
        </div>
      </CollapsibleOnMobile>

      {/* ── Quick nav ─────────────────────────────────────────────────── */}
      <div className="grid md:grid-cols-3 gap-4">
        <Link
          href="/plans"
          className="group bg-card border border-border p-5 flex items-center justify-between hover:border-primary transition-colors"
        >
          <div>
            <div className="font-bold">Тарифы</div>
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
              Ключи VPN
              {!keysLoading && (
                <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-bold bg-primary/10 text-primary rounded-full">
                  {activeKeys.length}
                </span>
              )}
            </div>
            <div className="text-sm text-muted-foreground">Управление доступом</div>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-1 transition-all" />
        </Link>
        <Link
          href="/payments"
          className="group bg-card border border-border p-5 flex items-center justify-between hover:border-primary transition-colors"
        >
          <div>
            <div className="font-bold">Платежи</div>
            <div className="text-sm text-muted-foreground">История и статус оплат</div>
          </div>
          <CreditCard className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-all" />
        </Link>
      </div>

      {/* ── Referral ──────────────────────────────────────────────── */}
      <ReferralSection />
    </div>
  );
}
