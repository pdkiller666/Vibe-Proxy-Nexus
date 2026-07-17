import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListMyPayments,
  useGetMe,
  useCreateBalanceTopupOrder,
  useListMyBalanceTransactions,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Clock, CheckCircle2, XCircle, Info, Wallet, Plus, ArrowUpCircle, ArrowDownCircle, RotateCcw, Users } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";
import { useToast } from "@/hooks/use-toast";

function formatKopecks(kopecks: number): string {
  const rubles = Math.floor(kopecks / 100);
  const cents = kopecks % 100;
  if (cents === 0) return `${rubles} ₽`;
  return `${rubles},${String(cents).padStart(2, "0")} ₽`;
}

function formatDateTime(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

const balanceTxLabel: Record<string, string> = {
  topup: "Пополнение",
  debit: "Списание",
  refund: "Возврат",
  referral: "Реферальная комиссия",
};

function BalanceHistorySection() {
  const { data: transactions, isLoading } = useListMyBalanceTransactions();

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!transactions || transactions.length === 0) return null;

  return (
    <div className="bg-card border border-border p-5 space-y-3">
      <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
        История операций с балансом
      </p>
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {transactions.slice(0, 30).map((tx) => {
          const isPositive = tx.type === "topup" || tx.type === "refund" || tx.type === "referral";
          const Icon =
            tx.type === "topup" ? ArrowUpCircle :
            tx.type === "refund" ? RotateCcw :
            tx.type === "referral" ? Users :
            ArrowDownCircle;
          return (
            <div key={tx.id} className="flex items-center justify-between gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
              <div className="flex items-center gap-2 min-w-0">
                <Icon className={`w-4 h-4 shrink-0 ${isPositive ? "text-green-600" : "text-muted-foreground"}`} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{balanceTxLabel[tx.type] ?? tx.type}</p>
                  {tx.description && <p className="text-xs text-muted-foreground truncate">{tx.description}</p>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className={`text-sm font-bold ${isPositive ? "text-green-600" : "text-foreground"}`}>
                  {isPositive ? "+" : "-"}
                  {formatKopecks(Math.abs(tx.amountKopecks))}
                </p>
                <p className="text-xs text-muted-foreground font-mono">{formatDateTime(tx.createdAt)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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

const statusConfig = {
  pending: { label: "Ожидает", icon: Clock, className: "bg-primary/10 text-primary" },
  confirmed: { label: "Подтверждён", icon: CheckCircle2, className: "bg-green-100 text-green-700" },
  rejected: { label: "Отклонён", icon: XCircle, className: "bg-destructive/10 text-destructive" },
} as const;

function paymentTypeLabel(type: string): string {
  if (type === "extra_device_slot") return "Доп. устройство";
  if (type === "balance_topup") return "Пополнение баланса";
  return "Подписка";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

export default function Payments() {
  const { data: payments, isLoading } = useListMyPayments();

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Платежи</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Баланс, пополнение и история оплат.
        </p>
      </div>

      <BalanceWidget />

      <BalanceHistorySection />

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
                    <div className="font-bold">{payment.amountRub} ₽ · {paymentTypeLabel(payment.type)}</div>
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
