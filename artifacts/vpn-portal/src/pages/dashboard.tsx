import { Link } from "wouter";
import { useGetMe, useListMyVpnKeys } from "@workspace/api-client-react";
import { Shield, Key, CreditCard, ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

function formatDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function Dashboard() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const { data: keys, isLoading: keysLoading } = useListMyVpnKeys();

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Панель управления</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Статус вашего доступа к узлу.
        </p>
      </div>

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
              <p className="text-sm text-muted-foreground mt-1">
                Активна до {formatDate(me.subscriptionEndsAt)}
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
