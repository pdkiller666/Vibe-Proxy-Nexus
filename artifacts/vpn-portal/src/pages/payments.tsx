import { useListMyPayments } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, CheckCircle2, XCircle, Info } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";

const statusConfig = {
  pending: { label: "Ожидает", icon: Clock, className: "bg-primary/10 text-primary" },
  confirmed: { label: "Подтверждён", icon: CheckCircle2, className: "bg-green-100 text-green-700" },
  rejected: { label: "Отклонён", icon: XCircle, className: "bg-destructive/10 text-destructive" },
} as const;

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

export default function Payments() {
  const { data: payments, isLoading } = useListMyPayments();

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">История платежей</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Статус ваших обращений по оплате.
        </p>
      </div>

      <OnboardingTip
        id="payments-info"
        icon={<Info className="w-4 h-4" />}
        title="Как работают платежи"
      >
        <p>
          После оплаты тарифа через СБП здесь появится запись со статусом <strong>«Ожидает»</strong>.
        </p>
        <p>
          Когда администратор подтвердит перевод, статус сменится на <strong>«Подтверждён»</strong>
          — и подписка активируется автоматически.
        </p>
      </OnboardingTip>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : !payments || payments.length === 0 ? (
        <p className="text-muted-foreground">Платежей пока нет.</p>
      ) : (
        <div className="space-y-3">
          {payments
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((payment, i) => {
              const status = statusConfig[payment.status];
              const StatusIcon = status.icon;
              return (
                <div
                  key={payment.id}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="bg-card border border-border p-5 flex items-center justify-between gap-4 flex-wrap animate-in fade-in slide-in-from-bottom-1 duration-500"
                >
                  <div className="min-w-0 break-words">
                    <div className="font-bold">{payment.amountRub} ₽</div>
                    <div className="text-sm text-muted-foreground font-mono">
                      {formatDate(payment.createdAt)} · {payment.reference}
                    </div>
                    {payment.status === "rejected" && payment.rejectionReason && (
                      <div className="text-sm text-destructive mt-1">{payment.rejectionReason}</div>
                    )}
                  </div>
                  <span
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold shrink-0 ${status.className}`}
                  >
                    <StatusIcon className="w-3.5 h-3.5" />
                    {status.label}
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
