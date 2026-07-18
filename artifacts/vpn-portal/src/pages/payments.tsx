import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useListMyPayments,
  useGetMe,
  useCreateBalanceTopupOrder,
  useListMyBalanceTransactions,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import type { BalanceTransaction, Payment } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Clock, CheckCircle2, XCircle, Info, Wallet, Plus,
  ArrowUpCircle, ArrowDownCircle, RotateCcw, Users, ChevronDown, ChevronRight,
} from "lucide-react";
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

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function formatDayLabel(dayKey: string) {
  // dayKey is a local-date key "YYYY-MM-DD"
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

const balanceTxLabel: Record<string, string> = {
  topup: "Пополнение",
  debit: "Списание",
  refund: "Возврат",
  referral: "Реферальная комиссия",
};

const statusConfig = {
  pending: { label: "Ожидает", icon: Clock, className: "bg-primary/10 text-primary" },
  confirmed: { label: "Подтверждён", icon: CheckCircle2, className: "bg-green-100 text-green-700" },
  rejected: { label: "Отклонён", icon: XCircle, className: "bg-destructive/10 text-destructive" },
} as const;

function paymentTypeLabel(type: string): string {
  if (type === "extra_device_slot") return "Доп. устройство";
  if (type === "extra_traffic") return "Доп. трафик";
  if (type === "balance_topup") return "Пополнение баланса";
  return "Подписка";
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

/** Prominent cards for payments awaiting confirmation — they need user action. */
function PendingPaymentsSection({ payments }: { payments: Payment[] }) {
  const [, setLocation] = useLocation();
  if (payments.length === 0) return null;
  return (
    <div className="space-y-3">
      {payments.map((payment) => (
        <div
          key={payment.id}
          className="bg-card border border-primary/50 p-5 flex items-center justify-between gap-4 flex-wrap animate-in fade-in duration-500"
        >
          <div className="min-w-0 break-words">
            <div className="font-bold">{payment.amountRub} ₽ · {paymentTypeLabel(payment.type)}</div>
            <div className="text-sm text-muted-foreground font-mono">
              {formatDate(payment.createdAt)} · {payment.reference}
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 flex-wrap">
            {payment.type === "balance_topup" && (
              <button
                onClick={() => setLocation(`/balance-topup/${payment.id}`)}
                className="bg-primary text-primary-foreground font-bold px-4 py-1.5 text-xs hover:opacity-90 transition-opacity"
              >
                Продолжить оплату
              </button>
            )}
            <span className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary">
              <Clock className="w-3.5 h-3.5" /> Ожидает
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

type FeedEntry =
  | { kind: "tx"; ts: number; tx: BalanceTransaction }
  | { kind: "debitGroup"; ts: number; day: string; totalKopecks: number; items: BalanceTransaction[] }
  | { kind: "payment"; ts: number; payment: Payment };

type FeedFilter = "all" | "debits" | "topups" | "payments";

const filterLabels: Record<FeedFilter, string> = {
  all: "Все",
  debits: "Списания",
  topups: "Пополнения",
  payments: "Платежи",
};

function localDayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Builds the unified feed:
 * - balance transactions are the source of truth for balance movements;
 *   hourly/other debits are grouped per calendar day into one collapsible row;
 * - completed payments (confirmed subscriptions/slots + everything rejected)
 *   are merged in with their status badge;
 * - confirmed balance top-up payments are EXCLUDED — the same money already
 *   appears as a `topup` balance transaction, so showing both would duplicate.
 */
function buildFeed(transactions: BalanceTransaction[], payments: Payment[]): FeedEntry[] {
  const entries: FeedEntry[] = [];

  const debitsByDay = new Map<string, BalanceTransaction[]>();
  for (const tx of transactions) {
    if (tx.type === "debit") {
      const day = localDayKey(tx.createdAt);
      const list = debitsByDay.get(day) ?? [];
      list.push(tx);
      debitsByDay.set(day, list);
    } else {
      entries.push({ kind: "tx", ts: new Date(tx.createdAt).getTime(), tx });
    }
  }
  for (const [day, items] of debitsByDay) {
    const ts = Math.max(...items.map((t) => new Date(t.createdAt).getTime()));
    const totalKopecks = items.reduce((sum, t) => sum + Math.abs(t.amountKopecks), 0);
    entries.push({ kind: "debitGroup", ts, day, totalKopecks, items });
  }

  for (const payment of payments) {
    if (payment.status === "pending") continue; // shown separately above the feed
    if (payment.status === "confirmed" && payment.type === "balance_topup") continue; // dedupe with topup tx
    entries.push({ kind: "payment", ts: new Date(payment.createdAt).getTime(), payment });
  }

  return entries.sort((a, b) => b.ts - a.ts);
}

function TxRow({ tx }: { tx: BalanceTransaction }) {
  const isPositive = tx.type === "topup" || tx.type === "refund" || tx.type === "referral";
  const Icon =
    tx.type === "topup" ? ArrowUpCircle :
    tx.type === "refund" ? RotateCcw :
    tx.type === "referral" ? Users :
    ArrowDownCircle;
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
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
}

function DebitGroupRow({ entry }: { entry: Extract<FeedEntry, { kind: "debitGroup" }> }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="py-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 py-1.5 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Chevron className="w-4 h-4 shrink-0 text-muted-foreground" />
          <ArrowDownCircle className="w-4 h-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Списания за {formatDayLabel(entry.day)}</p>
            <p className="text-xs text-muted-foreground">{entry.items.length} операц. · почасовой тариф и др.</p>
          </div>
        </div>
        <p className="text-sm font-bold shrink-0">-{formatKopecks(entry.totalKopecks)}</p>
      </button>
      {open && (
        <div className="pl-6 border-l border-border ml-2 mt-1">
          {entry.items
            .slice()
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((tx) => (
              <div key={tx.id} className="flex items-center justify-between gap-3 py-1">
                <p className="text-xs text-muted-foreground truncate">{tx.description || "Списание"}</p>
                <div className="text-right shrink-0">
                  <span className="text-xs font-semibold">-{formatKopecks(Math.abs(tx.amountKopecks))}</span>
                  <span className="text-xs text-muted-foreground font-mono ml-2">{formatDateTime(tx.createdAt)}</span>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function PaymentRow({ payment }: { payment: Payment }) {
  const status = statusConfig[payment.status];
  const StatusIcon = status.icon;
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 flex-wrap">
      <div className="min-w-0 break-words">
        <p className="text-sm font-semibold">{payment.amountRub} ₽ · {paymentTypeLabel(payment.type)}</p>
        <p className="text-xs text-muted-foreground font-mono">
          {formatDateTime(payment.createdAt)} · {payment.reference}
        </p>
        {payment.status === "rejected" && payment.rejectionReason && (
          <p className="text-xs text-destructive mt-0.5">{payment.rejectionReason}</p>
        )}
      </div>
      <span className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold shrink-0 ${status.className}`}>
        <StatusIcon className="w-3.5 h-3.5" />
        {status.label}
      </span>
    </div>
  );
}

function UnifiedHistorySection({
  transactions,
  payments,
}: {
  transactions: BalanceTransaction[];
  payments: Payment[];
}) {
  const [filter, setFilter] = useState<FeedFilter>("all");
  const feed = useMemo(() => buildFeed(transactions, payments), [transactions, payments]);

  const filtered = feed.filter((e) => {
    if (filter === "all") return true;
    if (filter === "debits") return e.kind === "debitGroup";
    if (filter === "topups") return e.kind === "tx";
    return e.kind === "payment";
  });

  if (feed.length === 0) return <p className="text-muted-foreground">Операций пока нет.</p>;

  return (
    <div className="bg-card border border-border p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs font-mono font-bold uppercase tracking-widest text-muted-foreground">
          История операций
        </p>
        <div className="flex gap-1.5 flex-wrap">
          {(Object.keys(filterLabels) as FeedFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-xs font-semibold border transition-colors ${
                filter === f
                  ? "border-primary text-primary bg-primary/10"
                  : "border-border text-muted-foreground hover:border-primary/50"
              }`}
            >
              {filterLabels[f]}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-96 overflow-y-auto divide-y divide-border">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">Нет операций в этой категории.</p>
        ) : (
          filtered.slice(0, 60).map((entry) => {
            if (entry.kind === "tx") return <TxRow key={`tx-${entry.tx.id}`} tx={entry.tx} />;
            if (entry.kind === "debitGroup") return <DebitGroupRow key={`dg-${entry.day}`} entry={entry} />;
            return <PaymentRow key={`p-${entry.payment.id}`} payment={entry.payment} />;
          })
        )}
      </div>
    </div>
  );
}

export default function Payments() {
  const { data: payments, isLoading: paymentsLoading } = useListMyPayments();
  const { data: transactions, isLoading: txLoading } = useListMyBalanceTransactions();

  const pendingPayments = (payments ?? []).filter((p) => p.status === "pending");

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Платежи</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Баланс, пополнение и история операций.
        </p>
      </div>

      <BalanceWidget />

      <PendingPaymentsSection payments={pendingPayments} />

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

      {paymentsLoading || txLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <UnifiedHistorySection transactions={transactions ?? []} payments={payments ?? []} />
      )}
    </div>
  );
}
