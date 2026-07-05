import { useState } from "react";
import { useParams, Link } from "wouter";
import {
  useListMyPayments,
  useGetPaymentSettings,
  useUpdatePaymentNote,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Copy, CheckCircle2, Clock, XCircle } from "lucide-react";

function CopyField({ label, value }: { label: string; value: string }) {
  const { toast } = useToast();
  return (
    <div className="flex items-center justify-between gap-4 flex-wrap py-3 border-b border-border last:border-0">
      <div className="min-w-0 break-words">
        <div className="text-xs font-mono text-muted-foreground uppercase">{label}</div>
        <div className="font-medium break-all">{value}</div>
      </div>
      <button
        onClick={() => {
          navigator.clipboard.writeText(value);
          toast({ title: "Скопировано" });
        }}
        className="p-2 text-muted-foreground hover:text-primary transition-colors shrink-0"
        aria-label="Копировать"
      >
        <Copy className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function Checkout() {
  const { id } = useParams<{ id: string }>();
  const subscriptionId = Number(id);
  const { data: payments, isLoading: paymentsLoading } = useListMyPayments();
  const { data: settings, isLoading: settingsLoading } = useGetPaymentSettings();
  const { mutate: updateNote, isPending: notePending } = useUpdatePaymentNote();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const payment = payments
    ?.filter((p) => p.subscriptionId === subscriptionId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  function handleSubmitNote() {
    if (!payment || !note.trim()) return;
    updateNote(
      { paymentId: payment.id, data: { userNote: note.trim() } },
      {
        onSuccess: () => {
          setSubmitted(true);
          toast({ title: "Отметка сохранена", description: "Ожидайте подтверждения администратором." });
        },
        onError: () => {
          toast({ title: "Не удалось сохранить отметку", variant: "destructive" });
        },
      },
    );
  }

  if (paymentsLoading || settingsLoading) {
    return (
      <div className="space-y-4 max-w-xl">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!payment) {
    return (
      <div className="max-w-xl animate-in fade-in duration-500">
        <p className="text-muted-foreground">Платёж не найден.</p>
        <Link href="/plans" className="text-primary font-medium">
          Вернуться к тарифам
        </Link>
      </div>
    );
  }

  const statusConfig = {
    pending: { label: "Ожидает подтверждения", icon: Clock, color: "text-primary" },
    confirmed: { label: "Подтверждён", icon: CheckCircle2, color: "text-green-600" },
    rejected: { label: "Отклонён", icon: XCircle, color: "text-destructive" },
  } as const;

  const status = statusConfig[payment.status];
  const StatusIcon = status.icon;

  return (
    <div className="max-w-xl space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Оплата через СБП</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Переведите указанную сумму и подтвердите оплату ниже.
        </p>
      </div>

      <div className={`flex items-center gap-2 font-bold ${status.color}`}>
        <StatusIcon className="w-5 h-5" />
        {status.label}
      </div>

      {payment.status === "rejected" && payment.rejectionReason && (
        <div className="bg-destructive/10 border border-destructive/30 p-4 text-sm text-destructive">
          Причина отклонения: {payment.rejectionReason}
        </div>
      )}

      <div className="bg-card border border-border p-6">
        <CopyField label="Сумма" value={`${payment.amountRub} ₽`} />
        <CopyField label="Телефон СБП" value={settings?.sbpPhone ?? "—"} />
        <CopyField label="Банк" value={settings?.sbpBank ?? "—"} />
        <CopyField label="Получатель" value={settings?.sbpRecipientName ?? "—"} />
        <CopyField label="Референс платежа" value={payment.reference} />
      </div>

      {settings?.instructions && (
        <p className="text-sm text-muted-foreground font-mono whitespace-pre-line">
          {settings.instructions}
        </p>
      )}

      {payment.status === "pending" && (
        <div className="space-y-3">
          <label className="text-sm font-bold block">
            Отметка об оплате (например, время перевода)
          </label>
          <Textarea
            value={note || payment.userNote || ""}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Оплатил(а) в 14:32, перевод прошёл"
            className="rounded-none"
          />
          <button
            onClick={handleSubmitNote}
            disabled={notePending || (!note.trim() && !payment.userNote)}
            className="bg-primary text-primary-foreground font-bold px-6 py-3 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {notePending ? "Сохраняем..." : submitted || payment.userNote ? "Обновить отметку" : "Я оплатил(а)"}
          </button>
          <p className="text-xs text-muted-foreground">
            Это не автоматическая оплата картой — администратор вручную сверит перевод и активирует подписку.
          </p>
        </div>
      )}
    </div>
  );
}
