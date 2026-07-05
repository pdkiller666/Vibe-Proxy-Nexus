import { useState } from "react";
import {
  useGetMe,
  useListMyVpnKeys,
  useListVpnNodes,
  useCreateVpnKey,
  useRevokeVpnKey,
  useGetSubscriptionUrl,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/query-client";
import { getListMyVpnKeysQueryKey } from "@workspace/api-client-react";
import { Copy, Trash2, Plus, KeyRound, RefreshCw, ChevronDown } from "lucide-react";

export default function Keys() {
  const { data: me } = useGetMe();
  const { data: keys, isLoading } = useListMyVpnKeys();
  const { data: nodes } = useListVpnNodes();
  const { data: subscription } = useGetSubscriptionUrl();
  const { mutate: createKey, isPending: creating } = useCreateVpnKey();
  const { mutate: revokeKey } = useRevokeVpnKey();
  const { toast } = useToast();
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [showManualLinks, setShowManualLinks] = useState(false);

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];
  const canIssue = !!me?.hasActiveSubscription;
  const defaultNodeId = nodes?.find((n) => n.isActive)?.id;

  function handleCreate() {
    createKey(
      { data: { nodeId: defaultNodeId, label: "Мой ключ" } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListMyVpnKeysQueryKey() });
          toast({ title: "Ключ выпущен", description: "Импортируйте его в клиент VLESS." });
        },
        onError: () => {
          toast({ title: "Не удалось выпустить ключ", variant: "destructive" });
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

  function copyLink(link: string) {
    navigator.clipboard.writeText(link);
    toast({ title: "Ссылка скопирована" });
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ключи VPN</h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">
            Учётные данные подключения. Импортируйте vless-ссылку в свой клиент.
          </p>
        </div>
        <button
          onClick={handleCreate}
          disabled={!canIssue || creating}
          title={canIssue ? undefined : "Нужна активная подписка"}
          className="flex items-center gap-2 bg-primary text-primary-foreground font-bold px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          <Plus className="w-4 h-4" />
          {creating ? "Выпускаем..." : "Новый ключ"}
        </button>
      </div>

      {!canIssue && (
        <p className="text-sm text-muted-foreground bg-card border border-border p-4">
          Для выпуска ключей нужна активная подписка. Перейдите в раздел «Тарифы».
        </p>
      )}

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
              onClick={() => copyLink(subscription.url)}
              className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
            >
              <Copy className="w-4 h-4" />
            </button>
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
      ) : !keys || keys.length === 0 ? (
        <p className="text-muted-foreground">Ключей пока нет.</p>
      ) : !subscription?.url || activeKeys.length === 0 || showManualLinks ? (
        <div className="space-y-3">
          {keys.map((key, i) => (
            <div
              key={key.id}
              style={{ animationDelay: `${i * 60}ms` }}
              className={`bg-card border p-5 animate-in fade-in slide-in-from-bottom-1 duration-500 ${
                key.revokedAt ? "border-border opacity-50" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-4 mb-3">
                <div className="flex items-center gap-2 font-bold">
                  <KeyRound className="w-4 h-4 text-primary" />
                  {key.label} <span className="text-muted-foreground font-normal font-mono text-sm">· {key.nodeName}</span>
                </div>
                {!key.revokedAt && (
                  <button
                    onClick={() => handleRevoke(key.id)}
                    disabled={revokingId === key.id}
                    className="flex items-center gap-1.5 text-sm text-destructive hover:opacity-70 transition-opacity"
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
                  <button
                    onClick={() => copyLink(key.vlessLink)}
                    className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
