import { useState, useEffect } from "react";
import {
  useGetMe,
  useListMyVpnKeys,
  useListVpnNodes,
  useCreateVpnKey,
  useRevokeVpnKey,
  useGetSubscriptionUrl,
  useGetPaymentSettings,
  useCreateExtraSlotOrder,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/query-client";
import { getListMyVpnKeysQueryKey } from "@workspace/api-client-react";
import { Copy, Trash2, Plus, KeyRound, RefreshCw, ChevronDown, Check, QrCode, X, Smartphone, Monitor, ExternalLink, Zap } from "lucide-react";
import { OnboardingTip } from "@/components/onboarding-tip";
import QRCode from "qrcode";

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

const CLIENTS = [
  { name: "Android: v2rayNG", url: "https://play.google.com/store/apps/details?id=com.v2ray.ang" },
  { name: "Android/iOS: Happ", url: "https://apps.apple.com/app/happ-proxy-utility/id6504287215" },
  { name: "iOS: Streisand", url: "https://apps.apple.com/app/streisand/id6450534064" },
  { name: "Windows: v2rayN", url: "https://github.com/2dust/v2rayN/releases/latest" },
  { name: "macOS: V2Box", url: "https://apps.apple.com/app/v2box-v2ray-client/id6446814690" },
];

function ConnectionGuide({ subscriptionUrl }: { subscriptionUrl?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-card border border-border">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between p-5 text-left"
      >
        <div className="flex items-center gap-2 font-bold">
          <Smartphone className="w-4 h-4 text-primary" />
          Как подключиться?
        </div>
        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-border p-5 space-y-4 text-sm">
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold text-muted-foreground uppercase text-xs font-mono tracking-wide">
              <Monitor className="w-3.5 h-3.5" /> Шаг 1 — Установите приложение
            </div>
            <ul className="space-y-1.5 ml-1">
              {CLIENTS.map((c) => (
                <li key={c.name}>
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-primary hover:underline"
                  >
                    {c.name} <ExternalLink className="w-3 h-3" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold text-muted-foreground uppercase text-xs font-mono tracking-wide">
              <RefreshCw className="w-3.5 h-3.5" /> Шаг 2 — Добавьте подписку (рекомендуется)
            </div>
            <p className="text-muted-foreground">
              Скопируйте <strong>ссылку подписки</strong> выше и вставьте в приложение через
              пункт <strong>«Добавить подписку»</strong> / <strong>«Add subscription»</strong>.
              Ключи будут обновляться автоматически.
            </p>
            {subscriptionUrl && (
              <p className="text-muted-foreground text-xs">
                Или отсканируйте QR-код — нажмите иконку <QrCode className="inline w-3 h-3" /> рядом со ссылкой.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-2 font-semibold text-muted-foreground uppercase text-xs font-mono tracking-wide">
              <KeyRound className="w-3.5 h-3.5" /> Альтернатива — импорт отдельного ключа
            </div>
            <p className="text-muted-foreground">
              Скопируйте <strong>vless://...</strong> ссылку и вставьте в приложение через
              «Импорт из буфера обмена» / «Import from clipboard».
            </p>
          </div>
          <div className="bg-muted/40 border border-border p-3 text-xs text-muted-foreground">
            После добавления нажмите кнопку подключения в приложении. Если VPN не работает — обратитесь в поддержку.
          </div>
        </div>
      )}
    </div>
  );
}

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
  const [showManualLinks, setShowManualLinks] = useState(false);
  const [showQR, setShowQR] = useState(false);

  const isAdmin = me?.role === "admin";
  const activeKeys = (keys ?? []).filter((k: { revokedAt?: string | null }) => !k.revokedAt);
  const visibleKeys = (keys ?? []).filter((k: { revokedAt?: string | null }) => isAdmin || !k.revokedAt);
  const canIssue = !!me?.hasActiveSubscription;
  const activeNodes = (nodes ?? []).filter((n: { isActive: boolean }) => n.isActive);
  const defaultNodeId = activeNodes[0]?.id;

  const deviceSlots = me?.deviceSlots ?? 1;
  const activeKeyCount = me?.activeKeyCount ?? activeKeys.length;
  const hasSlotAvailable = canIssue && activeKeyCount < deviceSlots;
  const slotPrice = paymentSettings?.extraDeviceSlotPriceRub ?? 0;

  function handleCreate() {
    createKey(
      { data: { nodeId: defaultNodeId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
          toast({ title: "Ключ выпущен", description: "Импортируйте его в клиент VLESS." });
        },
        onError: (err: unknown) => {
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

      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ключи VPN</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Учётные данные подключения. Импортируйте vless-ссылку в свой клиент.
          </p>
        </div>
        {canIssue && (
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-sm font-mono text-muted-foreground">
              Устройства: {activeKeyCount} / {deviceSlots}
            </span>
            {hasSlotAvailable ? (
              <button
                onClick={handleCreate}
                disabled={creating}
                className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
                {creating ? "Выпускаем..." : "Добавить устройство"}
              </button>
            ) : (
              <button
                onClick={() => {
                  createSlotOrder(undefined, {
                    onSuccess: (data) => setLocation(`/checkout/slot/${data.paymentId}`),
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
                disabled={orderingSlot}
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
        title="Как подключиться за 2 минуты"
      >
        <p>
          <strong>1.</strong> Установите приложение: <strong>Happ</strong> (iOS/Android), <strong>v2rayNG</strong> (Android) или <strong>v2rayN</strong> (Windows).
        </p>
        <p>
          <strong>2.</strong> Скопируйте <strong>Ссылку подписки</strong> ниже и добавьте её в приложение через «Добавить подписку».
        </p>
        <p>
          <strong>3.</strong> Нажмите подключение — готово. Ключи обновляются автоматически.
        </p>
      </OnboardingTip>

      {!canIssue && (
        <p className="text-sm text-muted-foreground bg-card border border-border p-4">
          Для выпуска ключей нужна активная подписка. Перейдите в раздел «Тарифы».
        </p>
      )}

      <ConnectionGuide subscriptionUrl={subscription?.url} />

      {subscription?.url && activeKeys.length > 0 && (
        <div className="bg-card border border-border p-5 space-y-3">
          <div className="flex items-center gap-2 font-bold">
            <RefreshCw className="w-4 h-4 text-primary" />
            Ссылка подписки
          </div>
          <p className="text-sm text-muted-foreground">
            Рекомендуемый способ: добавьте эту ссылку один раз в приложение (Happ, v2rayNG, v2rayN — пункт «Добавить
            подписку» / «Add subscription»). Приложение само подтягивает актуальные ключи при обновлении, поэтому
            вручную ничего менять не нужно — и любые правки конфигурации внутри приложения будут перезаписаны при
            следующем обновлении.
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
          <button
            onClick={() => setShowManualLinks((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showManualLinks ? "rotate-180" : ""}`} />
            {showManualLinks ? "Скрыть отдельные ключи" : "Показать отдельные ключи для ручного импорта"}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : !visibleKeys || visibleKeys.length === 0 ? (
        <p className="text-muted-foreground">Ключей пока нет.</p>
      ) : !subscription?.url || activeKeys.length === 0 || showManualLinks ? (
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
                <div className="flex items-center gap-2 font-bold min-w-0 break-words">
                  <KeyRound className="w-4 h-4 text-primary shrink-0" />
                  {key.label} <span className="text-muted-foreground font-normal font-mono text-sm">· {key.nodeName}</span>
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
              {key.revokedAt ? (
                <span className="text-xs font-mono text-muted-foreground">Отозван</span>
              ) : (
                <div className="flex items-center gap-2 bg-muted/50 border border-border px-3 py-2 font-mono text-xs overflow-hidden">
                  <span className="truncate flex-1">{key.vlessLink}</span>
                  <CopyButton text={key.vlessLink} />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
