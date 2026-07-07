import { useState } from "react";
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
import type { Plan, VpnNode, SupportTicket, TicketStatus } from "@workspace/api-client-react";
import { queryClient } from "@/lib/query-client";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, X, Trash2, Pencil, Plus, Users, CreditCard, Shield, Settings, Key, Copy, MessageCircle, Send, ArrowLeft, Bell } from "lucide-react";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
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
  const { data: payments, isLoading } = useListAdminPayments({ status: "pending" });
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
          const isSlot = data?.type === "extra_device_slot";
          toast({ title: "Платёж подтверждён", description: isSlot ? "Устройство добавлено пользователю." : "Подписка активирована." });
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
  if (!payments || payments.length === 0)
    return <p className="text-muted-foreground">Нет платежей, ожидающих подтверждения.</p>;

  return (
    <div className="space-y-3">
      {payments.map((payment) => (
        <div key={payment.id} className="bg-card border border-border p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="font-bold">
                {payment.userEmail} · {payment.type === "extra_device_slot" ? "Доп. устройство" : (payment.planName ?? "—")}
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                {payment.amountRub} ₽ · {payment.reference} · {formatDate(payment.createdAt)}
              </div>
              {payment.userNote && (
                <div className="text-sm mt-1 italic text-muted-foreground">«{payment.userNote}»</div>
              )}
            </div>
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
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);

  function handleSubmit() {
    const body = {
      name,
      description,
      priceRub: Number(priceRub),
      durationDays: Number(durationDays),
      devicesIncluded: devicesIncluded ? Number(devicesIncluded) : 1,
      isActive,
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
        <Input
          type="number"
          placeholder="Устройств включено"
          min={1}
          value={devicesIncluded}
          onChange={(e) => setDevicesIncluded(e.target.value.replace(/[^0-9]/g, ""))}
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
          disabled={creating || updating || !name || !priceRub || !durationDays}
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

  return (
    <div className="space-y-3">
      {plans?.map((plan) =>
        editingId === plan.id ? (
          <PlanForm key={plan.id} plan={plan} onDone={() => setEditingId(null)} />
        ) : (
          <div key={plan.id} className="bg-card border border-border p-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0 break-words">
              <div className="font-bold">
                {plan.name} {!plan.isActive && <span className="text-muted-foreground font-normal">(неактивен)</span>}
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                {plan.priceRub} ₽ · {plan.durationDays} дней · {plan.devicesIncluded} уст.
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

  return (
    <div className="space-y-3">
      {nodes?.map((node) =>
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

function UsersManagement() {
  const { data: users, isLoading } = useListAdminUsers();
  const { mutate: updateRole } = useUpdateUserRole();
  const { mutate: updateExtraSlots } = useUpdateUserExtraSlots();
  const { mutate: resetPassword, isPending: resettingPassword } = useAdminResetUserPassword();
  const { toast } = useToast();
  const [resetLinks, setResetLinks] = useState<Record<number, string>>({});

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
          toast({ title: `Дополнительных слотов: ${next}` });
        },
        onError: () => toast({ title: "Ошибка изменения слотов", variant: "destructive" }),
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

  if (isLoading) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-3">
      {users?.map((user) => (
        <div key={user.id} className="bg-card border border-border p-4 space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0 break-words">
              <div className="font-bold break-all">{user.email}</div>
              <div className="text-sm text-muted-foreground font-mono">
                {user.role === "admin" ? "Администратор" : "Пользователь"} · с {formatDate(user.createdAt)}
              </div>
            </div>
            <div className="flex gap-2 flex-wrap shrink-0">
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
            </div>
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
        </div>
      ))}
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
  const [trialEnabled, setTrialEnabled] = useState(false);
  const [trialDays, setTrialDays] = useState("5");
  const [initialized, setInitialized] = useState(false);

  if (settings && !initialized) {
    setSbpPhone(settings.sbpPhone);
    setSbpBank(settings.sbpBank);
    setSbpRecipientName(settings.sbpRecipientName);
    setInstructions(settings.instructions ?? "");
    setExtraDeviceSlotPriceRub(String(settings.extraDeviceSlotPriceRub ?? 0));
    setTrialEnabled(settings.trialEnabled ?? false);
    setTrialDays(String(settings.trialDays ?? 5));
    setInitialized(true);
  }

  function handleSubmit() {
    update(
      { data: { sbpPhone, sbpBank, sbpRecipientName, instructions, extraDeviceSlotPriceRub: Number(extraDeviceSlotPriceRub) || 0, trialEnabled, trialDays: Number(trialDays) || 5 } },
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
}

function VpnKeysManagement() {
  const { toast } = useToast();
  const [issuingUserId, setIssuingUserId] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");

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
      refetch();
    },
    onError: () => toast({ title: "Ошибка выдачи ключа", variant: "destructive" }),
  });

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

  const filtered = (keys ?? []).filter(
    (k) =>
      !filter ||
      k.userEmail.toLowerCase().includes(filter.toLowerCase()) ||
      k.label.toLowerCase().includes(filter.toLowerCase()),
  );

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
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={issuingUserId ?? ""}
            onChange={(e) => setIssuingUserId(Number(e.target.value) || null)}
            className="border border-border bg-background px-3 py-2 text-sm rounded-none min-w-48"
          >
            <option value="">— Выберите пользователя —</option>
            {users?.map((u) => (
              <option key={u.id} value={u.id}>{u.email}</option>
            ))}
          </select>
          <button
            onClick={() => issuingUserId && issueMutation.mutate(issuingUserId)}
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
      { ticketId, body },
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
      { ticketId, status: "closed" },
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
  const { data: tickets, isLoading } = useListAdminTickets(
    filterStatus !== "all" ? { status: filterStatus } : undefined,
  );

  if (selectedId !== null) {
    return <TicketDetail ticketId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="space-y-4">
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

      {isLoading ? (
        <div className="space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : !tickets?.length ? (
        <div className="bg-muted/50 border border-border p-10 text-center text-sm text-muted-foreground">
          <MessageCircle className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
          Тикетов нет
        </div>
      ) : (
        <div className="divide-y divide-border border border-border">
          {tickets.map((t: SupportTicket) => (
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
        <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
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
