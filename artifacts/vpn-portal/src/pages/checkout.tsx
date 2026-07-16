import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import {
  useListMyPayments,
  useGetPaymentSettings,
  useUpdatePaymentNote,
  getListMyPaymentsQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Copy, CheckCircle2, Clock, XCircle, AlertTriangle } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PaymentScreenshotUpload } from "@/components/payment-screenshot-upload";
import { FkPaymentButtons } from "@/components/fk-payment-buttons";

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
  const [, setLocation] = useLocation();
  const { data: payments, isLoading: paymentsLoading } = useListMyPayments({
    query: {
      queryKey: getListMyPaymentsQueryKey(),
      refetchInterval: (query) => {
        const list = query.state.data;
        const current = list
          ?.filter((p) => p.subscriptionId === subscriptionId)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        return !current || current.status === "pending" ? 15_000 : false;
      },
    },
  });
  const { data: settings, isLoading: settingsLoading } = useGetPaymentSettings();
  const { mutate: updateNote, isPending: notePending } = useUpdatePaymentNote();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const payment = payments
    ?.filter((p) => p.subscriptionId === subscriptionId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  // #5 — User-initiated cancellation of their own pending_payment subscription.
  const { mutate: cancelSubscription, isPending: cancelling } = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/subscriptions/${subscriptionId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Не удалось отменить подписку");
      }
    },
    onSuccess: () => {
      toast({ title: "Подписка отменена" });
      queryClient.invalidateQueries({ queryKey: ["payments", "me"] });
      queryClient.invalidateQueries({ queryKey: ["subscriptions", "me"] });
      setLocation("/plans");
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
      setConfirmCancel(false);
    },
  });

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
        <h1 className="text-2xl font-bold tracking-tight">Оплата подписки</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Выберите удобный способ оплаты.
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

      {payment.status === "pending" && (
        <>
          {/* Primary: FreeKassa online payment */}
          <div className="bg-card border border-primary/40 p-6">
            <FkPaymentButtons paymentId={payment.id} amountRub={payment.amountRub} />
          </div>

          {/* Fallback: manual SBP transfer */}
          <details className="group">
            <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground transition-colors select-none list-none flex items-center gap-2">
              <span className="border border-border px-3 py-1.5 hover:bg-muted transition-colors inline-block">
                Альтернатива: перевод по СБП вручную
              </span>
            </summary>
            <div className="mt-4 space-y-4">
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
                  Администратор вручную сверит перевод и активирует подписку. Обычно до нескольких часов.
                </p>
              </div>
              <PaymentScreenshotUpload paymentId={payment.id} hasScreenshot={payment.hasScreenshot} />
            </div>
          </details>

          {/* Cancel pending subscription */}
          <div className="border-t border-border pt-6">
            {!confirmCancel ? (
              <button
                onClick={() => setConfirmCancel(true)}
                className="text-sm text-muted-foreground hover:text-destructive transition-colors underline underline-offset-2"
              >
                Отменить заявку на подписку
              </button>
            ) : (
              <div className="bg-destructive/10 border border-destructive/30 p-4 space-y-3">
                <div className="flex items-start gap-2 text-sm text-destructive font-medium">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  Вы уверены? Заявка будет отменена. Если вы уже перевели деньги — свяжитесь с поддержкой.
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={() => cancelSubscription()}
                    disabled={cancelling}
                    className="bg-destructive text-destructive-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {cancelling ? "Отменяем..." : "Да, отменить"}
                  </button>
                  <button
                    onClick={() => setConfirmCancel(false)}
                    className="border border-border px-4 py-2 text-sm hover:bg-muted transition-colors"
                  >
                    Назад
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
