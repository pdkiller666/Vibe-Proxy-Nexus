import { useState, useEffect } from "react";
import {
  useGetMe,
  useListMyVpnKeys,
  useListVpnNodes,
  useCreateVpnKey,
  useRevokeVpnKey,
  useUpdateVpnKey,
  useRelocateVpnKey,
  useGetSubscriptionUrl,
  useGetPaymentSettings,
  useCreateExtraSlotOrder,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/query-client";
import { getListMyVpnKeysQueryKey, getGetMeQueryKey } from "@workspace/api-client-react";
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
      relocateKey(
        { keyId, data: { nodeId: selectedNodeId } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
            toast({ title: "Ключ перемещён", description: "Новый ключ выпущен на выбранном сервере." });
            onClose();
          },
          onError: (err: unknown) => {
            const msg = err instanceof Error ? err.message : undefined;
            toast({ title: msg ?? "Не удалось переместить ключ", variant: "destructive" });
          },
        },
      );
    } else {
      updateKey(
        { keyId, data: { label: trimmed, description: description.trim() } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
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

function CopyButton({ text }: { text: string }) {
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
      className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
      title="Копировать"
    >
      {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
    </button>
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
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
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
          {submitting ? "Выпускаем..." : "Выпустить ключ"}
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
          <h3 className="font-bold text-base">QR-код подписки</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          Отсканируйте в приложении (v2rayNG, Happ, Sing-Box) через «Добавить подписку».
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

const CLIENTS = [
  { name: "Happ (Android / iOS)", url: "https://apps.apple.com/app/happ-proxy-utility/id6504287215" },
  { name: "v2rayNG (Android)", url: "https://play.google.com/store/apps/details?id=com.v2ray.ang" },
  { name: "Streisand (iOS)", url: "https://apps.apple.com/app/streisand/id6450534064" },
  { name: "v2rayN (Windows)", url: "https://github.com/2dust/v2rayN/releases/latest" },
  { name: "V2Box (macOS)", url: "https://apps.apple.com/app/v2box-v2ray-client/id6446814690" },
];

export default function Keys() {
  const { data: me } = useGetMe();
  const { data: keys, isLoading } = useListMyVpnKeys();
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
  const [showAddDeviceModal, setShowAddDeviceModal] = useState(false);
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null);

  const isAdmin = me?.role === "admin";
  const activeKeys = (keys ?? []).filter((k: { revokedAt?: string | null }) => !k.revokedAt);
  const visibleKeys = (keys ?? []).filter((k: { revokedAt?: string | null }) => isAdmin || !k.revokedAt);
  const canIssue = !!me?.hasActiveSubscription;
  const activeNodes = (nodes ?? []).filter((n: { isActive: boolean }) => n.isActive);

  const deviceSlots = me?.deviceSlots ?? 1;
  const activeKeyCount = me?.activeKeyCount ?? activeKeys.length;
  const hasSlotAvailable = canIssue && activeKeyCount < deviceSlots;
  const slotPrice = paymentSettings?.extraDeviceSlotPriceRub ?? 0;
  const allowFreeSlot = paymentSettings?.allowFreeExtraDeviceSlot ?? false;
  const slotButtonDisabled = slotPrice <= 0 && !allowFreeSlot;

  function handleCreate(label: string, description: string, nodeId: number | undefined) {
    createKey(
      { data: { nodeId, label: label || undefined, description: description || undefined } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          setShowAddDeviceModal(false);
          toast({ title: "Ключ выпущен", description: "Импортируйте его в клиент VLESS." });
        },
        onError: (err: unknown) => {
          queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
          const msg = err instanceof Error ? err.message : undefined;
          toast({ title: msg ?? "Не удалось выпустить ключ", variant: "destructive" });
        },
      },
    );
  }

  function handleRevoke(keyId: number) {
    setRevokingId(keyId);
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
          <h1 className="text-2xl font-bold tracking-tight">Ключи VPN</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Добавьте ссылку подписки в свой клиент — конфигурация подключится автоматически.
          </p>
        </div>
        {canIssue && (
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-sm font-mono text-muted-foreground">
              Устройства: {activeKeyCount} / {deviceSlots}
            </span>
            {hasSlotAvailable ? (
              <button
                onClick={() => setShowAddDeviceModal(true)}
                disabled={creating}
                className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
                Добавить устройство
              </button>
            ) : (
              <button
                onClick={() => {
                  createSlotOrder(undefined, {
                    onSuccess: (data) => {
                      if (data.freeGranted) {
                        queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
                        setShowAddDeviceModal(true);
                        toast({ title: "Слот добавлен бесплатно" });
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
                }}
                disabled={orderingSlot || slotButtonDisabled}
                title={slotButtonDisabled ? "Покупка дополнительных устройств временно недоступна" : undefined}
                className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
                {orderingSlot
                  ? "Создаём заявку..."
                  : slotPrice > 0
                    ? `Добавить устройство — ${slotPrice} ₽`
                    : "Добавить устройство"}
              </button>
            )}
          </div>
        )}
      </div>

      <OnboardingTip
        id="keys-intro"
        icon={<Zap className="w-4 h-4" />}
        title="Быстрый старт"
      >
        <p>
          <strong>1.</strong> Установите приложение:{" "}
          {CLIENTS.map((c, i) => (
            <span key={c.name}>
              <a href={c.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">{c.name}</a>
              {i < CLIENTS.length - 1 ? ", " : "."}
            </span>
          ))}
        </p>
        <p>
          <strong>2.</strong> Скопируйте <strong>Ссылку подписки</strong> ниже → в приложении нажмите <strong>«Добавить подписку»</strong> → вставьте. Готово, ключи обновляются сами.
        </p>
        <p>
          <strong>3.</strong> Хотите, чтобы российские сайты работали без VPN? Используйте <strong>Xray-конфиг с автообходом РФ</strong> — ссылки ниже, отдельно для каждого устройства.
        </p>
      </OnboardingTip>

      {!canIssue && (
        <p className="text-sm text-muted-foreground bg-card border border-border p-4">
          Для выпуска ключей нужна активная подписка. Перейдите в раздел «Тарифы».
        </p>
      )}

      {/* ── Универсальная ссылка подписки ──────────────────────────────────── */}
      {subscription?.url && activeKeys.length > 0 && (
        <div className="bg-card border border-border p-5 space-y-3">
          <div className="flex items-center gap-2 font-bold">
            <RefreshCw className="w-4 h-4 text-primary" />
            Ссылка подписки
            <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
              все приложения
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Добавьте один раз — приложение само подтягивает актуальные ключи.
            Подходит для <strong>Happ</strong>, <strong>v2rayNG</strong>, <strong>v2rayN</strong>, <strong>Streisand</strong> и любого другого VLESS-клиента.
          </p>
          <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
            <span className="truncate flex-1">{subscription.url}</span>
            <button
              onClick={() => setShowQR(true)}
              className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
              title="QR-код"
            >
              <QrCode className="w-4 h-4" />
            </button>
            <CopyButton text={subscription.url} />
          </div>
          <p className="text-xs text-muted-foreground">
            В приложении: нажмите <strong>«+»</strong> → <strong>«Добавить подписку»</strong> → вставьте ссылку.
            Или отсканируйте QR-код <QrCode className="inline w-3 h-3 mx-0.5" /> прямо с экрана.
          </p>
        </div>
      )}

      {/* ── Xray-конфиг с автообходом РФ ───────────────────────────────────── */}
      {subscription?.url && activeKeys.length > 0 && (
        <div className="bg-card border border-border p-5 space-y-4">
          <div className="flex items-center gap-2 font-bold">
            <Route className="w-4 h-4 text-green-500" />
            Xray-конфиг с автообходом РФ
            <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full ml-1">
              Happ · v2rayN
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Российские сервисы (Сбербанк, Госуслуги, Яндекс, ВКонтакте) идут напрямую — без VPN.
            Всё остальное — через туннель. Для каждого устройства своя ссылка.
          </p>

          {/* Предупреждение идёт ПЕРЕД ссылками — пользователь видит его первым */}
          <div className="flex gap-3 border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 p-3 text-sm">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 text-amber-800 dark:text-amber-300">
              <p className="font-semibold">Перед добавлением в Happ</p>
              <p className="text-amber-700 dark:text-amber-400 text-xs">
                В настройках Happ убедитесь: ядро — <strong>Xray core</strong>, тумблер <strong>«Маршрутизация» (Routing) — ВЫКЛЮЧЕН</strong>.
                Иначе встроенная маршрутизация Happ перекроет правила конфига и обход не заработает.
              </p>
            </div>
          </div>

          {/* Per-device xray subscription URLs */}
          <div className="space-y-2">
            {activeKeys.map((key) => {
              const xrayUrl = `${subscription.url}?format=xray&key=${key.id}`;
              return (
                <div key={key.id} className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground">{key.label}</p>
                  <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                    <span className="truncate flex-1">{xrayUrl}</span>
                    <button
                      onClick={() => setXrayQRUrl(xrayUrl)}
                      className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                      title="QR-код"
                    >
                      <QrCode className="w-4 h-4" />
                    </button>
                    <CopyButton text={xrayUrl} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Краткая инструкция */}
          <div className="text-xs text-muted-foreground space-y-2 border-t border-border pt-3">
            <p>
              <strong className="text-foreground">Happ (Android / iOS):</strong>{" "}
              скопируйте ссылку своего устройства (или отсканируйте QR) →
              в Happ нажмите <strong>«+»</strong> → <strong>«Добавить подписку»</strong>.
              Подписка появится с именем вашего устройства и будет обновляться автоматически.
            </p>
            <p>
              <strong className="text-foreground">v2rayN (Windows):</strong>{" "}
              <strong>«Подписки»</strong> → <strong>«Настройки подписок»</strong> → добавить новую → вставить ссылку.
            </p>
            <p className="text-muted-foreground/60">
              При смене сервера ссылка не меняется — конфиг обновится автоматически при следующем обновлении подписки.
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : !visibleKeys || visibleKeys.length === 0 ? (
        <p className="text-muted-foreground">Ключей пока нет.</p>
      ) : (
        <div className="space-y-3">
          {visibleKeys.map((key, i) => (
            <div
              key={key.id}
              style={{ animationDelay: `${i * 60}ms` }}
              className={`bg-card border p-5 animate-in fade-in slide-in-from-bottom-1 duration-500 ${
                key.revokedAt ? "border-border opacity-50" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-bold min-w-0 break-words">
                    <KeyRound className="w-4 h-4 text-primary shrink-0" />
                    {key.label} <span className="text-muted-foreground font-normal font-mono text-sm">· {key.nodeName}</span>
                    {!key.revokedAt && editingKeyId !== key.id && (
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
                  Для подключения используйте «Ссылку подписки» выше.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
