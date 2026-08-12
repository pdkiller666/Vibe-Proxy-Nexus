import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  useGetAdminDashboardSummary,
  useListAdminPayments,
  useConfirmPayment,
  useRejectPayment,
  useListPlans,
  useCreatePlan,
  useUpdatePlan,
  useDeletePlan,
  useListVpnNodes,
  useCreateVpnNode,
  useUpdateVpnNode,
  useDeleteVpnNode,
  useListAdminUsers,
  useUpdateUserRole,
  useUpdateUserExtraSlots,
  useUpdateUserProfile,
  useUpdateUserSubscription,
  useDeleteUser,
  useAdminResetUserPassword,
  useAdminSetUserBalance,
  useAdminSetUserPassword,
  useGetPaymentSettings,
  useUploadSbpQr,
  useDeleteSbpQr,
  useUpdatePaymentSettings,
  getGetAdminDashboardSummaryQueryKey,
  getListAdminPaymentsQueryKey,
  getListPlansQueryKey,
  getListVpnNodesQueryKey,
  getListAdminUsersQueryKey,
  getGetPaymentSettingsQueryKey,
  useListAdminTickets,
  useGetAdminTicket,
  useAdminAddTicketMessage,
  useUpdateTicketStatus,
  getListAdminTicketsQueryKey,
  getGetAdminTicketQueryKey,
  useListAdminUserBalanceTransactions,
  useAdminForceLogout,
  useAdminBanUser,
  useAdminUnbanUser,
  useAdminSetUserNote,
  useGetVpnNodeHealth,
  getGetVpnNodeHealthQueryKey,
  useGetAdminTrafficPollingHealth,
  getGetAdminTrafficPollingHealthQueryKey,
  useListAdminPlans,
  getListAdminPlansQueryKey,
  useListAdminVpnKeys,
  getListAdminVpnKeysQueryKey,
  useListAdminReferrals,
  useListAdminInviteLinks,
  useCreateAdminInviteLink,
  useUpdateAdminInviteLink,
  useDeleteAdminInviteLink,
  getListAdminInviteLinksQueryKey,
  useGetAdminInviteLinkUsers,
  useListAdminSystemEvents,
  useAcknowledgeAdminSystemEvent,
  useAcknowledgeAllAdminSystemEvents,
  useGetAdminSystemEventsHistory,
  getListAdminSystemEventsQueryKey,
  getGetAdminSystemEventsHistoryQueryKey,
  useSendAdminBroadcast,
  useListAdminBroadcasts,
  getListAdminBroadcastsQueryKey,
  useSearchAdminUsers,
  useProvisionVpnNode,
  useGetVpnNodeSystemStatus,
  useGetVpnNodeSystemLogs,
  useRestartVpnNodeXray,
  useGetVpnNodeMetrics,
  getGetVpnNodeSystemStatusQueryKey,
  getGetVpnNodeSystemLogsQueryKey,
  GetVpnNodeSystemLogsProcess,
  GetVpnNodeMetricsMetric,
  useGetAdminAuditLog,
  useGetMe,
  AdminAuditLogAction,
} from "@workspace/api-client-react";
import type { Plan, VpnNode, SupportTicket, TicketStatus, AdminUser, AdminBalanceTransaction, AdminNotification, AdminInviteLink, AdminInviteLinkUser, AdminAuditLogEntry, AdminUserSearchResult } from "@workspace/api-client-react";
import { queryClient } from "@/lib/query-client";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, X, Trash2, Pencil, Plus, Users, CreditCard, Shield, Settings, Key, Copy, MessageCircle, Send, ArrowLeft, Bell, Image as ImageIcon, AlertTriangle, TrendingUp, Clock, Wallet, Share2, CheckSquare, Square, ChevronDown, ChevronUp, Link2, Activity, RefreshCw, Terminal, RotateCcw, Zap, Server, LineChart as LineChartIcon, ClipboardList, Download } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { SupportMessageAttachmentDisplay } from "@/components/support-attachment-picker";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function Metric({ label, value, highlight }: { label: string; value: string | number; highlight?: boolean }) {
  return (
    <div className={`bg-card border p-5 ${highlight ? "border-orange-400 bg-orange-50/50" : "border-border"}`}>
      <div className={`text-xs font-mono uppercase mb-1 ${highlight ? "text-orange-600 font-bold" : "text-muted-foreground"}`}>{label}</div>
      <div className={`text-2xl font-bold ${highlight ? "text-orange-700" : ""}`}>{value}</div>
    </div>
  );
}

function Badge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-orange-600 text-white text-[10px] font-bold leading-none">
      {count > 99 ? "99+" : count}
    </span>
  );
}

// ─── Payment notification poller ─────────────────────────────────────────────
// Unified poller: payments + audit log actions from other admins.
//
// Pending payments: the backend returns ALL currently pending payments on every
// poll (no time filter), so the bell always reflects the live queue — even
// payments submitted before the admin opened the page. The local state is
// replaced (not accumulated) on each successful poll so the badge count stays
// accurate when payments are confirmed / rejected externally.
//
// Confirmed / rejected: returned only since the last poll timestamp so we can
// fire a one-time toast without accumulating stale history.
//
// Audit log: actions by OTHER admins, deduplicated by entry id.
function useUnifiedPoller(currentAdminId: number | undefined): {
  payments: AdminNotification[];
  otherAdminActions: AdminAuditLogEntry[];
} {
  const { toast } = useToast();

  // ── Payments ──────────────────────────────────────────────────────────────
  // seenEventKeys tracks `${id}:${status}` so a pending→confirmed transition
  // fires a toast even though the same id was seen before.
  const seenEventKeys = useRef<Set<string>>(new Set());
  const paymentSinceRef = useRef(new Date(Date.now() - 2 * 60 * 1000).toISOString());
  // Live pending queue — replaced on every successful poll.
  const [payments, setPayments] = useState<AdminNotification[]>([]);

  // ── Audit log (other admins) ───────────────────────────────────────────────
  const seenAuditIds = useRef<Set<number>>(new Set());
  const auditSinceRef = useRef(new Date(Date.now() - 2 * 60 * 1000).toISOString());
  const [otherAdminActions, setOtherAdminActions] = useState<AdminAuditLogEntry[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const now = new Date().toISOString();

      // ── Poll payments ──────────────────────────────────────────────────────
      try {
        const res = await fetch(
          `/api/admin/notifications?since=${encodeURIComponent(paymentSinceRef.current)}`,
          { credentials: "include" },
        );
        if (res.ok && !cancelled) {
          const data: AdminNotification[] = await res.json();

          const pendingPayments = data.filter((n) => n.status === "pending");
          const statusChanges  = data.filter((n) => n.status === "confirmed" || n.status === "rejected");

          // Toast for newly-submitted pending payments (first time we see them).
          for (const n of pendingPayments) {
            const key = `${n.id}:pending`;
            if (!seenEventKeys.current.has(key)) {
              seenEventKeys.current.add(key);
              const providerLabel =
                n.provider === "yoomoney" ? "ЮMoney" :
                n.provider === "balance"  ? "Баланс" : "СБП";
              const typeLabel =
                n.type === "extra_device_slot" ? "Доп. устройство" :
                n.type === "balance_topup"     ? "Пополнение баланса" :
                n.type === "extra_traffic"     ? `Доп. трафик${n.extraTrafficGb ? ` (+${n.extraTrafficGb} ГБ)` : ""}` :
                                                 "Подписка";
              toast({ title: "Новый платёж", description: `${n.userEmail} · ${typeLabel} · ${n.amountRub} ₽ · ${providerLabel}` });
            }
          }

          // Toast for confirmed / rejected (deduplicated by id+status).
          for (const n of statusChanges) {
            const key = `${n.id}:${n.status}`;
            if (!seenEventKeys.current.has(key)) {
              seenEventKeys.current.add(key);
              const typeLabel =
                n.type === "extra_device_slot" ? "Доп. устройство" :
                n.type === "balance_topup"     ? "Пополнение баланса" :
                n.type === "extra_traffic"     ? `Доп. трафик${n.extraTrafficGb ? ` (+${n.extraTrafficGb} ГБ)` : ""}` :
                                                 "Подписка";
              if (n.status === "confirmed") {
                toast({ title: "Платёж подтверждён", description: `${n.userEmail} · ${typeLabel} · ${n.amountRub} ₽` });
              } else {
                toast({ title: "Платёж отклонён", description: `${n.userEmail} · ${n.amountRub} ₽`, variant: "destructive" });
              }
            }
          }

          // Replace bell's pending list with current server state so the badge
          // count is always accurate (shrinks when payments are confirmed/rejected).
          setPayments(pendingPayments);
          paymentSinceRef.current = now;
        }
      } catch { /* Network error — silently skip. */ }

      // ── Poll audit log: other admins ───────────────────────────────────────
      if (currentAdminId != null && !cancelled) {
        try {
          const res = await fetch(
            `/api/admin/audit-log?since=${encodeURIComponent(auditSinceRef.current)}&pageSize=20`,
            { credentials: "include" },
          );
          if (res.ok && !cancelled) {
            const data: { entries: AdminAuditLogEntry[] } = await res.json();
            const otherEntries = (data.entries ?? []).filter(
              (e) => e.adminId !== currentAdminId && !seenAuditIds.current.has(e.id),
            );
            for (const e of otherEntries) {
              seenAuditIds.current.add(e.id);
              toast({
                title: "Действие другого администратора",
                description: `${e.adminEmail} · ${ACTION_LABELS[e.action] ?? e.action}`,
              });
            }
            if (otherEntries.length > 0) {
              setOtherAdminActions((prev) => [...otherEntries.reverse(), ...prev].slice(0, 30));
            }
            auditSinceRef.current = now;
          }
        } catch { /* Network error — silently skip. */ }
      }
    }

    poll(); // immediate first fetch on mount
    const timer = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [toast, currentAdminId]);

  return { payments, otherAdminActions };
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function TrafficPollingWarningBanner() {
  const { data } = useGetAdminTrafficPollingHealth({
    query: { queryKey: getGetAdminTrafficPollingHealthQueryKey(), refetchInterval: 60_000 },
  });
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissal whenever a new failure epoch starts (count increases or
  // stale-success condition appears), so the banner re-appears after each
  // new detected problem rather than staying permanently hidden.
  const failureCount = data?.consecutiveFailures ?? 0;
  const lastSuccessAt = data?.lastSuccessAt ? new Date(data.lastSuccessAt) : null;
  const isStale = lastSuccessAt !== null && Date.now() - lastSuccessAt.getTime() > STALE_THRESHOLD_MS;
  const isDegraded = failureCount > 0 || isStale;

  // Re-show the banner whenever the failure count increases (a new failure
  // was observed after the user had dismissed a previous count).
  const prevFailureCountRef = useRef(0);
  useEffect(() => {
    if (failureCount > prevFailureCountRef.current) {
      setDismissed(false);
    }
    prevFailureCountRef.current = failureCount;
  }, [failureCount]);

  if (!isDegraded || dismissed) return null;

  const lastSuccessLabel = lastSuccessAt
    ? lastSuccessAt.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "medium" })
    : "никогда";

  return (
    <div className="flex items-start gap-3 bg-yellow-50 border border-yellow-400 p-4">
      <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono uppercase font-bold text-yellow-700">Опрос трафика нарушен</div>
        <div className="text-sm text-yellow-800 mt-0.5">
          {failureCount > 0
            ? `${failureCount} сбоев подряд. Последний успех: ${lastSuccessLabel}.`
            : `Последний успешный опрос: ${lastSuccessLabel}.`}
          {" "}Учёт трафика может быть неточным — проверьте логи.
        </div>
        {data?.lastError && (
          <div className="text-xs font-mono text-yellow-700 mt-1 truncate">{data.lastError}</div>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-yellow-600 hover:text-yellow-800 shrink-0"
        aria-label="Закрыть"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/**
 * Surfaces a dismissible warning whenever an Xray config volume remount event
 * is recorded (i.e. readConfig() hit ENOENT and rebuilt from template + DB).
 * Each unacknowledged event gets its own card so admins can track repeated
 * remounts that might indicate an infrastructure problem.
 */
function XrayConfigRemountBanner() {
  const { data: events, isLoading } = useListAdminSystemEvents({
    query: { queryKey: getListAdminSystemEventsQueryKey(), refetchInterval: 60_000 },
  });
  const { mutate: acknowledge } = useAcknowledgeAdminSystemEvent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAdminSystemEventsQueryKey() });
      },
    },
  });

  const remountEvents = (events ?? []).filter((e) => e.eventType === "xray_config_remount");

  if (isLoading || remountEvents.length === 0) return null;

  return (
    <>
      {remountEvents.map((event) => {
        const meta = event.metadata as { restoredKeyCount?: number; configPath?: string } | undefined;
        const restoredCount = meta?.restoredKeyCount ?? 0;
        const ts = new Date(event.createdAt).toLocaleString("ru-RU", {
          dateStyle: "short",
          timeStyle: "medium",
        });

        return (
          <div key={event.id} className="flex items-start gap-3 bg-orange-50 border border-orange-400 p-4">
            <AlertTriangle className="w-4 h-4 text-orange-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono uppercase font-bold text-orange-700">Обнаружен пересмонтаж конфига Xray</div>
              <div className="text-sm text-orange-800 mt-0.5">
                Файл конфигурации Xray не был найден на PVC и был восстановлен из шаблона и БД.
                {" "}Восстановлено ключей: <strong>{restoredCount}</strong>.
                {" "}Время события: {ts}.
              </div>
              <div className="text-xs text-orange-600 mt-1">
                Если это повторяется — проверьте стабильность PVC и логи инфраструктуры.
              </div>
            </div>
            <button
              onClick={() => acknowledge({ eventId: event.id })}
              className="text-orange-600 hover:text-orange-800 shrink-0"
              aria-label="Закрыть"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </>
  );
}

function NodeAlertsBanner() {
  const { data: events, isLoading } = useListAdminSystemEvents({
    query: { queryKey: getListAdminSystemEventsQueryKey(), refetchInterval: 60_000 },
  });
  const { mutate: acknowledge } = useAcknowledgeAdminSystemEvent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAdminSystemEventsQueryKey() });
      },
    },
  });

  const nodeEvents = (events ?? []).filter((e) =>
    e.eventType === "node_unavailable" ||
    e.eventType === "node_unreachable" ||
    e.eventType === "node_overloaded" ||
    e.eventType === "node_recovered"
  );

  if (isLoading || nodeEvents.length === 0) return null;

  return (
    <>
      {nodeEvents.map((event) => {
        const meta = event.metadata as {
          nodeId?: number;
          nodeName?: string;
          cpuPercent?: number;
          ramPercent?: number;
          cpuOverloaded?: boolean;
          ramOverloaded?: boolean;
          consecutiveFailures?: number;
          lastError?: string;
          prevConsecutiveFailures?: number;
        } | undefined;

        const ts = new Date(event.createdAt).toLocaleString("ru-RU", {
          dateStyle: "short",
          timeStyle: "medium",
        });
        const nodeName = meta?.nodeName ?? `Узел #${meta?.nodeId}`;

        let colorClass = "bg-red-50 border-red-400";
        let iconColor = "text-red-600";
        let labelColor = "text-red-700";
        let bodyColor = "text-red-800";
        let hintColor = "text-red-600";
        let btnColor = "text-red-600 hover:text-red-800";
        let label = "";
        let body = "";
        let hint = "";

        if (event.eventType === "node_unreachable") {
          label = `Узел «${nodeName}» автоматически отключён`;
          body = `Нода не отвечала ${meta?.consecutiveFailures ?? 3} проверок подряд — она переведена в неактивный статус и ключи пользователей перенесены на другие серверы.${meta?.lastError ? ` Последняя ошибка: ${meta.lastError}.` : ""} Время события: ${ts}.`;
          hint = "Нода восстановится автоматически после успешного ответа на healthcheck. Проверьте состояние VPS и Docker-контейнер с Xray.";
        } else if (event.eventType === "node_unavailable") {
          label = `Узел «${nodeName}» недоступен`;
          body = `Нода не отвечала ${meta?.consecutiveFailures ?? 3} проверок подряд.${meta?.lastError ? ` Последняя ошибка: ${meta.lastError}.` : ""} Время события: ${ts}.`;
          hint = "Проверьте состояние VPS и убедитесь, что Docker-контейнер с Xray запущен.";
        } else if (event.eventType === "node_overloaded") {
          colorClass = "bg-amber-50 border-amber-400";
          iconColor = "text-amber-600";
          labelColor = "text-amber-700";
          bodyColor = "text-amber-800";
          hintColor = "text-amber-600";
          btnColor = "text-amber-600 hover:text-amber-800";
          const parts: string[] = [];
          if (meta?.cpuOverloaded) parts.push(`CPU ${meta.cpuPercent}%`);
          if (meta?.ramOverloaded) parts.push(`RAM ${meta.ramPercent}%`);
          label = `Узел «${nodeName}» перегружен`;
          body = `Превышен порог 90%: ${parts.join(", ")}. Время события: ${ts}.`;
          hint = "Рассмотрите масштабирование или ограничение числа активных ключей на этой ноде.";
        } else if (event.eventType === "node_recovered") {
          colorClass = "bg-green-50 border-green-400";
          iconColor = "text-green-600";
          labelColor = "text-green-700";
          bodyColor = "text-green-800";
          hintColor = "text-green-600";
          btnColor = "text-green-600 hover:text-green-800";
          label = `Узел «${nodeName}» восстановлен`;
          body = `Нода снова доступна. CPU: ${meta?.cpuPercent ?? "—"}%. Время события: ${ts}.`;
          hint = "Предыдущий алерт о недоступности можно закрыть.";
        }

        return (
          <div key={event.id} className={`flex items-start gap-3 border p-4 ${colorClass}`}>
            <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${iconColor}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-mono uppercase font-bold ${labelColor}`}>{label}</div>
              <div className={`text-sm mt-0.5 ${bodyColor}`}>{body}</div>
              <div className={`text-xs mt-1 ${hintColor}`}>{hint}</div>
            </div>
            <button
              onClick={() => acknowledge({ eventId: event.id })}
              className={`shrink-0 ${btnColor}`}
              aria-label="Закрыть"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </>
  );
}

function SummarySection() {
  const { data, isLoading } = useGetAdminDashboardSummary({
    query: { queryKey: getGetAdminDashboardSummaryQueryKey(), refetchInterval: 30_000 },
  });

  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem("admin-summary-collapsed");
      if (saved !== null) return saved === "true";
    } catch {}
    return typeof window !== "undefined" && window.innerWidth < 768;
  });

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("admin-summary-collapsed", String(next)); } catch {}
      return next;
    });
  };

  const maxRevenue = !isLoading && data ? Math.max(1, ...data.revenueByDay.map((d) => d.amountRub)) : 1;

  return (
    <div className="border border-border">
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        <span className="text-xs font-mono uppercase font-bold text-muted-foreground tracking-wider">
          Статистика и сводка
        </span>
        {collapsed
          ? <ChevronDown className="w-4 h-4 text-muted-foreground" />
          : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>
      {!collapsed && (
      <div className="px-4 pb-4 pt-3 border-t border-border">
      {(isLoading || !data) ? (
        <div className="grid md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : (
    <div className="space-y-4">
      <div className="grid md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Metric label="Пользователи" value={data.totalUsers} />
        <div className={`bg-card border p-5 ${data.activeNow > 0 ? "border-orange-400 bg-orange-50/50" : "border-border"}`}>
          <div className={`text-xs font-mono uppercase mb-1 ${data.activeNow > 0 ? "text-orange-600 font-bold" : "text-muted-foreground"}`}>Онлайн сейчас</div>
          <div className={`text-2xl font-bold ${data.activeNow > 0 ? "text-orange-700" : ""}`}>{data.activeNow}</div>
          {data.activeNow > 0 && (
            <div className="flex gap-2 mt-1.5 flex-wrap">
              {data.activeOnVpn > 0 && (
                <span className="text-[11px] font-mono bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                  VPN: {data.activeOnVpn}
                </span>
              )}
              {data.activeOnSite > 0 && (
                <span className="text-[11px] font-mono bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                  Сайт: {data.activeOnSite}
                </span>
              )}
            </div>
          )}
        </div>
        <Metric label="Активные подписки" value={data.activeSubscriptions} />
        <Metric label="Ожидают оплаты" value={data.pendingPayments} highlight={data.pendingPayments > 0} />
        <Metric label="Доход (30 дней)" value={`${data.last30DaysRevenueRub} ₽`} />
        <Metric label="Открытых тикетов" value={data.openTickets} highlight={data.openTickets > 0} />
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        <Metric label="Выпущено ключей" value={data.totalVpnKeys} />
        <Metric label="Новых за 7 дней" value={data.newUsersLast7Days} />
        <Metric label="Новых за 30 дней" value={data.newUsersLast30Days} />
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Metric label="Привлечено по рефералам" value={data.referralCount} />
        <Metric label="Комиссии за месяц" value={`${data.referralCommissionsThisMonthRub} ₽`} />
      </div>
      {(data.expiringIn3Days > 0 || data.lowBalanceHourly > 0) && (
        <div className="grid md:grid-cols-2 gap-4">
          {data.expiringIn3Days > 0 && (
            <div className="flex items-start gap-3 bg-red-50 border border-red-300 p-4">
              <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs font-mono uppercase font-bold text-red-700">Истекают через 3 дня</div>
                <div className="text-2xl font-bold text-red-700">{data.expiringIn3Days}</div>
                <div className="text-xs text-red-600 mt-0.5">месячных подписок</div>
              </div>
            </div>
          )}
          {data.lowBalanceHourly > 0 && (
            <div className="flex items-start gap-3 bg-orange-50 border border-orange-300 p-4">
              <Wallet className="w-4 h-4 text-orange-600 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs font-mono uppercase font-bold text-orange-700">Низкий баланс</div>
                <div className="text-2xl font-bold text-orange-700">{data.lowBalanceHourly}</div>
                <div className="text-xs text-orange-600 mt-0.5">почасовых пользователей (&lt; 3 ч)</div>
              </div>
            </div>
          )}
        </div>
      )}
      {data.topTrafficUsers.length > 0 && (
        <div className="bg-card border border-border p-5">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-3.5 h-3.5 text-muted-foreground" />
            <div className="text-xs font-mono uppercase text-muted-foreground">Топ трафика (период)</div>
          </div>
          <div className="space-y-2">
            {data.topTrafficUsers.map((u, i) => (
              <div key={u.userId} className="flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-mono text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                  <span className="truncate font-medium">{u.name ?? u.email}</span>
                  {u.name && <span className="text-xs text-muted-foreground truncate hidden sm:block">{u.email}</span>}
                </div>
                <span className="font-mono text-xs shrink-0 text-muted-foreground">{formatBytes(u.periodBytes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-card border border-border p-5">
          <div className="text-xs font-mono uppercase mb-3 text-muted-foreground">Доход по дням (14 дней)</div>
          {/* No items-end here: flex children must stretch to the full h-32 so
              the percentage bar heights inside resolve against a real height.
              With items-end the per-day column shrank to content height (0),
              collapsing every revenue bar to 0px while the 2px zero-day
              hairlines stayed visible — a completely "flat" chart. */}
          <div className="flex gap-1 h-32">
            {data.revenueByDay.map((d) => (
              <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-1 group relative h-full">
                <div
                  className="w-full bg-orange-500/80 hover:bg-orange-500 transition-colors"
                  style={{
                    // For zero-revenue days keep a 2px hairline so the bar is visible.
                    // Use inline minHeight so it isn't overridden by the height value
                    // (Tailwind min-h-* loses to inline style specificity).
                    height: d.amountRub > 0
                      ? `${Math.max(4, (d.amountRub / maxRevenue) * 100)}%`
                      : "2px",
                  }}
                  title={`${new Date(d.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}: ${d.amountRub} ₽`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1 font-mono">
            <span>{new Date(data.revenueByDay[0]!.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}</span>
            <span>{new Date(data.revenueByDay[data.revenueByDay.length - 1]!.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}</span>
          </div>
        </div>
        <div className="bg-card border border-border p-5">
          <div className="text-xs font-mono uppercase mb-3 text-muted-foreground">Распределение по тарифам</div>
          {data.planDistribution.length === 0 ? (
            <p className="text-sm text-muted-foreground">Нет активных подписок</p>
          ) : (
            <div className="space-y-2">
              {data.planDistribution.map((p) => {
                const total = data.planDistribution.reduce((s, x) => s + x.count, 0);
                const pct = total > 0 ? (p.count / total) * 100 : 0;
                return (
                  <div key={p.planName}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="font-semibold">{p.planName}</span>
                      <span className="text-muted-foreground">{p.count}</span>
                    </div>
                    <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
      )}
      </div>
      )}
    </div>
  );
}

const ADMIN_PAGE_SIZE = 20;

function PaginationBar({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-3 border-t border-border">
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="text-sm px-3 py-1.5 border border-border disabled:opacity-30 hover:bg-muted transition-colors"
      >
        ← Назад
      </button>
      <span className="text-xs text-muted-foreground font-mono">
        Стр. {page} / {totalPages} · Всего: {total}
      </span>
      <button
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="text-sm px-3 py-1.5 border border-border disabled:opacity-30 hover:bg-muted transition-colors"
      >
        Вперёд →
      </button>
    </div>
  );
}

function formatWaitTime(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "< 1 ч.";
  if (hours < 24) return `${hours} ч.`;
  return `${Math.floor(hours / 24)} дн.`;
}

function PaymentsQueue() {
  const [statusFilter, setStatusFilter] = useState<"pending" | "confirmed" | "rejected" | "all">("pending");
  const [providerFilter, setProviderFilter] = useState<"all" | "yoomoney" | "manual_sbp" | "balance">("all");
  const [sort, setSort] = useState<"date_desc" | "date_asc" | "amount_desc" | "amount_asc">("date_desc");
  const [search, setSearch] = useState("");
  const { data: payments, isLoading } = useListAdminPayments(
    statusFilter === "all" ? undefined : { status: statusFilter },
    { query: { queryKey: getListAdminPaymentsQueryKey(statusFilter === "all" ? undefined : { status: statusFilter }), refetchInterval: statusFilter === "pending" ? 30_000 : false } },
  );
  const { mutate: confirm } = useConfirmPayment();
  const { mutate: reject } = useRejectPayment();
  const { toast } = useToast();
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [page, setPage] = useState(1);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: getListAdminPaymentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdminDashboardSummaryQueryKey() });
  }

  function handleConfirm(paymentId: number) {
    confirm(
      { paymentId },
      {
        onSuccess: (data) => {
          invalidate();
          queryClient.invalidateQueries({ queryKey: ["me"] });
          const desc =
            data?.type === "extra_device_slot"
              ? "Устройство добавлено пользователю."
              : data?.type === "balance_topup"
                ? "Баланс пользователя пополнен."
                : data?.type === "extra_traffic"
                  ? "Трафик начислен пользователю."
                  : "Подписка активирована.";
          toast({ title: "Платёж подтверждён", description: desc });
        },
        onError: () => toast({ title: "Ошибка подтверждения", variant: "destructive" }),
      },
    );
  }

  function handleReject(paymentId: number) {
    reject(
      { paymentId, data: { reason: reason.trim() || undefined } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Платёж отклонён" });
          setRejectingId(null);
          setReason("");
        },
        onError: () => toast({ title: "Ошибка отклонения", variant: "destructive" }),
      },
    );
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const filteredPayments = (payments ?? [])
    .filter((p) => {
      if (providerFilter !== "all" && p.provider !== providerFilter) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return p.userEmail.toLowerCase().includes(q) || p.reference.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      switch (sort) {
        case "date_asc":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "amount_desc":
          return b.amountRub - a.amountRub;
        case "amount_asc":
          return a.amountRub - b.amountRub;
        case "date_desc":
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

  const totalPagesP = Math.max(1, Math.ceil(filteredPayments.length / ADMIN_PAGE_SIZE));
  const effectivePageP = Math.min(page, totalPagesP);
  const pagedPayments = filteredPayments.slice((effectivePageP - 1) * ADMIN_PAGE_SIZE, effectivePageP * ADMIN_PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Поиск по email или референсу"
          className="rounded-none min-w-0 flex-1 basis-48"
        />
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(1); }}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="pending">Ожидающие</option>
          <option value="confirmed">Подтверждённые</option>
          <option value="rejected">Отклонённые</option>
          <option value="all">Все</option>
        </select>
        <select
          value={providerFilter}
          onChange={(e) => { setProviderFilter(e.target.value as typeof providerFilter); setPage(1); }}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все методы</option>
          <option value="yoomoney">ЮMoney</option>
          <option value="manual_sbp">СБП</option>
          <option value="balance">Баланс</option>
        </select>
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as typeof sort); setPage(1); }}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="date_desc">Сначала новые</option>
          <option value="date_asc">Сначала старые</option>
          <option value="amount_desc">По сумме (убыв.)</option>
          <option value="amount_asc">По сумме (возр.)</option>
        </select>
        <button
          onClick={() => {
            const header = "ID,Дата,Email,Тариф,Тип,Провайдер,Сумма (₽),Статус,Референс";
            const rows = filteredPayments.map((p) =>
              [p.id, p.createdAt, p.userEmail, p.planName ?? "", p.type, p.provider, p.amountRub, p.status, p.reference]
                .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
                .join(",")
            );
            const csv = [header, ...rows].join("\n");
            const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `payments-${new Date().toISOString().slice(0,10)}.csv`; a.click();
            URL.revokeObjectURL(url);
          }}
          className="border border-border px-3 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
        >
          Экспорт CSV
        </button>
      </div>
      {filteredPayments.length === 0 && (
        <p className="text-muted-foreground">Платежей не найдено.</p>
      )}
      {pagedPayments.map((payment) => (
        <div key={payment.id} className="bg-card border border-border p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="font-bold">
                {payment.userEmail} ·{" "}
                {payment.type === "extra_device_slot"
                  ? "Доп. устройство"
                  : payment.type === "balance_topup"
                    ? "Пополнение баланса"
                    : payment.type === "extra_traffic"
                      ? `Доп. трафик${payment.extraTrafficGb ? ` (+${payment.extraTrafficGb} ГБ)` : ""}`
                      : (payment.planName ?? "—")}
              </div>
              <div className="text-sm text-muted-foreground font-mono flex items-center gap-2 flex-wrap">
                <span>{payment.amountRub} ₽ · {payment.reference} · {formatDate(payment.createdAt)}</span>
                <span className="text-[11px] px-1.5 py-0.5 bg-muted font-mono rounded">
                  {payment.provider === "yoomoney" ? "ЮMoney" : payment.provider === "balance" ? "Баланс" : "СБП"}
                </span>
                {payment.status === "pending" && (
                  <span className="flex items-center gap-1 text-[11px] text-orange-600 font-mono">
                    <Clock className="w-3 h-3" /> {formatWaitTime(payment.createdAt)}
                  </span>
                )}
              </div>
              {payment.userNote && (
                <div className="text-sm mt-1 italic text-muted-foreground">«{payment.userNote}»</div>
              )}
              {payment.hasScreenshot && (
                <a
                  href={`/api/payments/${payment.id}/screenshot/image`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm mt-1 text-primary hover:underline"
                >
                  <ImageIcon className="w-3.5 h-3.5" /> Скриншот оплаты
                </a>
              )}
            </div>
            {payment.status === "pending" ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleConfirm(payment.id)}
                  className="flex items-center gap-1.5 bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity"
                >
                  <Check className="w-4 h-4" /> Подтвердить
                </button>
                <button
                  onClick={() => setRejectingId(rejectingId === payment.id ? null : payment.id)}
                  className="flex items-center gap-1.5 border border-destructive text-destructive font-bold px-4 py-2 text-sm hover:bg-destructive/10 transition-colors"
                >
                  <X className="w-4 h-4" /> Отклонить
                </button>
              </div>
            ) : (
              <div
                className={`text-xs font-bold uppercase px-3 py-1 ${payment.status === "confirmed" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}
              >
                {payment.status === "confirmed" ? "Подтверждён" : "Отклонён"}
              </div>
            )}
          </div>
          {rejectingId === payment.id && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Причина отклонения"
                className="rounded-none min-w-0 flex-1 basis-40"
              />
              <button
                onClick={() => handleReject(payment.id)}
                className="bg-destructive text-white font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity whitespace-nowrap"
              >
                Подтвердить отказ
              </button>
            </div>
          )}
        </div>
      ))}
      <PaginationBar page={effectivePageP} total={filteredPayments.length} onPage={setPage} />
    </div>
  );
}

function PlanForm({ plan, onDone }: { plan?: Plan; onDone: () => void }) {
  const { mutate: createPlan, isPending: creating } = useCreatePlan();
  const { mutate: updatePlan, isPending: updating } = useUpdatePlan();
  const { toast } = useToast();
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [priceRub, setPriceRub] = useState(plan?.priceRub?.toString() ?? "");
  const [durationDays, setDurationDays] = useState(plan?.durationDays?.toString() ?? "");
  const [devicesIncluded, setDevicesIncluded] = useState(plan?.devicesIncluded?.toString() ?? "1");
  const [trafficLimitGb, setTrafficLimitGb] = useState(plan?.trafficLimitGb?.toString() ?? "");
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);
  const [isPromo, setIsPromo] = useState(plan?.isPromo ?? false);
  const [maxUses, setMaxUses] = useState(plan?.maxUses?.toString() ?? "");
  const [billingType, setBillingType] = useState<"monthly" | "hourly">(plan?.billingType ?? "monthly");
  const [hourlyRateRub, setHourlyRateRub] = useState(
    plan?.hourlyRateKopecks != null ? (plan.hourlyRateKopecks / 100).toString() : "",
  );

  function handleSubmit() {
    const body = {
      name,
      description,
      priceRub: billingType === "hourly" ? 0 : Number(priceRub),
      durationDays: billingType === "hourly" ? 0 : Number(durationDays),
      devicesIncluded: devicesIncluded ? Number(devicesIncluded) : 1,
      trafficLimitGb: trafficLimitGb ? Number(trafficLimitGb) : null,
      isActive,
      isPromo,
      maxUses: maxUses ? Number(maxUses) : null,
      billingType,
      hourlyRateKopecks: billingType === "hourly" ? Math.round(Number(hourlyRateRub) * 100) : null,
    };
    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getListAdminPlansQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListPlansQueryKey() });
      toast({ title: plan ? "Тариф обновлён" : "Тариф создан" });
      onDone();
    };
    const onError = () => toast({ title: "Ошибка сохранения тарифа", variant: "destructive" });

    if (plan) {
      updatePlan({ planId: plan.id, data: body }, { onSuccess, onError });
    } else {
      createPlan({ data: body }, { onSuccess, onError });
    }
  }

  return (
    <div className="bg-muted/30 border border-border p-4 space-y-3">
      <div className="grid md:grid-cols-2 gap-3">
        <Input placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} className="rounded-none" />
        <select
          value={billingType}
          onChange={(e) => setBillingType(e.target.value as "monthly" | "hourly")}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="monthly">Помесячный</option>
          <option value="hourly">Почасовой</option>
        </select>
        {billingType === "hourly" ? (
          <Input
            type="number"
            step="0.01"
            min={0}
            placeholder="Цена, ₽/час"
            value={hourlyRateRub}
            onChange={(e) => setHourlyRateRub(e.target.value.replace(/[^0-9.]/g, ""))}
            className="rounded-none"
          />
        ) : (
          <>
            <Input
              type="number"
              placeholder="Цена, ₽"
              value={priceRub}
              onChange={(e) => setPriceRub(e.target.value)}
              className="rounded-none"
            />
            <Input
              type="number"
              placeholder="Длительность, дней"
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
              className="rounded-none"
            />
          </>
        )}
        <Input
          type="number"
          placeholder="Устройств включено"
          min={1}
          value={devicesIncluded}
          onChange={(e) => setDevicesIncluded(e.target.value.replace(/[^0-9]/g, ""))}
          className="rounded-none"
        />
        <Input
          type="number"
          placeholder="Лимит трафика, ГБ (пусто = безлимит)"
          min={1}
          value={trafficLimitGb}
          onChange={(e) => setTrafficLimitGb(e.target.value.replace(/[^0-9]/g, ""))}
          className="rounded-none"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Активен
        </label>
        <label className="flex items-center gap-2 text-sm" title="Промо-тарифы скрыты от пользователей и доступны только через инвайт-ссылки">
          <input type="checkbox" checked={isPromo} onChange={(e) => setIsPromo(e.target.checked)} />
          Промо <span className="text-[11px] text-muted-foreground">(только через инвайт)</span>
        </label>
        <Input
          type="number"
          placeholder="Лимит покупок на пользователя (пусто = без лимита)"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value.replace(/[^0-9]/g, ""))}
          className="rounded-none md:col-span-2"
          title="Сколько раз один пользователь может купить этот тариф. Актуально для промо-тарифов."
        />
      </div>
      <Textarea
        placeholder="Описание"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="rounded-none"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={
            creating ||
            updating ||
            !name ||
            (billingType === "hourly" ? !hourlyRateRub : !priceRub || !durationDays)
          }
          className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          Сохранить
        </button>
        <button onClick={onDone} className="border border-border px-4 py-2 text-sm">
          Отмена
        </button>
      </div>
    </div>
  );
}

function PlansManagement() {
  const { data: plans, isLoading } = useListAdminPlans();
  const { mutate: deletePlan } = useDeletePlan();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [billingFilter, setBillingFilter] = useState<"all" | "monthly" | "hourly">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [promoFilter, setPromoFilter] = useState<"all" | "promo" | "regular">("all");
  const [sort, setSort] = useState<"default" | "price_asc" | "price_desc" | "name">("default");

  function handleDelete(planId: number) {
    deletePlan(
      { planId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminPlansQueryKey() });
          toast({ title: "Тариф деактивирован" });
        },
        onError: () => toast({ title: "Ошибка удаления тарифа", variant: "destructive" }),
      },
    );
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  function effectivePrice(plan: Plan) {
    return plan.billingType === "hourly" ? (plan.hourlyRateKopecks ?? 0) / 100 : plan.priceRub;
  }

  const filteredPlans = (plans ?? [])
    .filter((p) => billingFilter === "all" || p.billingType === billingFilter)
    .filter((p) => statusFilter === "all" || (statusFilter === "active" ? p.isActive : !p.isActive))
    .filter((p) => promoFilter === "all" || (promoFilter === "promo" ? p.isPromo : !p.isPromo))
    .sort((a, b) => {
      switch (sort) {
        case "price_asc":
          return effectivePrice(a) - effectivePrice(b);
        case "price_desc":
          return effectivePrice(b) - effectivePrice(a);
        case "name":
          return a.name.localeCompare(b.name);
        case "default":
        default:
          return 0;
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={billingFilter}
          onChange={(e) => setBillingFilter(e.target.value as typeof billingFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все тарифы</option>
          <option value="monthly">Помесячные</option>
          <option value="hourly">Почасовые</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все статусы</option>
          <option value="active">Активные</option>
          <option value="inactive">Неактивные</option>
        </select>
        <select
          value={promoFilter}
          onChange={(e) => setPromoFilter(e.target.value as typeof promoFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все типы</option>
          <option value="regular">Обычные</option>
          <option value="promo">Промо</option>
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="default">Без сортировки</option>
          <option value="price_asc">Цена: по возрастанию</option>
          <option value="price_desc">Цена: по убыванию</option>
          <option value="name">По названию</option>
        </select>
      </div>
      {filteredPlans.map((plan) =>
        editingId === plan.id ? (
          <PlanForm key={plan.id} plan={plan} onDone={() => setEditingId(null)} />
        ) : (
          <div key={plan.id} className="bg-card border border-border p-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0 break-words">
              <div className="font-bold flex items-center gap-2 flex-wrap">
                {plan.name}
                {plan.isPromo && <span className="text-[10px] font-mono font-bold uppercase tracking-wide bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 px-1.5 py-0.5 rounded">Промо</span>}
                {!plan.isActive && <span className="text-muted-foreground font-normal text-sm">(неактивен)</span>}
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                {plan.billingType === "hourly" ? (
                  <>{((plan.hourlyRateKopecks ?? 0) / 100).toFixed(2)} ₽/час (почасовой)</>
                ) : (
                  <>{plan.priceRub} ₽ · {plan.durationDays} дней</>
                )}{" "}
                · {plan.devicesIncluded} уст. ·{" "}
                {plan.trafficLimitGb ? `${plan.trafficLimitGb} ГБ/период` : "трафик без лимита"}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setEditingId(plan.id)} className="p-2 text-muted-foreground hover:text-primary">
                <Pencil className="w-4 h-4" />
              </button>
              <button onClick={() => handleDelete(plan.id)} className="p-2 text-muted-foreground hover:text-destructive">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ),
      )}
      {editingId === "new" ? (
        <PlanForm onDone={() => setEditingId(null)} />
      ) : (
        <button
          onClick={() => setEditingId("new")}
          className="flex items-center gap-2 border border-dashed border-border px-4 py-3 text-sm font-medium text-muted-foreground hover:text-primary hover:border-primary transition-colors w-full justify-center"
        >
          <Plus className="w-4 h-4" /> Новый тариф
        </button>
      )}
    </div>
  );
}

// ─── VPN Node Auto-Provisioning Wizard ───────────────────────────────────────

type ProvisionLogLevel = "info" | "step" | "success" | "error";

interface ProvisionLog {
  ts: number;
  text: string;
  level: ProvisionLogLevel;
}

function NodeProvisioningWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1 — SSH access
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("root");
  const [sshPassword, setSshPassword] = useState("");

  // Step 2 — node metadata
  const [domain, setDomain] = useState("");
  const [nodeName, setNodeName] = useState("");
  const [nodeRegion, setNodeRegion] = useState("");

  // Step 3 — provisioning progress
  const [jobId, setJobId] = useState<string | null>(null);
  const [logs, setLogs] = useState<ProvisionLog[]>([]);
  const [jobStatus, setJobStatus] = useState<"running" | "done" | "error" | null>(null);
  const [newNodeId, setNewNodeId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const logsEndRef = useRef<HTMLDivElement>(null);

  const { mutate: startProvision, isPending: starting } = useProvisionVpnNode();
  const { toast } = useToast();

  // Auto-scroll to latest log entry
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // SSE — connect once we have a jobId
  useEffect(() => {
    if (!jobId) return;

    const es = new EventSource(`/api/admin/vpn-nodes/provision/${jobId}/logs`);

    es.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as Record<string, unknown>;
        if (data["type"] === "log") {
          setLogs(prev => [...prev, data as unknown as ProvisionLog]);
        } else if (data["type"] === "done") {
          setJobStatus("done");
          setNewNodeId(data["nodeId"] as number);
          queryClient.invalidateQueries({ queryKey: getListVpnNodesQueryKey() });
          es.close();
        } else if (data["type"] === "error") {
          setJobStatus("error");
          setErrorMessage((data["message"] as string) ?? "Неизвестная ошибка");
          es.close();
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      if (jobStatus !== "done" && jobStatus !== "error") {
        setJobStatus("error");
        setErrorMessage("Соединение с сервером прервано");
      }
      es.close();
    };

    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  function doStart(opts: { sshHost: string; sshUser: string; sshPassword: string; domain: string; nodeName: string; nodeRegion: string }) {
    startProvision(
      { data: opts },
      {
        onSuccess: (res) => {
          setJobId(res.jobId);
          setJobStatus("running");
          setStep(3);
        },
        onError: () => {
          toast({ title: "Не удалось запустить развертывание", variant: "destructive" });
        },
      },
    );
  }

  function handleStep2Submit() {
    setLogs([]);
    setJobStatus(null);
    setErrorMessage("");
    setNewNodeId(null);
    doStart({ sshHost, sshUser, sshPassword, domain, nodeName, nodeRegion });
  }

  function handleRetry() {
    setLogs([]);
    setJobId(null);
    setJobStatus("running");
    setErrorMessage("");
    setNewNodeId(null);
    // Small delay so useEffect cleanup runs before new jobId is set
    setTimeout(() => {
      doStart({ sshHost, sshUser, sshPassword, domain, nodeName, nodeRegion });
    }, 50);
  }

  const logLevelClass: Record<ProvisionLogLevel, string> = {
    info: "text-muted-foreground",
    step: "text-blue-600 font-semibold",
    success: "text-green-600 font-semibold",
    error: "text-red-600 font-semibold",
  };

  const step1Valid = sshHost.trim() && sshUser.trim() && sshPassword.trim();
  const step2Valid = domain.trim() && nodeName.trim() && nodeRegion.trim();

  return (
    <div className="bg-muted/30 border border-border p-4 space-y-4">
      {/* Header + step indicator */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold text-sm">
          <Zap className="w-4 h-4 text-primary" />
          Авто-развертывание узла
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          {([1, 2, 3] as const).map((s) => (
            <span
              key={s}
              className={`w-5 h-5 rounded-full flex items-center justify-center border text-[10px] font-bold transition-colors ${
                step === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : step > s
                  ? "bg-green-600 text-white border-green-600"
                  : "border-border text-muted-foreground"
              }`}
            >
              {step > s ? "✓" : s}
            </span>
          ))}
        </div>
      </div>

      {/* ── Step 1: SSH access ─────────────────────────────────────────── */}
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Введите данные для подключения к новому VPS-серверу по SSH.
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <Input
              placeholder="IP-адрес VPS (например: 87.199.200.19)"
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value.trim())}
              className="rounded-none col-span-2"
            />
            <Input
              placeholder="SSH-пользователь"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value.trim())}
              className="rounded-none"
            />
            <Input
              type="password"
              placeholder="SSH-пароль"
              value={sshPassword}
              onChange={(e) => setSshPassword(e.target.value)}
              className="rounded-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setStep(2)}
              disabled={!step1Valid}
              className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50"
            >
              Далее →
            </button>
            <button onClick={onDone} className="border border-border px-4 py-2 text-sm">
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2: Node metadata ──────────────────────────────────────── */}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Укажите домен VPS (технический, выданный провайдером) и имя узла.
          </p>
          <div className="grid md:grid-cols-2 gap-3">
            <Input
              placeholder="Домен VPS (напр. v917715.hosted-by-vdsina.com)"
              value={domain}
              onChange={(e) => setDomain(e.target.value.trim())}
              className="rounded-none col-span-2"
            />
            <Input
              placeholder="Название узла (напр. Netherlands (VDSina))"
              value={nodeName}
              onChange={(e) => setNodeName(e.target.value)}
              className="rounded-none"
            />
            <Input
              placeholder="Регион (напр. nl, de, us)"
              value={nodeRegion}
              onChange={(e) => setNodeRegion(e.target.value.trim())}
              className="rounded-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleStep2Submit}
              disabled={!step2Valid || starting}
              className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50"
            >
              {starting ? "Запуск..." : "Развернуть →"}
            </button>
            <button onClick={() => setStep(1)} className="border border-border px-4 py-2 text-sm">
              ← Назад
            </button>
            <button onClick={onDone} className="border border-border px-4 py-2 text-sm ml-auto">
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Live provisioning log ─────────────────────────────── */}
      {step === 3 && (
        <div className="space-y-3">
          {/* Status badge */}
          <div className="flex items-center gap-2 text-sm font-medium">
            {jobStatus === "running" && (
              <span className="flex items-center gap-1.5 text-blue-600">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Развертывание...
              </span>
            )}
            {jobStatus === "done" && (
              <span className="flex items-center gap-1.5 text-green-600">
                <Check className="w-3.5 h-3.5" /> Готово! Узел подключён
                {newNodeId && <span className="text-muted-foreground font-normal">(id={newNodeId})</span>}
              </span>
            )}
            {jobStatus === "error" && (
              <span className="flex items-center gap-1.5 text-red-600">
                <AlertTriangle className="w-3.5 h-3.5" /> Ошибка: {errorMessage}
              </span>
            )}
          </div>

          {/* Log output */}
          <div className="bg-background border border-border font-mono text-xs p-3 h-72 overflow-y-auto space-y-0.5">
            {logs.length === 0 && jobStatus === "running" && (
              <span className="text-muted-foreground">Подключение к серверу...</span>
            )}
            {logs.map((log, i) => (
              <div key={i} className={logLevelClass[log.level]}>
                {log.text}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            {jobStatus === "error" && (
              <button
                onClick={handleRetry}
                disabled={starting}
                className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5 inline mr-1" />
                Повторить
              </button>
            )}
            <button
              onClick={onDone}
              disabled={jobStatus === "running"}
              className="border border-border px-4 py-2 text-sm disabled:opacity-40"
            >
              {jobStatus === "done" ? "Закрыть" : jobStatus === "error" ? "Отмена" : "Закрыть"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NodeForm({ node, onDone }: { node?: VpnNode; onDone: () => void }) {
  const { mutate: createNode, isPending: creating } = useCreateVpnNode();
  const { mutate: updateNode, isPending: updating } = useUpdateVpnNode();
  const { toast } = useToast();
  const [name, setName] = useState(node?.name ?? "");
  const [region, setRegion] = useState(node?.region ?? "");
  const [host, setHost] = useState(node?.host ?? "");
  const [port, setPort] = useState(String(node?.port ?? 443));
  const [sni, setSni] = useState(node?.sni ?? "");
  const [publicKey, setPublicKey] = useState("");
  const [shortId, setShortId] = useState("");
  const [managementApiUrl, setManagementApiUrl] = useState(node?.managementApiUrl ?? "");
  // managementApiSecret is intentionally NOT returned from the API for security.
  // The form always starts empty; leave blank to keep the existing secret unchanged.
  const [managementApiSecret, setManagementApiSecret] = useState("");
  const [certSha256, setCertSha256] = useState(node?.certSha256 ?? "");
  const [isActive, setIsActive] = useState(node?.isActive ?? true);
  const [maxUsers, setMaxUsers] = useState(node?.maxUsers != null ? String(node.maxUsers) : "");
  const [certCopied, setCertCopied] = useState(false);

  // Original SNI — to detect domain changes on existing auto-provisioned nodes.
  const originalSni = node?.sni ?? "";
  // True when editing an existing remote (auto-provisioned) node and the domain changed.
  const sniChanged = !!node && !!node.managementApiUrl && sni.trim() !== "" && sni.trim() !== originalSni;
  const certbotCmd = sni.trim()
    ? `certbot --nginx -d ${sni.trim()} --non-interactive --agree-tos --email admin@${sni.trim()}`
    : "";

  function handleSniChange(val: string) {
    setSni(val);
    // If host was in sync with the old SNI (typical for auto-provisioned nodes),
    // keep it in sync automatically so the user doesn't have to update both fields.
    if (host === originalSni) setHost(val);
  }

  function handleSubmit() {
    const commonFields = {
      name,
      region,
      host: host || undefined,
      port: port ? Number(port) : undefined,
      sni,
      publicKey: publicKey || undefined,
      shortId: shortId || undefined,
      managementApiUrl: managementApiUrl || undefined,
      managementApiSecret: managementApiSecret || undefined,
      isActive,
      maxUsers: maxUsers ? Number(maxUsers) : null,
    };
    const onSuccess = () => {
      queryClient.invalidateQueries({ queryKey: getListVpnNodesQueryKey() });
      toast({ title: node ? "Узел обновлён" : "Узел создан" });
      onDone();
    };
    const onError = () => toast({ title: "Ошибка сохранения узла", variant: "destructive" });

    if (node) {
      // On update: empty string → null to explicitly clear the pinned cert.
      // undefined would be omitted by JSON.stringify and the server would keep the old value.
      updateNode({ nodeId: node.id, data: { ...commonFields, certSha256: certSha256 === "" ? null : certSha256 } }, { onSuccess, onError });
    } else {
      // On create: a new node never has an existing cert to clear, so undefined is fine.
      createNode({ data: { ...commonFields, certSha256: certSha256 || undefined } }, { onSuccess, onError });
    }
  }

  return (
    <div className="bg-muted/30 border border-border p-4 space-y-3">
      <div className="grid md:grid-cols-2 gap-3">
        <Input placeholder="Название" value={name} onChange={(e) => setName(e.target.value)} className="rounded-none" />
        <Input placeholder="Регион" value={region} onChange={(e) => setRegion(e.target.value)} className="rounded-none" />
        <Input placeholder="Host" value={host} onChange={(e) => setHost(e.target.value)} className="rounded-none" />
        <Input
          placeholder="Порт (443 или 27017 для Amvera TCP)"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="rounded-none"
        />
        <Input placeholder="SNI / домен" value={sni} onChange={(e) => handleSniChange(e.target.value)} className="rounded-none" />
        <Input
          placeholder="Reality Public Key"
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          className="rounded-none"
        />
        <Input placeholder="Short ID" value={shortId} onChange={(e) => setShortId(e.target.value)} className="rounded-none" />
        <Input
          placeholder="Лимит пользователей (пусто = без лимита)"
          value={maxUsers}
          onChange={(e) => setMaxUsers(e.target.value.replace(/[^0-9]/g, ""))}
          className="rounded-none"
        />
        <Input
          placeholder="Management API URL (пусто = локальный узел Amvera)"
          value={managementApiUrl}
          onChange={(e) => setManagementApiUrl(e.target.value)}
          className="rounded-none col-span-2"
        />
        <Input
          type="password"
          placeholder="Management API Secret (X-Management-Secret)"
          value={managementApiSecret}
          onChange={(e) => setManagementApiSecret(e.target.value)}
          className="rounded-none col-span-2"
        />
        <Input
          placeholder="Cert SHA256 (base64, для IP-нод без домена — вместо allowInsecure)"
          value={certSha256}
          onChange={(e) => setCertSha256(e.target.value)}
          className="rounded-none col-span-2"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Активен
        </label>
      </div>
      {/* SSH hint for reading the MGMT secret from a remote node */}
      {node && node.managementApiUrl && (() => {
        const ipMatch = node.managementApiUrl.match(/https?:\/\/([\d.]+)/);
        const ip = ipMatch?.[1];
        if (!ip) return null;
        const sshCmd = `ssh root@${ip} cat /opt/vpn-node/.env`;
        return (
          <div className="border border-muted bg-muted/20 p-3 space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">🔑 Получить актуальный секрет с сервера:</p>
            <code className="block bg-background border border-border px-2 py-1.5 font-mono select-all break-all">
              {sshCmd}
            </code>
            <p>Скопируй значение <span className="font-mono">MGMT_API_SECRET=...</span> и вставь в поле выше.</p>
          </div>
        );
      })()}
      {sniChanged && (
        <div className="border border-amber-400 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2 text-sm">
          <p className="font-semibold text-amber-800 dark:text-amber-300">
            ⚠️ Домен изменился — нужно перевыпустить SSL-сертификат вручную
          </p>
          <p className="text-amber-700 dark:text-amber-400 text-xs">
            База обновится сразу после сохранения. Затем подключись по SSH к серверу и выполни:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-amber-100 dark:bg-amber-900/50 border border-amber-300 px-2 py-1.5 text-xs font-mono break-all select-all">
              {certbotCmd}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(certbotCmd).catch(() => {});
                setCertCopied(true);
                setTimeout(() => setCertCopied(false), 2000);
              }}
              className="shrink-0 border border-amber-400 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors"
            >
              {certCopied ? "✓ Скопировано" : "Копировать"}
            </button>
          </div>
          <p className="text-amber-600 dark:text-amber-500 text-xs">
            Убедись что DNS-запись <strong>{sni.trim()}</strong> указывает на IP этого сервера до запуска команды.
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={creating || updating || !name || !region || !sni}
          className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          Сохранить
        </button>
        <button onClick={onDone} className="border border-border px-4 py-2 text-sm">
          Отмена
        </button>
      </div>
    </div>
  );
}

function NodesManagement() {
  const { data: nodes, isLoading } = useListVpnNodes();
  const { mutate: deleteNode } = useDeleteVpnNode();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [managingId, setManagingId] = useState<number | null>(null);
  const [newNodeMode, setNewNodeMode] = useState<null | "provision" | "manual">(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [regionFilter, setRegionFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sort, setSort] = useState<"default" | "clients_desc" | "name">("default");

  function handleDelete(nodeId: number) {
    if (confirmDeleteId !== nodeId) {
      setConfirmDeleteId(nodeId);
      return;
    }
    setConfirmDeleteId(null);
    deleteNode(
      { nodeId },
      {
        onSuccess: (data) => {
          queryClient.invalidateQueries({ queryKey: getListVpnNodesQueryKey() });
          if (data.failedMigrations > 0) {
            toast({
              title: `Узел удалён (ключей перенесено: ${data.migratedKeys}, не удалось: ${data.failedMigrations})`,
              description: "Пользователи с непереноситыми ключами остались без VPN. Проверьте логи.",
              variant: "destructive",
            });
          } else if (data.migratedKeys > 0) {
            toast({
              title: `Узел удалён`,
              description: `${data.migratedKeys} ${data.migratedKeys === 1 ? "ключ перенесён" : "ключей перенесено"} на другие серверы.`,
            });
          } else {
            toast({ title: "Узел удалён" });
          }
        },
        onError: (err: unknown) => {
          const msg =
            err && typeof err === "object" && "message" in err
              ? (err as { message: string }).message
              : "Ошибка удаления узла";
          toast({ title: msg, variant: "destructive" });
        },
      },
    );
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const regions = [...new Set((nodes ?? []).map((n) => n.region))];

  const filteredNodes = (nodes ?? [])
    .filter((n) => regionFilter === "all" || n.region === regionFilter)
    .filter((n) => statusFilter === "all" || (statusFilter === "active" ? n.isActive : !n.isActive))
    .sort((a, b) => {
      switch (sort) {
        case "clients_desc":
          return (b.activeUserCount ?? 0) - (a.activeUserCount ?? 0);
        case "name":
          return a.name.localeCompare(b.name);
        case "default":
        default:
          return 0;
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={regionFilter}
          onChange={(e) => setRegionFilter(e.target.value)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все регионы</option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все статусы</option>
          <option value="active">Активные</option>
          <option value="inactive">Неактивные</option>
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="default">Без сортировки</option>
          <option value="clients_desc">По числу клиентов</option>
          <option value="name">По названию</option>
        </select>
      </div>
      {filteredNodes.map((node) =>
        editingId === node.id ? (
          <NodeForm key={node.id} node={node} onDone={() => setEditingId(null)} />
        ) : (
          <div key={node.id} className="bg-card border border-border">
            <div className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0 break-words">
                <div className="font-bold flex items-center gap-2 flex-wrap">
                  <span>{node.name}</span>
                  <span className="text-muted-foreground font-normal">· {node.region}</span>
                  {!node.isActive && <span className="text-muted-foreground font-normal">(неактивен)</span>}
                  {node.managementApiUrl && <NodePollingHealthIndicator nodeName={node.name} />}
                  {/* Warn when a remote node uses a self-signed cert (provisioner
                      stores the SHA256 fingerprint in certSha256 only for self-signed;
                      LE-cert nodes have certSha256 = null). */}
                  {node.managementApiUrl && node.certSha256 && (
                    <span
                      title={"Самоподписанный сертификат — VPN-клиенты не смогут подключиться!\nЗайди на сервер и выполни: certbot --nginx -d " + node.sni}
                      className="text-xs font-normal bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400 border border-red-300 dark:border-red-800 px-1.5 py-0.5 cursor-help"
                    >
                      ⚠️ Self-signed cert
                    </span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground font-mono break-all">
                  {node.host ?? "—"}:{node.port ?? 443} · SNI: {node.sni}
                </div>
                {node.managementApiUrl && (
                  <div className="text-xs text-blue-600 font-mono break-all">
                    Remote: {node.managementApiUrl}
                  </div>
                )}
                <div className="text-sm text-muted-foreground">
                  Клиентов: {node.activeUserCount}
                  {node.maxUsers != null ? ` / ${node.maxUsers}` : ""}
                </div>
              </div>
              <div className="flex gap-2 shrink-0 items-center">
                <NodeHealthButton nodeId={node.id} />
                <button
                  onClick={() => setManagingId(managingId === node.id ? null : node.id)}
                  className={`flex items-center gap-1 text-xs px-2 py-1 border transition-colors ${
                    managingId === node.id
                      ? "border-primary text-primary bg-primary/5"
                      : "border-border text-muted-foreground hover:text-primary hover:border-primary"
                  }`}
                  title="Управление узлом"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Управление</span>
                </button>
                <button onClick={() => { setEditingId(node.id); setManagingId(null); }} className="p-2 text-muted-foreground hover:text-primary">
                  <Pencil className="w-4 h-4" />
                </button>
                {confirmDeleteId === node.id ? (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-destructive">
                      {(node.activeUserCount ?? 0) > 0
                        ? `Удалить узел и ${node.activeUserCount} акт. ключей?`
                        : "Удалить узел?"}
                    </span>
                    <button
                      onClick={() => handleDelete(node.id)}
                      className="text-xs px-2 py-1 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Да
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-xs px-2 py-1 border border-border hover:bg-muted"
                    >
                      Нет
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => handleDelete(node.id)}
                    className="p-2 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
            {managingId === node.id && (
              <div className="px-4 pb-4">
                <NodeManagementPanel nodeId={node.id} />
              </div>
            )}
          </div>
        ),
      )}
      {editingId === "new" ? (
        newNodeMode === "provision" ? (
          <NodeProvisioningWizard onDone={() => { setEditingId(null); setNewNodeMode(null); }} />
        ) : newNodeMode === "manual" ? (
          <NodeForm onDone={() => { setEditingId(null); setNewNodeMode(null); }} />
        ) : (
          /* Mode selection */
          <div className="border border-dashed border-border p-4 space-y-3">
            <p className="text-sm text-muted-foreground text-center">Как добавить узел?</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <button
                onClick={() => setNewNodeMode("provision")}
                className="flex flex-col items-center gap-2 border border-border p-4 text-sm hover:border-primary hover:text-primary transition-colors group"
              >
                <Zap className="w-5 h-5 text-primary" />
                <span className="font-bold">Авто-развертывание</span>
                <span className="text-xs text-muted-foreground text-center group-hover:text-primary/70">
                  Введите IP и пароль VPS — всё остальное автоматически
                </span>
              </button>
              <button
                onClick={() => setNewNodeMode("manual")}
                className="flex flex-col items-center gap-2 border border-border p-4 text-sm hover:border-primary hover:text-primary transition-colors group"
              >
                <Server className="w-5 h-5 text-muted-foreground group-hover:text-primary" />
                <span className="font-bold">Вручную</span>
                <span className="text-xs text-muted-foreground text-center group-hover:text-primary/70">
                  Сервер уже настроен — введите параметры подключения
                </span>
              </button>
            </div>
            <div className="flex justify-center">
              <button
                onClick={() => setEditingId(null)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Отмена
              </button>
            </div>
          </div>
        )
      ) : (
        <button
          onClick={() => { setEditingId("new"); setNewNodeMode(null); }}
          className="flex items-center gap-2 border border-dashed border-border px-4 py-3 text-sm font-medium text-muted-foreground hover:text-primary hover:border-primary transition-colors w-full justify-center"
        >
          <Plus className="w-4 h-4" /> Новый узел
        </button>
      )}
    </div>
  );
}

function UserSubscriptionEditor({ user }: { user: AdminUser }) {
  const { data: plans } = useListPlans();
  const { mutate: updateSubscription, isPending } = useUpdateUserSubscription();
  const { toast } = useToast();
  const [fixingBilling, setFixingBilling] = useState(false);
  // Default to the genuinely active plan (not a cancelled/pending one).
  const [planId, setPlanId] = useState<string>(
    user.activePlanId ? String(user.activePlanId) : user.planId ? String(user.planId) : "",
  );
  const [durationDays, setDurationDays] = useState("");

  // Detect hourly subscriptions whose startsAt is in the future — this causes
  // ticksElapsed to be negative and billing to silently skip forever.
  // Use activeSubscription* fields (sourced from the status=active row) rather
  // than subscriptionStartsAt/BillingType (sourced from the most-recently-
  // CREATED subscription regardless of status), because a cancelled pending
  // row with startsAt=null sorts first in DESC and masks the real active one.
  const billingStartInFuture =
    user.activeSubscriptionBillingType === "hourly" &&
    user.activeSubscriptionId != null &&
    user.activeSubscriptionStartsAt != null &&
    new Date(user.activeSubscriptionStartsAt) > new Date();

  async function handleFixBillingStart() {
    if (!user.activeSubscriptionId) return;
    setFixingBilling(true);
    try {
      const res = await fetch(`/api/admin/debug/billing/fix/${user.activeSubscriptionId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}), // reset to now
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: `Ошибка сброса биллинга: ${body.error ?? res.status}`, variant: "destructive" });
        return;
      }
      const data = await res.json();
      queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
      toast({
        title: "Биллинг сброшен ✓",
        description: `starts_at сброшен с ${data.previousStartsAt ? new Date(data.previousStartsAt).toLocaleString("ru") : "—"} на текущее время. Списание начнётся в течение 5 минут.`,
      });
    } catch {
      toast({ title: "Ошибка сброса биллинга", variant: "destructive" });
    } finally {
      setFixingBilling(false);
    }
  }

  function handleAssign() {
    if (!planId) return;
    updateSubscription(
      {
        userId: user.id,
        data: { planId: Number(planId), ...(durationDays ? { durationDays: Number(durationDays) } : {}) },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          toast({ title: "Подписка обновлена" });
          setDurationDays("");
        },
        onError: () => toast({ title: "Ошибка обновления подписки", variant: "destructive" }),
      },
    );
  }

  const statusLabel: Record<string, string> = {
    pending_payment: "Ожидает оплаты",
    active: "Активна",
    expired: "Истекла",
    cancelled: "Отменена",
    rejected: "Отклонена",
  };

  // Show the genuinely active plan prominently; if there's also a most-recent
  // subscription with a different status (e.g. a cancelled request), show it
  // as secondary info so admins aren't confused by the two differing.
  const hasActiveplan = Boolean(user.activePlanName);
  const hasDifferentCurrent = user.planName && user.planName !== user.activePlanName;

  return (
    <div className="space-y-2">
      {hasActiveplan ? (
        <div className="text-xs font-mono text-muted-foreground">
          Активный тариф:{" "}
          <span className="font-bold text-foreground">{user.activePlanName}</span>
          {user.subscriptionStatus === "active" && user.subscriptionEndsAt && ` · до ${formatDate(user.subscriptionEndsAt)}`}
          {hasDifferentCurrent && (
            <span className="ml-2 text-muted-foreground/70">
              · последняя заявка: {user.planName}{" "}
              {user.subscriptionStatus && `· ${statusLabel[user.subscriptionStatus] ?? user.subscriptionStatus}`}
            </span>
          )}
        </div>
      ) : (
        <div className="text-xs font-mono text-muted-foreground">
          {user.planName ? (
            <>
              Последняя подписка:{" "}
              <span className="font-bold text-foreground">{user.planName}</span>
              {user.subscriptionStatus && ` · ${statusLabel[user.subscriptionStatus] ?? user.subscriptionStatus}`}
              {user.subscriptionEndsAt && ` · до ${formatDate(user.subscriptionEndsAt)}`}
            </>
          ) : (
            <span>Подписок нет</span>
          )}
        </div>
      )}
      {user.activeSubscriptionBillingType === "hourly" && user.activeSubscriptionId != null && (
        <div className={`flex items-center gap-2 flex-wrap rounded border px-3 py-2 ${
          billingStartInFuture
            ? "border-yellow-500/50 bg-yellow-500/10"
            : "border-border bg-muted/30"
        }`}>
          <span className={`text-xs flex-1 font-mono ${billingStartInFuture ? "text-yellow-700 dark:text-yellow-400" : "text-muted-foreground"}`}>
            {billingStartInFuture ? (
              <>⚠ Биллинг заморожен: <code>starts_at</code> в будущем ({new Date(user.activeSubscriptionStartsAt!).toLocaleString("ru")})</>
            ) : (
              <>✓ Почасовой биллинг активен{user.activeSubscriptionLastBilledAt
                ? ` · последнее списание: ${new Date(user.activeSubscriptionLastBilledAt).toLocaleString("ru")}`
                : " · ещё не списывалось"
              }</>
            )}
          </span>
          {billingStartInFuture && (
            <button
              onClick={handleFixBillingStart}
              disabled={fixingBilling}
              className="bg-yellow-500 text-white font-bold px-3 py-1 text-xs hover:bg-yellow-600 transition-colors disabled:opacity-50 shrink-0"
            >
              {fixingBilling ? "Сброс…" : "Исправить биллинг"}
            </button>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="">— Выберите тариф —</option>
          {plans?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.durationDays} дн.
            </option>
          ))}
        </select>
        <Input
          type="number"
          min={1}
          placeholder="Дней (необязательно)"
          value={durationDays}
          onChange={(e) => setDurationDays(e.target.value)}
          className="rounded-none w-44"
        />
        <button
          onClick={handleAssign}
          disabled={!planId || isPending}
          className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          Назначить / продлить
        </button>
      </div>
    </div>
  );
}

function UserBalanceEditor({ user }: { user: AdminUser }) {
  const { mutate: setBalance, isPending } = useAdminSetUserBalance();
  const { toast } = useToast();
  // Input in rubles, backend expects kopecks
  const [value, setValue] = useState(String((user.balanceKopecks / 100).toFixed(2)));

  function handleSave() {
    const rubles = parseFloat(value.replace(",", "."));
    if (isNaN(rubles) || rubles < 0) {
      toast({ title: "Некорректное значение", variant: "destructive" });
      return;
    }
    const kopecks = Math.round(rubles * 100);
    setBalance(
      { userId: user.id, data: { balanceKopecks: kopecks } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          toast({ title: `Баланс установлен: ${rubles.toFixed(2)} ₽` });
        },
        onError: (err: unknown) =>
          toast({
            title: err instanceof Error ? err.message : "Ошибка изменения баланса",
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-none w-36 font-mono"
        placeholder="0.00"
      />
      <span className="text-sm text-muted-foreground">₽</span>
      <button
        onClick={handleSave}
        disabled={isPending}
        className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
      >
        Установить
      </button>
    </div>
  );
}

function UserSetPasswordEditor({ user }: { user: AdminUser }) {
  const { mutate: setPassword, isPending } = useAdminSetUserPassword();
  const { toast } = useToast();
  const [password, setPasswordValue] = useState("");

  function handleSave() {
    if (password.length < 8) {
      toast({ title: "Минимум 8 символов", variant: "destructive" });
      return;
    }
    setPassword(
      { userId: user.id, data: { password } },
      {
        onSuccess: () => {
          setPasswordValue("");
          toast({ title: "Пароль установлен. Все сессии пользователя завершены." });
        },
        onError: (err: unknown) =>
          toast({
            title: err instanceof Error ? err.message : "Ошибка смены пароля",
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Input
        type="password"
        value={password}
        onChange={(e) => setPasswordValue(e.target.value)}
        className="rounded-none max-w-64"
        placeholder="Новый пароль (мин. 8 символов)"
      />
      <button
        onClick={handleSave}
        disabled={isPending || password.length < 8}
        className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
      >
        Задать пароль
      </button>
      <span className="text-xs text-muted-foreground">Все сессии пользователя будут завершены.</span>
    </div>
  );
}

function UserProfileEditor({ user }: { user: AdminUser }) {
  const { mutate: updateProfile, isPending } = useUpdateUserProfile();
  const { toast } = useToast();
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);

  function handleSave() {
    const data: { name?: string | null; email?: string } = {};
    if (name !== (user.name ?? "")) data.name = name || null;
    if (email !== user.email) data.email = email;
    if (Object.keys(data).length === 0) return;

    updateProfile(
      { userId: user.id, data },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          toast({ title: "Профиль обновлён" });
        },
        onError: (err: unknown) =>
          toast({
            title: err instanceof Error ? err.message : "Ошибка обновления профиля",
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Input
        placeholder="Имя"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-none max-w-48"
      />
      <Input
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-none max-w-64"
      />
      <button
        onClick={handleSave}
        disabled={isPending}
        className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
      >
        Сохранить
      </button>
    </div>
  );
}

function BalanceTransactionRow({ tx }: { tx: AdminBalanceTransaction }) {
  const isCredit = tx.amountKopecks > 0;
  const typeLabel: Record<string, string> = {
    topup: "Пополнение",
    debit: "Списание",
    refund: "Возврат",
    referral: "Реферал",
  };
  return (
    <div className="flex items-center justify-between gap-2 bg-muted/30 border border-border px-2 py-1.5 text-xs">
      <div className="min-w-0">
        <div className="font-medium">{typeLabel[tx.type] ?? tx.type}</div>
        {tx.description && <div className="text-muted-foreground truncate">{tx.description}</div>}
        <div className="text-muted-foreground font-mono">{formatDate(tx.createdAt)}</div>
      </div>
      <div className={`font-mono font-bold shrink-0 ${isCredit ? "text-green-600" : "text-muted-foreground"}`}>
        {isCredit ? "+" : ""}{(tx.amountKopecks / 100).toFixed(2)} ₽
      </div>
    </div>
  );
}

function ForceLogoutButton({ userId }: { userId: number }) {
  const { mutate, isPending } = useAdminForceLogout();
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        mutate(
          { userId },
          {
            onSuccess: () => toast({ title: "Все сессии пользователя завершены" }),
            onError: () => toast({ title: "Ошибка принудительного выхода", variant: "destructive" }),
          },
        )
      }
      disabled={isPending}
      className="border border-border px-4 py-2 text-sm font-medium hover:border-destructive hover:text-destructive transition-colors disabled:opacity-50"
    >
      Выйти со всех устройств
    </button>
  );
}

function BanButton({ userId, isBanned }: { userId: number; isBanned: boolean }) {
  const { mutate: ban, isPending: banning } = useAdminBanUser();
  const { mutate: unban, isPending: unbanning } = useAdminUnbanUser();
  const { toast } = useToast();
  const isPending = banning || unbanning;

  if (isBanned) {
    return (
      <button
        onClick={() =>
          unban(
            { userId },
            {
              onSuccess: () => {
                toast({ title: "Блокировка снята" });
                queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
              },
              onError: () => toast({ title: "Ошибка при разблокировке", variant: "destructive" }),
            },
          )
        }
        disabled={isPending}
        className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
      >
        Разблокировать
      </button>
    );
  }

  return (
    <button
      onClick={() =>
        ban(
          { userId },
          {
            onSuccess: () => {
              toast({ title: "Пользователь заблокирован" });
              queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
            },
            onError: () => toast({ title: "Ошибка при блокировке", variant: "destructive" }),
          },
        )
      }
      disabled={isPending}
      className="border border-amber-500 text-amber-600 px-4 py-2 text-sm font-medium hover:bg-amber-500 hover:text-white transition-colors disabled:opacity-50"
    >
      Заблокировать
    </button>
  );
}

function AdminNoteEditor({ userId, initialNote }: { userId: number; initialNote: string | null }) {
  const [note, setNote] = useState(initialNote ?? "");
  const { mutate, isPending } = useAdminSetUserNote();
  const { toast } = useToast();

  function handleSave() {
    mutate(
      { userId, data: { note: note.trim() || null } },
      {
        onSuccess: () => toast({ title: "Заметка сохранена" }),
        onError: () => toast({ title: "Ошибка сохранения заметки", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Внутренняя заметка для администраторов (не видна пользователю)..."
        className="rounded-none text-sm min-h-[80px] resize-y"
      />
      <button
        onClick={handleSave}
        disabled={isPending}
        className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
      >
        Сохранить заметку
      </button>
    </div>
  );
}

const NODE_POLL_STALE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Shows the last background traffic-poll result for a specific remote node.
 * Uses the same polling-health query as the global banner so there's no extra
 * network request — React Query serves from cache.
 */
function NodePollingHealthIndicator({ nodeName }: { nodeName: string }) {
  const { data } = useGetAdminTrafficPollingHealth({
    query: { queryKey: getGetAdminTrafficPollingHealthQueryKey(), refetchInterval: 60_000 },
  });

  const nodeHealth = data?.nodes?.find((n) => n.nodeName === nodeName);
  if (!nodeHealth) return null;

  const lastSuccess = nodeHealth.lastSuccessAt ? new Date(nodeHealth.lastSuccessAt) : null;
  const isStale = lastSuccess !== null && Date.now() - lastSuccess.getTime() > NODE_POLL_STALE_MS;
  const failures = nodeHealth.consecutiveFailures;

  let dotColor: string;
  let label: string;
  if (failures === 0 && lastSuccess !== null && !isStale) {
    dotColor = "bg-green-500";
    label = `Опрос OK · ${lastSuccess.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  } else if (failures > 0) {
    dotColor = failures >= 3 ? "bg-red-500" : "bg-yellow-500";
    label = `${failures} сбоев опроса${nodeHealth.lastError ? ` · ${nodeHealth.lastError}` : ""}`;
  } else if (isStale) {
    dotColor = "bg-yellow-500";
    label = `Опрос устарел · ${lastSuccess ? lastSuccess.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "никогда"}`;
  } else {
    // No data yet for this node
    dotColor = "bg-gray-400";
    label = "Опрос ещё не выполнялся";
  }

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotColor}`}
      title={label}
      aria-label={label}
    />
  );
}

function NodeHealthButton({ nodeId }: { nodeId: number }) {
  const [enabled, setEnabled] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const { data, isFetching, error } = useGetVpnNodeHealth(nodeId, {
    query: {
      enabled,
      staleTime: 0,
      gcTime: 0,
      retry: false,
      queryKey: getGetVpnNodeHealthQueryKey(nodeId),
    },
  });

  // Record timestamp when result arrives
  const prevFetching = useRef(false);
  useEffect(() => {
    if (prevFetching.current && !isFetching && enabled) {
      setCheckedAt(new Date());
    }
    prevFetching.current = isFetching;
  }, [isFetching, enabled]);

  if (!enabled) {
    return (
      <button
        onClick={() => setEnabled(true)}
        className="p-2 text-muted-foreground hover:text-primary transition-colors"
        title="Проверить доступность"
      >
        <Shield className="w-4 h-4" />
      </button>
    );
  }

  if (isFetching) return <span className="text-xs font-mono text-muted-foreground px-2">Пинг...</span>;

  return (
    <button
      onClick={() => { setEnabled(false); setCheckedAt(null); }}
      className="text-left"
      title="Нажмите чтобы сбросить"
    >
      {error || !data ? (
        <span className="text-xs font-mono text-destructive px-2">✗ Ошибка</span>
      ) : (
        <span className={`text-xs font-mono px-2 ${data.ok ? "text-green-600" : "text-destructive"}`}>
          {data.ok ? `✓ ${data.latencyMs != null ? `${data.latencyMs}ms` : "OK"}` : `✗ ${data.error ?? "Недоступен"}`}
        </span>
      )}
      {checkedAt && (
        <span className="block text-[9px] font-mono text-muted-foreground px-2">
          {checkedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      )}
    </button>
  );
}

// ─── Node Metric History Panel ────────────────────────────────────────────────

type MetricKey = "cpu" | "ram" | "disk";

const METRIC_LABELS: Record<MetricKey, string> = { cpu: "CPU", ram: "RAM", disk: "Диск" };

const METRIC_COLORS: Record<MetricKey, string> = {
  cpu:  "#3b82f6",
  ram:  "#8b5cf6",
  disk: "#f59e0b",
};

function MetricHistoryPanel({
  nodeId,
  metric,
  onClose,
}: {
  nodeId: number;
  metric: MetricKey;
  onClose: () => void;
}) {
  // Period presets
  type Period = "7d" | "30d" | "90d" | "custom";
  const [period, setPeriod] = useState<Period>("30d");

  // Default custom range: last 7 days (YYYY-MM-DD, local calendar)
  const todayStr = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const sevenDaysAgoStr = useMemo(() => new Date(Date.now() - 7 * 86400_000).toLocaleDateString("en-CA"), []);
  const [customFrom, setCustomFrom] = useState(sevenDaysAgoStr);
  const [customTo, setCustomTo]     = useState(todayStr);

  // Memoize the date range so the queryKey stays stable between re-renders.
  // Without this, `new Date()` produces a different ISO string on every render
  // (e.g. when the parent's 30-second status refetch triggers a re-render),
  // the queryKey changes, and React Query restarts the fetch — producing an
  // infinite loading spinner.
  const { from, to } = useMemo(() => {
    const now = new Date();
    if (period === "7d")  return { from: new Date(now.getTime() - 7  * 86400_000).toISOString(), to: now.toISOString() };
    if (period === "30d") return { from: new Date(now.getTime() - 30 * 86400_000).toISOString(), to: now.toISOString() };
    if (period === "90d") return { from: new Date(now.getTime() - 90 * 86400_000).toISOString(), to: now.toISOString() };
    // Custom: `<input type="date">` returns "YYYY-MM-DD" which new Date() parses
    // as midnight UTC — that would cut off the whole calendar day in UTC+3 and
    // later timezones. Append T23:59:59.999Z so the chosen "to" day is fully
    // included regardless of the user's timezone.
    return {
      from: customFrom
        ? new Date(customFrom + "T00:00:00.000Z").toISOString()
        : new Date(now.getTime() - 30 * 86400_000).toISOString(),
      to: customTo
        ? new Date(customTo + "T23:59:59.999Z").toISOString()
        : now.toISOString(),
    };
  }, [period, customFrom, customTo]);

  const { data, isLoading } = useGetVpnNodeMetrics(
    nodeId,
    { metric: metric as GetVpnNodeMetricsMetric, from, to },
    {
      query: {
        queryKey: [nodeId, metric, from, to],
      },
    },
  );

  const points = data?.points ?? [];
  const rangeMs = new Date(to).getTime() - new Date(from).getTime();
  const shortRange = rangeMs <= 7 * 86400_000;

  const formatXTick = (ts: number) => {
    const d = new Date(ts);
    if (shortRange) {
      return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "short" });
  };

  const formatTooltipDate = (ts: number) =>
    new Date(ts).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

  const color = METRIC_COLORS[metric];
  const label = METRIC_LABELS[metric];

  return (
    <div className="mt-3 border border-border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <span className="text-xs font-bold uppercase tracking-wide flex items-center gap-1.5">
          <LineChartIcon className="w-3.5 h-3.5" />
          {label} — история
        </span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground p-1 transition-colors"
          title="Закрыть"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border flex-wrap">
        {(["7d", "30d", "90d"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-2.5 py-0.5 text-xs border transition-colors ${
              period === p
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
            }`}
          >
            {p === "7d" ? "7 дней" : p === "30d" ? "30 дней" : "90 дней"}
          </button>
        ))}
        <button
          onClick={() => setPeriod("custom")}
          className={`px-2.5 py-0.5 text-xs border transition-colors ${
            period === "custom"
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
          }`}
        >
          Произвольный
        </button>
        {period === "custom" && (
          <div className="flex items-center gap-1.5 mt-1 w-full">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="border border-border bg-background text-xs px-2 py-0.5 flex-1 min-w-0"
            />
            <span className="text-xs text-muted-foreground shrink-0">—</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="border border-border bg-background text-xs px-2 py-0.5 flex-1 min-w-0"
            />
          </div>
        )}
      </div>

      {/* Chart */}
      <div className="px-2 py-3">
        {isLoading ? (
          <div className="h-36 flex items-center justify-center">
            <p className="text-xs text-muted-foreground">Загрузка…</p>
          </div>
        ) : points.length === 0 ? (
          <div className="h-36 flex flex-col items-center justify-center gap-1">
            <p className="text-xs font-medium text-muted-foreground">Данных пока нет</p>
            <p className="text-[10px] text-muted-foreground max-w-[220px] text-center">
              Снимки метрик накапливаются с момента открытия панели статуса. Первые точки появятся через&nbsp;5&nbsp;минут.
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={points} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${metric}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="10%" stopColor={color} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={formatXTick}
                tick={{ fontSize: 9 }}
                stroke="var(--muted-foreground)"
                tickCount={5}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 9 }}
                stroke="var(--muted-foreground)"
                width={38}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0];
                  if (!p?.payload) return null;
                  return (
                    <div className="bg-background border border-border px-2 py-1 text-xs shadow-md">
                      <p className="text-muted-foreground">{formatTooltipDate(p.payload.ts as number)}</p>
                      <p className="font-bold" style={{ color }}>
                        {label}: {p.value}%
                      </p>
                    </div>
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={1.5}
                fill={`url(#grad-${metric})`}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
        {points.length > 0 && (
          <p className="text-[9px] text-muted-foreground text-right mt-1 font-mono">
            {points.length} точек · усреднение по {rangeMs <= 7 * 86400_000 ? "15 мин" : rangeMs <= 30 * 86400_000 ? "1 ч" : "4 ч"}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Node Management Panel ────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function formatBytesShort(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} ГБ`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} МБ`;
  return `${(bytes / 1024).toFixed(0)} КБ`;
}

function NodeManagementPanel({ nodeId }: { nodeId: number }) {
  const { toast } = useToast();
  const [logProcess, setLogProcess] = useState<"xray" | "mgmt-api">("xray");
  const [logLines, setLogLines] = useState(100);
  const [logsEnabled, setLogsEnabled] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);

  // Status — auto-refresh every 30s once panel is open.
  const {
    data: status,
    isFetching: statusFetching,
    error: statusError,
    refetch: refetchStatus,
  } = useGetVpnNodeSystemStatus(nodeId, {
    query: {
      queryKey: getGetVpnNodeSystemStatusQueryKey(nodeId),
      refetchInterval: 30_000,
      retry: false,
    },
  });

  // Logs — only fetched when explicitly requested.
  const {
    data: logs,
    isFetching: logsFetching,
    refetch: refetchLogs,
  } = useGetVpnNodeSystemLogs(nodeId, { process: logProcess, lines: logLines }, {
    query: {
      queryKey: getGetVpnNodeSystemLogsQueryKey(nodeId, { process: logProcess, lines: logLines }),
      enabled: logsEnabled,
      staleTime: 0,
      gcTime: 0,
      retry: false,
    },
  });

  // Restart mutation.
  const { mutate: restartXray, isPending: restarting } = useRestartVpnNodeXray({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetVpnNodeSystemStatusQueryKey(nodeId), data.status);
        toast({ title: data.ok ? "Xray перезапущен" : "Перезапуск завершён с ошибкой", variant: data.ok ? "default" : "destructive" });
        setConfirmRestart(false);
      },
      onError: () => {
        toast({ title: "Ошибка перезапуска Xray", variant: "destructive" });
        setConfirmRestart(false);
      },
    },
  });

  const cpuBarWidth = status ? Math.min(100, status.cpuPercent) : 0;
  const ramPercent = status ? Math.round((status.ramUsedBytes / status.ramTotalBytes) * 100) : 0;
  const diskPercent = status ? Math.round((status.diskUsedBytes / status.diskTotalBytes) * 100) : 0;

  return (
    <div className="mt-3 border border-border bg-muted/30 p-4 space-y-4">
      {/* ── System status ── */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5" /> Системный статус
        </span>
        <button
          onClick={() => refetchStatus()}
          disabled={statusFetching}
          className="text-muted-foreground hover:text-primary p-1 transition-colors"
          title="Обновить"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${statusFetching ? "animate-spin" : ""}`} />
        </button>
      </div>

      {statusError ? (
        <p className="text-xs text-destructive font-mono">
          Ошибка: {statusError instanceof Error ? statusError.message : "Недоступен"}
        </p>
      ) : !status ? (
        <p className="text-xs text-muted-foreground font-mono">Загрузка…</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* CPU — clickable */}
          <button
            type="button"
            onClick={() => setOpenMetric(openMetric === "cpu" ? null : "cpu")}
            className={`bg-background border p-3 text-left transition-colors hover:bg-muted/40 ${openMetric === "cpu" ? "border-blue-500 ring-1 ring-blue-500/30" : "border-border"}`}
            title="Показать историю CPU"
          >
            <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1 flex items-center justify-between">
              CPU <LineChartIcon className="w-2.5 h-2.5 opacity-40" />
            </div>
            <div className="text-lg font-bold">{status.cpuPercent.toFixed(1)}%</div>
            <div className="mt-1.5 h-1 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${cpuBarWidth > 80 ? "bg-destructive" : cpuBarWidth > 50 ? "bg-yellow-500" : "bg-green-500"}`}
                style={{ width: `${cpuBarWidth}%` }}
              />
            </div>
          </button>
          {/* RAM — clickable */}
          <button
            type="button"
            onClick={() => setOpenMetric(openMetric === "ram" ? null : "ram")}
            className={`bg-background border p-3 text-left transition-colors hover:bg-muted/40 ${openMetric === "ram" ? "border-violet-500 ring-1 ring-violet-500/30" : "border-border"}`}
            title="Показать историю RAM"
          >
            <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1 flex items-center justify-between">
              RAM <LineChartIcon className="w-2.5 h-2.5 opacity-40" />
            </div>
            <div className="text-lg font-bold">{ramPercent}%</div>
            <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
              {formatBytesShort(status.ramUsedBytes)} / {formatBytesShort(status.ramTotalBytes)}
            </div>
          </button>
          {/* Disk — clickable */}
          <button
            type="button"
            onClick={() => setOpenMetric(openMetric === "disk" ? null : "disk")}
            className={`bg-background border p-3 text-left transition-colors hover:bg-muted/40 ${openMetric === "disk" ? "border-amber-500 ring-1 ring-amber-500/30" : "border-border"}`}
            title="Показать историю диска"
          >
            <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1 flex items-center justify-between">
              Диск <LineChartIcon className="w-2.5 h-2.5 opacity-40" />
            </div>
            <div className="text-lg font-bold">{diskPercent}%</div>
            <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
              {formatBytesShort(status.diskUsedBytes)} / {formatBytesShort(status.diskTotalBytes)}
            </div>
          </button>
          {/* Uptime — not charted */}
          <div className="bg-background border border-border p-3">
            <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Uptime</div>
            <div className="text-lg font-bold">{formatUptime(status.uptimeSeconds)}</div>
          </div>
        </div>
      )}

      {/* ── Metric history panel (slides in below tiles on click) ── */}
      {openMetric && (
        <MetricHistoryPanel
          nodeId={nodeId}
          metric={openMetric}
          onClose={() => setOpenMetric(null)}
        />
      )}

      {/* ── Logs ── */}
      <div>
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <span className="text-xs font-bold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5" /> Логи
          </span>
          <select
            value={logProcess}
            onChange={(e) => {
              setLogProcess(e.target.value as "xray" | "mgmt-api");
              setLogsEnabled(false);
            }}
            className="border border-border bg-background px-2 py-1 text-xs rounded-none"
          >
            <option value="xray">xray</option>
            <option value="mgmt-api">mgmt-api</option>
          </select>
          <select
            value={logLines}
            onChange={(e) => setLogLines(Number(e.target.value))}
            className="border border-border bg-background px-2 py-1 text-xs rounded-none"
          >
            <option value={50}>50 строк</option>
            <option value={100}>100 строк</option>
            <option value={200}>200 строк</option>
            <option value={500}>500 строк</option>
          </select>
          <button
            onClick={() => { setLogsEnabled(true); refetchLogs(); }}
            disabled={logsFetching}
            className="flex items-center gap-1 text-xs border border-border px-3 py-1 hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${logsFetching ? "animate-spin" : ""}`} />
            {logsEnabled ? "Обновить" : "Показать"}
          </button>
        </div>

        {logsEnabled && (
          <pre className="bg-black text-green-400 text-[11px] font-mono p-3 overflow-auto max-h-72 whitespace-pre-wrap break-all leading-relaxed">
            {logsFetching
              ? "Загрузка…"
              : logs && logs.lines.length > 0
              ? logs.lines.join("\n")
              : "Нет данных"}
          </pre>
        )}
      </div>

      {/* ── Restart Xray ── */}
      <div className="flex items-center gap-3 pt-1 border-t border-border">
        {!confirmRestart ? (
          <button
            onClick={() => setConfirmRestart(true)}
            className="flex items-center gap-1.5 text-xs border border-border px-3 py-1.5 hover:border-orange-500 hover:text-orange-600 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Перезапустить Xray
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Вы уверены?</span>
            <button
              onClick={() => restartXray({ nodeId })}
              disabled={restarting}
              className="text-xs bg-orange-600 text-white px-3 py-1.5 hover:bg-orange-700 transition-colors disabled:opacity-50"
            >
              {restarting ? "Перезапуск…" : "Да, перезапустить"}
            </button>
            <button
              onClick={() => setConfirmRestart(false)}
              className="text-xs border border-border px-3 py-1.5 hover:bg-muted transition-colors"
            >
              Отмена
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const KEYS_PAGE_SIZE = 8;
const PAYMENTS_PAGE_SIZE = 10;
const TXS_PAGE_SIZE = 10;

function UserKeysAndPayments({ userId }: { userId: number }) {
  const { data: keys } = useListAdminVpnKeys({ userId });
  const { data: payments } = useListAdminPayments({ userId });
  const { data: balanceTxs } = useListAdminUserBalanceTransactions(userId);
  const { toast } = useToast();
  const [showAllKeys, setShowAllKeys] = useState(false);
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [showAllTxs, setShowAllTxs] = useState(false);

  const revokeMutation = useMutation({
    mutationFn: async (keyId: number) => {
      const res = await fetch(`/api/admin/vpn-keys/${keyId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      toast({ title: "Ключ отозван" });
      queryClient.invalidateQueries({ queryKey: getListAdminVpnKeysQueryKey({ userId }) });
      queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
    },
    onError: () => toast({ title: "Ошибка отзыва ключа", variant: "destructive" }),
  });

  const userKeys = keys ?? [];
  const userPayments = payments ?? [];
  const visibleKeys = showAllKeys ? userKeys : userKeys.slice(0, KEYS_PAGE_SIZE);
  const totalPaymentPages = Math.max(1, Math.ceil(userPayments.length / PAYMENTS_PAGE_SIZE));
  const visiblePayments = userPayments.slice((paymentsPage - 1) * PAYMENTS_PAGE_SIZE, paymentsPage * PAYMENTS_PAGE_SIZE);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
          Ключи VPN ({userKeys.length})
        </div>
        {userKeys.length === 0 ? (
          <p className="text-xs text-muted-foreground">Ключей нет.</p>
        ) : (
          visibleKeys.map((key) => (
            <div key={key.id} className={`bg-muted/30 border border-border px-2 py-1.5 text-xs ${key.revokedAt ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between gap-2 min-w-0">
                <div className={`min-w-0 truncate ${key.revokedAt ? "text-muted-foreground line-through font-medium" : "font-medium"}`}>
                  {key.label}
                </div>
                {!key.revokedAt && (
                  <button
                    onClick={() => revokeMutation.mutate(key.id)}
                    disabled={revokeMutation.isPending}
                    className="shrink-0 text-destructive hover:opacity-70 transition-opacity"
                    title="Отозвать"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 text-muted-foreground font-mono">
                <div>
                  <span className="text-[10px] uppercase tracking-wide">Период</span>
                  <div>↑ {formatBytes(key.periodUpBytes)}</div>
                  <div>↓ {formatBytes(key.periodDownBytes)}</div>
                  <div className="text-foreground/70">= {formatBytes(key.periodUpBytes + key.periodDownBytes)}</div>
                </div>
                <div>
                  <span className="text-[10px] uppercase tracking-wide">Всего</span>
                  <div>↑ {formatBytes(key.trafficUpBytes)}</div>
                  <div>↓ {formatBytes(key.trafficDownBytes)}</div>
                  <div className="text-foreground/70">= {formatBytes(key.trafficUpBytes + key.trafficDownBytes)}</div>
                </div>
              </div>
              {key.revokedAt && (
                <div className="mt-1 text-[10px] text-muted-foreground font-mono">
                  Отозван: {formatDate(key.revokedAt)}
                  {key.revokedReason && (
                    <span className="ml-1 px-1 bg-muted rounded">
                      {key.revokedReason === "admin" ? "вручную" :
                       key.revokedReason === "traffic_limit" ? "лимит трафика" :
                       key.revokedReason === "expired" ? "подписка истекла" :
                       key.revokedReason}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        {userKeys.length > KEYS_PAGE_SIZE && (
          <button
            onClick={() => setShowAllKeys((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
          >
            {showAllKeys ? "Скрыть" : `Показать все ${userKeys.length} ключей`}
          </button>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
          Платежи ({userPayments.length})
        </div>
        {userPayments.length === 0 ? (
          <p className="text-xs text-muted-foreground">Платежей нет.</p>
        ) : (
          <>
            {visiblePayments.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 bg-muted/30 border border-border px-2 py-1.5 text-xs">
                <div className="min-w-0">
                  <div className="font-medium">
                    {p.type === "extra_device_slot"
                      ? "Доп. устройство"
                      : p.type === "extra_traffic"
                        ? `Доп. трафик${p.extraTrafficGb ? ` (+${p.extraTrafficGb} ГБ)` : ""}`
                        : p.type === "balance_topup"
                          ? "Пополнение баланса"
                          : (p.planName ?? "Подписка")}
                  </div>
                  <div className="text-muted-foreground font-mono">{formatDate(p.createdAt)}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="font-mono font-bold">{p.amountRub} ₽</div>
                  <div
                    className={
                      p.status === "confirmed"
                        ? "text-green-600"
                        : p.status === "rejected"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }
                  >
                    {p.status === "confirmed" ? "Оплачен" : p.status === "rejected" ? "Отклонён" : "Ожидает"}
                  </div>
                </div>
              </div>
            ))}
            {totalPaymentPages > 1 && (
              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => setPaymentsPage((p) => Math.max(1, p - 1))}
                  disabled={paymentsPage === 1}
                  className="text-xs border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-muted transition-colors"
                >←</button>
                <span className="text-xs text-muted-foreground">{paymentsPage} / {totalPaymentPages}</span>
                <button
                  onClick={() => setPaymentsPage((p) => Math.min(totalPaymentPages, p + 1))}
                  disabled={paymentsPage === totalPaymentPages}
                  className="text-xs border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-muted transition-colors"
                >→</button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide flex items-center gap-1.5">
          <Wallet className="w-3 h-3" /> История баланса ({balanceTxs?.length ?? 0})
        </div>
        {!balanceTxs || balanceTxs.length === 0 ? (
          <p className="text-xs text-muted-foreground">Транзакций нет.</p>
        ) : (
          <>
            {(showAllTxs ? balanceTxs : balanceTxs.slice(0, TXS_PAGE_SIZE)).map((tx) => (
              <BalanceTransactionRow key={tx.id} tx={tx} />
            ))}
            {balanceTxs.length > TXS_PAGE_SIZE && (
              <button
                onClick={() => setShowAllTxs((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
              >
                {showAllTxs ? "Скрыть" : `Показать все ${balanceTxs.length} транзакций`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Invite Links tab ─────────────────────────────────────────────────────────
function InviteLinkRow({
  link,
  basePath,
  isEditing,
  isViewingUsers,
  onToggleActive,
  onDelete,
  onCopyUrl,
  onEdit,
  onViewUsers,
}: {
  link: AdminInviteLink;
  basePath: string;
  isEditing: boolean;
  isViewingUsers: boolean;
  onToggleActive: () => void;
  onDelete: () => void;
  onCopyUrl: () => void;
  onEdit: () => void;
  onViewUsers: () => void;
}) {
  return (
    <tr className={`hover:bg-muted/30 transition-colors ${!link.isActive ? "opacity-50" : ""} ${isEditing ? "bg-orange-50/40" : ""}`}>
      <td className="px-4 py-2.5 max-w-[200px]">
        <div className="font-medium truncate">{link.note ?? <span className="text-muted-foreground italic">без заметки</span>}</div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="font-mono text-xs text-muted-foreground tracking-widest">{link.code}</span>
          <button
            onClick={onCopyUrl}
            title="Скопировать ссылку"
            className="p-0.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Copy className="w-3 h-3" />
          </button>
        </div>
      </td>
      <td className="px-4 py-2.5">
        <div className="text-xs">
          {link.planName ? (
            <span className="font-medium">{link.planName}</span>
          ) : (
            <span className="text-muted-foreground">по умолч.</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {link.trialDays != null ? `${link.trialDays} дн.` : "стандарт"}
        </div>
      </td>
      <td className="px-4 py-2.5 text-right font-mono">
        <span className={link.maxUses != null && link.usedCount >= link.maxUses ? "text-red-500 font-bold" : ""}>
          {link.usedCount}
        </span>
        {link.maxUses != null && (
          <span className="text-muted-foreground">/{link.maxUses}</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-center">
        <button
          onClick={onToggleActive}
          className={`w-6 h-6 flex items-center justify-center mx-auto border transition-colors ${
            link.isActive
              ? "border-green-500 text-green-600 hover:bg-red-50 hover:border-red-400 hover:text-red-500"
              : "border-border text-muted-foreground hover:border-green-400 hover:text-green-600"
          }`}
          title={link.isActive ? "Деактивировать" : "Активировать"}
        >
          {link.isActive ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
        </button>
      </td>
      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
        {link.expiresAt ? formatDate(link.expiresAt) : "—"}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-1">
          <button
            onClick={onViewUsers}
            className={`p-1 transition-colors ${isViewingUsers ? "text-blue-600" : "text-muted-foreground hover:text-foreground"}`}
            title="Посмотреть пользователей этой ссылки"
          >
            <Users className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onEdit}
            className={`p-1 transition-colors ${isEditing ? "text-orange-600" : "text-muted-foreground hover:text-foreground"}`}
            title="Редактировать ссылку"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1 text-muted-foreground hover:text-red-500 transition-colors"
            title="Удалить ссылку"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Expandable panel showing all users who registered via a specific invite link. */
function InviteLinkUsersPanel({ linkId, linkCode }: { linkId: number; linkCode: string }) {
  const { data: users, isLoading } = useGetAdminInviteLinkUsers(linkId);

  return (
    <tr className="bg-blue-50/40 border-b border-blue-100">
      <td colSpan={6} className="px-4 py-3">
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700">
            Пользователи по ссылке <span className="font-mono">{linkCode}</span>
          </p>
          {isLoading ? (
            <div className="text-xs text-muted-foreground">Загрузка...</div>
          ) : !users?.length ? (
            <div className="text-xs text-muted-foreground italic">
              Никто ещё не зарегистрировался по этой ссылке
            </div>
          ) : (
            <div className="border border-blue-100 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-blue-100 bg-blue-50/60">
                    <th className="text-left px-3 py-1.5 font-bold uppercase text-muted-foreground">Пользователь</th>
                    <th className="text-left px-3 py-1.5 font-bold uppercase text-muted-foreground">Email</th>
                    <th className="text-left px-3 py-1.5 font-bold uppercase text-muted-foreground">Дата регистрации</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-blue-50">
                  {(users as AdminInviteLinkUser[]).map((u) => (
                    <tr key={u.id} className="hover:bg-blue-50/40">
                      <td className="px-3 py-1.5 font-medium">{u.name ?? <span className="text-muted-foreground italic">без имени</span>}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{u.email}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">{formatDate(u.createdAt as unknown as string)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-blue-100 bg-blue-50/40">
                  <tr>
                    <td colSpan={3} className="px-3 py-1.5 text-muted-foreground">
                      Всего: <span className="font-bold">{users.length}</span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Convert a UTC ISO string to a YYYY-MM-DDTHH:mm string in the browser's local timezone,
 *  suitable for use as the value of a <input type="datetime-local"> element. */
function toLocalDatetimeInput(isoString: string | Date): string {
  const d = typeof isoString === "string" ? new Date(isoString) : isoString;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function InviteLinkEditRow({
  link,
  plans,
  onSave,
  onCancel,
  isSaving,
}: {
  link: AdminInviteLink;
  plans: Plan[];
  onSave: (data: { note?: string; planId?: number | null; trialDays?: number | null; maxUses?: number | null; expiresAt?: string | null }) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [note, setNote] = useState(link.note ?? "");
  const [planId, setPlanId] = useState(link.planId != null ? String(link.planId) : "");
  const [trialDays, setTrialDays] = useState(link.trialDays != null ? String(link.trialDays) : "");
  const [maxUses, setMaxUses] = useState(link.maxUses != null ? String(link.maxUses) : "");

  // Initialize in local time so the displayed value matches the user's clock,
  // and track the original value so we only send the field when it actually changed.
  const initialExpiresAt = link.expiresAt ? toLocalDatetimeInput(link.expiresAt as unknown as string) : "";
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [expiresAtTouched, setExpiresAtTouched] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Only include expiresAt in the payload when the user explicitly changed it,
    // to avoid accidentally overwriting or drifting an untouched expiry value.
    const expiresAtPayload: { expiresAt?: string | null } = expiresAtTouched
      ? { expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null }
      : {};
    onSave({
      note: note.trim() || undefined,
      planId: planId ? Number(planId) : null,
      trialDays: trialDays ? Number(trialDays) : null,
      maxUses: maxUses ? Number(maxUses) : null,
      ...expiresAtPayload,
    });
  }

  const monthlyPlans = plans.filter((p) => p.isActive && p.billingType === "monthly");

  return (
    <tr className="bg-orange-50/60 border-b border-orange-200">
      <td colSpan={6} className="px-4 py-3">
        <form onSubmit={handleSubmit} className="space-y-3">
          <p className="text-xs font-bold uppercase tracking-wider text-orange-700">
            Редактировать: <span className="font-mono">{link.code}</span>
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Заметка</label>
              <Input
                placeholder="Например: Telegram-канал @vpnexus или Иван из команды"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="rounded-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Тариф <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <select
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="w-full border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">По умолчанию (глобальная настройка)</option>
                {monthlyPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.priceRub} ₽/мес{p.isPromo ? " · Промо" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Пробный период, дней <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <Input
                type="number"
                min={0}
                max={365}
                placeholder="Стандарт (из настроек)"
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                className="rounded-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Лимит использований <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <Input
                type="number"
                min={1}
                placeholder="Без лимита"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                className="rounded-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Действует до <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => { setExpiresAt(e.target.value); setExpiresAtTouched(true); }}
                className="rounded-none"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-1.5 text-sm bg-orange-600 hover:bg-orange-700 text-white font-mono transition-colors disabled:opacity-50"
            >
              {isSaving ? "Сохранение..." : "Сохранить"}
            </button>
          </div>
        </form>
      </td>
    </tr>
  );
}

function InviteLinksManagement() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const { data: links, isLoading } = useListAdminInviteLinks();
  // Must use admin plans so promo plans appear in the edit-link dropdown too.
  const { data: plans } = useListAdminPlans();
  const { data: paymentSettings } = useGetPaymentSettings();
  const { toast } = useToast();
  const trialDisabled = paymentSettings !== undefined && !paymentSettings.trialEnabled;

  const { mutate: createLink, isPending: creating } = useCreateAdminInviteLink({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAdminInviteLinksQueryKey() });
        setShowForm(false);
        setNote(""); setPlanId(""); setTrialDays(""); setMaxUses(""); setExpiresAt("");
        toast({ title: "Ссылка создана" });
      },
      onError: () => toast({ title: "Ошибка создания", variant: "destructive" }),
    },
  });

  const [editingLinkId, setEditingLinkId] = useState<number | null>(null);
  const [viewingUsersLinkId, setViewingUsersLinkId] = useState<number | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const { mutate: updateLink } = useUpdateAdminInviteLink({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: getListAdminInviteLinksQueryKey() });
        // Only close edit form and show toast when it was an edit (not a toggle)
        if (editingLinkId === variables.linkId) {
          setEditingLinkId(null);
          toast({ title: "Ссылка обновлена" });
        }
        setIsSavingEdit(false);
      },
      onError: () => {
        toast({ title: "Ошибка обновления", variant: "destructive" });
        setIsSavingEdit(false);
      },
    },
  });

  const { mutate: deleteLink } = useDeleteAdminInviteLink({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAdminInviteLinksQueryKey() });
        toast({ title: "Ссылка удалена" });
      },
      onError: () => toast({ title: "Ошибка удаления", variant: "destructive" }),
    },
  });

  const [showForm, setShowForm] = useState(false);
  const [note, setNote] = useState("");
  const [planId, setPlanId] = useState("");
  const [trialDays, setTrialDays] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createLink({
      data: {
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(planId ? { planId: Number(planId) } : {}),
        ...(trialDays ? { trialDays: Number(trialDays) } : {}),
        ...(maxUses ? { maxUses: Number(maxUses) } : {}),
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      },
    });
  }

  // Use admin plans so promo plans are visible in the invite dropdown too.
  const { data: adminPlans } = useListAdminPlans();
  // All active monthly plans (regular + promo) — promo plans are hidden from
  // the public plan page but should be selectable when creating invite links.
  const monthlyPlans = (adminPlans ?? plans ?? []).filter((p) => p.isActive && p.billingType === "monthly");

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground max-w-xl">
          Создавайте именные инвайт-ссылки для конкретных кампаний или людей — с индивидуальным тарифом,
          длиной пробного периода и лимитом использований. Код 12 символов, уникальный для каждой ссылки.
        </p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 bg-orange-600 hover:bg-orange-700 text-white text-sm font-mono px-3 py-1.5 transition-colors shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> Создать
        </button>
      </div>

      {/* Warning: global trial disabled, but per-link overrides still work */}
      {trialDisabled && (
        <div className="flex items-start gap-2.5 border border-amber-300 bg-amber-50/60 px-3 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
          <span>
            Глобальный пробный период <strong>выключен</strong> в Настройках. Ссылки с явно заданным тарифом или
            длиной пробника всё равно выдадут пробник — остальные не выдадут.
            Чтобы пробник работал для всех ссылок без оверрайда, включите его в{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-amber-900 transition-colors"
              onClick={() => {
                const el = document.querySelector('[data-tab="settings"]') as HTMLButtonElement | null;
                el?.click();
              }}
            >
              Настройках
            </button>.
          </span>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <form
          onSubmit={handleCreate}
          className="border border-orange-200 bg-orange-50/40 p-4 space-y-3"
        >
          <p className="text-xs font-bold uppercase tracking-wider text-orange-700">Новая инвайт-ссылка</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Заметка (для кого / зачем)</label>
              <Input
                placeholder="Например: Telegram-канал @vpnexus или Иван из команды"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="rounded-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Тариф пробника <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <select
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="w-full border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">По умолчанию (глобальная настройка)</option>
                {monthlyPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.priceRub} ₽/мес{p.isPromo ? " · Промо" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Пробный период, дней <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <Input
                type="number"
                min={0}
                max={365}
                placeholder="Стандарт (из настроек)"
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value)}
                className="rounded-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Лимит использований <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <Input
                type="number"
                min={1}
                placeholder="Без лимита"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                className="rounded-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Действует до <span className="text-muted-foreground/60">(опционально)</span>
              </label>
              <Input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="rounded-none"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <button
              type="button"
              onClick={() => { setShowForm(false); setNote(""); setPlanId(""); setTrialDays(""); setMaxUses(""); setExpiresAt(""); }}
              className="px-3 py-1.5 text-sm border border-border text-muted-foreground hover:text-foreground transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={creating}
              className="px-4 py-1.5 text-sm bg-orange-600 hover:bg-orange-700 text-white font-mono transition-colors disabled:opacity-50"
            >
              {creating ? "Создание..." : "Создать ссылку"}
            </button>
          </div>
        </form>
      )}

      {/* Links table */}
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !links?.length ? (
        <div className="bg-muted/50 border border-border p-10 text-center text-sm text-muted-foreground">
          <Link2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
          Нет инвайт-ссылок — нажмите «Создать»
        </div>
      ) : (
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Заметка / Код</th>
                <th className="text-left px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Тариф / Пробник</th>
                <th className="text-right px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Исп.</th>
                <th className="text-center px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Акт.</th>
                <th className="text-left px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Истекает</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {links.map((link) => (
                <>
                  <InviteLinkRow
                    key={link.id}
                    link={link}
                    basePath={basePath}
                    isEditing={editingLinkId === link.id}
                    isViewingUsers={viewingUsersLinkId === link.id}
                    onToggleActive={() =>
                      updateLink({ linkId: link.id, data: { isActive: !link.isActive } })
                    }
                    onDelete={() => deleteLink({ linkId: link.id })}
                    onCopyUrl={() => {
                      const url = `${window.location.origin}${basePath}/sign-up?ref=${link.code}`;
                      navigator.clipboard.writeText(url).then(() =>
                        toast({ title: "Ссылка скопирована", description: link.note ?? link.code }),
                      );
                    }}
                    onEdit={() => setEditingLinkId(editingLinkId === link.id ? null : link.id)}
                    onViewUsers={() => setViewingUsersLinkId(viewingUsersLinkId === link.id ? null : link.id)}
                  />
                  {viewingUsersLinkId === link.id && (
                    <InviteLinkUsersPanel key={`users-${link.id}`} linkId={link.id} linkCode={link.code} />
                  )}
                  {editingLinkId === link.id && (
                    <InviteLinkEditRow
                      key={`edit-${link.id}`}
                      link={link}
                      plans={plans ?? []}
                      isSaving={isSavingEdit}
                      onCancel={() => setEditingLinkId(null)}
                      onSave={(data) => {
                        setIsSavingEdit(true);
                        updateLink({ linkId: link.id, data });
                      }}
                    />
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Referrals tab ────────────────────────────────────────────────────────────
function ReferralsManagement() {
  const { data, isLoading } = useListAdminReferrals();

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const rows = data ?? [];

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Пользователи, которые привлекли хотя бы одного участника по реф. ссылке.
        Доход — сумма подтверждённых платежей приглашённых пользователей; комиссия — начисления на баланс реферера.
      </div>
      {rows.length === 0 ? (
        <div className="bg-muted/50 border border-border p-10 text-center text-sm text-muted-foreground">
          <Share2 className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
          Реферальных записей нет
        </div>
      ) : (
        <div className="border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Реферер</th>
                <th className="text-right px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Приглашено</th>
                <th className="text-right px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Доход рефер.</th>
                <th className="text-right px-4 py-2 text-xs font-bold uppercase text-muted-foreground">Комиссия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.userId} className="hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{r.name ?? r.email}</div>
                    {r.name && <div className="text-xs text-muted-foreground font-mono">{r.email}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono font-bold">{r.referredCount}</td>
                  <td className="px-4 py-2.5 text-right font-mono">{r.totalRevenueRub} ₽</td>
                  <td className="px-4 py-2.5 text-right font-mono">
                    <span className={r.commissionsRub > 0 ? "text-green-600 font-bold" : "text-muted-foreground"}>
                      {r.commissionsRub} ₽
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-border bg-muted/20">
              <tr>
                <td className="px-4 py-2 text-xs text-muted-foreground">Итого рефереров: {rows.length}</td>
                <td className="px-4 py-2 text-right font-mono font-bold text-xs">
                  {rows.reduce((s, r) => s + r.referredCount, 0)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs">
                  {rows.reduce((s, r) => s + r.totalRevenueRub, 0)} ₽
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs text-green-600 font-bold">
                  {rows.reduce((s, r) => s + r.commissionsRub, 0)} ₽
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Users management ─────────────────────────────────────────────────────────
function UsersManagement() {
  const { data: users, isLoading } = useListAdminUsers();
  const { mutate: updateRole } = useUpdateUserRole();
  const { mutate: updateExtraSlots } = useUpdateUserExtraSlots();
  const { mutate: resetPassword, isPending: resettingPassword } = useAdminResetUserPassword();
  const { mutate: deleteUser, isPending: deleting } = useDeleteUser();
  const { mutate: forceLogout } = useAdminForceLogout();
  const { toast } = useToast();
  const [resetLinks, setResetLinks] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [subscriptionFilter, setSubscriptionFilter] = useState<"all" | "active" | "trial" | "none">("all");
  const [sort, setSort] = useState<"date_desc" | "date_asc" | "email" | "traffic" | "online">("date_desc");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function bulkForceLogout() {
    selectedIds.forEach((id) => forceLogout({ userId: id }));
    toast({ title: `Выход выполнен для ${selectedIds.size} пользователей` });
    setSelectedIds(new Set());
  }

  function bulkExportCsv() {
    const selected = (users ?? []).filter((u) => selectedIds.has(u.id));
    const header = "ID,Email,Имя,Роль,Баланс (₽),Тариф,Трафик (байт),Реф. код";
    const rows = selected.map((u) =>
      [u.id, u.email, u.name ?? "", u.role, (u.balanceKopecks / 100).toFixed(2), u.activePlanName ?? "", u.trafficUpBytes + u.trafficDownBytes, u.referralCode]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(","),
    );
    const csv = [header, ...rows].join("\n");
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" })),
      download: `users-selected-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  }

  function toggleRole(userId: number, currentRole: string) {
    const role = currentRole === "admin" ? "user" : "admin";
    updateRole(
      { userId, data: { role } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          toast({ title: "Роль обновлена" });
        },
        onError: () => toast({ title: "Ошибка обновления роли", variant: "destructive" }),
      },
    );
  }

  function changeExtraSlots(userId: number, current: number, delta: number) {
    const next = Math.max(0, current + delta);
    updateExtraSlots(
      { userId, data: { extraDeviceSlots: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          toast({ title: `Дополнительных устройств: ${next}` });
        },
        onError: () => toast({ title: "Ошибка изменения устройств", variant: "destructive" }),
      },
    );
  }

  function generateResetLink(userId: number) {
    resetPassword(
      { userId },
      {
        onSuccess: (data) => {
          setResetLinks((prev) => ({ ...prev, [userId]: `${window.location.origin}${data.resetUrl}` }));
          toast({ title: "Ссылка для сброса пароля создана" });
        },
        onError: () => toast({ title: "Ошибка создания ссылки", variant: "destructive" }),
      },
    );
  }

  function handleDelete(userId: number) {
    if (confirmDeleteId !== userId) {
      setConfirmDeleteId(userId);
      return;
    }
    deleteUser(
      { userId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
          toast({ title: "Пользователь удалён" });
          setConfirmDeleteId(null);
        },
        onError: (err: unknown) => {
          toast({
            title: err instanceof Error ? err.message : "Ошибка удаления пользователя",
            variant: "destructive",
          });
          setConfirmDeleteId(null);
        },
      },
    );
  }

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const filtered = (users ?? [])
    .filter(
      (u) => !search || u.email.toLowerCase().includes(search.toLowerCase()) || (u.name ?? "").toLowerCase().includes(search.toLowerCase()),
    )
    .filter((u) => roleFilter === "all" || u.role === roleFilter)
    .filter((u) => {
      if (subscriptionFilter === "active") return u.subscriptionStatus === "active" && !u.isOnTrial;
      if (subscriptionFilter === "trial") return u.isOnTrial === true;
      if (subscriptionFilter === "none") return u.subscriptionStatus !== "active" && !u.activePlanName;
      return true;
    })
    .sort((a, b) => {
      switch (sort) {
        case "date_asc":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "email":
          return a.email.localeCompare(b.email);
        case "traffic":
          return b.trafficUpBytes + b.trafficDownBytes - (a.trafficUpBytes + a.trafficDownBytes);
        case "online":
          return Number(b.isOnline) - Number(a.isOnline);
        case "date_desc":
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

  const totalPagesU = Math.max(1, Math.ceil(filtered.length / ADMIN_PAGE_SIZE));
  const effectivePageU = Math.min(page, totalPagesU);
  const pagedUsers = filtered.slice((effectivePageU - 1) * ADMIN_PAGE_SIZE, effectivePageU * ADMIN_PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Поиск по email или имени..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="rounded-none max-w-xs"
        />
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value as typeof roleFilter); setPage(1); }}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все роли</option>
          <option value="admin">Администраторы</option>
          <option value="user">Пользователи</option>
        </select>
        <select
          value={subscriptionFilter}
          onChange={(e) => { setSubscriptionFilter(e.target.value as typeof subscriptionFilter); setPage(1); }}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все подписки</option>
          <option value="active">С активной</option>
          <option value="trial">Пробный период</option>
          <option value="none">Без подписки</option>
        </select>
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as typeof sort); setPage(1); }}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="date_desc">Сначала новые</option>
          <option value="date_asc">Сначала старые</option>
          <option value="email">По email</option>
          <option value="traffic">По трафику</option>
          <option value="online">Сначала онлайн</option>
        </select>
        <button
          onClick={() => {
            const header = "ID,Дата регистрации,Email,Имя,Роль,Баланс (₽),Тариф,Трафик всего (байт),Реф. код,Приглашён";
            const rows = filtered.map((u) =>
              [
                u.id,
                u.createdAt,
                u.email,
                u.name ?? "",
                u.role,
                (u.balanceKopecks / 100).toFixed(2),
                u.activePlanName ?? "",
                u.trafficUpBytes + u.trafficDownBytes,
                u.referralCode,
                u.referredByEmail ?? "",
              ]
                .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
                .join(","),
            );
            const csv = [header, ...rows].join("\n");
            const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
            const a = Object.assign(document.createElement("a"), {
              href: URL.createObjectURL(blob),
              download: `users-${new Date().toISOString().slice(0, 10)}.csv`,
            });
            a.click(); URL.revokeObjectURL(a.href);
          }}
          className="border border-border px-3 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
        >
          Экспорт CSV
        </button>
      </div>
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 flex-wrap bg-primary/5 border border-primary/30 p-3">
          <span className="text-sm font-bold text-primary">{selectedIds.size} выбрано</span>
          <button onClick={bulkForceLogout} className="border border-border px-3 py-1.5 text-sm hover:border-destructive hover:text-destructive transition-colors">
            Выйти со всех устройств
          </button>
          <button onClick={bulkExportCsv} className="border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary transition-colors">
            Экспорт CSV
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="text-sm text-muted-foreground hover:text-foreground transition-colors ml-auto">
            Снять выделение
          </button>
        </div>
      )}
      {pagedUsers.map((user) => {
        const expanded = expandedId === user.id;
        const isSelected = selectedIds.has(user.id);
        return (
          <div key={user.id} className={`bg-card border p-4 space-y-3 transition-colors ${isSelected ? "border-primary/50 bg-primary/5" : "border-border"}`}>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0 break-words flex items-start gap-2">
                <button
                  onClick={() => toggleSelected(user.id)}
                  className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors"
                  title={isSelected ? "Снять выделение" : "Выбрать"}
                >
                  {isSelected ? <CheckSquare className="w-4 h-4 text-primary" /> : <Square className="w-4 h-4" />}
                </button>
                <div>
                <div className="font-bold break-all flex items-center gap-2 flex-wrap">
                  <span
                    className={`inline-block w-2 h-2 rounded-full shrink-0 ${
                      user.activityStatus === "site"
                        ? "bg-green-500"
                        : user.activityStatus === "vpn"
                          ? "bg-blue-500"
                          : "bg-gray-300"
                    }`}
                    title={
                      user.activityStatus === "site"
                        ? "На сайте"
                        : user.activityStatus === "vpn"
                          ? "Использует VPN"
                          : "Не в сети"
                    }
                  />
                  {user.name ? `${user.name} · ` : ""}
                  {user.email}
                  {user.isBanned && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold bg-red-100 text-red-700 border border-red-300 rounded cursor-default">
                      ЗАБЛ
                    </span>
                  )}
                  {user.isOnTrial && (
                    <span
                      title={user.trialEndsAt ? `Пробный период истекает ${new Date(user.trialEndsAt).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" })}` : "Пробный период"}
                      className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold bg-purple-100 text-purple-700 border border-purple-300 rounded cursor-default"
                    >
                      ПРОБНЫЙ
                    </span>
                  )}
                  {user.adminNote && (
                    <span
                      title={user.adminNote}
                      className="inline-flex items-center px-1 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700 border border-amber-300 rounded cursor-default"
                    >
                      📝
                    </span>
                  )}
                  {user.activityStatus === "site" && (
                    <span className="text-[10px] font-bold uppercase tracking-wide text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full">
                      На сайте
                    </span>
                  )}
                  {user.activityStatus === "vpn" && (
                    <span className="text-[10px] font-bold uppercase tracking-wide text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded-full">
                      Использует VPN
                    </span>
                  )}
                </div>
                <div className="text-sm text-muted-foreground font-mono">
                  {user.role === "admin" ? "Администратор" : "Пользователь"} · с {formatDate(user.createdAt)}
                  {user.activityStatus === "offline" && (() => {
                    // Show whichever signal is more recent — site or VPN.
                    const siteTs = user.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0;
                    const vpnTs  = user.vpnLastActiveAt ? new Date(user.vpnLastActiveAt).getTime() : 0;
                    if (siteTs === 0 && vpnTs === 0) return null;
                    if (vpnTs > siteTs) return ` · VPN: ${formatDate(user.vpnLastActiveAt!)}`;
                    return ` · был(а) на сайте ${formatDate(user.lastActiveAt!)}`;
                  })()}
                </div>
                </div>{/* close inner text wrapper */}
              </div>{/* close min-w-0 flex container */}
              <div className="flex gap-2 flex-wrap w-full sm:w-auto">
                <button
                  onClick={() => setExpandedId(expanded ? null : user.id)}
                  className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
                >
                  {expanded ? "Скрыть детали" : "Подробнее"}
                </button>
                <button
                  onClick={() => generateResetLink(user.id)}
                  disabled={resettingPassword}
                  className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors disabled:opacity-50"
                >
                  Сбросить пароль
                </button>
                <button
                  onClick={() => toggleRole(user.id, user.role)}
                  className="border border-border px-4 py-2 text-sm font-medium hover:border-primary hover:text-primary transition-colors"
                >
                  {user.role === "admin" ? "Понизить" : "Назначить админом"}
                </button>
                <ForceLogoutButton userId={user.id} />
                <BanButton userId={user.id} isBanned={user.isBanned} />
                <button
                  onClick={() => handleDelete(user.id)}
                  disabled={deleting}
                  className={`border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                    confirmDeleteId === user.id
                      ? "border-destructive bg-destructive text-destructive-foreground"
                      : "border-border text-destructive hover:border-destructive"
                  }`}
                >
                  {confirmDeleteId === user.id ? "Точно удалить?" : "Удалить"}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-4 flex-wrap pt-1 text-xs font-mono">
              <span className={user.trafficLimitExceeded ? "text-destructive font-bold" : "text-muted-foreground"}>
                За период: {formatBytes(user.periodUpBytes + user.periodDownBytes)}
                {user.trafficLimitGb != null && ` / ${user.trafficLimitGb} ГБ`}
                {user.extraTrafficGb > 0 && ` (+${user.extraTrafficGb} ГБ докуплено)`}
                {user.trafficLimitExceeded && " · лимит превышен"}
              </span>
              {user.periodStartedAt && (
                <span className="text-muted-foreground">
                  Период с:{" "}
                  <span className="text-foreground">
                    {new Date(user.periodStartedAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </span>
              )}
              <span className="text-muted-foreground">
                Всего: {formatBytes(user.trafficUpBytes + user.trafficDownBytes)}
              </span>
              {user.activePlanName && (
                <span className="text-muted-foreground">
                  Тариф: <span className="text-foreground font-bold">{user.activePlanName}</span>
                </span>
              )}
              <span className="text-muted-foreground">
                Баланс: <span className="text-foreground font-bold">{(user.balanceKopecks / 100).toFixed(2)} ₽</span>
              </span>
              <span className="text-muted-foreground">
                Реф. код: <span className="text-foreground font-bold">{user.referralCode}</span>
                {user.referredUserCount > 0 && ` · пригласил(а) ${user.referredUserCount}`}
              </span>
              {user.referredByEmail && (
                <span className="text-muted-foreground">
                  Приглашён(а): <span className="text-foreground">{user.referredByEmail}</span>
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 pt-1">
              <span className="text-xs text-muted-foreground font-mono">Доп. устройства:</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => changeExtraSlots(user.id, user.extraDeviceSlots, -1)}
                  disabled={user.extraDeviceSlots === 0}
                  className="w-7 h-7 flex items-center justify-center border border-border text-sm font-bold hover:border-primary hover:text-primary transition-colors disabled:opacity-30"
                >
                  −
                </button>
                <span className="w-8 text-center text-sm font-mono font-bold">{user.extraDeviceSlots}</span>
                <button
                  onClick={() => changeExtraSlots(user.id, user.extraDeviceSlots, +1)}
                  className="w-7 h-7 flex items-center justify-center border border-border text-sm font-bold hover:border-primary hover:text-primary transition-colors"
                >
                  +
                </button>
              </div>
            </div>
            {resetLinks[user.id] && (
              <div className="bg-muted/30 border border-border p-3 space-y-1">
                <p className="text-xs text-muted-foreground">
                  Одноразовая ссылка для сброса пароля (действует 30 минут). Передайте её пользователю через
                  доверенный канал (например, поддержку):
                </p>
                <p className="text-sm font-mono break-all text-primary">{resetLinks[user.id]}</p>
              </div>
            )}
            {expanded && (
              <div className="border-t border-border pt-3 space-y-4">
                <div className="space-y-1.5">
                  <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">Профиль</div>
                  <UserProfileEditor user={user} />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">Баланс</div>
                  <UserBalanceEditor user={user} />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">Пароль</div>
                  <UserSetPasswordEditor user={user} />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">Заметка администратора</div>
                  <AdminNoteEditor userId={user.id} initialNote={user.adminNote ?? null} />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">Подписка</div>
                  <UserSubscriptionEditor user={user} />
                </div>
                <UserKeysAndPayments userId={user.id} />
              </div>
            )}
          </div>
        );
      })}
      <PaginationBar page={effectivePageU} total={filtered.length} onPage={setPage} />
      {filtered.length === 0 && <p className="text-muted-foreground text-sm">Пользователи не найдены.</p>}
    </div>
  );
}

function PaymentSettingsForm() {
  // Refetch every 60 s so the domain-health alert auto-clears once the domain
  // is healthy again — same cadence as the server-side healthz cache TTL.
  const { data: settings, isLoading } = useGetPaymentSettings({
    query: { queryKey: getGetPaymentSettingsQueryKey(), refetchInterval: 60_000 },
  });
  const { data: plans } = useListPlans();
  const { mutate: update, isPending } = useUpdatePaymentSettings();
  const { toast } = useToast();
  // Only monthly plans are valid for trial (hourly plans start at 0₽ and
  // immediately cut off access when the user's balance=0 hits the first tick).
  const monthlyPlans = (plans ?? []).filter((p) => p.billingType === "monthly" && p.isActive);
  const [sbpPhone, setSbpPhone] = useState("");
  const [sbpBank, setSbpBank] = useState("");
  const [sbpRecipientName, setSbpRecipientName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [extraDeviceSlotPriceRub, setExtraDeviceSlotPriceRub] = useState("");
  const [allowFreeExtraDeviceSlot, setAllowFreeExtraDeviceSlot] = useState(false);
  const [extraTrafficPriceRub, setExtraTrafficPriceRub] = useState("");
  const [extraTrafficPackageGb, setExtraTrafficPackageGb] = useState("10");
  const [allowFreeExtraTraffic, setAllowFreeExtraTraffic] = useState(false);
  const [trialEnabled, setTrialEnabled] = useState(false);
  const [trialDays, setTrialDays] = useState("5");
  const [trialPlanId, setTrialPlanId] = useState<number | null>(null);
  const [minHourlyTopupRub, setMinHourlyTopupRub] = useState("0");
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [referralCommissionPercent, setReferralCommissionPercent] = useState("0");
  const [sbpPaymentUrl, setSbpPaymentUrl] = useState("");
  const [showManualSbpDetails, setShowManualSbpDetails] = useState(false);
  const [yookassaEnabled, setYookassaEnabled] = useState(true);
  const [sbpEnabled, setSbpEnabled] = useState(true);
  const [balancePaymentsEnabled, setBalancePaymentsEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);

  if (settings && !initialized) {
    setSbpPhone(settings.sbpPhone);
    setSbpBank(settings.sbpBank);
    setSbpRecipientName(settings.sbpRecipientName);
    setInstructions(settings.instructions ?? "");
    setExtraDeviceSlotPriceRub(String(settings.extraDeviceSlotPriceRub ?? 0));
    setAllowFreeExtraDeviceSlot(settings.allowFreeExtraDeviceSlot ?? false);
    setExtraTrafficPriceRub(String(settings.extraTrafficPriceRub ?? 0));
    setExtraTrafficPackageGb(String(settings.extraTrafficPackageGb ?? 10));
    setAllowFreeExtraTraffic(settings.allowFreeExtraTraffic ?? false);
    setTrialEnabled(settings.trialEnabled ?? false);
    setTrialDays(String(settings.trialDays ?? 5));
    setTrialPlanId(settings.trialPlanId ?? null);
    setMinHourlyTopupRub(String(settings.minHourlyTopupRub ?? 0));
    setPrimaryDomain(settings.primaryDomain ?? "");
    setReferralCommissionPercent(String(settings.referralCommissionPercent ?? 0));
    setSbpPaymentUrl(settings.sbpPaymentUrl ?? "");
    setShowManualSbpDetails(settings.showManualSbpDetails ?? false);
    setYookassaEnabled(settings.yookassaEnabled ?? true);
    setSbpEnabled(settings.sbpEnabled ?? true);
    setBalancePaymentsEnabled(settings.balancePaymentsEnabled ?? false);
    setInitialized(true);
  }

  function handleSubmit() {
    update(
      {
        data: {
          sbpPhone,
          sbpBank,
          sbpRecipientName,
          instructions,
          extraDeviceSlotPriceRub: Number(extraDeviceSlotPriceRub) || 0,
          allowFreeExtraDeviceSlot,
          extraTrafficPriceRub: Number(extraTrafficPriceRub) || 0,
          extraTrafficPackageGb: Number(extraTrafficPackageGb) || 10,
          allowFreeExtraTraffic,
          trialEnabled,
          trialDays: Number(trialDays) || 5,
          trialPlanId: trialPlanId ?? null,
          minHourlyTopupRub: Number(minHourlyTopupRub) || 0,
          primaryDomain: primaryDomain.trim(),
          referralCommissionPercent: Number(referralCommissionPercent) || 0,
          sbpPaymentUrl: sbpPaymentUrl.trim(),
          showManualSbpDetails,
          yookassaEnabled,
          sbpEnabled,
          balancePaymentsEnabled,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          toast({ title: "Реквизиты обновлены" });
        },
        onError: () => toast({ title: "Ошибка сохранения реквизитов", variant: "destructive" }),
      },
    );
  }

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="bg-card border border-border p-5 space-y-3 max-w-xl">
      {/* Domain health alert: shown when the primary domain fails the healthz check */}
      {settings?.primaryDomainHealthy === false && (
        <div className="flex items-start gap-3 bg-red-50 dark:bg-red-950/30 border border-red-400 dark:border-red-700 p-4">
          <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-red-700 dark:text-red-300">
              Основной домен недоступен
            </p>
            <p className="text-xs text-red-600 dark:text-red-400">
              Домен <strong>{settings.primaryDomain || "vpnexus.pro"}</strong> не отвечает на
              проверку работоспособности. Если он заблокирован — смените поле «Основной домен»
              ниже на новый адрес и сохраните. Сервер немедленно начнёт выдавать новый URL
              подписки, а клиенты с поддержкой автообновления подпишутся на него автоматически
              при следующем рефреше (каждые 3 часа).
            </p>
          </div>
        </div>
      )}

      {/* Payment method visibility toggles */}
      <div className="border border-border p-4 space-y-3">
        <p className="text-sm font-semibold">Способы оплаты</p>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Карта / SberPay (ЮMoney)</p>
            <p className="text-xs text-muted-foreground mt-0.5">Показывать тайл «Карта / SberPay» на страницах оплаты</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={yookassaEnabled}
              onChange={(e) => setYookassaEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">СБП</p>
            <p className="text-xs text-muted-foreground mt-0.5">Показывать тайл «СБП» на страницах оплаты</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={sbpEnabled}
              onChange={(e) => setSbpEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Оплата с баланса</p>
            <p className="text-xs text-muted-foreground mt-0.5">Разрешить мгновенную оплату с кошелька (без модерации)</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={balancePaymentsEnabled}
              onChange={(e) => setBalancePaymentsEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      {/* SBP online payment settings */}
      <div className="border border-border p-4 space-y-3">
        <p className="text-sm font-semibold">СБП — ссылка и QR</p>
        <div>
          <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Ссылка для кнопки «Перейти к оплате по СБП»</label>
          <Input
            placeholder="https://finance.ozon.ru/apps/sbp/... (пусто = Озон Банк по умолчанию)"
            value={sbpPaymentUrl}
            onChange={(e) => setSbpPaymentUrl(e.target.value)}
            className="rounded-none"
          />
          <p className="text-xs text-muted-foreground mt-1">Оставьте пустым чтобы использовать встроенную ссылку Озон Банк.</p>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Показывать реквизиты (телефон/банк/получатель)</p>
            <p className="text-xs text-muted-foreground mt-0.5">Отображать старую форму с реквизитами на страницах оплаты СБП</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={showManualSbpDetails}
              onChange={(e) => setShowManualSbpDetails(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      {/* Manual SBP requisites (shown only when showManualSbpDetails is on) */}
      <Input placeholder="Телефон СБП" value={sbpPhone} onChange={(e) => setSbpPhone(e.target.value)} className="rounded-none" />
      <Input placeholder="Банк" value={sbpBank} onChange={(e) => setSbpBank(e.target.value)} className="rounded-none" />
      <Input
        placeholder="Имя получателя"
        value={sbpRecipientName}
        onChange={(e) => setSbpRecipientName(e.target.value)}
        className="rounded-none"
      />
      <Textarea
        placeholder="Инструкции для пользователя"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        className="rounded-none"
      />
      <div>
        <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Цена доп. устройства (₽)</label>
        <Input
          type="number"
          min="0"
          placeholder="0"
          value={extraDeviceSlotPriceRub}
          onChange={(e) => setExtraDeviceSlotPriceRub(e.target.value)}
          className="rounded-none"
        />
      </div>

      <div className="border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Бесплатные доп. устройства</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Если цена не задана (0 ₽), выдавать слот без оплаты вместо блокировки кнопки
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={allowFreeExtraDeviceSlot}
              onChange={(e) => setAllowFreeExtraDeviceSlot(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      <div className="border border-border p-4 space-y-3">
        <p className="text-sm font-semibold">Доп. трафик</p>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Размер пакета (ГБ)</label>
            <Input
              type="number"
              min="1"
              placeholder="10"
              value={extraTrafficPackageGb}
              onChange={(e) => setExtraTrafficPackageGb(e.target.value.replace(/[^0-9]/g, ""))}
              className="rounded-none"
            />
          </div>
          <div className="flex-1">
            <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Цена пакета (₽)</label>
            <Input
              type="number"
              min="0"
              placeholder="0"
              value={extraTrafficPriceRub}
              onChange={(e) => setExtraTrafficPriceRub(e.target.value)}
              className="rounded-none"
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Если цена не задана (0 ₽), выдавать пакет без оплаты вместо блокировки кнопки
          </p>
          <label className="relative inline-flex items-center cursor-pointer shrink-0 ml-3">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={allowFreeExtraTraffic}
              onChange={(e) => setAllowFreeExtraTraffic(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
      </div>

      <div className="border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Пробный период</p>
            <p className="text-xs text-muted-foreground mt-0.5">Новые пользователи получают бесплатную подписку при регистрации</p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={trialEnabled}
              onChange={(e) => setTrialEnabled(e.target.checked)}
            />
            <div className="w-10 h-6 bg-muted peer-checked:bg-primary rounded-full transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:w-5 after:h-5 after:rounded-full after:transition-all peer-checked:after:translate-x-4" />
          </label>
        </div>
        {trialEnabled && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Длительность пробного периода (дней)</label>
              <Input
                type="number"
                min="1"
                max="365"
                placeholder="5"
                value={trialDays}
                onChange={(e) => setTrialDays(e.target.value.replace(/[^0-9]/g, ""))}
                className="rounded-none max-w-[140px]"
              />
            </div>
            <div>
              <label className="text-xs font-mono text-muted-foreground uppercase block mb-1">Тариф для пробного периода</label>
              <select
                value={trialPlanId ?? ""}
                onChange={(e) => setTrialPlanId(e.target.value ? Number(e.target.value) : null)}
                className="border border-border bg-background px-3 py-2 text-sm rounded-none w-full max-w-xs"
              >
                <option value="">Авто — наиболее дешёвый месячный тариф</option>
                {monthlyPlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.trafficLimitGb ? ` — ${p.trafficLimitGb} ГБ` : " — без лимита"}
                    {`, ${p.devicesIncluded} уст.`}
                  </option>
                ))}
              </select>
              {monthlyPlans.length === 0 && (
                <p className="text-xs text-muted-foreground mt-1">Нет активных месячных тарифов. Создайте тариф заранее.</p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="border border-border p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Минимальное пополнение для почасового тарифа</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Пользователь не сможет подключить почасовой тариф, пока баланс не достигнет этой суммы. 0 — без ограничения.
          </p>
        </div>
        <Input
          type="number"
          min="0"
          placeholder="0"
          value={minHourlyTopupRub}
          onChange={(e) => setMinHourlyTopupRub(e.target.value.replace(/[^0-9]/g, ""))}
          className="rounded-none max-w-[140px]"
        />
      </div>

      <div className="border border-border p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Основной домен</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Показывается пользователям в ссылке подписки и ключах, пока доступен (проверяется автоматически). Если домен
            заблокируют — измените здесь, сервер сразу переключится на резервный технический адрес, пока не примените новый.
          </p>
        </div>
        <Input
          placeholder="vpnexus.pro"
          value={primaryDomain}
          onChange={(e) => setPrimaryDomain(e.target.value)}
          className="rounded-none max-w-[280px]"
        />
      </div>

      <div className="border border-border p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold">Реферальная программа</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Процент от суммы каждой реально оплаченной подписки, который начисляется на баланс пригласившего
            пользователя. 0 — вознаграждение не начисляется.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0"
            max="100"
            placeholder="0"
            value={referralCommissionPercent}
            onChange={(e) => setReferralCommissionPercent(e.target.value.replace(/[^0-9]/g, ""))}
            className="rounded-none max-w-[140px]"
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={isPending}
        className="bg-primary text-primary-foreground font-bold px-5 py-2.5 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        Сохранить реквизиты
      </button>

      {/* QR code section — separate mutation, not part of the main form */}
      <SbpQrSection />

      {/* iOS Happ routing profile — separate mutation */}
      <HappIosRoutingSection />

      {/* App download links — separate mutation */}
      <AppDownloadLinksSection />
    </div>
  );
}

function SbpQrSection() {
  const { data: settings } = useGetPaymentSettings();
  const { mutate: uploadQr, isPending: uploading } = useUploadSbpQr();
  const { mutate: deleteQr, isPending: deleting } = useDeleteSbpQr();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const MAX_BYTES = 8 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      toast({ title: "Файл слишком большой (макс. 8 МБ)", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1] ?? "";
      uploadQr(
        { data: { data: base64, mimeType: file.type } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
            toast({ title: "QR-код загружен" });
          },
          onError: () => toast({ title: "Ошибка загрузки QR", variant: "destructive" }),
        },
      );
    };
    reader.readAsDataURL(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="border border-border p-4 space-y-3 mt-2">
      <p className="text-sm font-semibold">QR-код для СБП</p>
      {settings?.hasSbpQr ? (
        <div className="space-y-2">
          <img
            src="/api/payment-settings/sbp-qr-image"
            alt="QR СБП"
            className="w-40 h-40 object-contain border border-border bg-white p-1"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
              className="border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-50"
            >
              {uploading ? "Загружаем..." : "Заменить QR"}
            </button>
            <button
              type="button"
              disabled={deleting}
              onClick={() =>
                deleteQr(undefined as never, {
                  onSuccess: () => {
                    queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
                    toast({ title: "QR-код удалён" });
                  },
                  onError: () => toast({ title: "Ошибка удаления QR", variant: "destructive" }),
                })
              }
              className="border border-destructive/50 text-destructive px-3 py-1.5 text-sm hover:bg-destructive/10 transition-colors disabled:opacity-50"
            >
              {deleting ? "Удаляем..." : "Удалить QR"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">QR-код не загружен. После загрузки кнопка «Показать QR» появится на странице оплаты СБП.</p>
          <button
            type="button"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-50"
          >
            <ImageIcon className="w-4 h-4" />
            {uploading ? "Загружаем..." : "Загрузить QR-код"}
          </button>
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />
    </div>
  );
}

// ── iOS Happ routing profile editor ──────────────────────────────────────────
// Standalone section: admin edits the direct-bypass domain / CIDR list and the
// profile name. Changes are saved via PATCH /admin/payment-settings and do NOT
// require the main form to be submitted — separate "Save" button below.

/** Strip "domain:" prefix for display; keep other prefixes (regexp:, etc.) intact. */
function formatSitesForDisplay(sites: string[]): string {
  return sites
    .map((s) => (s.startsWith("domain:") ? s.slice(7) : s))
    .join("\n");
}

/** Restore full Xray matcher format from a textarea value.
 *  Lines that already contain ":" are kept as-is (regexp:, full:, etc.).
 *  Plain domain names get the "domain:" prefix added back. */
function parseSitesFromDisplay(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.includes(":") ? l : `domain:${l}`));
}

function HappIosRoutingSection() {
  const { data: settings } = useGetPaymentSettings();
  const { mutate: update, isPending } = useUpdatePaymentSettings();
  const { toast } = useToast();

  const [profileName, setProfileName] = useState("");
  const [directSitesText, setDirectSitesText] = useState("");
  const [directIpText, setDirectIpText] = useState("");
  const [initialized, setInitialized] = useState(false);

  // Seed form from API (effective profile — always non-null from server).
  if (settings && !initialized) {
    const p = settings.happIosRoutingProfile;
    setProfileName(p.name);
    setDirectSitesText(formatSitesForDisplay(p.directsites));
    setDirectIpText(p.directip.join("\n"));
    setInitialized(true);
  }

  function handleSave() {
    const profile = {
      name: profileName.trim() || "VPNexus",
      directsites: parseSitesFromDisplay(directSitesText),
      directip: directIpText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    };
    update(
      { data: { happIosRoutingProfile: profile } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          toast({ title: "Профиль iOS маршрутизации сохранён" });
        },
        onError: () => toast({ title: "Ошибка сохранения профиля", variant: "destructive" }),
      },
    );
  }

  function handleReset() {
    update(
      { data: { happIosRoutingProfile: null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          setInitialized(false); // re-seed form from refreshed defaults
          toast({ title: "Профиль сброшен до встроенных значений" });
        },
        onError: () => toast({ title: "Ошибка сброса профиля", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="border border-border p-4 space-y-4 mt-2">
      <div>
        <p className="text-sm font-semibold">iOS Happ — профиль маршрутизации</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Управляйте списком сайтов и IP-адресов, которые будут проходить напрямую (обходить тоннель)
          у iOS-пользователей. Изменения применяются мгновенно — пользователи переимпортируют
          профиль нажатием кнопки на странице ключей.
        </p>
      </div>

      {/* Current deep link preview */}
      {settings?.happIosRoutingUrl && (
        <div className="space-y-1">
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-wide">Текущая ссылка профиля</p>
          <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
            <span className="truncate flex-1">{settings.happIosRoutingUrl}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Пользователи открывают эту ссылку на iPhone — Happ применяет профиль автоматически.
          </p>
        </div>
      )}

      {/* Profile name */}
      <div className="space-y-1">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
          Название профиля
        </label>
        <Input
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          placeholder="VPNexus"
          className="rounded-none max-w-[240px]"
        />
        <p className="text-xs text-muted-foreground">Отображается в Happ при импорте.</p>
      </div>

      {/* Direct sites textarea */}
      <div className="space-y-1">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
          Сайты напрямую (по одному на строку)
        </label>
        <Textarea
          value={directSitesText}
          onChange={(e) => setDirectSitesText(e.target.value)}
          placeholder={"avito.ru\nsberbankl.ru\nregexp:\\.ru$"}
          rows={10}
          className="rounded-none font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Просто доменное имя (без префикса) → будет добавлен <code>domain:</code>.
          Строки с двоеточием (например <code>regexp:\\.ru$</code>) принимаются как есть.
        </p>
      </div>

      {/* Direct IPs textarea */}
      <div className="space-y-1">
        <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
          IP-диапазоны напрямую (CIDR, по одному на строку)
        </label>
        <Textarea
          value={directIpText}
          onChange={(e) => setDirectIpText(e.target.value)}
          placeholder={"10.0.0.0/8\n192.168.0.0/16"}
          rows={4}
          className="rounded-none font-mono text-xs"
        />
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleSave}
          disabled={isPending}
          className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isPending ? "Сохраняем..." : "Сохранить профиль"}
        </button>
        <button
          onClick={handleReset}
          disabled={isPending}
          className="border border-border px-4 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
        >
          Сбросить до умолчаний
        </button>
      </div>
    </div>
  );
}

// ── App download links editor ─────────────────────────────────────────────────
// Admin configures the 4 recommended client app links shown in the keys page
// "Quick start" banners and iOS routing instructions. Saved via
// PATCH /admin/payment-settings. Separate Save/Reset from the main form.

const APP_LINK_LABELS: Record<string, string> = {
  happAndroid: "Happ — Android",
  happIos: "Happ — iOS (App Store)",
  v2rayng: "v2rayNG — Android",
  v2rayn: "v2rayN — Windows",
};

function AppDownloadLinksSection() {
  const { data: settings } = useGetPaymentSettings();
  const { mutate: update, isPending } = useUpdatePaymentSettings();
  const { toast } = useToast();

  const [links, setLinks] = useState({
    happAndroid: "",
    happIos: "",
    v2rayng: "",
    v2rayn: "",
  });
  const [initialized, setInitialized] = useState(false);

  if (settings && !initialized) {
    const l = settings.appDownloadLinks;
    setLinks({ happAndroid: l.happAndroid, happIos: l.happIos, v2rayng: l.v2rayng, v2rayn: l.v2rayn });
    setInitialized(true);
  }

  function handleSave() {
    update(
      { data: { appDownloadLinks: { happAndroid: links.happAndroid.trim(), happIos: links.happIos.trim(), v2rayng: links.v2rayng.trim(), v2rayn: links.v2rayn.trim() } } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          toast({ title: "Ссылки на приложения сохранены" });
        },
        onError: () => toast({ title: "Ошибка сохранения ссылок", variant: "destructive" }),
      },
    );
  }

  function handleReset() {
    update(
      { data: { appDownloadLinks: null } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsQueryKey() });
          setInitialized(false);
          toast({ title: "Ссылки сброшены до встроенных значений" });
        },
        onError: () => toast({ title: "Ошибка сброса", variant: "destructive" }),
      },
    );
  }

  return (
    <div className="border border-border p-4 space-y-4 mt-2">
      <div>
        <p className="text-sm font-semibold">Ссылки на приложения</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Настройте ссылки на скачивание VPN-клиентов, которые показываются пользователям
          на странице ключей (баннер «Быстрый старт» и инструкции). Изменения применяются мгновенно.
        </p>
      </div>

      {(["happAndroid", "happIos", "v2rayng", "v2rayn"] as const).map((key) => (
        <div key={key} className="space-y-1">
          <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
            {APP_LINK_LABELS[key]}
          </label>
          <div className="flex items-center gap-2">
            <Input
              value={links[key]}
              onChange={(e) => setLinks((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder="https://..."
              className="rounded-none font-mono text-xs"
            />
            {links[key] && (
              <a
                href={links[key]}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-xs text-muted-foreground hover:text-primary underline underline-offset-2 whitespace-nowrap"
              >
                Открыть
              </a>
            )}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleSave}
          disabled={isPending}
          className="bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isPending ? "Сохраняем..." : "Сохранить ссылки"}
        </button>
        <button
          onClick={handleReset}
          disabled={isPending}
          className="border border-border px-4 py-2 text-sm hover:bg-muted transition-colors disabled:opacity-50"
        >
          Сбросить до умолчаний
        </button>
      </div>
    </div>
  );
}

interface AdminVpnKey {
  id: number;
  userId: number;
  nodeId: number;
  label: string;
  vlessLink: string;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  nodeName: string;
  userEmail: string;
  trafficUpBytes: number;
  trafficDownBytes: number;
  periodUpBytes: number;
  periodDownBytes: number;
}

function VpnKeysManagement() {
  const { toast } = useToast();
  const [issuingUserId, setIssuingUserId] = useState<number | null>(null);
  const [issuingUserEmail, setIssuingUserEmail] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [showUserList, setShowUserList] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "revoked">("all");
  const [sort, setSort] = useState<"date_desc" | "date_asc" | "email" | "traffic">("date_desc");
  const [page, setPage] = useState(1);
  const [issuingNodeId, setIssuingNodeId] = useState<number | "auto">("auto");
  // Guards against a genuine double-click firing two overlapping issue
  // requests before React commits `issueMutation.isPending` and disables the
  // button — a slow issue request (Xray provisioning) made this window wide
  // enough in practice to create two keys from what looked like one click.
  const issueInFlightRef = useRef(false);

  const { data: keys, isLoading, refetch } = useQuery<AdminVpnKey[]>({
    queryKey: ["admin", "vpn-keys"],
    queryFn: async () => {
      const res = await fetch("/api/admin/vpn-keys", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: users } = useQuery({
    queryKey: getListAdminUsersQueryKey(),
    queryFn: async () => {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json() as Promise<Array<{ id: number; email: string; trafficLimitExceeded?: boolean }>>;
    },
  });

  const { data: activeNodes } = useQuery({
    queryKey: ["vpn-nodes-active"],
    queryFn: async () => {
      const res = await fetch("/api/vpn-nodes", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<Array<{ id: number; name: string }>>;
    },
  });

  const issueMutation = useMutation({
    mutationFn: async (userId: number) => {
      const body: Record<string, unknown> = { userId };
      if (issuingNodeId !== "auto") body.nodeId = issuingNodeId;
      const res = await fetch("/api/admin/vpn-keys/issue", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      toast({ title: "Ключ выдан" });
      setIssuingUserId(null);
      setIssuingUserEmail("");
      setUserSearch("");
      refetch();
    },
    onError: () => toast({ title: "Ошибка выдачи ключа", variant: "destructive" }),
    onSettled: () => {
      issueInFlightRef.current = false;
    },
  });

  function handleIssueClick() {
    // `issueMutation.isPending` only reflects reality once React commits the
    // next render, which isn't fast enough to beat a real double-click on a
    // slow request (Xray provisioning). This ref blocks the second call
    // synchronously, before React ever sees it.
    if (!issuingUserId || issueInFlightRef.current) return;
    issueInFlightRef.current = true;
    issueMutation.mutate(issuingUserId);
  }

  const revokeMutation = useMutation({
    mutationFn: async (keyId: number) => {
      const res = await fetch(`/api/admin/vpn-keys/${keyId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      toast({ title: "Ключ отозван" });
      refetch();
    },
    onError: () => toast({ title: "Ошибка отзыва ключа", variant: "destructive" }),
  });

  function copyLink(keyId: number, link: string) {
    navigator.clipboard.writeText(link);
    setCopiedId(keyId);
    toast({ title: "Ссылка скопирована" });
    setTimeout(() => setCopiedId(null), 2000);
  }

  const filtered = (keys ?? [])
    .filter(
      (k) =>
        !filter ||
        k.userEmail.toLowerCase().includes(filter.toLowerCase()) ||
        k.label.toLowerCase().includes(filter.toLowerCase()),
    )
    .filter((k) => (statusFilter === "all" ? true : statusFilter === "active" ? !k.revokedAt : !!k.revokedAt))
    .sort((a, b) => {
      switch (sort) {
        case "date_asc":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "email":
          return a.userEmail.localeCompare(b.userEmail);
        case "traffic":
          return b.trafficUpBytes + b.trafficDownBytes - (a.trafficUpBytes + a.trafficDownBytes);
        case "date_desc":
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

  const activeCount = (keys ?? []).filter((k) => !k.revokedAt).length;

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  const totalPagesK = Math.max(1, Math.ceil(filtered.length / ADMIN_PAGE_SIZE));
  const effectivePageK = Math.min(page, totalPagesK);
  const pagedKeys = filtered.slice((effectivePageK - 1) * ADMIN_PAGE_SIZE, effectivePageK * ADMIN_PAGE_SIZE);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Поиск по email или ключу..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-none max-w-xs"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все статусы</option>
          <option value="active">Активные</option>
          <option value="revoked">Отозванные</option>
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="date_desc">Сначала новые</option>
          <option value="date_asc">Сначала старые</option>
          <option value="email">По email</option>
          <option value="traffic">По трафику</option>
        </select>
        <span className="text-sm text-muted-foreground font-mono">
          Активных: {activeCount} / Всего: {keys?.length ?? 0}
        </span>
      </div>

      <div className="border border-border p-4">
        <div className="text-sm font-bold mb-3">Выдать ключ пользователю вручную</div>
        <div className="flex items-start gap-2 flex-wrap">
          {/* Searchable user picker */}
          <div className="relative">
            <Input
              placeholder="Поиск пользователя по email..."
              value={issuingUserId ? issuingUserEmail : userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setIssuingUserId(null);
                setIssuingUserEmail("");
                setShowUserList(true);
              }}
              onFocus={() => setShowUserList(true)}
              onBlur={() => setTimeout(() => setShowUserList(false), 150)}
              className="rounded-none w-72 text-sm"
            />
            {issuingUserId && (
              <button
                onClick={() => { setIssuingUserId(null); setIssuingUserEmail(""); setUserSearch(""); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            {showUserList && !issuingUserId && (
              <div className="absolute z-50 top-full left-0 w-full mt-1 bg-background border border-border shadow-md max-h-52 overflow-y-auto">
                {(users ?? [])
                  .filter((u) => !userSearch || u.email.toLowerCase().includes(userSearch.toLowerCase()))
                  .slice(0, 50)
                  .map((u) => (
                    <button
                      key={u.id}
                      onMouseDown={() => {
                        setIssuingUserId(u.id);
                        setIssuingUserEmail(u.email);
                        setUserSearch("");
                        setShowUserList(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/60 transition-colors font-mono truncate"
                    >
                      {u.email}
                    </button>
                  ))}
                {(users ?? []).filter((u) => !userSearch || u.email.toLowerCase().includes(userSearch.toLowerCase())).length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted-foreground">Не найдено</p>
                )}
              </div>
            )}
          </div>
          <select
            value={issuingNodeId}
            onChange={(e) => setIssuingNodeId(e.target.value === "auto" ? "auto" : Number(e.target.value))}
            className="border border-border bg-background px-3 py-2 text-sm rounded-none h-10"
          >
            <option value="auto">Узел: авто</option>
            {(activeNodes ?? []).map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
          <div className="flex flex-col gap-1">
            <button
              onClick={handleIssueClick}
              disabled={!issuingUserId || issueMutation.isPending}
              className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              <Plus className="w-4 h-4" /> Выдать ключ
            </button>
            {issuingUserId && (users ?? []).find((u) => u.id === issuingUserId)?.trafficLimitExceeded && (
              <p className="text-xs text-orange-600 font-mono flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 shrink-0" />
                У пользователя превышен лимит трафика — ключ будет автоматически отозван через ~1 минуту.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {pagedKeys.map((key) => (
          <div
            key={key.id}
            className={`bg-card border p-4 ${key.revokedAt ? "border-border opacity-50" : "border-border"}`}
          >
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0 space-y-1">
                <div className="font-bold text-sm break-all">{key.userEmail}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {key.label} · {key.nodeName} · {formatDate(key.createdAt)}
                  {key.revokedAt && (
                    <>
                      <span className="ml-2 text-destructive">Отозван {formatDate(key.revokedAt)}</span>
                      {key.revokedReason && (
                        <span className="ml-1 px-1 bg-muted text-muted-foreground rounded text-[10px]">
                          {key.revokedReason === "admin" ? "вручную" :
                           key.revokedReason === "traffic_limit" ? "лимит трафика" :
                           key.revokedReason === "expired" ? "подписка истекла" :
                           key.revokedReason}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  За период: {formatBytes(key.periodUpBytes + key.periodDownBytes)} · Всего:{" "}
                  {formatBytes(key.trafficUpBytes + key.trafficDownBytes)}
                </div>
                {!key.revokedAt && (
                  <div className="flex items-center gap-2 bg-muted/50 border border-border px-2 py-1 font-mono text-xs overflow-hidden max-w-lg">
                    <span className="truncate flex-1">{key.vlessLink}</span>
                    <button
                      onClick={() => copyLink(key.id, key.vlessLink)}
                      className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                    >
                      {copiedId === key.id ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>
              {!key.revokedAt && (
                <button
                  onClick={() => revokeMutation.mutate(key.id)}
                  disabled={revokeMutation.isPending}
                  className="flex items-center gap-1.5 text-sm text-destructive hover:opacity-70 transition-opacity shrink-0 whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Отозвать
                </button>
              )}
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-muted-foreground text-sm">Ключей не найдено.</p>
        )}
        <PaginationBar page={effectivePageK} total={filtered.length} onPage={setPage} />
      </div>

    </div>
  );
}

const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Открыт",
  answered: "Отвечен",
  closed: "Закрыт",
};
const TICKET_STATUS_CLS: Record<TicketStatus, string> = {
  open: "bg-blue-50 text-blue-700",
  answered: "bg-orange-50 text-orange-700",
  closed: "bg-gray-100 text-gray-500",
};

function TicketDetail({ ticketId, onBack }: { ticketId: number; onBack: () => void }) {
  const [reply, setReply] = useState("");
  const { data: ticket, isLoading } = useGetAdminTicket(ticketId);
  const { mutate: sendMsg, isPending: sending } = useAdminAddTicketMessage();
  const { mutate: setStatus, isPending: updatingStatus } = useUpdateTicketStatus();
  const { toast } = useToast();

  function send() {
    const body = reply.trim();
    if (!body) return;
    sendMsg(
      { ticketId, data: { body } },
      {
        onSuccess: () => {
          setReply("");
          queryClient.invalidateQueries({ queryKey: getGetAdminTicketQueryKey(ticketId) });
          queryClient.invalidateQueries({ queryKey: getListAdminTicketsQueryKey() });
        },
        onError: () => toast({ title: "Ошибка отправки", variant: "destructive" }),
      },
    );
  }

  function closeTicket() {
    setStatus(
      { ticketId, data: { status: "closed" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetAdminTicketQueryKey(ticketId) });
          queryClient.invalidateQueries({ queryKey: getListAdminTicketsQueryKey() });
        },
        onError: () => toast({ title: "Ошибка", variant: "destructive" }),
      },
    );
  }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Все тикеты
      </button>
      {isLoading || !ticket ? (
        <div className="space-y-3"><Skeleton className="h-8 w-1/3" /><Skeleton className="h-40 w-full" /></div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3 mb-4 pb-4 border-b border-border">
            <div>
              <h3 className="font-bold text-base">{ticket.subject}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">#{ticket.id} · {ticket.userEmail} · {formatDate(ticket.createdAt.toString())}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-0.5 ${TICKET_STATUS_CLS[ticket.status as TicketStatus]}`}>
                {TICKET_STATUS_LABEL[ticket.status as TicketStatus]}
              </span>
              {ticket.status !== "closed" && (
                <button onClick={closeTicket} disabled={updatingStatus} className="text-xs text-muted-foreground border border-border px-2 py-0.5 hover:text-destructive transition-colors disabled:opacity-50">
                  Закрыть
                </button>
              )}
            </div>
          </div>

          <div className="space-y-3 max-h-[50vh] overflow-y-auto mb-4 pr-1">
            {ticket.messages.map((msg) => (
              <div key={msg.id} className={`p-3 text-sm ${msg.isAdmin ? "bg-orange-50 border border-orange-100 ml-8" : "bg-muted border border-border mr-8"}`}>
                <p className="whitespace-pre-wrap text-foreground">{msg.body}</p>
                <SupportMessageAttachmentDisplay
                  baseUrl={`/api/admin/support-tickets/${ticketId}/messages/${msg.id}/attachments`}
                  count={msg.attachmentCount ?? 0}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {msg.isAdmin ? "Поддержка" : msg.authorEmail} · {formatDate(msg.createdAt.toString())}
                </p>
              </div>
            ))}
          </div>

          {ticket.status !== "closed" && (
            <div className="space-y-2">
              <Textarea
                placeholder="Ответ клиенту…"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                className="resize-none rounded-none"
                rows={3}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send(); }}
              />
              <button onClick={send} disabled={sending || !reply.trim()} className="flex items-center gap-2 bg-primary text-primary-foreground text-sm font-medium px-4 py-2 hover:opacity-90 disabled:opacity-50 transition-opacity">
                <Send className="w-3.5 h-3.5" /> {sending ? "Отправка…" : "Ответить"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SupportManagement() {
  const [filterStatus, setFilterStatus] = useState<TicketStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"date_desc" | "date_asc" | "messages_desc">("date_desc");
  const { data: tickets, isLoading } = useListAdminTickets(
    filterStatus !== "all" ? { status: filterStatus } : undefined,
  );

  if (selectedId !== null) {
    return <TicketDetail ticketId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  const filteredTickets = (tickets ?? [])
    .filter((t: SupportTicket) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return t.subject.toLowerCase().includes(q) || t.userEmail.toLowerCase().includes(q);
    })
    .sort((a: SupportTicket, b: SupportTicket) => {
      switch (sort) {
        case "date_asc":
          return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        case "messages_desc":
          return b.messageCount - a.messageCount;
        case "date_desc":
        default:
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
    });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {(["all", "open", "answered", "closed"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              className={`text-xs font-semibold px-3 py-1.5 transition-colors border ${
                filterStatus === s
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background text-muted-foreground border-border hover:text-foreground"
              }`}
            >
              {s === "all" ? "Все" : TICKET_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по теме или email"
            className="rounded-none min-w-0 flex-1 basis-48"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            className="border border-border bg-background px-3 py-2 text-sm rounded-none"
          >
            <option value="date_desc">Сначала новые</option>
            <option value="date_asc">Сначала старые</option>
            <option value="messages_desc">По числу сообщений</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : !filteredTickets.length ? (
        <div className="bg-muted/50 border border-border p-10 text-center text-sm text-muted-foreground">
          <MessageCircle className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
          Тикетов нет
        </div>
      ) : (
        <div className="divide-y divide-border border border-border">
          {filteredTickets.map((t: SupportTicket) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors flex items-start justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{t.subject}</p>
                <p className="text-xs text-muted-foreground mt-0.5">#{t.id} · {t.userEmail} · {formatDate(t.updatedAt.toString())} · {t.messageCount} сообщ.</p>
              </div>
              <span className={`text-xs font-semibold px-2 py-0.5 shrink-0 ${TICKET_STATUS_CLS[t.status as TicketStatus]}`}>
                {TICKET_STATUS_LABEL[t.status as TicketStatus]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Notification Bell ────────────────────────────────────────────────────────
// Human-readable labels for system event types shown in the bell dropdown.
const SYS_EVENT_LABELS: Record<string, string> = {
  node_unreachable:      "Нода автоматически отключена",
  node_unavailable:      "Нода недоступна",
  node_overloaded:       "Нода перегружена",
  node_recovered:        "Нода восстановлена",
  auto_renew_success:    "Авто-продление выполнено",
  auto_renew_failed:     "Ошибка авто-продления",
  auto_renew_error:      "Критическая ошибка авто-продления",
  xray_config_remount:   "Конфиг Xray восстановлен из шаблона",
  key_migrated:          "Ключи VPN мигрированы",
};

function NotificationBell() {
  const { data: me } = useGetMe();
  const { payments, otherAdminActions } = useUnifiedPoller(me?.id);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

  const { data: systemEventsRaw } = useListAdminSystemEvents({
    query: { queryKey: getListAdminSystemEventsQueryKey(), refetchInterval: 30_000 },
  });
  const { mutate: acknowledgeEvent } = useAcknowledgeAdminSystemEvent({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAdminSystemEventsQueryKey() }),
    },
  });
  const { mutate: acknowledgeAll, isPending: isAckAllPending } = useAcknowledgeAllAdminSystemEvents({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getListAdminSystemEventsQueryKey() }),
    },
  });

  const systemEvents = systemEventsRaw ?? [];
  const totalBadge = payments.length + systemEvents.length + otherAdminActions.length;

  const handleOpen = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const MARGIN = 8;
      const panelWidth = Math.min(384, vw - MARGIN * 2);
      // Align right edge of panel with right edge of button, clamped so left edge ≥ MARGIN
      const rightFromEdge = Math.max(MARGIN, vw - rect.right);
      const leftEdge = vw - rightFromEdge - panelWidth;
      const finalRight = leftEdge < MARGIN ? vw - panelWidth - MARGIN : rightFromEdge;
      setDropdownStyle({
        position: "fixed",
        top: rect.bottom + 8,
        right: finalRight,
        width: panelWidth,
      });
    }
    setOpen((o) => !o);
  };

  return (
    <div>
      <button
        ref={buttonRef}
        onClick={handleOpen}
        className="relative p-2 text-muted-foreground hover:text-foreground transition-colors"
        title="Уведомления"
      >
        <Bell className="w-5 h-5" />
        {totalBadge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold px-1">
            {totalBadge > 99 ? "99+" : totalBadge}
          </span>
        )}
      </button>
      {open && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="z-50 max-h-[32rem] overflow-y-auto bg-background border border-border shadow-lg" style={dropdownStyle}>

            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className="px-3 py-2 border-b border-border flex items-center justify-between sticky top-0 bg-background z-10">
              <span className="text-xs font-bold uppercase text-muted-foreground tracking-wider">Уведомления</span>
              <span className="text-xs text-muted-foreground">{totalBadge > 0 ? totalBadge : "нет новых"}</span>
            </div>

            {totalBadge === 0 ? (
              <p className="px-3 py-6 text-sm text-muted-foreground text-center">Нет уведомлений</p>
            ) : (
              <>
                {/* ── Системные события (персистентные) ───────────────────── */}
                {systemEvents.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-muted/50 border-b border-border flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Системные события
                      </span>
                      <button
                        onClick={() => acknowledgeAll()}
                        disabled={isAckAllPending}
                        className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 transition-colors"
                        title="Закрыть все"
                      >
                        Закрыть все
                      </button>
                    </div>
                    <div className="divide-y divide-border">
                      {systemEvents.map((e) => {
                        const meta = e.metadata as Record<string, unknown> | undefined;
                        const nodeName = typeof meta?.nodeName === "string" ? meta.nodeName : null;
                        const label = SYS_EVENT_LABELS[e.eventType] ?? e.eventType;
                        const isOk  = e.eventType === "node_recovered" || e.eventType === "auto_renew_success";
                        const isWarn = e.eventType === "node_overloaded";
                        const iconCls = isOk ? "text-green-600" : isWarn ? "text-amber-500" : "text-destructive";
                        return (
                          <div key={e.id} className="px-3 py-2.5 flex items-start gap-2 text-xs">
                            <AlertTriangle className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${iconCls}`} />
                            <div className="flex-1 min-w-0">
                              <div className="font-medium">
                                {label}{nodeName ? <span className="text-muted-foreground"> — {nodeName}</span> : null}
                              </div>
                              <div className="text-muted-foreground font-mono mt-0.5">{formatDate(e.createdAt.toString())}</div>
                            </div>
                            <button
                              onClick={() => acknowledgeEvent({ eventId: e.id })}
                              className="text-muted-foreground hover:text-foreground shrink-0 mt-0.5"
                              title="Подтвердить / закрыть"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Платежи (за сессию) ──────────────────────────────────── */}
                {payments.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-muted/50 border-b border-border">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Платежи — за сессию
                      </span>
                    </div>
                    <div className="divide-y divide-border">
                      {payments.map((n) => {
                        const providerLabel =
                          n.provider === "yoomoney" ? "ЮMoney" :
                          n.provider === "balance"  ? "Баланс" : "СБП";
                        const typeLabel =
                          n.type === "extra_device_slot" ? "Доп. устройство" :
                          n.type === "balance_topup"     ? "Пополнение" :
                          n.type === "extra_traffic"     ? `Доп. трафик${n.extraTrafficGb ? ` +${n.extraTrafficGb}ГБ` : ""}` :
                                                           "Подписка";
                        const statusCls =
                          n.status === "pending"   ? "text-orange-600" :
                          n.status === "confirmed" ? "text-green-600"  : "text-destructive";
                        const statusLabel =
                          n.status === "pending"   ? "Ожидает" :
                          n.status === "confirmed" ? "Подтверждён" : "Отклонён";
                        return (
                          <div key={n.id} className="px-3 py-2.5 flex items-start gap-2 text-xs">
                            <CreditCard className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium truncate">{n.userEmail}</span>
                                <span className={`font-bold shrink-0 ${statusCls}`}>{statusLabel}</span>
                              </div>
                              <div className="text-muted-foreground font-mono mt-0.5">
                                {n.amountRub} ₽ · {typeLabel} · {providerLabel} · {formatDate(n.createdAt.toString())}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Действия других администраторов (за сессию) ─────────── */}
                {otherAdminActions.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-muted/50 border-b border-border">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                        Другие администраторы — за сессию
                      </span>
                    </div>
                    <div className="divide-y divide-border">
                      {otherAdminActions.map((e) => (
                        <div key={e.id} className="px-3 py-2.5 flex items-start gap-2 text-xs">
                          <Activity className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium truncate">{e.adminEmail}</span>
                              <span className={`font-mono shrink-0 ${(e.responseStatus ?? 0) >= 400 ? "text-destructive" : "text-muted-foreground"}`}>
                                {e.responseStatus ?? "—"}
                              </span>
                            </div>
                            <div className="mt-0.5">
                              {ACTION_LABELS[e.action] ?? e.action}
                              {e.targetDescription
                                ? <span className="text-muted-foreground"> — {e.targetDescription}</span>
                                : null}
                            </div>
                            <div className="text-muted-foreground font-mono mt-0.5">{formatDate(e.createdAt.toString())}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

// ── Audit Log ─────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  update_user_role: "Роль пользователя",
  update_user_profile: "Профиль пользователя",
  delete_user: "Удаление пользователя",
  update_user_subscription: "Подписка",
  update_user_extra_slots: "Слоты",
  set_user_balance: "Баланс",
  reset_user_password: "Сброс пароля",
  update_user_note: "Заметка",
  ban_user: "Бан",
  unban_user: "Разбан",
  force_logout: "Принудительный выход",
  create_plan: "Создание тарифа",
  update_plan: "Редактирование тарифа",
  delete_plan: "Удаление тарифа",
  create_vpn_node: "Создание узла",
  update_vpn_node: "Редактирование узла",
  delete_vpn_node: "Удаление узла",
  restart_xray: "Перезапуск Xray",
  provision_vpn_node: "Провизионирование узла",
  issue_vpn_key: "Выдача ключа VPN",
  revoke_vpn_key: "Отзыв ключа VPN",
  create_invite_link: "Создание инвайта",
  update_invite_link: "Редактирование инвайта",
  delete_invite_link: "Удаление инвайта",
  update_payment_settings: "Настройки платежей",
  upload_sbp_qr: "Загрузка QR СБП",
  delete_sbp_qr: "Удаление QR СБП",
  confirm_payment: "Подтверждение платежа",
  reject_payment: "Отклонение платежа",
  update_payment_note: "Заметка к платежу",
  reply_to_ticket: "Ответ на тикет",
  update_ticket_status: "Статус тикета",
  generate_password_reset_link: "Ссылка сброса пароля",
  acknowledge_system_event: "Подтверждение события",
  send_broadcast: "Рассылка уведомления",
  unknown_action: "Неизвестное действие",
};

function AuditLogRow({ entry }: { entry: AdminAuditLogEntry }) {
  const [open, setOpen] = useState(false);
  const label = ACTION_LABELS[entry.action] ?? entry.action;
  const methodColor: Record<string, string> = {
    POST: "text-green-600",
    PATCH: "text-blue-600",
    PUT: "text-blue-600",
    DELETE: "text-red-600",
  };

  return (
    <>
      <tr
        className="border-b hover:bg-muted/30 cursor-pointer text-sm"
        onClick={() => setOpen((v) => !v)}
      >
        <td className="p-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
          {new Date(entry.createdAt).toLocaleString("ru-RU")}
        </td>
        <td className="p-2 max-w-[180px] truncate" title={entry.adminEmail}>
          {entry.adminEmail}
        </td>
        <td className="p-2 whitespace-nowrap">{label}</td>
        <td className={`p-2 font-mono text-xs font-semibold ${methodColor[entry.method] ?? ""}`}>
          {entry.method}
        </td>
        <td className="p-2 font-mono text-xs max-w-[220px] truncate text-muted-foreground" title={entry.path}>
          {entry.path}
        </td>
        <td className="p-2 text-xs">
          {entry.targetDescription ?? (entry.targetType ? `${entry.targetType} #${entry.targetId}` : "—")}
        </td>
        <td className="p-2 text-xs text-center">
          {entry.responseStatus ?? "—"}
        </td>
        <td className="p-2 text-xs text-center text-muted-foreground">
          {entry.durationMs != null ? `${entry.durationMs}ms` : "—"}
        </td>
      </tr>
      {open && (
        <tr className="bg-muted/20">
          <td colSpan={8} className="p-3">
            <div className="text-xs space-y-1">
              {entry.ipAddress && (
                <div><span className="font-semibold">IP:</span> {entry.ipAddress}</div>
              )}
              {entry.userAgent && (
                <div><span className="font-semibold">UA:</span> <span className="text-muted-foreground">{entry.userAgent}</span></div>
              )}
              {entry.details && Object.keys(entry.details).length > 0 && (
                <pre className="bg-muted p-2 rounded text-xs overflow-auto max-h-60">
                  {JSON.stringify(entry.details, null, 2)}
                </pre>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Broadcasts Tab ───────────────────────────────────────────────────────────
/** Inline multi-select combobox for picking specific broadcast recipients */
function UserSearchCombobox({
  selected,
  onChange,
}: {
  selected: AdminUserSearchResult[];
  onChange: (users: AdminUserSearchResult[]) => void;
}) {
  const [open,  setOpen]  = useState(false);
  const [query, setQuery] = useState("");

  const { data: results = [], isFetching } = useSearchAdminUsers(
    { q: query || "_", limit: 20 },
    { query: { enabled: query.trim().length >= 1, staleTime: 10_000, queryKey: ["admin-user-search", query] } },
  );

  const selectedIds = new Set(selected.map((u) => u.id));

  const toggle = (user: AdminUserSearchResult) => {
    if (selectedIds.has(user.id)) {
      onChange(selected.filter((u) => u.id !== user.id));
    } else {
      onChange([...selected, user]);
    }
  };

  return (
    <div className="space-y-2">
      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((u) => (
            <span
              key={u.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted border border-border rounded-sm"
            >
              <span className="text-muted-foreground">#{u.id}</span>
              <span>{u.email}</span>
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => s.id !== u.id))}
                className="ml-0.5 hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center justify-between border border-border px-3 py-2 text-sm text-left hover:bg-muted transition-colors"
          >
            <span className="text-muted-foreground">
              {selected.length === 0
                ? "Поиск по email или ID…"
                : `Выбрано: ${selected.length} польз.`}
            </span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[380px] p-0 rounded-none" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Email или ID пользователя…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {query.trim().length < 1 ? (
                <CommandEmpty className="text-muted-foreground py-4 text-xs text-center">
                  Введите email или ID для поиска
                </CommandEmpty>
              ) : isFetching ? (
                <CommandEmpty className="py-4 text-xs text-center text-muted-foreground">
                  Поиск…
                </CommandEmpty>
              ) : results.length === 0 ? (
                <CommandEmpty>Пользователи не найдены</CommandEmpty>
              ) : (
                <CommandGroup>
                  {results.map((user) => {
                    const isSelected = selectedIds.has(user.id);
                    return (
                      <CommandItem
                        key={user.id}
                        value={String(user.id)}
                        onSelect={() => toggle(user)}
                        className="flex items-center gap-2 cursor-pointer"
                      >
                        <div className={`flex h-4 w-4 items-center justify-center border ${isSelected ? "bg-primary border-primary" : "border-border"}`}>
                          {isSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                        </div>
                        <span className="flex-1 truncate">{user.email}</span>
                        <span className="text-xs text-muted-foreground shrink-0">#{user.id}</span>
                        {user.isBanned && (
                          <span className="text-xs text-destructive shrink-0">banned</span>
                        )}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function BroadcastsTab() {
  const { toast } = useToast();
  const { data: plans } = useListAdminPlans();

  // ── Compose form state ──
  const [title,      setTitle]      = useState("");
  const [message,    setMessage]    = useState("");
  const [targetType, setTargetType] = useState<"all" | "filtered" | "specific">("all");
  const [filterHasActiveSub, setFilterHasActiveSub] = useState<"" | "true" | "false">("");
  const [filterPlanId,       setFilterPlanId]       = useState<string>("");
  const [selectedUsers,      setSelectedUsers]       = useState<AdminUserSearchResult[]>([]);

  // ── History state ──
  const [page,    setPage]    = useState(1);
  const pageSize = 20;

  const { data: history, isLoading: historyLoading, refetch: refetchHistory } = useListAdminBroadcasts(
    { page, pageSize },
    { query: { queryKey: getListAdminBroadcastsQueryKey({ page, pageSize }) } },
  );

  const { mutate: send, isPending: isSending } = useSendAdminBroadcast({
    mutation: {
      onSuccess: (result) => {
        const skipped = result.skippedBannedCount > 0
          ? ` (пропущено забаненных: ${result.skippedBannedCount})`
          : "";
        toast({ title: `Рассылка отправлена ${result.sentCount} пользователям${skipped}` });
        setTitle("");
        setMessage("");
        setTargetType("all");
        setFilterHasActiveSub("");
        setFilterPlanId("");
        setSelectedUsers([]);
        refetchHistory();
        queryClient.invalidateQueries({ queryKey: getListAdminBroadcastsQueryKey() });
      },
      onError: () => toast({ title: "Ошибка отправки рассылки", variant: "destructive" }),
    },
  });

  const handleSend = () => {
    if (!title.trim() || !message.trim()) {
      toast({ title: "Заполните заголовок и текст", variant: "destructive" });
      return;
    }

    const filters: { hasActiveSubscription?: boolean; planId?: number } = {};
    if (targetType === "filtered") {
      if (filterHasActiveSub === "true")  filters.hasActiveSubscription = true;
      if (filterHasActiveSub === "false") filters.hasActiveSubscription = false;
      if (filterPlanId) filters.planId = parseInt(filterPlanId, 10);
    }

    const userIds =
      targetType === "specific"
        ? selectedUsers.map((u) => u.id)
        : undefined;

    if (targetType === "specific" && (!userIds || userIds.length === 0)) {
      toast({ title: "Выберите хотя бы одного пользователя", variant: "destructive" });
      return;
    }

    // Confirmation guard — mandatory before any send to prevent accidental blasts
    const targetLabel =
      targetType === "all"      ? "ВСЕМ пользователям" :
      targetType === "filtered" ? "отфильтрованным пользователям" :
                                  `конкретным пользователям (${userIds?.length ?? 0})`;
    if (!window.confirm(`Отправить рассылку "${title.trim()}" — ${targetLabel}?\n\nЭто действие необратимо.`)) {
      return;
    }

    send({
      data: {
        title:      title.trim(),
        message:    message.trim(),
        targetType,
        ...(userIds ? { userIds } : {}),
        ...(targetType === "filtered" ? { filters } : {}),
      },
    });
  };

  const total      = history?.total    ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-8">

      {/* ── Compose ─────────────────────────────────────────────────────── */}
      <div className="border border-border p-4 space-y-4">
        <h3 className="font-semibold text-sm">Новая рассылка</h3>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase">Заголовок</label>
          <Input
            className="rounded-none"
            placeholder="Например: Плановое обслуживание"
            maxLength={100}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase">Текст сообщения</label>
          <Textarea
            className="rounded-none min-h-[80px]"
            placeholder="Текст уведомления, который увидят пользователи…"
            maxLength={2000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="text-xs text-muted-foreground text-right">{message.length}/2000</div>
        </div>

        {/* Target selector */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase">Получатели</label>
          <div className="flex flex-wrap gap-2">
            {(["all", "filtered", "specific"] as const).map((t) => {
              const label = t === "all" ? "Все пользователи" : t === "filtered" ? "По фильтру" : "Конкретные";
              return (
                <button
                  key={t}
                  onClick={() => setTargetType(t)}
                  className={`px-3 py-1.5 text-xs font-medium border transition-colors ${
                    targetType === t
                      ? "bg-primary text-primary-foreground border-primary"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Filtered options */}
        {targetType === "filtered" && (
          <div className="flex flex-wrap gap-3 p-3 bg-muted/40 border border-border">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Статус подписки</label>
              <select
                className="border rounded-none px-2 py-1.5 text-sm bg-background block"
                value={filterHasActiveSub}
                onChange={(e) => setFilterHasActiveSub(e.target.value as "" | "true" | "false")}
              >
                <option value="">Любой</option>
                <option value="true">С активной подпиской</option>
                <option value="false">Без активной подписки</option>
              </select>
            </div>
            {filterHasActiveSub === "true" && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Тариф (опционально)</label>
                <select
                  className="border rounded-none px-2 py-1.5 text-sm bg-background block"
                  value={filterPlanId}
                  onChange={(e) => setFilterPlanId(e.target.value)}
                >
                  <option value="">Все тарифы</option>
                  {(plans ?? []).map((p) => (
                    <option key={p.id} value={String(p.id)}>{p.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Specific user picker */}
        {targetType === "specific" && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Получатели</label>
            <UserSearchCombobox selected={selectedUsers} onChange={setSelectedUsers} />
          </div>
        )}

        <button
          onClick={handleSend}
          disabled={isSending || !title.trim() || !message.trim()}
          className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
        >
          {isSending ? "Отправка…" : "Отправить"}
        </button>
      </div>

      {/* ── History ─────────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <h3 className="font-semibold text-sm">История рассылок</h3>

        {historyLoading ? (
          <div className="py-8 text-center text-muted-foreground">Загрузка…</div>
        ) : !history || history.entries.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">Рассылок пока не было</div>
        ) : (
          <div className="overflow-x-auto border rounded-none">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-muted/50 border-b text-left text-xs font-semibold">
                  <th className="p-2 whitespace-nowrap">Отправлено</th>
                  <th className="p-2">Заголовок</th>
                  <th className="p-2">Текст</th>
                  <th className="p-2 text-right whitespace-nowrap">Получателей</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {history.entries.map((b) => (
                  <tr key={b.broadcastId} className="hover:bg-muted/20">
                    <td className="p-2 text-xs text-muted-foreground font-mono whitespace-nowrap">
                      {formatDate(b.sentAt.toString())}
                    </td>
                    <td className="p-2 font-medium max-w-[180px] truncate" title={b.title}>
                      {b.title}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground max-w-[300px] truncate" title={b.message}>
                      {b.message}
                    </td>
                    <td className="p-2 text-right font-mono text-xs">{b.recipientCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > pageSize && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {total} рассылок, страница {page} из {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                className="px-3 py-1 border rounded-none text-sm disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >←</button>
              <button
                className="px-3 py-1 border rounded-none text-sm disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >→</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Event History Tab ────────────────────────────────────────────────────────
function EventHistoryTab() {
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [eventTypeFilter, setEventTypeFilter] = useState<string>("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const params = {
    page,
    pageSize,
    ...(eventTypeFilter ? { eventType: eventTypeFilter } : {}),
    ...(since  ? { since:  since  } : {}),
    ...(until  ? { until:  until  } : {}),
  };

  const { data, isLoading } = useGetAdminSystemEventsHistory(params, {
    query: { queryKey: getGetAdminSystemEventsHistoryQueryKey(params), refetchInterval: 30_000 },
  });

  const { mutate: acknowledgeOne } = useAcknowledgeAdminSystemEvent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAdminSystemEventsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAdminSystemEventsHistoryQueryKey() });
      },
    },
  });

  const total      = data?.total    ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      {/* ── Filters ── */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="border rounded-none px-2 py-1.5 text-sm bg-background"
          value={eventTypeFilter}
          onChange={(e) => { setEventTypeFilter(e.target.value); setPage(1); }}
        >
          <option value="">Все типы</option>
          {Object.entries(SYS_EVENT_LABELS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <Input
          type="datetime-local"
          className="rounded-none w-auto text-sm"
          value={since}
          onChange={(e) => { setSince(e.target.value); setPage(1); }}
          placeholder="С"
        />
        <Input
          type="datetime-local"
          className="rounded-none w-auto text-sm"
          value={until}
          onChange={(e) => { setUntil(e.target.value); setPage(1); }}
          placeholder="По"
        />
      </div>

      {/* ── Table ── */}
      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Загрузка...</div>
      ) : !data || data.entries.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">Нет записей</div>
      ) : (
        <div className="overflow-x-auto border rounded-none">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="bg-muted/50 border-b text-left text-xs font-semibold">
                <th className="p-2 whitespace-nowrap">Время</th>
                <th className="p-2">Тип события</th>
                <th className="p-2">Детали</th>
                <th className="p-2 text-center">Статус</th>
                <th className="p-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.entries.map((e) => {
                const meta       = e.metadata as Record<string, unknown> | undefined;
                const label      = SYS_EVENT_LABELS[e.eventType] ?? e.eventType;
                const nodeName   = typeof meta?.nodeName   === "string" ? meta.nodeName   : null;
                const nodeId     = typeof meta?.nodeId     === "number" ? meta.nodeId     : null;
                const isOk       = e.eventType === "node_recovered" || e.eventType === "auto_renew_success";
                const isWarn     = e.eventType === "node_overloaded";
                const isDone     = !!e.acknowledgedAt;
                const dotCls     = isOk ? "bg-green-500" : isWarn ? "bg-amber-500" : "bg-destructive";
                return (
                  <tr key={e.id} className={isDone ? "opacity-50" : ""}>
                    <td className="p-2 text-xs text-muted-foreground font-mono whitespace-nowrap">
                      {formatDate(e.createdAt.toString())}
                    </td>
                    <td className="p-2">
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dotCls}`} />
                        <span className="font-medium text-xs">{label}</span>
                      </div>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {nodeName ?? (nodeId != null ? `Node #${nodeId}` : "—")}
                    </td>
                    <td className="p-2 text-center">
                      {isDone ? (
                        <span className="text-xs text-muted-foreground">Закрыто</span>
                      ) : (
                        <span className="text-xs font-semibold text-destructive">Активно</span>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      {!isDone && (
                        <button
                          onClick={() => acknowledgeOne({ eventId: e.id })}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="Закрыть событие"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pagination ── */}
      {total > pageSize && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {total} записей, страница {page} из {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              className="px-3 py-1 border rounded-none text-sm disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >←</button>
            <button
              className="px-3 py-1 border rounded-none text-sm disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >→</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuditLogTab() {
  const [page, setPage] = useState(1);
  const pageSize = 50;
  const [actionFilter, setActionFilter] = useState<string>("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const params = {
    page,
    pageSize,
    ...(actionFilter ? { action: actionFilter as typeof AdminAuditLogAction[keyof typeof AdminAuditLogAction] } : {}),
    ...(since ? { since: since } : {}),
    ...(until ? { until: until } : {}),
  };

  const { data: rawData, isLoading } = useGetAdminAuditLog(params);
  // Hook may return string on CSV format — we always request JSON here.
  const data = rawData && typeof rawData !== "string" ? rawData : null;

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const csvHref = (() => {
    const q = new URLSearchParams();
    q.set("format", "csv");
    if (actionFilter) q.set("action", actionFilter);
    if (since) q.set("since", new Date(since).toISOString());
    if (until) q.set("until", new Date(until).toISOString());
    return `/api/admin/audit-log?${q.toString()}`;
  })();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="border rounded-none px-2 py-1.5 text-sm bg-background"
          value={actionFilter}
          onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
        >
          <option value="">Все действия</option>
          {Object.entries(ACTION_LABELS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <Input
          type="datetime-local"
          className="rounded-none w-auto text-sm"
          value={since}
          onChange={(e) => { setSince(e.target.value); setPage(1); }}
          placeholder="С"
        />
        <Input
          type="datetime-local"
          className="rounded-none w-auto text-sm"
          value={until}
          onChange={(e) => { setUntil(e.target.value); setPage(1); }}
          placeholder="По"
        />
        <a
          href={csvHref}
          download="audit-log.csv"
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-none bg-background hover:bg-muted"
        >
          <Download className="w-4 h-4" /> Экспорт CSV
        </a>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Загрузка...</div>
      ) : !data || data.entries.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">Нет записей</div>
      ) : (
        <div className="overflow-x-auto border rounded-none">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="bg-muted/50 border-b text-left text-xs font-semibold">
                <th className="p-2 whitespace-nowrap">Время</th>
                <th className="p-2">Администратор</th>
                <th className="p-2">Действие</th>
                <th className="p-2">Метод</th>
                <th className="p-2">Путь</th>
                <th className="p-2">Цель</th>
                <th className="p-2 text-center">Статус</th>
                <th className="p-2 text-center">Время</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <AuditLogRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > pageSize && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {total} записей, страница {page} из {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              className="px-3 py-1 border rounded-none text-sm disabled:opacity-40"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ←
            </button>
            <button
              className="px-3 py-1 border rounded-none text-sm disabled:opacity-40"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Admin() {
  const { data: summary } = useGetAdminDashboardSummary();
  const pendingPayments = summary?.pendingPayments ?? 0;
  const openTickets = summary?.openTickets ?? 0;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Панель администратора</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">Управление сервисом VPNexus.</p>
        </div>
        <NotificationBell />
      </div>

      <TrafficPollingWarningBanner />
      <XrayConfigRemountBanner />
      <NodeAlertsBanner />

      <SummarySection />

      <Tabs defaultValue="payments">
        <div className="relative -mx-4 md:mx-0 sticky top-0 z-10 bg-background border-b border-border">
          <div className="overflow-x-auto px-4 md:px-0">
            <TabsList className="rounded-none w-max min-w-full md:w-auto border-b-0">
              <TabsTrigger value="payments" className="rounded-none gap-1.5 whitespace-nowrap">
                <CreditCard className="w-4 h-4" /> Платежи
                <Badge count={pendingPayments} />
              </TabsTrigger>
              <TabsTrigger value="plans" className="rounded-none gap-1.5 whitespace-nowrap">
                <Shield className="w-4 h-4" /> Тарифы
              </TabsTrigger>
              <TabsTrigger value="nodes" className="rounded-none gap-1.5 whitespace-nowrap">
                <Settings className="w-4 h-4" /> Узлы
              </TabsTrigger>
              <TabsTrigger value="vpn-keys" className="rounded-none gap-1.5 whitespace-nowrap">
                <Key className="w-4 h-4" /> Ключи VPN
              </TabsTrigger>
              <TabsTrigger value="users" className="rounded-none gap-1.5 whitespace-nowrap">
                <Users className="w-4 h-4" /> Пользователи
              </TabsTrigger>
              <TabsTrigger value="invites" className="rounded-none gap-1.5 whitespace-nowrap">
                <Link2 className="w-4 h-4" /> Инвайты
              </TabsTrigger>
              <TabsTrigger value="referrals" className="rounded-none gap-1.5 whitespace-nowrap">
                <Share2 className="w-4 h-4" /> Рефералы
              </TabsTrigger>
              <TabsTrigger value="settings" className="rounded-none gap-1.5 whitespace-nowrap">
                <Settings className="w-4 h-4" /> Реквизиты
              </TabsTrigger>
              <TabsTrigger value="support" className="rounded-none gap-1.5 whitespace-nowrap">
                <MessageCircle className="w-4 h-4" /> Поддержка
                <Badge count={openTickets} />
              </TabsTrigger>
              <TabsTrigger value="broadcasts" className="rounded-none gap-1.5 whitespace-nowrap">
                <Bell className="w-4 h-4" /> Рассылки
              </TabsTrigger>
              <TabsTrigger value="event-history" className="rounded-none gap-1.5 whitespace-nowrap">
                <Bell className="w-4 h-4" /> История событий
              </TabsTrigger>
              <TabsTrigger value="audit-log" className="rounded-none gap-1.5 whitespace-nowrap">
                <ClipboardList className="w-4 h-4" /> Журнал действий
              </TabsTrigger>
            </TabsList>
          </div>
          <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-background to-transparent md:hidden" />
        </div>
        <TabsContent value="payments" className="pt-4">
          <PaymentsQueue />
        </TabsContent>
        <TabsContent value="plans" className="pt-4">
          <PlansManagement />
        </TabsContent>
        <TabsContent value="nodes" className="pt-4">
          <NodesManagement />
        </TabsContent>
        <TabsContent value="vpn-keys" className="pt-4">
          <VpnKeysManagement />
        </TabsContent>
        <TabsContent value="users" className="pt-4">
          <UsersManagement />
        </TabsContent>
        <TabsContent value="invites" className="pt-4">
          <InviteLinksManagement />
        </TabsContent>
        <TabsContent value="referrals" className="pt-4">
          <ReferralsManagement />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <PaymentSettingsForm />
        </TabsContent>
        <TabsContent value="support" className="pt-4">
          <SupportManagement />
        </TabsContent>
        <TabsContent value="broadcasts" className="pt-4">
          <BroadcastsTab />
        </TabsContent>
        <TabsContent value="event-history" className="pt-4">
          <EventHistoryTab />
        </TabsContent>
        <TabsContent value="audit-log" className="pt-4">
          <AuditLogTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
