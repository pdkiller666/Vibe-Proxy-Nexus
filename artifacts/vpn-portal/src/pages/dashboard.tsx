import { Link } from "wouter";
import { useGetMe, useListMyVpnKeys } from "@workspace/api-client-react";
import { Shield, Key, CreditCard, ArrowRight, AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

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

export default function Dashboard() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: keys, isLoading: keysLoading } = useListMyVpnKeys();

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];
  const daysLeft = getDaysLeft(me?.subscriptionEndsAt as string | null | undefined);
  const isExpiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 5;
  const isExpired = daysLeft !== null && daysLeft < 0;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Панель управления</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Статус вашего доступа к узлу.
        </p>
      </div>

      {isExpiringSoon && !isExpired && (
        <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 p-4 text-sm text-orange-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Подписка истекает через <strong>{daysLeft === 0 ? "менее суток" : `${daysLeft} ${daysLeft === 1 ? "день" : daysLeft <= 4 ? "дня" : "дней"}`}</strong>.{" "}
            <Link href="/plans" className="underline font-semibold hover:text-orange-900">
              Продлить сейчас
            </Link>
          </span>
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        <div className="bg-card border border-border p-6 col-span-1 md:col-span-2">
          <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground mb-3">
            <Shield className="w-4 h-4 text-primary" />
            ПОДПИСКА
          </div>
          {meLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : me?.hasActiveSubscription ? (
            <div>
              <div className="text-2xl font-bold">{me.currentPlanName}</div>
              <p className={`text-sm mt-1 ${isExpiringSoon ? "text-orange-600 font-medium" : "text-muted-foreground"}`}>
                Активна до {formatDate(me.subscriptionEndsAt as string | null | undefined)}
                {isExpiringSoon && daysLeft !== null && daysLeft >= 0 && (
                  <span className="ml-1">
                    ({daysLeft === 0 ? "последний день" : `осталось ${daysLeft} ${daysLeft === 1 ? "день" : daysLeft <= 4 ? "дня" : "дней"}`})
                  </span>
                )}
              </p>
            </div>
          ) : (
            <div>
              <div className="text-xl font-bold text-muted-foreground">Нет активной подписки</div>
              <Link
                href="/plans"
                className="inline-flex items-center gap-2 mt-4 bg-primary text-primary-foreground px-5 py-2.5 text-sm font-bold hover:opacity-90 transition-opacity"
              >
                Выбрать тариф <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          )}
        </div>

        <div className="bg-card border border-border p-6">
          <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground mb-3">
            <Key className="w-4 h-4 text-primary" />
            КЛЮЧИ
          </div>
          {keysLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="text-3xl font-bold">{activeKeys.length}</div>
          )}
          <p className="text-sm text-muted-foreground mt-1">активных ключей доступа</p>
        </div>
      </div>

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
