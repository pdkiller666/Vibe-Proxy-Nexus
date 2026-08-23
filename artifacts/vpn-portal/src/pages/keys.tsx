import { useState, useEffect, type ReactNode } from "react";
import {
  useGetMe,
  useListMyVpnKeys,
  useListAdminVpnKeys,
  useListVpnNodes,
  useCreateVpnKey,
  useRevokeVpnKey,
  useUpdateVpnKey,
  useRelocateVpnKey,
  useGetSubscriptionUrl,
  useGetPaymentSettings,
  useCreateExtraSlotOrder,
} from "@workspace/api-client-react";

type Platform = "android" | "ios" | "windows";

function getInitialPlatform(): Platform {
  try {
    const stored = localStorage.getItem("vpn-platform");
    if (stored === "android" || stored === "ios" || stored === "windows") return stored;
  } catch {
    // localStorage unavailable in some contexts
  }
  return "android";
}
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/query-client";
import {
  getListAdminVpnKeysQueryKey,
  getListMyVpnKeysQueryKey,
  getGetMeQueryKey,
} from "@workspace/api-client-react";
import { Copy, Trash2, Plus, KeyRound, RefreshCw, ChevronDown, Check, QrCode, X, ExternalLink, Zap, Pencil, Route, AlertTriangle } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";
import QRCode from "qrcode";

type NodeOption = {
  id: number;
  name: string;
  flagEmoji?: string | null;
  activeUserCount?: number;
  maxUsers?: number | null;
};

function EditKeyForm({
  keyId,
  initialLabel,
  initialDescription,
  currentNodeId,
  nodes,
  onClose,
}: {
  keyId: number;
  initialLabel: string;
  initialDescription: string;
  /** nodeId of the node this key currently lives on */
  currentNodeId: number;
  /** All active nodes the user can relocate to (pass [] to hide node picker) */
  nodes: NodeOption[];
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [description, setDescription] = useState(initialDescription);
  const [selectedNodeId, setSelectedNodeId] = useState(currentNodeId);
  const { mutate: updateKey, isPending: updatingKey } = useUpdateVpnKey();
  const { mutate: relocateKey, isPending: relocating } = useRelocateVpnKey();
  const { toast } = useToast();

  const isPending = updatingKey || relocating;
  const nodeChanged = selectedNodeId !== currentNodeId;

  function handleSave() {
    const trimmed = label.trim();
    if (!trimmed) return;

    if (nodeChanged) {
      // Relocate: issue a new key on the selected node, revoke the old one.
      // A fresh UUID is generated per click so Amvera proxy retries are
      // idempotent and never produce a duplicate key on the target node.
      relocateKey(
        { keyId, data: { nodeId: selectedNodeId, idempotencyKey: crypto.randomUUID() } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
            queryClient.invalidateQueries({ queryKey: getListAdminVpnKeysQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
            toast({ title: "Ключ перемещён", description: "Новый ключ выпущен на выбранном сервере." });
            onClose();
          },
          onError: (err: unknown) => {
            // ApiError carries .status; show a friendly message for node-side failures
            const apiError = err as {
              status?: number;
              data?: { error?: unknown } | null;
            };
            const status = apiError?.status;
            const serverMessage =
              typeof apiError?.data?.error === "string" ? apiError.data.error : undefined;
            if (status === 502 || status === 503 || status === 504) {
              toast({
                title: "Сервер недоступен",
                description: "Попробуйте другой сервер или повторите позже.",
                variant: "destructive",
              });
              return;
            }
            const msg =
              serverMessage === "Selected VPN node has reached its user capacity"
                ? "Выбранный сервер переполнен. Попробуйте другой сервер."
                : serverMessage === "No available VPN node found"
                  ? "Сейчас нет доступного сервера. Попробуйте позже."
                  : serverMessage ??
                    (err instanceof Error ? err.message : "Не удалось переместить ключ");
            toast({ title: "Не удалось переместить ключ", description: msg, variant: "destructive" });
          },
        },
      );
    } else {
      updateKey(
        { keyId, data: { label: trimmed, description: description.trim() } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
            queryClient.invalidateQueries({ queryKey: getListAdminVpnKeysQueryKey() });
            toast({ title: "Название обновлено" });
            onClose();
          },
          onError: (err: unknown) => {
            const msg = err instanceof Error ? err.message : undefined;
            toast({ title: msg ?? "Не удалось обновить название", variant: "destructive" });
          },
        },
      );
    }
  }

  const showNodePicker = nodes.length > 1;

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-3">
      {/* Label */}
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Название устройства"
        className="rounded-none"
        autoFocus={!showNodePicker}
        disabled={nodeChanged}
      />
      {/* Description */}
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Описание (необязательно)"
        className="rounded-none"
        disabled={nodeChanged}
      />

      {/* Node picker — only visible when there are multiple active nodes */}
      {showNodePicker && (
        <div className="space-y-1.5">
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
            Сервер
          </p>
          <div className="grid gap-1.5">
            {nodes.map((node) => {
              const isCurrent = node.id === currentNodeId;
              const isFull =
                !isCurrent &&
                node.maxUsers != null &&
                (node.activeUserCount ?? 0) >= node.maxUsers;
              const isSelected = selectedNodeId === node.id;
              return (
                <button
                  key={node.id}
                  type="button"
                  disabled={isFull}
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`w-full text-left px-3 py-2 text-sm border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    isSelected
                      ? "border-primary bg-primary/5 font-semibold"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <span className="font-mono">{node.flagEmoji ?? "🌐"}</span>{" "}
                  <span>{node.name}</span>
                  {isCurrent && (
                    <span className="text-xs text-muted-foreground ml-1">(текущий)</span>
                  )}
                  {isFull && (
                    <span className="text-xs text-muted-foreground ml-1">(заполнен)</span>
                  )}
                </button>
              );
            })}
          </div>
          {nodeChanged && (
            <p className="text-xs text-amber-600">
              Старый ключ будет отозван, новый выпущен на «{nodes.find((n) => n.id === selectedNodeId)?.name}».
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={isPending || (!label.trim() && !nodeChanged)}
          className="bg-primary text-primary-foreground font-bold px-4 py-1.5 text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {relocating
            ? "Перемещаем..."
            : updatingKey
              ? "Сохраняем..."
              : nodeChanged
                ? "Переместить на этот сервер"
                : "Сохранить"}
        </button>
        <button
          onClick={onClose}
          className="border border-border px-4 py-1.5 text-sm hover:bg-muted transition-colors"
        >
          Отмена
        </button>
      </div>
    </div>
  );
}

function CopyButton({ text, showLabel = false }: { text: string; showLabel?: boolean }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ title: "Скопировано" });
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      className={`shrink-0 inline-flex items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors ${
        showLabel ? "text-xs font-semibold" : ""
      }`}
      title="Копировать"
    >
      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
      {showLabel && (copied ? "Скопировано" : "Скопировать")}
    </button>
  );
}

// Keep the connection guide compact on mobile, just like the referral section
// on the dashboard. Content stays mounted so copying links and QR actions keep
// their state when a section is opened again.
function CollapsibleConnectionStep({
  id,
  icon,
  title,
  summary,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => (
    typeof window !== "undefined" ? window.innerWidth >= 768 : true
  ));

  return (
    <section className="bg-card border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={id}
        className="w-full flex items-center justify-between gap-4 p-5 border-b border-border text-left hover:bg-muted/30 transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-bold">
            {icon}
            <span>{title}</span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{summary}</p>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <div id={id} className={open ? "block p-5" : "hidden"}>
        {children}
      </div>
    </section>
  );
}

function AddDeviceModal({
  onClose,
  onSubmit,
  submitting,
  nodes,
}: {
  onClose: () => void;
  onSubmit: (label: string, description: string, nodeId: number | undefined) => void;
  submitting: boolean;
  nodes: Array<{ id: number; name: string; flagEmoji?: string | null; activeUserCount?: number; maxUsers?: number | null }>;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<number | "auto">("auto");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white p-6 max-w-sm w-full mx-4 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-base">Новое устройство</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть окно добавления устройства"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
              Название устройства
            </label>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Например: iPhone Ани"
              className="w-full border border-border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          {nodes.length > 1 && (
            <div className="space-y-1">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
                Сервер
              </label>
              <div className="grid gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedNodeId("auto")}
                  className={`w-full text-left px-3 py-2 text-sm border transition-colors ${
                    selectedNodeId === "auto"
                      ? "border-primary bg-primary/5 font-semibold"
                      : "border-border hover:bg-muted/50"
                  }`}
                >
                  <span className="font-mono">🌐</span>{" "}
                  <span>Автоматически</span>
                  <span className="text-xs text-muted-foreground ml-1">(наименее загруженный)</span>
                </button>
                {nodes.map((node) => {
                  const isFull = node.maxUsers != null && (node.activeUserCount ?? 0) >= node.maxUsers;
                  return (
                    <button
                      key={node.id}
                      type="button"
                      disabled={isFull}
                      onClick={() => setSelectedNodeId(node.id)}
                      className={`w-full text-left px-3 py-2 text-sm border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        selectedNodeId === node.id
                          ? "border-primary bg-primary/5 font-semibold"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <span className="font-mono">{node.flagEmoji ?? "🌐"}</span>{" "}
                      <span>{node.name}</span>
                      {isFull && <span className="text-xs text-muted-foreground ml-1">(заполнен)</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-mono text-muted-foreground uppercase tracking-wide">
              Описание (необязательно)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Заметка для себя"
              rows={2}
              className="w-full border border-border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
          </div>
        </div>
        <button
          onClick={() => onSubmit(
            label.trim(),
            description.trim(),
            selectedNodeId === "auto" ? undefined : selectedNodeId,
          )}
          disabled={submitting}
          className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground font-bold px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {submitting ? "Подключаем..." : "Подключить устройство"}
        </button>
      </div>
    </div>
  );
}

function QRModal({ url, onClose }: { url: string; onClose: () => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: "#000000", light: "#ffffff" } })
      .then(setDataUrl)
      .catch(console.error);
  }, [url]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-white p-6 max-w-sm w-full mx-4 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-base">QR-код для подключения</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть QR-код"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          Отсканируйте этот код в приложении через «Добавить подписку».
        </p>
        <div className="flex justify-center">
          {dataUrl ? (
            <img src={dataUrl} alt="QR-код подписки" className="w-64 h-64" />
          ) : (
            <div className="w-64 h-64 bg-muted animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
}

const revokedReasonLabel: Record<string, string> = {
  user: "отозван пользователем",
  admin: "отозван администратором",
  expired: "истёк срок подписки",
  billing: "закончился баланс",
  traffic_limit: "исчерпан лимит трафика",
};

// App download links are now admin-configurable via payment settings.
// Fallback URLs are used while paymentSettings is loading.
const FALLBACK_LINKS = {
  happAndroid: "https://play.google.com/store/apps/details?id=com.happproxy.v2ray",
  happIos: "https://apps.apple.com/app/happ-proxy-utility/id6504287215",
  v2rayng: "https://play.google.com/store/apps/details?id=com.v2ray.ang",
  v2rayn: "https://github.com/2dust/v2rayN/releases/latest",
};

function formatDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export default function Keys() {
  const { data: me } = useGetMe();
  const isAdmin = me?.role === "admin";
  const { data: myKeys, isLoading: isLoadingMyKeys } = useListMyVpnKeys({
    query: { queryKey: getListMyVpnKeysQueryKey(), enabled: !isAdmin },
  });
  const { data: adminKeys, isLoading: isLoadingAdminKeys } = useListAdminVpnKeys(undefined, {
    query: { queryKey: getListAdminVpnKeysQueryKey(), enabled: isAdmin },
  });
  const keys = isAdmin ? adminKeys : myKeys;
  const isLoading = isAdmin ? isLoadingAdminKeys : isLoadingMyKeys;
  const { data: nodes } = useListVpnNodes();
  const { data: subscription } = useGetSubscriptionUrl();
  const { data: paymentSettings } = useGetPaymentSettings();
  const { mutate: createKey, isPending: creating } = useCreateVpnKey();
  const { mutate: createSlotOrder, isPending: orderingSlot } = useCreateExtraSlotOrder();
  const { mutate: revokeKey } = useRevokeVpnKey();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [showQR, setShowQR] = useState(false);
  const [xrayQRUrl, setXrayQRUrl] = useState<string | null>(null);
  const [showRoutingQR, setShowRoutingQR] = useState(false);
  const [showAddDeviceModal, setShowAddDeviceModal] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null);
  const [platform, setPlatform] = useState<Platform>(getInitialPlatform);
  const [adminKeySearch, setAdminKeySearch] = useState("");
  const [adminKeyStatus, setAdminKeyStatus] = useState<"all" | "active" | "revoked">("all");

  function switchPlatform(p: Platform) {
    setPlatform(p);
    try { localStorage.setItem("vpn-platform", p); } catch { /* ignore */ }
  }

  const activeKeys = (keys ?? []).filter((k: { revokedAt?: string | null }) => !k.revokedAt);
  const visibleKeys = (keys ?? []).filter((k: { revokedAt?: string | null }) => isAdmin || !k.revokedAt);
  const filteredVisibleKeys = visibleKeys.filter((key) => {
    if (isAdmin && adminKeyStatus === "active" && key.revokedAt) return false;
    if (isAdmin && adminKeyStatus === "revoked" && !key.revokedAt) return false;
    if (isAdmin && adminKeySearch.trim()) {
      const query = adminKeySearch.trim().toLowerCase();
      return [key.label, key.nodeName, key.userEmail]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(query));
    }
    return true;
  });
  const canIssue = !!me?.hasActiveSubscription;
  const expiredSubscription =
    me?.subscriptionState === "expired" &&
    me.expiredSubscription?.billingType !== "hourly"
      ? me.expiredSubscription
      : null;
  const hourlyBalanceExhausted =
    !me?.hasActiveSubscription &&
    me?.subscriptionState === "expired" &&
    (me.expiredSubscription?.billingType === "hourly" || me.currentPlanBillingType === "hourly");
  const activeNodes = (nodes ?? []).filter((n: { isActive: boolean }) => n.isActive);

  const deviceSlots = me?.deviceSlots ?? 1;
  const activeKeyCount = me?.activeKeyCount ?? activeKeys.length;
  const hasSlotAvailable = canIssue && activeKeyCount < deviceSlots;
  const slotPrice = paymentSettings?.extraDeviceSlotPriceRub ?? 0;
  const allowFreeSlot = paymentSettings?.allowFreeExtraDeviceSlot ?? false;
  const slotButtonDisabled = slotPrice <= 0 && !allowFreeSlot;

  function handleAddSlot() {
    createSlotOrder(undefined, {
      onSuccess: (data) => {
        if (data.freeGranted) {
          queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListAdminVpnKeysQueryKey() });
          setShowAddDeviceModal(true);
          toast({ title: "Дополнительное место добавлено" });
          return;
        }
        setLocation(`/checkout/slot/${data.paymentId}`);
      },
      onError: (err: unknown) => {
        const body = err as { paymentId?: number; message?: string };
        if (body?.paymentId) {
          setLocation(`/checkout/slot/${body.paymentId}`);
          return;
        }
        toast({
          title: err instanceof Error ? err.message : "Не удалось создать заявку",
          variant: "destructive",
        });
      },
    });
  }

  function handleCreate(label: string, description: string, nodeId: number | undefined) {
    createKey(
      {
        data: {
          nodeId,
          label: label || undefined,
          description: description || undefined,
          // UUID-per-click: if Amvera's proxy retries this POST, the server
          // returns the already-issued key instead of creating a duplicate.
          idempotencyKey:
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
            queryClient.invalidateQueries({ queryKey: getListAdminVpnKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          setShowAddDeviceModal(false);
          toast({ title: "Устройство подключено", description: "Добавьте ссылку для подключения в приложение ниже." });
        },
        onError: (err: unknown) => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          const msg = err instanceof Error ? err.message : undefined;
          toast({ title: msg ?? "Не удалось подключить устройство", variant: "destructive" });
        },
      },
    );
  }

  function handleRevoke(keyId: number) {
    setRevokingId(keyId);
    if (isAdmin) {
      void (async () => {
        try {
          const response = await fetch(`/api/admin/vpn-keys/${keyId}`, {
            method: "DELETE",
            credentials: "include",
          });
          if (!response.ok) throw new Error("Failed to revoke VPN key");
          queryClient.invalidateQueries({ queryKey: getListAdminVpnKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          toast({ title: "Ключ отозван" });
        } catch {
          toast({ title: "Не удалось отозвать ключ", variant: "destructive" });
        } finally {
          setRevokingId(null);
        }
      })();
      return;
    }
    revokeKey(
      { keyId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          toast({ title: "Ключ отозван" });
          setRevokingId(null);
        },
        onError: () => {
          toast({ title: "Не удалось отозвать ключ", variant: "destructive" });
          setRevokingId(null);
        },
      },
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {showQR && subscription?.url && (
        <QRModal url={subscription.url} onClose={() => setShowQR(false)} />
      )}
      {xrayQRUrl && (
        <QRModal url={xrayQRUrl} onClose={() => setXrayQRUrl(null)} />
      )}
      {showRoutingQR && paymentSettings?.happIosRoutingUrl && (
        <QRModal url={paymentSettings.happIosRoutingUrl} onClose={() => setShowRoutingQR(false)} />
      )}

      {showAddDeviceModal && (
        <AddDeviceModal
          onClose={() => setShowAddDeviceModal(false)}
          onSubmit={handleCreate}
          submitting={creating}
          nodes={activeNodes}
        />
      )}

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Подключение VPN</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Установите приложение, добавьте ссылку и включите VPN.
          </p>
        </div>
      </div>

      {me?.hasActiveSubscription ? (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border border-border border-l-4 border-l-primary bg-card px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" aria-hidden="true" />
            <span className="text-sm font-semibold shrink-0">Доступ активен</span>
            <span className="text-sm text-muted-foreground truncate">
              {me.currentPlanBillingType === "hourly"
                ? "Почасовой доступ · списание с баланса"
                : me.subscriptionEndsAt
                  ? `до ${formatDate(me.subscriptionEndsAt as string)}`
                  : "можно подключить VPN"}
            </span>
          </div>
          {activeKeys.length === 0 && hasSlotAvailable ? (
            <button
              type="button"
              onClick={() => setShowAddDeviceModal(true)}
              disabled={creating}
              className="shrink-0 bg-primary text-primary-foreground font-bold px-4 py-2 text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              Подключить это устройство
            </button>
          ) : null}
        </div>
      ) : (
        <div className="bg-card border border-border p-5 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1">
            <p className="font-bold">
              {hourlyBalanceExhausted
                ? "Недостаточно средств на балансе"
                : expiredSubscription
                  ? "Подписка закончилась"
                  : "Сначала выберите тариф"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {hourlyBalanceExhausted
                ? "Пополните баланс, чтобы почасовой доступ к VPN снова заработал."
                : expiredSubscription
                  ? "Выберите тариф, чтобы снова подключить VPN."
                  : "После оплаты вы сможете подключить VPN на своих устройствах."}
            </p>
          </div>
          <a
            href={hourlyBalanceExhausted ? "/payments" : "/plans"}
            className="shrink-0 bg-primary text-primary-foreground font-bold px-5 py-2.5 text-sm text-center hover:opacity-90 transition-opacity"
          >
            {hourlyBalanceExhausted
              ? "Пополнить баланс"
              : expiredSubscription
                ? "Возобновить подписку"
                : "Выбрать тариф"}
          </a>
        </div>
      )}

      {/* ── Platform tab switcher ──────────────────────────────────────────── */}
      <div id="connection-start" className="scroll-mt-4 flex items-center gap-1 bg-muted/50 border border-border p-1 w-fit">
        <button
          onClick={() => switchPlatform("android")}
          className={`px-4 py-1.5 text-sm font-semibold transition-colors ${
            platform === "android"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Android
        </button>
        <button
          onClick={() => switchPlatform("ios")}
          className={`px-4 py-1.5 text-sm font-semibold transition-colors ${
            platform === "ios"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          iPhone
        </button>
        <button
          onClick={() => switchPlatform("windows")}
          className={`px-4 py-1.5 text-sm font-semibold transition-colors ${
            platform === "windows"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Windows
        </button>
      </div>

      {/* ── Android tab ───────────────────────────────────────────────────── */}
      {platform === "android" && (
        <>
          <CollapsibleConnectionStep
            id="connection-android-install"
            icon={<ExternalLink className="w-4 h-4 text-primary" />}
            title="1. Установите приложение"
            summary="Выберите приложение для своего телефона."
          >
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                После установки вы добавите в него ссылку для подключения.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={paymentSettings?.appDownloadLinks?.happAndroid ?? FALLBACK_LINKS.happAndroid}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors"
                >
                  Скачать Happ
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <a
                  href={paymentSettings?.appDownloadLinks?.v2rayng ?? FALLBACK_LINKS.v2rayng}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors"
                >
                  Скачать v2rayNG
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </CollapsibleConnectionStep>

          <OnboardingTip
            id="keys-intro-android"
            icon={<Zap className="w-4 h-4" />}
            title="Быстрый старт — Android"
          >
            <p>
              <strong>2.</strong> Скопируйте ссылку ниже → в приложении нажмите <strong>«Добавить подписку»</strong> → вставьте ссылку.
            </p>
            <p>
              <strong>3.</strong> Включите VPN в приложении. Дополнительные настройки находятся ниже.
            </p>
          </OnboardingTip>

          {/* Subscription URL — Android */}
          {canIssue && subscription?.url && activeKeys.length > 0 && (
            <CollapsibleConnectionStep
              id="connection-android-link"
              icon={<RefreshCw className="w-4 h-4 text-primary" />}
              title="2. Добавьте ссылку для подключения"
              summary="Приложение будет само получать актуальные настройки VPN."
            >
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Добавьте ссылку один раз. Подходит для <strong>Happ</strong> и <strong>v2rayNG</strong>.
                </p>
                <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                  <span className="truncate flex-1">{subscription.url}</span>
                  <button
                    type="button"
                    onClick={() => setShowQR(true)}
                    className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                    title="QR-код"
                    aria-label="Показать QR-код ссылки для подключения"
                  >
                    <QrCode className="w-4 h-4" />
                  </button>
                  <CopyButton text={subscription.url} showLabel />
                </div>
                <p className="text-xs text-muted-foreground">
                  В приложении нажмите <strong>«+»</strong> → <strong>«Добавить подписку»</strong> → вставьте ссылку.
                  Или отсканируйте QR-код <QrCode className="inline w-3 h-3 mx-0.5" /> прямо с экрана.
                </p>
              </div>
            </CollapsibleConnectionStep>
          )}

          {/* Xray config with Russian bypass — Android / Windows */}
          {canIssue && subscription?.url && activeKeys.length > 0 && (
            <CollapsibleConnectionStep
              id="connection-android-routing"
              icon={<Route className="w-4 h-4 text-green-500" />}
              title="Дополнительный режим: обход российских сайтов"
              summary="Российские сервисы идут напрямую, всё остальное — через VPN."
            >
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Этот режим нужен только если вам требуется обход российских сайтов.
                </p>

                <div className="flex gap-3 border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-3 text-sm">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-amber-800 dark:text-amber-300">
                    <p className="font-semibold">Перед добавлением в Happ</p>
                    <p className="text-amber-700 dark:text-amber-400 text-xs">
                      В настройках Happ убедитесь: ядро — <strong>Xray core</strong>, тумблер <strong>«Маршрутизация» (Routing) — ВЫКЛЮЧЕН</strong>.
                      Иначе встроенная маршрутизация Happ перекроет правила конфига.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  {activeKeys.map((key) => {
                    const xrayUrl = `${subscription.url}?format=xray&key=${key.id}`;
                    return (
                      <div key={key.id} className="space-y-1">
                        <p className="text-xs font-semibold text-muted-foreground">{key.label}</p>
                        <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                          <span className="truncate flex-1">{xrayUrl}</span>
                          <button
                            type="button"
                            onClick={() => setXrayQRUrl(xrayUrl)}
                            className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                            title="QR-код"
                            aria-label={`Показать QR-код устройства ${key.label}`}
                          >
                            <QrCode className="w-4 h-4" />
                          </button>
                          <CopyButton text={xrayUrl} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="text-xs text-muted-foreground space-y-2 border-t border-border pt-3">
                  <p>
                    <strong className="text-foreground">Happ Android:</strong>{" "}
                    скопируйте ссылку своего устройства (или отсканируйте QR) →
                    в Happ нажмите <strong>«+»</strong> → <strong>«Добавить подписку»</strong>.
                  </p>
                  <p className="text-muted-foreground/60">
                    При смене сервера ссылка не меняется — конфиг обновится автоматически при следующем обновлении подписки.
                  </p>
                </div>
              </div>
            </CollapsibleConnectionStep>
          )}
        </>
      )}

      {/* ── Windows tab ───────────────────────────────────────────────────── */}
      {platform === "windows" && (
        <>
          <CollapsibleConnectionStep
            id="connection-windows-install"
            icon={<ExternalLink className="w-4 h-4 text-primary" />}
            title="1. Установите приложение"
            summary="Установите v2rayN на компьютер."
          >
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Затем добавьте в него ссылку для подключения.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={paymentSettings?.appDownloadLinks?.v2rayn ?? FALLBACK_LINKS.v2rayn}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors"
                >
                  Скачать v2rayN
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </CollapsibleConnectionStep>

          <OnboardingTip
            id="keys-intro-windows"
            icon={<Zap className="w-4 h-4" />}
            title="Быстрый старт — Windows"
          >
            <p>
              <strong>2.</strong> Скопируйте ссылку ниже → откройте в v2rayN раздел <strong>«Подписки»</strong> → добавьте новую подписку.
            </p>
            <p>
              <strong>3.</strong> Обновите список профилей и включите VPN в v2rayN.
            </p>
          </OnboardingTip>

          {canIssue && subscription?.url && activeKeys.length > 0 && (
            <CollapsibleConnectionStep
              id="connection-windows-link"
              icon={<RefreshCw className="w-4 h-4 text-primary" />}
              title="2. Добавьте ссылку для подключения"
              summary="v2rayN будет автоматически получать актуальные настройки VPN."
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                  <span className="truncate flex-1">{subscription.url}</span>
                  <button
                    type="button"
                    onClick={() => setShowQR(true)}
                    className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                    title="Показать QR-код"
                    aria-label="Показать QR-код ссылки для подключения"
                  >
                    <QrCode className="w-4 h-4" />
                  </button>
                  <CopyButton text={subscription.url} showLabel />
                </div>
                <p className="text-xs text-muted-foreground">
                  В v2rayN: <strong>«Подписки»</strong> → <strong>«Настройки подписок»</strong> → добавить новую → вставить ссылку.
                </p>
              </div>
            </CollapsibleConnectionStep>
          )}

          {canIssue && subscription?.url && activeKeys.length > 0 && (
            <CollapsibleConnectionStep
              id="connection-windows-routing"
              icon={<Route className="w-4 h-4 text-green-500" />}
              title="Дополнительный режим: обход российских сайтов"
              summary="Российские сервисы работают напрямую, всё остальное — через VPN."
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  {activeKeys.map((key) => {
                    const xrayUrl = `${subscription.url}?format=xray&key=${key.id}`;
                    return (
                      <div key={key.id} className="space-y-1">
                        <p className="text-xs font-semibold text-muted-foreground">{key.label}</p>
                        <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                          <span className="truncate flex-1">{xrayUrl}</span>
                          <button
                          type="button"
                            onClick={() => setXrayQRUrl(xrayUrl)}
                            className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                            title="Показать QR-код"
                          aria-label={`Показать QR-код устройства ${key.label}`}
                          >
                            <QrCode className="w-4 h-4" />
                          </button>
                          <CopyButton text={xrayUrl} showLabel />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground border-t border-border pt-3">
                  В v2rayN: <strong>«Подписки»</strong> → <strong>«Настройки подписок»</strong> → добавить новую → вставить ссылку для нужного устройства.
                </p>
              </div>
            </CollapsibleConnectionStep>
          )}
        </>
      )}

      {/* ── iOS tab ───────────────────────────────────────────────────────── */}
      {platform === "ios" && (
        <>
          <CollapsibleConnectionStep
            id="connection-ios-install"
            icon={<ExternalLink className="w-4 h-4 text-primary" />}
            title="1. Установите приложение"
            summary="Установите Happ из App Store."
          >
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Затем добавьте в него ссылку для подключения.
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={paymentSettings?.appDownloadLinks?.happIos ?? FALLBACK_LINKS.happIos}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors"
                >
                  Скачать Happ
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            </div>
          </CollapsibleConnectionStep>

          <OnboardingTip
            id="keys-intro-ios"
            icon={<Zap className="w-4 h-4" />}
            title="Быстрый старт — iOS"
          >
            <p>
              <strong>2.</strong> Скопируйте ссылку ниже и добавьте её в Happ.
            </p>
            <p>
              <strong>3.</strong> Включите VPN в Happ. Дополнительную маршрутизацию можно настроить ниже.
            </p>
          </OnboardingTip>

          {/* Subscription URL — iOS */}
          {canIssue && subscription?.url && activeKeys.length > 0 && (
            <CollapsibleConnectionStep
              id="connection-ios-link"
              icon={<RefreshCw className="w-4 h-4 text-primary" />}
              title="2. Добавьте ссылку для подключения"
              summary="Happ будет автоматически получать актуальные настройки VPN."
            >
              <div className="space-y-3">
                <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                  <span className="truncate flex-1">{subscription.url}</span>
                  <button
                    type="button"
                    onClick={() => setShowQR(true)}
                    className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                    title="QR-код"
                    aria-label="Показать QR-код ссылки для подключения"
                  >
                    <QrCode className="w-4 h-4" />
                  </button>
                  <CopyButton text={subscription.url} showLabel />
                </div>
                <p className="text-xs text-muted-foreground">
                  В Happ нажмите <strong>«+»</strong> → <strong>«Добавить подписку»</strong> → вставьте ссылку.
                  Или отсканируйте QR-код <QrCode className="inline w-3 h-3 mx-0.5" /> прямо с экрана.
                </p>
              </div>
            </CollapsibleConnectionStep>
          )}

          {/* iOS Happ routing profile */}
          {canIssue && subscription?.url && activeKeys.length > 0 && (
            <CollapsibleConnectionStep
              id="connection-ios-routing"
              icon={<Route className="w-4 h-4 text-green-500" />}
              title="Маршрутизация для Happ iOS"
              summary="Российские сервисы идут напрямую, всё остальное — через туннель."
            >
              <div className="space-y-4">
                {paymentSettings?.happIosRoutingUrl ? (
                  <>
                    <a
                      href={paymentSettings.happIosRoutingUrl}
                      className="flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground font-bold px-5 py-3 hover:opacity-90 transition-opacity text-sm"
                    >
                      <Route className="w-4 h-4" />
                      Настроить маршрутизацию →
                    </a>

                    {/* URL + copy + QR — для отправки ссылки на другое устройство */}
                    <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                      <span className="truncate flex-1">{paymentSettings.happIosRoutingUrl}</span>
                      <button
                        type="button"
                        onClick={() => setShowRoutingQR(true)}
                        className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                        title="QR-код маршрутизации"
                        aria-label="Показать QR-код маршрутизации"
                      >
                        <QrCode className="w-4 h-4" />
                      </button>
                      <CopyButton text={paymentSettings.happIosRoutingUrl} />
                    </div>
                    <p className="text-xs text-muted-foreground -mt-1">
                      Перешлите ссылку или отсканируйте QR-код <QrCode className="inline w-3 h-3 mx-0.5" /> с другого устройства.
                    </p>
                  </>
                ) : (
                  <div className="h-12 bg-muted animate-pulse" />
                )}

                <div className="text-xs text-muted-foreground space-y-1.5 border-t border-border pt-3">
                  <p>
                    <strong className="text-foreground">Как работает:</strong>{" "}
                    кнопка открывает Happ напрямую. Приложение покажет диалог «Импортировать профиль маршрутизации?» — нажмите <strong>«Применить»</strong>.
                  </p>
                  <p>
                    Профиль обновляется администратором сервиса — при изменении нажмите кнопку снова.
                  </p>
                  <p className="text-muted-foreground/60">
                    Требуется Happ 4.11+ с ядром Xray (iOS).
                  </p>
                </div>
              </div>
            </CollapsibleConnectionStep>
          )}
        </>
      )}

      {(canIssue || visibleKeys.length > 0) && (
        <div className="bg-card border border-border p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="font-bold">{isAdmin ? "Устройства пользователей" : "Мои устройства"}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {isAdmin ? `Активных ключей: ${activeKeys.length}` : `Подключено устройств: ${activeKeyCount} из ${deviceSlots}`}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {isAdmin
                  ? "Используйте поиск и фильтр статуса, чтобы быстро найти нужный ключ."
                  : "Для каждого телефона или компьютера нужен отдельный VPN-доступ."}
              </p>
            </div>
            {canIssue && (
              hasSlotAvailable ? (
                <button
                  type="button"
                  onClick={() => setShowAddDeviceModal(true)}
                  disabled={creating}
                  className="shrink-0 inline-flex items-center gap-2 border border-border px-4 py-2 text-sm font-semibold hover:border-primary hover:text-primary transition-colors disabled:opacity-40"
                >
                  <Plus className="w-4 h-4" />
                  Добавить ещё устройство
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleAddSlot}
                  disabled={orderingSlot || slotButtonDisabled}
                  title={slotButtonDisabled ? "Покупка дополнительных устройств временно недоступна" : undefined}
                  className="shrink-0 inline-flex items-center gap-2 border border-primary text-primary px-4 py-2 text-sm font-semibold hover:bg-primary/5 transition-colors disabled:opacity-40"
                >
                  <Plus className="w-4 h-4" />
                  {orderingSlot
                    ? "Создаём заявку..."
                    : slotPrice > 0
                      ? `Добавить место — ${slotPrice} ₽`
                      : "Добавить место для устройства"}
                </button>
              )
            )}
          </div>
          {isAdmin && visibleKeys.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border flex items-center gap-2 flex-wrap">
              <Input
                value={adminKeySearch}
                onChange={(e) => setAdminKeySearch(e.target.value)}
                placeholder="Поиск по устройству, email или серверу"
                aria-label="Поиск по устройству, email или серверу"
                className="rounded-none min-w-0 flex-1 basis-56"
              />
              <select
                value={adminKeyStatus}
                onChange={(e) => setAdminKeyStatus(e.target.value as typeof adminKeyStatus)}
                aria-label="Фильтр по статусу ключа"
                className="border border-border bg-background px-3 py-2 text-sm rounded-none"
              >
                <option value="all">Все ключи</option>
                <option value="active">Только активные</option>
                <option value="revoked">Только отозванные</option>
              </select>
              {(adminKeySearch || adminKeyStatus !== "all") && (
                <button
                  type="button"
                  onClick={() => {
                    setAdminKeySearch("");
                    setAdminKeyStatus("all");
                  }}
                  className="border border-border px-3 py-2 text-sm hover:border-primary hover:text-primary transition-colors whitespace-nowrap"
                >
                  Сбросить
                </button>
              )}
              <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                Показано: {filteredVisibleKeys.length} из {visibleKeys.length}
              </span>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : !visibleKeys || visibleKeys.length === 0 ? (
        <p className="text-sm text-muted-foreground bg-card border border-border p-4">
          Пока нет подключённых устройств. Нажмите «Подключить это устройство» выше, чтобы создать первый VPN-доступ.
        </p>
      ) : filteredVisibleKeys.length === 0 ? (
        <div className="text-sm text-muted-foreground bg-card border border-border p-4 flex items-center justify-between gap-3 flex-wrap">
          <span>По текущим фильтрам ключей не найдено.</span>
          <button
            type="button"
            onClick={() => {
              setAdminKeySearch("");
              setAdminKeyStatus("all");
            }}
            className="border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary transition-colors"
          >
            Сбросить фильтры
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredVisibleKeys.map((key, i) => (
            <div
              key={key.id}
              style={{ animationDelay: `${i * 60}ms` }}
              className={`bg-card border p-5 animate-in fade-in slide-in-from-bottom-1 duration-500 ${
                key.revokedAt ? "border-border opacity-50" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-bold min-w-0">
                    <KeyRound className="w-4 h-4 text-primary shrink-0" />
                    <span className="truncate min-w-0">{key.label}</span>
                    <span className="text-muted-foreground font-normal font-mono text-sm shrink-0 whitespace-nowrap">· {key.nodeName}</span>
                    {!key.revokedAt && editingKeyId !== key.id && (!isAdmin || key.userId === me?.id) && (
                      <button
                        onClick={() => setEditingKeyId(key.id)}
                        className="text-muted-foreground hover:text-primary transition-colors shrink-0"
                        title="Переименовать"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {key.description && editingKeyId !== key.id && (
                    <p className="text-xs text-muted-foreground mt-1 ml-6 break-words">{key.description}</p>
                  )}
                  {isAdmin && key.userEmail && (
                    <p className="text-xs text-muted-foreground mt-1 ml-6 break-all">{key.userEmail}</p>
                  )}
                </div>
                {!key.revokedAt && me?.role === "admin" && (
                  <button
                    onClick={() => handleRevoke(key.id)}
                    disabled={revokingId === key.id}
                    className="flex items-center gap-1.5 text-sm text-destructive hover:opacity-70 transition-opacity shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Отозвать
                  </button>
                )}
              </div>
              {editingKeyId === key.id && (
                <EditKeyForm
                  keyId={key.id}
                  initialLabel={key.label}
                  initialDescription={key.description ?? ""}
                  currentNodeId={key.nodeId}
                  nodes={activeNodes}
                  onClose={() => setEditingKeyId(null)}
                />
              )}
              {key.revokedAt ? (
                <span className="text-xs font-mono text-muted-foreground">
                  Отозван{key.revokedReason ? ` · ${revokedReasonLabel[key.revokedReason] ?? key.revokedReason}` : ""}
                </span>
              ) : isAdmin ? (
                <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                  <span className="truncate flex-1">{key.vlessLink}</span>
                  <CopyButton text={key.vlessLink} />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                   Для подключения используйте ссылку выше.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
