import { useState } from "react";
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
  useAdminResetUserPassword,
  useGetPaymentSettings,
  useUpdatePaymentSettings,
  getGetAdminDashboardSummaryQueryKey,
  getListAdminPaymentsQueryKey,
  getListPlansQueryKey,
  getListVpnNodesQueryKey,
  getListAdminUsersQueryKey,
  getGetPaymentSettingsQueryKey,
} from "@workspace/api-client-react";
import type { Plan, VpnNode } from "@workspace/api-client-react";
import { queryClient } from "@/lib/query-client";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, X, Trash2, Pencil, Plus, Users, CreditCard, Shield, Settings } from "lucide-react";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-card border border-border p-5">
      <div className="text-xs font-mono text-muted-foreground uppercase mb-1">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function SummarySection() {
  const { data, isLoading } = useGetAdminDashboardSummary();
  if (isLoading || !data) {
    return (
      <div className="grid md:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid md:grid-cols-5 gap-4">
      <Metric label="Пользователи" value={data.totalUsers} />
      <Metric label="Активные подписки" value={data.activeSubscriptions} />
      <Metric label="Ожидают оплаты" value={data.pendingPayments} />
      <Metric label="Доход за месяц" value={`${data.monthlyRevenueRub} ₽`} />
      <Metric label="Выпущено ключей" value={data.totalVpnKeys} />
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
        onSuccess: () => {
          invalidate();
          toast({ title: "Платёж подтверждён", description: "Подписка активирована." });
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
                {payment.userEmail} · {payment.planName}
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
            <div className="mt-4 flex gap-2">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Причина отклонения"
                className="rounded-none"
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
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);

  function handleSubmit() {
    const body = {
      name,
      description,
      priceRub: Number(priceRub),
      durationDays: Number(durationDays),
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
          <div key={plan.id} className="bg-card border border-border p-4 flex items-center justify-between gap-4">
            <div>
              <div className="font-bold">
                {plan.name} {!plan.isActive && <span className="text-muted-foreground font-normal">(неактивен)</span>}
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                {plan.priceRub} ₽ · {plan.durationDays} дней
              </div>
            </div>
            <div className="flex gap-2">
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
          <div key={node.id} className="bg-card border border-border p-4 flex items-center justify-between gap-4">
            <div>
              <div className="font-bold">
                {node.name} <span className="text-muted-foreground font-normal">· {node.region}</span>
                {!node.isActive && <span className="text-muted-foreground font-normal"> (неактивен)</span>}
              </div>
              <div className="text-sm text-muted-foreground font-mono">
                {node.host ?? "—"}:{node.port ?? 443} · SNI: {node.sni}
              </div>
            </div>
            <div className="flex gap-2">
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
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-bold">{user.email}</div>
              <div className="text-sm text-muted-foreground font-mono">
                {user.role === "admin" ? "Администратор" : "Пользователь"} · с {formatDate(user.createdAt)}
              </div>
            </div>
            <div className="flex gap-2">
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
  const [initialized, setInitialized] = useState(false);

  if (settings && !initialized) {
    setSbpPhone(settings.sbpPhone);
    setSbpBank(settings.sbpBank);
    setSbpRecipientName(settings.sbpRecipientName);
    setInstructions(settings.instructions ?? "");
    setInitialized(true);
  }

  function handleSubmit() {
    update(
      { data: { sbpPhone, sbpBank, sbpRecipientName, instructions } },
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

export default function Admin() {
  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Панель администратора</h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">Управление сервисом Vibe Proxy Nexus.</p>
      </div>

      <SummarySection />

      <Tabs defaultValue="payments">
        <TabsList className="rounded-none">
          <TabsTrigger value="payments" className="rounded-none gap-1.5">
            <CreditCard className="w-4 h-4" /> Платежи
          </TabsTrigger>
          <TabsTrigger value="plans" className="rounded-none gap-1.5">
            <Shield className="w-4 h-4" /> Тарифы
          </TabsTrigger>
          <TabsTrigger value="nodes" className="rounded-none gap-1.5">
            <Settings className="w-4 h-4" /> Узлы
          </TabsTrigger>
          <TabsTrigger value="users" className="rounded-none gap-1.5">
            <Users className="w-4 h-4" /> Пользователи
          </TabsTrigger>
          <TabsTrigger value="settings" className="rounded-none gap-1.5">
            <Settings className="w-4 h-4" /> Реквизиты
          </TabsTrigger>
        </TabsList>
        <TabsContent value="payments" className="pt-4">
          <PaymentsQueue />
        </TabsContent>
        <TabsContent value="plans" className="pt-4">
          <PlansManagement />
        </TabsContent>
        <TabsContent value="nodes" className="pt-4">
          <NodesManagement />
        </TabsContent>
        <TabsContent value="users" className="pt-4">
          <UsersManagement />
        </TabsContent>
        <TabsContent value="settings" className="pt-4">
          <PaymentSettingsForm />
        </TabsContent>
      </Tabs>
    </div>
  );
}
