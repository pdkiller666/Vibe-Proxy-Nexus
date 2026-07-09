import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetMe, useListMyVpnKeys, useCreateBalanceTopupOrder, getGetMeQueryKey } from "@workspace/api-client-react";
import { Shield, Key, CreditCard, ArrowRight, AlertTriangle, CheckCircle2, Clock, Sparkles, Wallet, Plus, Zap } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
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

function BalanceWidget() {
  const { data: me } = useGetMe();
  const { mutate: createTopup, isPending } = useCreateBalanceTopupOrder();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [showForm, setShowForm] = useState(false);

  function handleTopup() {
    const amountRub = Number(amount);
    if (!amountRub || amountRub < 1) return;
    createTopup(
      { data: { amountRub } },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          setLocation(`/balance-topup/${data.paymentId}`);
        },
        onError: (err: unknown) => {
          const msg = err instanceof Error ? err.message : undefined;
          toast({ title: msg ?? "Не удалось создать заявку", variant: "destructive" });
        },
      },
    );
  }

  return (
    <div className="bg-card border border-border p-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-primary/10 flex items-center justify-center shrink-0">
            <Wallet className="w-5 h-5 text-primary" />
          </div>
          <div>
            <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Баланс</p>
            <div className="text-2xl font-black">{me ? formatKopecks(me.balanceKopecks) : "—"}</div>
          </div>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
        >
          <Plus className="w-4 h-4" /> Пополнить
        </button>
      </div>
      {showForm && (
        <div className="mt-4 flex gap-2 flex-wrap">
          <Input
            type="number"
            min={1}
            placeholder="Сумма, ₽"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="rounded-none w-36"
          />
          <button
            onClick={handleTopup}
            disabled={isPending || !amount || Number(amount) < 1}
            className="bg-primary text-primary-foreground font-bold px-5 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isPending ? "Создаём..." : "Перейти к оплате"}
          </button>
          <button
            onClick={() => { setShowForm(false); setAmount(""); }}
            className="border border-border px-4 py-2 text-sm hover:bg-muted transition-colors"
          >
            Отмена
          </button>
        </div>
      )}
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

      {/* ── Balance ───────────────────────────────────────────────── */}
      <BalanceWidget />

      {/* ── Key count ─────────────────────────────────────────────── */}
      <div className="bg-card border border-border p-5 flex items-center gap-5">
        <div className="w-10 h-10 bg-primary/10 flex items-center justify-center shrink-0">
          <Key className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">Активных ключей</p>
          {keysLoading ? (
            <Skeleton className="h-7 w-16 mt-1" />
          ) : (
            <div className="text-3xl font-black">{activeKeys.length}</div>
          )}
        </div>
        <Link
          href="/keys"
          className="flex items-center gap-1 text-sm font-semibold text-primary hover:opacity-70 transition-opacity"
        >
          Управление <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      {/* ── Quick nav ─────────────────────────────────────────────── */}
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
            <div className="font-bold">Ключи VPN</div>
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
    </div>
  );
}
