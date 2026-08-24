import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  useListPlans,
  useUpdateUserSubscription,
  useUpdateUserRole,
  useUpdateUserExtraSlots,
  useUpdateUserProfile,
  useDeleteUser,
  useAdminResetUserPassword,
  useAdminSetUserBalance,
  useAdminSetUserPassword,
  useAdminForceLogout,
  useAdminBanUser,
  useAdminUnbanUser,
  useAdminSetUserNote,
  useListAdminVpnKeys,
  getListAdminVpnKeysQueryKey,
  useListAdminUsers,
  getListAdminUsersQueryKey,
  useListAdminPayments,
  useListAdminInviteLinks,
  useCreateAdminInviteLink,
  useUpdateAdminInviteLink,
  useDeleteAdminInviteLink,
  getListAdminInviteLinksQueryKey,
  useGetAdminInviteLinkUsers,
  useListAdminReferrals,
  useListAdminUserBalanceTransactions,
  useListAdminPlans,
  useGetPaymentSettings,
} from "@workspace/api-client-react";
import type {
  AdminUser,
  AdminBalanceTransaction,
  AdminInviteLink,
  AdminInviteLinkUser,
  Plan,
} from "@workspace/api-client-react";
import { queryClient } from "@/lib/query-client";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Check, X, Trash2, Pencil, Plus, Users, Key, Copy, Share2,
  CheckSquare, Square, ChevronDown, ChevronUp, Link2, Activity,
  RefreshCw, Terminal, RotateCcw, Zap, Server, LineChart as LineChartIcon,
  Wallet, AlertTriangle, Settings, Shield, Download,
} from "lucide-react";
import { formatDate, formatBytes, ADMIN_PAGE_SIZE, PaginationBar } from "./admin-shared";
import { ReferralQrDialog } from "@/components/referral-qr-dialog";

export type SubscriptionFilter =
  | "all"
  | "active"
  | "expiring_3_days"
  | "expiring_7_days"
  | "expiring_30_days"
  | "trial"
  | "expired"
  | "none";

type UserSort = "date_desc" | "date_asc" | "email" | "traffic" | "online" | "expiry_asc";

const DAY_MS = 24 * 60 * 60 * 1000;

function isExpiringFilter(filter: SubscriptionFilter): boolean {
  return filter === "expiring_3_days" || filter === "expiring_7_days" || filter === "expiring_30_days";
}

function isActiveMonthlyExpiringWithin(user: AdminUser, days: number, now = Date.now()): boolean {
  if (
    user.activeSubscriptionId == null ||
    user.activeSubscriptionBillingType !== "monthly" ||
    !user.activeSubscriptionEndsAt
  ) {
    return false;
  }
  const endsAt = new Date(user.activeSubscriptionEndsAt).getTime();
  return endsAt > now && endsAt <= now + days * DAY_MS;
}

function formatSubscriptionRemaining(endsAt: string): string {
  const remainingMs = new Date(endsAt).getTime() - Date.now();
  if (remainingMs <= 0) return "истекла";
  const days = Math.floor(remainingMs / DAY_MS);
  if (days > 0) return `осталось ${days} дн.`;
  const hours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
  return `осталось ${hours} ч.`;
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
           {user.activeSubscriptionId != null && user.activeSubscriptionEndsAt && ` · до ${formatDate(user.activeSubscriptionEndsAt)}`}
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

/**
 * Shows the last background traffic-poll result for a specific remote node.
 * Uses the same polling-health query as the global banner so there's no extra
 * network request — React Query serves from cache.
 */

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
                  {key.xrayCleanupPendingAt && (
                    <div className="mt-1 text-amber-600 dark:text-amber-400">
                      Ожидается удаление клиента из Xray: {formatDate(key.xrayCleanupPendingAt)}
                    </div>
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
          <ReferralQrDialog
            value={`${window.location.origin}${basePath}/sign-up?ref=${link.code}`}
            title="QR-код инвайт-ссылки"
            description="Отсканируйте код камерой — он откроет регистрацию по этой инвайт-ссылке."
            buttonLabel=""
            className="border-0 px-1 py-0.5 text-xs"
          />
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

export function InviteLinksManagement() {
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
export function ReferralsManagement() {
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
export function UsersManagement({
  subscriptionFilter,
  filterRequestId,
  onSubscriptionFilterChange,
}: {
  subscriptionFilter: SubscriptionFilter;
  filterRequestId: number;
  onSubscriptionFilterChange: (filter: SubscriptionFilter) => void;
}) {
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
  const [sort, setSort] = useState<UserSort>(isExpiringFilter(subscriptionFilter) ? "expiry_asc" : "date_desc");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    setSort(isExpiringFilter(subscriptionFilter) ? "expiry_asc" : "date_desc");
    setPage(1);
  }, [subscriptionFilter, filterRequestId]);

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
      if (subscriptionFilter === "expiring_3_days") return isActiveMonthlyExpiringWithin(u, 3);
      if (subscriptionFilter === "expiring_7_days") return isActiveMonthlyExpiringWithin(u, 7);
      if (subscriptionFilter === "expiring_30_days") return isActiveMonthlyExpiringWithin(u, 30);
      if (subscriptionFilter === "trial") return u.isOnTrial === true;
      if (subscriptionFilter === "expired") return u.subscriptionStatus === "expired";
      if (subscriptionFilter === "none") return u.subscriptionStatus !== "active" && !u.activePlanName;
      return true;
    })
    .sort((a, b) => {
      if (sort === "expiry_asc") {
        const aEnds = a.activeSubscriptionEndsAt ? new Date(a.activeSubscriptionEndsAt).getTime() : Number.POSITIVE_INFINITY;
        const bEnds = b.activeSubscriptionEndsAt ? new Date(b.activeSubscriptionEndsAt).getTime() : Number.POSITIVE_INFINITY;
        return aEnds - bEnds;
      }
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
          onChange={(e) => onSubscriptionFilterChange(e.target.value as SubscriptionFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все подписки</option>
          <option value="active">С активной</option>
          <option value="expiring_3_days">Истекает за 3 дня</option>
          <option value="expiring_7_days">Истекает за 7 дней</option>
          <option value="expiring_30_days">Истекает за 30 дней</option>
          <option value="trial">Пробный период</option>
          <option value="expired">Истёкшая</option>
          <option value="none">Без подписки</option>
        </select>
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as UserSort); setPage(1); }}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="date_desc">Сначала новые</option>
          <option value="date_asc">Сначала старые</option>
          <option value="email">По email</option>
          <option value="traffic">По трафику</option>
          <option value="online">Сначала онлайн</option>
          <option value="expiry_asc">Сначала истекают</option>
        </select>
        <button
          onClick={() => {
            const header = "ID,Дата регистрации,Email,Имя,Роль,Баланс (₽),Тариф,Трафик всего (байт),Реф. код,Приглашён,Инвайт-ссылка";
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
                u.inviteLinkCode ?? "",
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
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono">
                  {user.activePlanName ? (
                    <>
                      <span className="font-bold text-foreground">Подписка: {user.activePlanName}</span>
                      {user.activeSubscriptionEndsAt ? (
                        <span className={isActiveMonthlyExpiringWithin(user, 3) ? "font-bold text-red-700" : "text-muted-foreground"}>
                          до {formatDate(user.activeSubscriptionEndsAt)} · {formatSubscriptionRemaining(user.activeSubscriptionEndsAt)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">почасовая</span>
                      )}
                    </>
                  ) : user.planName ? (
                    <span className="text-muted-foreground">
                      Подписка: {user.planName} · {user.subscriptionStatus === "expired" ? "истекла" : "не активна"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Подписка: нет</span>
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
              {user.inviteLinkCode ? (
                <span className="text-muted-foreground">
                  Ссылка:{" "}
                  <span className="text-foreground font-mono font-semibold">{user.inviteLinkCode}</span>
                  {user.inviteLinkNote && (
                    <span className="text-foreground"> ({user.inviteLinkNote})</span>
                  )}
                  {user.referredByEmail && (
                    <span className="text-muted-foreground"> · {user.referredByEmail}</span>
                  )}
                </span>
              ) : user.referredByEmail ? (
                <span className="text-muted-foreground">
                  Приглашён(а): <span className="text-foreground">{user.referredByEmail}</span>
                </span>
              ) : null}
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

