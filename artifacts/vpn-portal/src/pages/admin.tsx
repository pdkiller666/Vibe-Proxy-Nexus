import { useRef, useState } from "react";
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
  useGetPaymentSettings,
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
} from "@workspace/api-client-react";
import type { Plan, VpnNode, SupportTicket, TicketStatus, AdminUser } from "@workspace/api-client-react";
import { queryClient } from "@/lib/query-client";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, X, Trash2, Pencil, Plus, Users, CreditCard, Shield, Settings, Key, Copy, MessageCircle, Send, ArrowLeft, Bell, Image as ImageIcon } from "lucide-react";

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

function SummarySection() {
  const { data, isLoading } = useGetAdminDashboardSummary();
  if (isLoading || !data) {
    return (
      <div className="grid md:grid-cols-3 lg:grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid md:grid-cols-3 lg:grid-cols-6 gap-4">
      <Metric label="Пользователи" value={data.totalUsers} />
      <Metric label="Активные подписки" value={data.activeSubscriptions} />
      <Metric label="Ожидают оплаты" value={data.pendingPayments} highlight={data.pendingPayments > 0} />
      <Metric label="Доход (30 дней)" value={`${data.last30DaysRevenueRub} ₽`} />
      <Metric label="Выпущено ключей" value={data.totalVpnKeys} />
      <Metric label="Открытых тикетов" value={data.openTickets} highlight={data.openTickets > 0} />
    </div>
  );
}

function PaymentsQueue() {
  const [statusFilter, setStatusFilter] = useState<"pending" | "confirmed" | "rejected" | "all">("pending");
  const [sort, setSort] = useState<"date_desc" | "date_asc" | "amount_desc" | "amount_asc">("date_desc");
  const [search, setSearch] = useState("");
  const { data: payments, isLoading } = useListAdminPayments(
    statusFilter === "all" ? undefined : { status: statusFilter },
  );
  const { mutate: confirm } = useConfirmPayment();
  const { mutate: reject } = useRejectPayment();
  const { toast } = useToast();
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [reason, setReason] = useState("");

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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по email или референсу"
          className="rounded-none min-w-0 flex-1 basis-48"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="pending">Ожидающие</option>
          <option value="confirmed">Подтверждённые</option>
          <option value="rejected">Отклонённые</option>
          <option value="all">Все</option>
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="date_desc">Сначала новые</option>
          <option value="date_asc">Сначала старые</option>
          <option value="amount_desc">По сумме (убыв.)</option>
          <option value="amount_asc">По сумме (возр.)</option>
        </select>
      </div>
      {filteredPayments.length === 0 && (
        <p className="text-muted-foreground">Платежей не найдено.</p>
      )}
      {filteredPayments.map((payment) => (
        <div key={payment.id} className="bg-card border border-border p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="font-bold">
                {payment.userEmail} ·{" "}
                {payment.type === "extra_device_slot"
                  ? "Доп. устройство"
                  : payment.type === "balance_topup"
                    ? "Пополнение баланса"
                    : (payment.planName ?? "—")}
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                {payment.amountRub} ₽ · {payment.reference} · {formatDate(payment.createdAt)}
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
      billingType,
      hourlyRateKopecks: billingType === "hourly" ? Math.round(Number(hourlyRateRub) * 100) : null,
    };
    const onSuccess = () => {
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
  const { data: plans, isLoading } = useListPlans();
  const { mutate: deletePlan } = useDeletePlan();
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [billingFilter, setBillingFilter] = useState<"all" | "monthly" | "hourly">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sort, setSort] = useState<"default" | "price_asc" | "price_desc" | "name">("default");

  function handleDelete(planId: number) {
    deletePlan(
      { planId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPlansQueryKey() });
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
              <div className="font-bold">
                {plan.name} {!plan.isActive && <span className="text-muted-foreground font-normal">(неактивен)</span>}
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
  const [panelUrl, setPanelUrl] = useState("");
  const [panelLogin, setPanelLogin] = useState("");
  const [panelPassword, setPanelPassword] = useState("");
  const [isActive, setIsActive] = useState(node?.isActive ?? true);
  const [maxUsers, setMaxUsers] = useState(node?.maxUsers != null ? String(node.maxUsers) : "");

  function handleSubmit() {
    const body = {
      name,
      region,
      host: host || undefined,
      port: port ? Number(port) : undefined,
      sni,
      publicKey: publicKey || undefined,
      shortId: shortId || undefined,
      panelUrl: panelUrl || undefined,
      panelLogin: panelLogin || undefined,
      panelPassword: panelPassword || undefined,
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
      updateNode({ nodeId: node.id, data: body }, { onSuccess, onError });
    } else {
      createNode({ data: body }, { onSuccess, onError });
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
        <Input placeholder="SNI" value={sni} onChange={(e) => setSni(e.target.value)} className="rounded-none" />
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
        <Input placeholder="Panel URL" value={panelUrl} onChange={(e) => setPanelUrl(e.target.value)} className="rounded-none" />
        <Input
          placeholder="Panel Login"
          value={panelLogin}
          onChange={(e) => setPanelLogin(e.target.value)}
          className="rounded-none"
        />
        <Input
          type="password"
          placeholder="Panel Password"
          value={panelPassword}
          onChange={(e) => setPanelPassword(e.target.value)}
          className="rounded-none"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Активен
        </label>
      </div>
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
  const [regionFilter, setRegionFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sort, setSort] = useState<"default" | "clients_desc" | "name">("default");

  function handleDelete(nodeId: number) {
    deleteNode(
      { nodeId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListVpnNodesQueryKey() });
          toast({ title: "Узел удалён" });
        },
        onError: () => toast({ title: "Ошибка удаления узла", variant: "destructive" }),
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
          <div key={node.id} className="bg-card border border-border p-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0 break-words">
              <div className="font-bold">
                {node.name} <span className="text-muted-foreground font-normal">· {node.region}</span>
                {!node.isActive && <span className="text-muted-foreground font-normal"> (неактивен)</span>}
              </div>
              <div className="text-sm text-muted-foreground font-mono break-all">
                {node.host ?? "—"}:{node.port ?? 443} · SNI: {node.sni}
              </div>
              <div className="text-sm text-muted-foreground">
                Клиентов: {node.activeUserCount}
                {node.maxUsers != null ? ` / ${node.maxUsers}` : ""}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setEditingId(node.id)} className="p-2 text-muted-foreground hover:text-primary">
                <Pencil className="w-4 h-4" />
              </button>
              <button onClick={() => handleDelete(node.id)} className="p-2 text-muted-foreground hover:text-destructive">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ),
      )}
      {editingId === "new" ? (
        <NodeForm onDone={() => setEditingId(null)} />
      ) : (
        <button
          onClick={() => setEditingId("new")}
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
  const [planId, setPlanId] = useState<string>(user.planId ? String(user.planId) : "");
  const [durationDays, setDurationDays] = useState("");

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

  return (
    <div className="space-y-2">
      <div className="text-xs font-mono text-muted-foreground">
        Текущий тариф: <span className="font-bold text-foreground">{user.planName ?? "—"}</span>
        {user.subscriptionStatus && ` · ${statusLabel[user.subscriptionStatus] ?? user.subscriptionStatus}`}
        {user.subscriptionEndsAt && ` · до ${formatDate(user.subscriptionEndsAt)}`}
      </div>
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

function UserKeysAndPayments({ userId }: { userId: number }) {
  const { data: keys } = useQuery<AdminVpnKey[]>({
    queryKey: ["admin", "vpn-keys"],
    queryFn: async () => {
      const res = await fetch("/api/admin/vpn-keys", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });
  const { data: payments } = useListAdminPayments();
  const { toast } = useToast();

  const revokeMutation = useMutation({
    mutationFn: async (keyId: number) => {
      const res = await fetch(`/api/admin/vpn-keys/${keyId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => {
      toast({ title: "Ключ отозван" });
      queryClient.invalidateQueries({ queryKey: ["admin", "vpn-keys"] });
      queryClient.invalidateQueries({ queryKey: getListAdminUsersQueryKey() });
    },
    onError: () => toast({ title: "Ошибка отзыва ключа", variant: "destructive" }),
  });

  const userKeys = (keys ?? []).filter((k) => k.userId === userId);
  const userPayments = (payments ?? []).filter((p) => p.userId === userId);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
          Ключи VPN ({userKeys.length})
        </div>
        {userKeys.length === 0 ? (
          <p className="text-xs text-muted-foreground">Ключей нет.</p>
        ) : (
          userKeys.map((key) => (
            <div key={key.id} className={`bg-muted/30 border border-border px-2 py-1.5 text-xs ${key.revokedAt ? "opacity-60" : ""}`}>
              <div className="flex items-center justify-between gap-2">
                <div className={key.revokedAt ? "text-muted-foreground line-through font-medium" : "font-medium"}>
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
            </div>
          ))
        )}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
          Платежи ({userPayments.length})
        </div>
        {userPayments.length === 0 ? (
          <p className="text-xs text-muted-foreground">Платежей нет.</p>
        ) : (
          userPayments.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 bg-muted/30 border border-border px-2 py-1.5 text-xs">
              <div className="min-w-0">
                <div className="font-medium">{p.planName ?? (p.type === "extra_device_slot" ? "Доп. устройство" : "Подписка")}</div>
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
          ))
        )}
      </div>
    </div>
  );
}

function UsersManagement() {
  const { data: users, isLoading } = useListAdminUsers();
  const { mutate: updateRole } = useUpdateUserRole();
  const { mutate: updateExtraSlots } = useUpdateUserExtraSlots();
  const { mutate: resetPassword, isPending: resettingPassword } = useAdminResetUserPassword();
  const { mutate: deleteUser, isPending: deleting } = useDeleteUser();
  const { toast } = useToast();
  const [resetLinks, setResetLinks] = useState<Record<number, string>>({});
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [sort, setSort] = useState<"date_desc" | "date_asc" | "email" | "traffic">("date_desc");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

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
    .sort((a, b) => {
      switch (sort) {
        case "date_asc":
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case "email":
          return a.email.localeCompare(b.email);
        case "traffic":
          return b.trafficUpBytes + b.trafficDownBytes - (a.trafficUpBytes + a.trafficDownBytes);
        case "date_desc":
        default:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Input
          placeholder="Поиск по email или имени..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-none max-w-xs"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)}
          className="border border-border bg-background px-3 py-2 text-sm rounded-none"
        >
          <option value="all">Все роли</option>
          <option value="admin">Администраторы</option>
          <option value="user">Пользователи</option>
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
      </div>
      {filtered.map((user) => {
        const expanded = expandedId === user.id;
        return (
          <div key={user.id} className="bg-card border border-border p-4 space-y-3">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0 break-words">
                <div className="font-bold break-all">
                  {user.name ? `${user.name} · ` : ""}
                  {user.email}
                </div>
                <div className="text-sm text-muted-foreground font-mono">
                  {user.role === "admin" ? "Администратор" : "Пользователь"} · с {formatDate(user.createdAt)}
                </div>
              </div>
              <div className="flex gap-2 flex-wrap shrink-0">
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
                  <div className="text-xs font-bold uppercase text-muted-foreground tracking-wide">Подписка</div>
                  <UserSubscriptionEditor user={user} />
                </div>
                <UserKeysAndPayments userId={user.id} />
              </div>
            )}
          </div>
        );
      })}
      {filtered.length === 0 && <p className="text-muted-foreground text-sm">Пользователи не найдены.</p>}
    </div>
  );
}

function PaymentSettingsForm() {
  const { data: settings, isLoading } = useGetPaymentSettings();
  const { mutate: update, isPending } = useUpdatePaymentSettings();
  const { toast } = useToast();
  const [sbpPhone, setSbpPhone] = useState("");
  const [sbpBank, setSbpBank] = useState("");
  const [sbpRecipientName, setSbpRecipientName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [extraDeviceSlotPriceRub, setExtraDeviceSlotPriceRub] = useState("");
  const [allowFreeExtraDeviceSlot, setAllowFreeExtraDeviceSlot] = useState(false);
  const [trialEnabled, setTrialEnabled] = useState(false);
  const [trialDays, setTrialDays] = useState("5");
  const [minHourlyTopupRub, setMinHourlyTopupRub] = useState("0");
  const [primaryDomain, setPrimaryDomain] = useState("");
  const [initialized, setInitialized] = useState(false);

  if (settings && !initialized) {
    setSbpPhone(settings.sbpPhone);
    setSbpBank(settings.sbpBank);
    setSbpRecipientName(settings.sbpRecipientName);
    setInstructions(settings.instructions ?? "");
    setExtraDeviceSlotPriceRub(String(settings.extraDeviceSlotPriceRub ?? 0));
    setAllowFreeExtraDeviceSlot(settings.allowFreeExtraDeviceSlot ?? false);
    setTrialEnabled(settings.trialEnabled ?? false);
    setTrialDays(String(settings.trialDays ?? 5));
    setMinHourlyTopupRub(String(settings.minHourlyTopupRub ?? 0));
    setPrimaryDomain(settings.primaryDomain ?? "");
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
          trialEnabled,
          trialDays: Number(trialDays) || 5,
          minHourlyTopupRub: Number(minHourlyTopupRub) || 0,
          primaryDomain: primaryDomain.trim(),
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
            <p className="text-xs text-muted-foreground mt-1">
              Используется наиболее дешёвый из активных тарифов. Создайте тариф заранее.
            </p>
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

      <button
        onClick={handleSubmit}
        disabled={isPending}
        className="bg-primary text-primary-foreground font-bold px-5 py-2.5 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        Сохранить реквизиты
      </button>
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
      return res.json() as Promise<Array<{ id: number; email: string }>>;
    },
  });

  const issueMutation = useMutation({
    mutationFn: async (userId: number) => {
      const res = await fetch("/api/admin/vpn-keys/issue", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
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

      <div className="space-y-2">
        {filtered.map((key) => (
          <div
            key={key.id}
            className={`bg-card border p-4 ${key.revokedAt ? "border-border opacity-50" : "border-border"}`}
          >
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0 space-y-1">
                <div className="font-bold text-sm break-all">{key.userEmail}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {key.label} · {key.nodeName} · {formatDate(key.createdAt)}
                  {key.revokedAt && <span className="ml-2 text-destructive">Отозван {formatDate(key.revokedAt)}</span>}
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
      </div>

      <div className="border-t border-border pt-4">
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
          <button
            onClick={handleIssueClick}
            disabled={!issuingUserId || issueMutation.isPending}
            className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> Выдать ключ
          </button>
        </div>
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

export default function Admin() {
  const { data: summary } = useGetAdminDashboardSummary();
  const pendingPayments = summary?.pendingPayments ?? 0;
  const openTickets = summary?.openTickets ?? 0;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Панель администратора</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">Управление сервисом VPNexus.</p>
      </div>

      <SummarySection />

      <Tabs defaultValue="payments">
        <div className="relative -mx-4 md:mx-0">
          <div className="overflow-x-auto px-4 md:px-0">
            <TabsList className="rounded-none w-max min-w-full md:w-auto">
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
            <TabsTrigger value="settings" className="rounded-none gap-1.5 whitespace-nowrap">
              <Settings className="w-4 h-4" /> Реквизиты
            </TabsTrigger>
            <TabsTrigger value="support" className="rounded-none gap-1.5 whitespace-nowrap">
              <MessageCircle className="w-4 h-4" /> Поддержка
              <Badge count={openTickets} />
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
        <TabsContent value="settings" className="pt-4">
          <PaymentSettingsForm />
        </TabsContent>
        <TabsContent value="support" className="pt-4">
          <SupportManagement />
        </TabsContent>
      </Tabs>
    </div>
  );
}
